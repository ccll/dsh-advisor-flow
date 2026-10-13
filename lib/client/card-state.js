/**
 * Web settings card — controller (pure state machine, no DOM).
 *
 * The card rides the host configForms pipeline (T-030, dsh-context 实测范式):
 * reads come from the host `ConfigFormController` snapshot (describe mirror,
 * revision-fenced, live-synced), writes go through `form.mutate(ops)` —
 * the host's regular client write path (`settings.mutate` → volatile write
 * → profile patch → volatile-update live re-apply). The plugin's own
 * gateway RPC is retired from the card; it stays only for the model catalog
 * (`llm/listProviders`, `session/modelCatalog`).
 *
 * The controller mirrors the host validation client-side so the save button
 * degrades BEFORE a round trip: invalid values and the
 * enabled-without-provider/model shape block the save with a reason
 * (R-02-001/AC-03, web side).
 *
 * @module dsh-advisor-flow/client/card-state
 */

import { mergeAdvisorFlowConfig } from '../gateway.js';
import { resolveAdvisorFlowConfig, advisorModelMissingMessage, SAVE_NOTICE_PERSISTED } from '../config.js';
import { isRecord } from '../util.js';

/**
 * Flatten a staged nested patch into one `settings.mutate` op list.
 * Leaf paths keep dotted nesting (`gates.loop.threshold` →
 * `['gates','loop','threshold']`); arrays are leaf values.
 *
 * @param {Record<string, unknown>} patch
 * @returns {Array<{op: 'set', path: string[], value: unknown}>}
 */
export function flattenPatchToOps(patch) {
    const ops = [];
    const walk = (node, path) => {
        if (Array.isArray(node)) {
            ops.push({ op: 'set', path, value: node });
            return;
        }
        if (isRecord(node)) {
            for (const [key, value] of Object.entries(node)) {
                walk(value, [...path, key]);
            }
            return;
        }
        ops.push({ op: 'set', path, value: node });
    };
    if (isRecord(patch)) {
        for (const [key, value] of Object.entries(patch)) {
            walk(value, [key]);
        }
    }
    return ops;
}

/**
 * Create the card controller.
 *
 * @param {object} options
 * @param {object} options.form the host `ConfigFormController` for the
 *   `advisor-flow` namespace (`configForms.get('advisor-flow')`) — the value
 *   source (describe mirror) and the write channel (`mutate`)
 * @param {{ call: (channel: string, method: string, payload: object) => Promise<object> }}
 *   options.rpc the connection's generic RPC caller (model catalog only)
 * @param {{ warn?, error? }} [options.logger]
 */
