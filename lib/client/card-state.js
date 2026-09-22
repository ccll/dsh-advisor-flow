/**
 * Web settings card — controller (pure state machine, no DOM) +
 * {@link applyPatch} semantics shared with the host gateway merge.
 *
 * The card edits the RAW `advisor-flow` namespace via the plugin's own
 * gateway RPC (`/api` → `advisor-flow/get` | `advisor-flow/set`), never the
 * `settings.describe` exposure channel (host-side allowlist would filter it).
 * The controller mirrors the host's validation client-side so the save button
 * degrades BEFORE a round trip: invalid values and the
 * enabled-without-provider/model shape block the save with a reason
 * (R-02-001/AC-03, web side).
 *
 * @module dsh-advisor-flow/client/card-state
 */

import { mergeAdvisorFlowConfig } from '../gateway.js';
import { resolveAdvisorFlowConfig, advisorModelMissingMessage, SAVE_NOTICE_EPHEMERAL, SAVE_NOTICE_PERSISTED } from '../config.js';
import { isRecord } from '../util.js';

/**
 * Create the card controller.
 *
 * @param {object} options
 * @param {{ call: (channel: string, method: string, payload: object) => Promise<object> }}
 *   options.rpc the connection's generic RPC caller (`rpc.call('/api', …)`)
 * @param {{ warn?, error? }} [options.logger]
 */
export function createSettingsCardController({ rpc, logger = console } = {}) {
    const state = {
        status: 'idle', // idle | ready | error
        config: {}, // raw namespace (the editable truth)
        warnings: [],
        error: undefined,
        patch: {}, // uncommitted edits
        saving: false,
        savedNotice: undefined,
    };
    const listeners = new Set();

    function emit() {
        for (const listener of [...listeners]) {
            listener();
        }
    }

    function effectiveConfig() {
        return mergeAdvisorFlowConfig(state.config, state.patch);
    }

    return {
        /** Subscribe to state changes (render framework glue). */
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        getState() {
            return {
                ...state,
                effectiveConfig: state.status === 'ready' ? effectiveConfig() : undefined,
                validationError: state.status === 'ready' ? this.validate() : undefined,
            };
        },

        /** Load the current config through `advisor-flow/get`. */
        async load() {
            state.status = state.status === 'error' ? 'error' : 'idle';
            try {
                const result = await rpc.call('/api', 'advisor-flow/get', { args: {} });
                if (!isRecord(result) || !isRecord(result.config)) {
                    state.status = 'error';
                    state.error = result?.error ?? '配置通道返回异常';
                } else {
                    state.config = result.config;
                    state.warnings = Array.isArray(result.warnings) ? result.warnings : [];
                    state.error = result.error;
                    state.status = 'ready';
                }
            } catch (error) {
                state.status = 'error';
                state.error = `配置通道不可用：${String(error)}`;
                logger.warn?.(`advisor-flow client: ${state.error}`);
            }
            emit();
            return state.status;
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
            // Same as the host gateway: the block reads the RAW merged shape
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

        /** Discard the staged patch (no gateway write). */
        discard() {
            state.patch = {};
            emit();
        },

        /**
         * Save the staged patch. A client-side validation failure blocks the
         * RPC entirely; a host rejection surfaces its message and keeps the
         * form. Resolves `{ ok, error? }`, never throws.
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
                const result = await rpc.call('/api', 'advisor-flow/set', { args: { patch: state.patch } });
                if (isRecord(result) && result.ok) {
                    state.config = isRecord(result.config) ? mergeToRaw(state.config, state.patch) : state.config;
                    state.warnings = Array.isArray(result.warnings) ? result.warnings : [];
                    state.error = undefined;
                    state.patch = {};
                    state.saving = false;
                    // 回执双形态由宿主裁决：persisted → 「已保存并持久化」；
                    // 写缝缺失或写入失败 → 「仅运行时态」。两种都不可暗示
                    // 未发生的持久化。
                    state.savedNotice = result.notice ?? SAVE_NOTICE_EPHEMERAL;
                    emit();
                    return { ok: true, persisted: result.persisted === true, notice: state.savedNotice };
                }
                state.error = result?.error ?? '保存被拒绝';
                state.saving = false;
                emit();
                return { ok: false, error: state.error };
            } catch (error) {
                state.error = `保存失败：${String(error)}`;
                state.saving = false;
                emit();
                return { ok: false, error: state.error };
            }
        },
    };
}

/** After a successful save the raw base absorbs the staged patch. */
function mergeToRaw(base, patch) {
    return mergeAdvisorFlowConfig(base, patch);
}