export function createSettingsCardController({ form, rpc, logger = console } = {}) {
    const state = {
        status: 'idle', // idle | ready | error
        config: {}, // raw namespace (the editable truth, defaults resolved for display)
        error: undefined,
        patch: {}, // uncommitted edits
        saving: false,
        savedNotice: undefined,
        writable: true, // 宿主表单只读位（describe 镜像；false 时保存钮禁用）
        // 卡片展开态（T-006 实测：emit 触发的重建式渲染若不持久化展开态，
        // setField → emit → 重绘会把卡片折叠回去——真实用户高频路径）。
        expanded: false,
        // 模型目录（llm/listProviders + session/modelCatalog 实测契约）：
        // provider/model/effort 三级联动下拉的数据源；拉取失败回退手动输入。
        providers: [],
        catalogGroups: [],
        catalogReady: false,
        catalogDegraded: false,
    };
    const listeners = new Set();
    let loadStarted = false; // load 幂等守卫（防 refresh→load 派生循环）
    let unsubscribeForm; // 宿主快照订阅解绑函数（dispose 用）

    function emit() {
        for (const listener of [...listeners]) {
            listener();
        }
    }

    function effectiveConfig() {
        return mergeAdvisorFlowConfig(state.config, state.patch);
    }

    /**
     * Unwrap one RPC envelope (dsh-client-connection 实测契约):
     * `rpc.call` resolves `{ ok: true, value }` or
     * `{ ok: false, error: { code, message, details } }` — it RESOLVES on
     * failure too, so the envelope must be inspected, never assumed.
     */
    async function unwrap(envelope) {
        // 仅解信封（ok/error 形态）——value 形态（含数组/标量意外）由调用方
        // 按各自契约校验并给 fallback 文案：unwrap 层拒形态会让调用方的
        // fallback 分支不可达（错误文案退化为通用「配置通道返回异常」）。
        if (!isRecord(envelope) || envelope.ok !== true) {
            const message = envelope?.error?.message ?? '配置通道返回异常';
            return { ok: false, value: undefined, message, code: envelope?.error?.code };
        }
        return { ok: true, value: envelope.value, message: undefined };
    }

    /** Host snapshot → card state. The staged patch overlay stays untouched. */
    function deriveFromForm() {
        try {
            const snapshot = typeof form?.getSnapshot === 'function' ? form.getSnapshot() : {};
            if (snapshot.status === 'ready' && isRecord(snapshot.value)) {
                // describe 镜像的 value = raw 命名空间（未过解析器的可编辑
                // 真相；宿主只投影 schema 声明键）。校验语义（enabled 缺
                // provider/model 阻断）在 validate() 里按 raw 形态执行，
                // 不在此处解析——解析会把缺省项翻转成 disabled-with-reason，
                // 恰好掩盖错误配置（T-030：与旧 gateway 读链同教训）。
                state.config = structuredClone(snapshot.value);
                state.status = 'ready';
                state.error = undefined;
            } else if (snapshot.status === 'unavailable') {
                state.status = 'error';
                state.error = '配置服务不可用，稍后自动重试';
            } else if (state.status !== 'ready') {
                state.status = 'idle';
            }
            state.writable = snapshot.writable !== false;
        } catch (error) {
            logger.warn?.(`advisor-flow client: 配置快照派生异常——保持现有视图: ${String(error)}`);
        }
        emit();
    }

    /**
     * 拉模型目录（R-02-001 GUI 面增强，东家要求）：listProviders →
     * [{id,name}]；session/modelCatalog → {routableProviders, groups}。
     * 两请求都走 unwrap 信封；任一失败 → 回退手动输入形态并一次性
     * 显性化（不得静默变空下拉）。
     */
    async function loadCatalogs() {
        try {
            const [providersEnv, catalogEnv] = await Promise.all([
                rpc.call('/api', 'llm/listProviders', { args: {} }),
                rpc.call('/api', 'session/modelCatalog', { args: {} }),
            ]);
            const providers = await unwrap(providersEnv);
            const catalog = await unwrap(catalogEnv);
            const providerList = Array.isArray(providers.value) ? providers.value : [];
            const groups = isRecord(catalog.value) && Array.isArray(catalog.value.groups) ? catalog.value.groups : [];
            if (providers.ok && providerList.length > 0 && catalog.ok && groups.length > 0) {
                state.providers = providerList.filter((entry) => isRecord(entry) && typeof entry.id === 'string');
                state.catalogGroups = groups.filter((entry) => isRecord(entry) && typeof entry.id === 'string');
                state.catalogReady = state.providers.length > 0 && state.catalogGroups.length > 0;
            }
            if (!state.catalogReady) {
                markCatalogDegraded();
            }
        } catch (error) {
            markCatalogDegraded();
            logger.warn?.(`advisor-flow client: 模型目录拉取异常——回退手动输入: ${String(error)}`);
        }
        emit(); // 目录异步到达后刷新下拉（表单先渲染，不阻塞 ready）
    }

    function markCatalogDegraded() {
        if (state.catalogDegraded) {
            return; // 一次性显性化
        }
        state.catalogDegraded = true;
        state.degradations = { ...(isRecord(state.degradations) ? state.degradations : {}), catalog: 'catalog-fetch-failed' };
        logger.warn?.('advisor-flow client: 模型目录拉取失败——provider/model/effort 回退手动输入（catalog-fetch-failed）');
    }

    /** provider 下拉选项；`undefined` = 目录不可用（render 回退自由文本）。 */
    function providerOptions() {
        if (!state.catalogReady) {
            return undefined;
        }
        const options = state.providers.map((entry) => ({ value: entry.id, label: entry.name ?? entry.id }));
        const current = effectiveConfig().advisor?.provider;
        if (current && !options.some((option) => option.value === current)) {
            options.push({ value: current, label: `${current}（当前值，目录外）` }); // 保留当前值
        }
        return options;
    }

    /**
     * 所选 provider 的模型下拉选项；`undefined` = 目录不可用（回退）。
     * `keepCurrent: false`（级联重置判断专用）返回目录纯集——「保留当前
     * 值」兜底不得参与「model 是否属于新 provider」的判定，否则级联
     * 重置永远不触发。
     */
    function modelsFor(providerId, { keepCurrent = true } = {}) {
        if (!state.catalogReady) {
            return undefined;
        }
        const group = state.catalogGroups.find((entry) => entry.id === providerId);
        const models = (group?.models ?? [])
            .filter((model) => isRecord(model) && typeof model.id === 'string')
            .map((model) => ({ value: model.id, label: model.name ?? model.id }));
        const current = effectiveConfig().advisor?.model;
        if (keepCurrent && current && !models.some((option) => option.value === current)) {
            models.push({ value: current, label: `${current}（当前值，目录外）` }); // 保留当前值
        }
        if (models.length === 0) {
            models.push({ value: '', label: '— 选择模型 —' });
        }
        return models;
    }

    /** 所选 model 的 effort 下拉选项（来自模型声明 reasoning.efforts）；`undefined` = 回退硬编码档位。 */
    function effortOptions(modelId) {
        if (!state.catalogReady) {
            return undefined;
        }
        const model = state.catalogGroups
            .flatMap((group) => group.models ?? [])
            .find((model) => isRecord(model) && model.id === modelId);
        const defaultEffort = model?.reasoning?.defaultEffort;
        const options = [{
            value: '',
            label: defaultEffort ? `跟随模型默认（default: ${defaultEffort}）` : '跟随模型默认',
        }];
        for (const effort of model?.reasoning?.efforts ?? []) {
            if (isRecord(effort) && typeof effort.id === 'string') {
                options.push({ value: effort.id, label: effort.name ?? effort.id });
            }
        }
        return options;
    }

    return {
        /** Subscribe to state changes (render framework glue). */
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },

        /** Derived card view (render framework glue). */
        getState() {
            return {
                ...state,
                effectiveConfig: state.status === 'ready' ? effectiveConfig() : undefined,
                validationError: state.status === 'ready' ? this.validate() : undefined,
                // 未保存显性化（R-02-001/AC-10～12，C-024）：与保存按钮的暂
                // 存语义同源——patch 非空即 dirty；不做深比较（改回原值仍算
                // 暂存，与「放弃修改/保存」既有语义一致，避免第二套真值）。
                dirty: state.status === 'ready' && Object.keys(state.patch).length > 0,
            };
        },

        /** provider 下拉选项；`undefined` = 目录不可用（render 回退自由文本）。 */
        providerOptions,

        /** 所选 provider 的模型下拉选项；`undefined` = 回退自由文本。 */
        modelsFor,

        /** 所选 model 的 effort 下拉选项；`undefined` = 回退硬编码档位。 */
        effortOptions,

        /**
         * Ensure the host form is loaded and subscribe to its snapshots
         * (describe mirror drives loading/recovery; the catalog fetch stays
         * background so the form renders before the dropdown data lands).
         * 幂等守卫：只订阅一次——render 的 refresh 会重入 load，无守卫
         * 则 refresh→load→derive→emit→refresh 死循环（T-030 实测）。
         */
        load() {
            if (loadStarted) {
                return;
            }
            loadStarted = true;
            if (form && typeof form.ensure === 'function') {
                try {
                    form.ensure();
                } catch (error) {
                    logger.warn?.(`advisor-flow client: 配置源拉取启动失败——${String(error)}`);
                }
            }
            if (form && typeof form.subscribe === 'function') {
                // 订阅解绑函数留存：控制器被替换/宿主服务重跑时由 dispose()
                // 显式解绑，防订阅泄漏。
                unsubscribeForm = form.subscribe(deriveFromForm);
            }
            deriveFromForm();
            loadCatalogs();
        },

        /** 解绑宿主快照订阅并复位装载标记（控制器被替换时调用）。 */
        dispose() {
            if (typeof unsubscribeForm === 'function') {
                try {
                    unsubscribeForm();
                } catch (error) {
                    logger.warn?.(`advisor-flow client: 快照订阅解绑异常——${String(error)}`);
                }
            }
            unsubscribeForm = undefined;
            loadStarted = false;
        },

        /**
         * 重试：再拉一次宿主快照（ensure + 派生，不重复订阅）。error 态的
         * 「重试」按钮走这里——宿主 describe 镜像恢复后快照经 live 订阅
         * 自动到达，重试只是额外的显式拉取。
         */
        retry() {
            if (!loadStarted) {
                this.load();
                return;
            }
            if (form && typeof form.ensure === 'function') {
                try {
                    form.ensure();
                } catch (error) {
                    logger.warn?.(`advisor-flow client: 配置源重拉启动失败——${String(error)}`);
                }
            }
            deriveFromForm();
        },

        /**
         * 卡片展开/折叠（T-006 实测：展开态须跨 setField/emit 重绘与宿主
         * slot 重挂存续——存 controller state 而非 render 闭包）。不触发
         * 校验/回执语义，仅重绘。
         */
        setExpanded(value) {
            state.expanded = value === true;
            emit();
        },

        /** Stage one dotted-path edit, e.g. `setField('advisor.provider', 'p')`. */
        setField(path, value) {
            if (state.savedNotice) {
                state.savedNotice = undefined; // 新编辑使旧回执失效
            }
            const keys = String(path).split('.');
            let section = state.patch;
            for (let i = 0; i < keys.length - 1; i++) {
                const key = keys[i];
                if (!isRecord(section[key])) {
                    section[key] = {};
                }
                section = section[key];
            }
            section[keys[keys.length - 1]] = value;
            // 三级联动：provider 变更后，若当前 model 不属于新 provider 则
            // 清空重置 model 与 effort（null = 未选择，校验阻断保存直至补齐）。
            if (path === 'advisor.provider' && state.catalogReady) {
                const models = modelsFor(value, { keepCurrent: false }); // 目录纯集判定
                const currentModel = effectiveConfig().advisor?.model;
                if (Array.isArray(models) && currentModel && !models.some((option) => option.value === currentModel)) {
                    section.model = null;
                    section.reasoningEffort = null;
                }
            }
            emit();
        },

        /**
         * Client-side mirror of the host validation (same parser, same
         * enabled-without-model block). Returns an error message or
         * `undefined` when the staged patch would save.
         */
        validate() {
            if (state.status !== 'ready') {
                return '配置尚未加载';
            }
            const merged = effectiveConfig();
            // Same as the host write path: the block reads the RAW merged shape
            // (the parser's disabled-with-reason gate would otherwise flip
            // `enabled` to false and hide the misconfiguration).
            const advisor = isRecord(merged.advisor) ? merged.advisor : {};
            if (merged.enabled === true && (!advisor.provider || !advisor.model)) {
                return advisorModelMissingMessage(advisor.provider ? 'advisor.model' : 'advisor.provider');
            }
            const resolved = resolveAdvisorFlowConfig(merged);
            if (!resolved.ok) {
                return `配置无效，无法保存：${resolved.error}`;
            }
            return undefined;
        },

        /** Discard the staged patch (no host write). */
        discard() {
            state.patch = {};
            emit();
        },

        /**
         * Save the staged patch as one atomic `settings.mutate` batch
         * (revision-fenced by the host controller; on rejection the host
         * recovers the snapshot and the staged patch survives for a retry).
         * A client-side validation failure blocks the write entirely.
         * Resolves `{ ok, error? }`, never throws.
         */
        async save() {
            const invalid = this.validate();
            if (invalid) {
                state.error = invalid;
                emit();
                return { ok: false, error: invalid };
            }
            state.saving = true;
            emit();
            try {
                if (Object.keys(state.patch).length === 0) {
                    // 空 patch = 无变化：不发起宿主 mutate（无意义往返）
                    state.saving = false;
                    state.error = undefined;
                    emit();
                    return { ok: true, persisted: false };
                }
                const accepted = await form.mutate(flattenPatchToOps(state.patch));
                state.saving = false;
                if (!accepted) {
                    // 宿主未收（revision 栅栏/服务态）——快照已 recover 刷新，
                    // 草稿保留供重试。
                    state.error = '保存被宿主拒绝：配置可能已被其他端修改，请重试';
                    emit();
                    return { ok: false, error: state.error };
                }
                state.error = undefined;
                state.patch = {};
                state.savedNotice = SAVE_NOTICE_PERSISTED;
                emit();
                return { ok: true, persisted: true, notice: state.savedNotice };
            } catch (error) {
                state.error = `保存失败：${String(error)}`;
                state.saving = false;
                emit();
                return { ok: false, error: state.error };
            }
        },
    };
}
