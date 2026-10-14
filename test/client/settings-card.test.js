import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsCardController } from '../../lib/client/card-state.js';
import { renderSettingsCard } from '../../lib/client/render.js';
import { pump } from '../helpers.js';

/** Fake RPC over canned handlers（信封形态与 dsh-client-connection 契约一致）. */
function makeRpc({ handlers }) {
    const calls = [];
    return {
        calls,
        call: async (channel, method, payload) => {
            calls.push({ channel, method, payload });
            const handler = handlers[method];
            if (!handler) {
                throw new Error(`no endpoint ${method}`);
            }
            const result = await handler(payload);
            // handler 返回 { ok, value } 形态 = 已是信封（模拟传输/网关级失败
            // 专用，见信封失败用例）；否则包成 { ok: true, value } —— 与
            // connection.rpc.call 的 resolve 契约一致（ok:false 也 resolve）。
            if (typeof result === 'object' && result !== null && result.ok !== undefined && 'value' in result) {
                return result;
            }
            return { ok: true, value: result };
        },
    };
}

const RAW = {
    advisor: { provider: 'p', model: 'm' },
    gates: { plan: { enabled: true }, failure: { enabled: true }, loop: { enabled: true, threshold: 5 } },
    failureMode: 'block-tool',
    privacy: { history: 'window' },
};

/** Host-side gateway handlers shared with test/gateway.test.js semantics. */
function gatewayHandlers(rawRef, persist) {
    // 引入宿主实现本身，保证卡片测试与宿主语义零漂移
    return import('../../lib/gateway.js').then(({ createConfigGateway }) => {
        const gateway = createConfigGateway({
            getRawConfig: () => rawRef.current,
            applyResolved: (resolved, nextRaw) => {
                rawRef.current = nextRaw;
            },
            persist,
        });
        return gateway;
    });
}

/** ops（settings.mutate 形态）→ 嵌套 patch（宿主 gateway set 入参同构）。 */
function nestOps(ops) {
    const patch = {};
    for (const op of ops) {
        if (op.op !== 'set') {
            continue;
        }
        let node = patch;
        for (const key of op.path.slice(0, -1)) {
            node[key] ??= {};
            node = node[key];
        }
        node[op.path[op.path.length - 1]] = structuredClone(op.value);
    }
    return patch;
}

/**
 * ConfigFormController 测试桩（宿主 configForms 契约子集，T-030）：
 * 值源 = 宿主 gateway（真实解析/合并语义的服务端替身），写经 mutate(ops)
 * 走同一 gateway set——快照同步由 publish() 显式驱动（模拟宿主
 * volatile-update live 同步）。catalog 用例注入目录 RPC handler。
 */
async function makeCard({ raw = structuredClone(RAW), persist, catalog, mutateBehavior } = {}) {
    const rawRef = { current: structuredClone(raw) };
    const gateway = await gatewayHandlers(rawRef, persist);
    // gateway handler 返回裸值（{config, warnings}），非 RPC 信封
    const initial = await gateway['advisor-flow/get']({ args: {} });
    let snapshot = { status: 'ready', value: structuredClone(initial.config), writable: true };
    const listeners = new Set();
    const mutations = [];
    const form = {
        mutations,
        ensured: 0,
        getSnapshot() {
            return snapshot;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        ensure() {
            form.ensured += 1;
        },
        async mutate(ops) {
            mutations.push(structuredClone(ops));
            if (mutateBehavior === false) {
                return false; // 宿主拒绝（revision 栅栏/服务态）
            }
            if (mutateBehavior instanceof Error) {
                throw mutateBehavior;
            }
            if (typeof mutateBehavior === 'function') {
                return mutateBehavior(gateway, ops);
            }
            const patch = nestOps(ops);
            const result = await gateway['advisor-flow/set']({ args: { patch } });
            if (result.ok && result.config !== undefined) {
                snapshot = { ...snapshot, value: structuredClone(result.config) };
            }
            for (const listener of [...listeners]) {
                listener();
            }
            return true;
        },
        /** 测试辅助：外部值变化 → 通知派生（宿主 live 同步的替身）。 */
        publish(nextStatus, nextValue, nextProps) {
            if (nextStatus !== undefined || nextProps !== undefined) {
                snapshot = {
                    ...snapshot,
                    ...(nextStatus !== undefined ? { status: nextStatus } : {}),
                    ...(nextStatus === 'ready' ? { value: nextValue ?? snapshot.value } : { value: null }),
                    ...nextProps,
                };
            }
            for (const listener of [...listeners]) {
                listener();
            }
        },
    };
    const catalogHandlers = catalog
        ? {
            'llm/listProviders': async () => catalog.providers,
            'session/modelCatalog': async () => catalog.catalog,
            // modelInfo（T-034）：宿主声明值桩——catalog.modelInfo 为 async
            // (payload) => 信封；缺省无处理器 → rpc 抛错 → 通道降级路径。
            ...(catalog.modelInfo ? { 'advisor-flow/modelInfo': catalog.modelInfo } : {}),
        }
        : {};
    const rpc = makeRpc({ handlers: catalogHandlers });
    const controller = createSettingsCardController({
        form,
        rpc,
        logger: { warn() {}, error() {} },
    });
    return { controller, rpc, rawRef, form, gateway };
}

/** 微型 DOM 桩：createElement/appendChild/事件监听，足够驱动 render.js。 */
function createDomStub() {
    const dom = {
        activeElement: null,
        createElement(tag) {
            const node = {
                tag,
                children: [],
                attrs: {},
                listeners: {},
                textContent: '',
                setAttribute(key, value) {
                    node.attrs[key] = String(value);
                },
                getAttribute(key) {
                    return key in node.attrs ? node.attrs[key] : null;
                },
                removeAttribute(key) {
                    delete node.attrs[key];
                },
                addEventListener(type, fn) {
                    (node.listeners[type] ??= []).push(fn);
                },
                appendChild(child) {
                    node.children.push(child);
                    return child;
                },
                removeChild(child) {
                    const index = node.children.indexOf(child);
                    if (index >= 0) {
                        node.children.splice(index, 1);
                    }
                },
                get firstChild() {
                    return node.children[0] ?? null;
                },
                replaceChildren(...replacements) {
                    node.children = replacements.filter((child) => child !== undefined && child !== null);
                },
                focus() {
                    node.__focused = true;
                },
                querySelector(selector) {
                    if (typeof selector !== 'string' || !selector.startsWith('#')) return null;
                    const id = selector.slice(1);
                    const find = (n) => {
                        if (n.attrs?.id === id) return n;
                        for (const child of n.children ?? []) {
                            const hit = find(child);
                            if (hit) return hit;
                        }
                        return null;
                    };
                    return find(node);
                },
            };
            return node;
        },
    };
    return dom;
}

function findAll(node, predicate, out = []) {
    if (predicate(node)) {
        out.push(node);
    }
    for (const child of node.children ?? []) {
        findAll(child, predicate, out);
    }
    return out;
}
const byTag = (node, tag) => findAll(node, (candidate) => candidate.tag === tag);
const findById = (node, id) => findAll(node, (candidate) => candidate.attrs.id === id)[0];

async function renderedCard(options = {}) {
    const { controller, rpc, rawRef, form } = await makeCard(options);
    const dom = createDomStub();
    const container = dom.createElement('div');
    const card = renderSettingsCard({ document: dom, container, controller });
    await controller.load(); // load 触发 emit → refresh 重渲染
    await pump(); // 目录后台拉取（load 不再 await catalog）——等微任务链收敛
    card.refresh();
    return { controller, container, card, dom, rpc, rawRef, form };
}

test('切换开关不引起滚动重锚：原子替换整棵新树并还原焦点（东家目验）', async () => {
    const { container, dom } = await renderedCard();
    // 模拟浏览器焦点在 Plan 门开关上（点击获焦即此状态）
    const planSwitch = findById(container, 'advisor-gate-plan-enabled');
    dom.activeElement = { id: 'advisor-gate-plan-enabled' };
    // 点击 → setField → emit → refresh（重建）
    planSwitch.listeners.click[0]();
    // 重建后焦点还原到同名新开关（旧节点已被原子替换）
    const rebuilt = findById(container, 'advisor-gate-plan-enabled');
    assert.notEqual(rebuilt, planSwitch, '开关确实被替换为新节点');
    assert.equal(rebuilt.__focused, true, '重建后焦点还原，浏览器无需重锚滚动');
});

test('R-02-001/AC-01 卡值全走宿主 configForms、自有 RPC 仅目录与模型声明值查询（平铺常开，C-030）', async () => {
    const { container, rpc } = await renderedCard();
    // 卡值读=快照订阅（不走 RPC）；自有通道只剩模型目录两查询 + 模型声明
    // 值查询（T-034 modelInfo——占位数值数据源；目录失败回退为手动输入，
    // 见目录用例）。负向契约：advisor-flow/get|set 不得出现在 RPC 面上
    // （回归者重新接回自有 gateway 读写即此例红）。
    assert.ok(rpc.calls.length >= 1);
    assert.ok(rpc.calls.every((call) => /^(llm\/listProviders|session\/modelCatalog|advisor-flow\/modelInfo)$/.test(call.method)));
    assert.ok(rpc.calls.every((call) => !/^advisor-flow\/(get|set)$/.test(call.method)), '卡值不走自有 gateway 读写（modelInfo 仅查模型声明，T-034）');
    // 平铺常开（C-030：0.2.0 每插件独享配置页，折叠交互退役）：header 为
    // 静态标题行（非 button、无 chevron），字段直接渲染。
    const html = JSON.stringify(container);
    assert.ok(html.includes('Advisor Flow'));
    assert.ok(html.includes('每次关键动作前由独立顾问模型评审并注入建议'));
    const header = findAll(container, (node) => (node.attrs.class ?? '').includes('advisorflow_header'))[0];
    assert.ok(header, '静态标题行存在');
    assert.notEqual(header.tag, 'button');
    assert.equal(byTag(container, 'svg').length, 0, 'chevron SVG 已随折叠交互退役');
    // 文案统一为中文规范名（T-007）：无 camelCase/中英混排标题
    assert.ok(html.includes('顾问提供方'));
    assert.ok(html.includes('顾问模型'));
    assert.ok(html.includes('推理档位'));
    assert.ok(!html.includes('reasoningEffort'), 'camelCase 连写词不再出现在卡片文案');
    assert.ok(!html.includes('Advisor provider'));
    assert.ok(!html.includes('启用 Advisor Flow'), '用户级启用开关已退役（宿主 bundle 开关承担装载启停）');
    assert.ok(!html.includes('关闭后 ask_advisor 工具与四类门控一并停用'));
    assert.ok(html.includes('密钥脱敏'));
    assert.ok(html.includes('开启后，密钥形状的值在发送给顾问前替换为占位符')); // 脱敏说明
    assert.ok(html.includes('启用计划守则')); // 守则名在开关 toggleRow 文字（legend 已删）
    assert.ok(html.includes('启用失败守则'));
    assert.ok(html.includes('启用完成守则'));
    assert.ok(html.includes('启用循环门'));
    assert.ok(html.includes('制定有实质影响的计划前先调用 ask_advisor 并附上草稿')); // 计划守则说明
    assert.ok(html.includes('等价尝试连续失败或无可测进展时先咨询')); // 失败守则说明
    assert.ok(html.includes('宣告完成前先调用 ask_advisor')); // 完成守则说明
    // 循环门句式与实现语义一致（计数含当前调用，达到阈值的那次调用本身受审）
    assert.ok(html.includes('等价工具调用重复达到阈值的那次调用，执行前先经顾问评审'));
    // 阻断模式下拉选项「中文（原值）」双写
    assert.ok(html.includes('警告并放行（warn-and-continue）'));
    assert.ok(html.includes('拦截本次调用（block-tool）'));
    assert.ok(html.includes('封锁会话（block-session）'));
    // 阈值/阻断模式/仓库上下文 hint 抽样补钉（T-007 评审）
    assert.ok(html.includes('等价工具调用重复达到该次数的那次调用即受审'));
    assert.ok(html.includes('循环门 blocked 决策与咨询失败的统一处置档位'));
    assert.ok(html.includes('patch 含当前变更补丁（受字节上限）'));
    assert.ok(!html.includes('评审门')); // legend 冗余已删（T-006 目验 ①）
    assert.ok(html.includes('不发送（off）')); // 隐私档位选项双写
    assert.ok(html.includes('随咨询发送的会话历史范围')); // 档位说明
    assert.ok(html.includes('placeholder":"默认 3"')); // 阈值空值=用默认（目验 ③）
    assert.ok(!html.includes('advisor 未启用'), '已配置卡片不显示派生禁用横幅');
    // footer 右对齐按钮组
    assert.ok(html.includes('advisor-flow-save'));
    assert.ok(html.includes('advisor-flow-discard'));
});

test('R-02-001/AC-01 卡片编辑经 mutate 保存成功：ops 提交、值同步、表单回显新值', async () => {
    const { controller, container, rawRef, form } = await renderedCard();
    controller.setField('advisor.model', 'm2');
    const save = byTag(container, 'button').find((node) => (node.attrs.class ?? '').includes('advisor-flow-save'));
    assert.equal(save.attrs.disabled, undefined); // 校验通过 → 可保存
    // 保存动作经 root 级按下-抬起委托（真实宿主上 blur 重绘换树仍可靠）
    const root = container.children[0];
    assert.ok(root, '卡片 root 存在');
    root.listeners.mousedown[0]({ target: save });
    await root.listeners.mouseup[0]({ target: save });
    await pump(); // 委托内 IIFE 异步落库
    assert.equal(form.mutations.length, 1); // 一批 mutate 提交全部字段
    assert.deepEqual(form.mutations[0], [
        { op: 'set', path: ['advisor', 'model'], value: 'm2' },
    ]);
    // 保存成功后 patch 清空、宿主快照吸收新值
    assert.equal(controller.getState().patch.advisor, undefined);
    assert.equal(controller.getState().effectiveConfig.advisor.model, 'm2');
    assert.equal(rawRef.current.advisor.model, 'm2'); // gateway 替身同步吸收
});

test('R-02-001/AC-03 路由不完整派生禁用：横幅提示可见，编辑/保存不再被拦截（T-031/C-030）', async () => {
    const { controller, container, rpc } = await renderedCard({
        raw: { advisor: { provider: 'p' } }, // 缺 advisor.model
    });
    const html = JSON.stringify(container);
    // AC-03：解析出的配置整体禁用且原因可查询——横幅承担「不出手的原因」
    assert.equal(controller.getState().enabled, false);
    assert.equal(controller.getState().disabledReason, 'missing-advisor-model');
    const banner = findAll(container, (node) => (node.attrs.class ?? '').includes('advisorflow_banner'))[0];
    assert.ok(banner, '派生禁用横幅存在');
    assert.ok(banner.textContent.includes('advisor 未启用'));
    assert.ok(banner.textContent.includes('缺少顾问提供方或模型'));
    // 单一表面（独立审核 finding 1 收敛）：未配置提示只由横幅承担，
    // 表单内不再叠加第二段近似告警。
    assert.equal(findAll(container, (node) => (node.attrs.class ?? '').includes('advisorflow_unconfigured')).length, 0,
        '未配置提示只由横幅承担');
    // 暂存补丁联动横幅（任务书测试计划承诺）：补齐 model 后横幅即时消失，
    // 无需先保存（横幅按 effectiveConfig = 快照 + 暂存补丁求值）。
    controller.setField('advisor.model', 'm1');
    assert.equal(controller.getState().enabled, true);
    assert.equal(controller.getState().disabledReason, undefined);
    const reHtml = JSON.stringify(container);
    assert.ok(!reHtml.includes('advisor 未启用'), '暂存补齐后横幅即时消失');
    // 平铺常开：字段照常渲染、编辑照常生效（禁用态提示不禁编辑）
    assert.ok(byTag(container, 'fieldset').length >= 5, '四门与隐私组照常渲染');
    controller.setField('privacy.redactSecrets', false);
    assert.equal(controller.getState().patch.privacy.redactSecrets, false);
    const save = byTag(container, 'button').find((node) => (node.attrs.class ?? '').includes('advisor-flow-save'));
    assert.equal(save.attrs.disabled, undefined, '路由不完整不再阻断保存（拦截已退役）');
    const before = rpc.calls.length;
    const result = await controller.save();
    assert.equal(result.ok, true); // 保存照常（AC-13：补齐即自动启用）
    assert.ok(rpc.calls.every((call) => /^(llm\/listProviders|session\/modelCatalog|advisor-flow\/modelInfo)$/.test(call.method)));
    assert.equal(rpc.calls.length >= before, true);
});

test('R-02-001/AC-13 路由齐备即派生启用：无横幅、无开关、配置可查询（T-031/C-030）', async () => {
    const { controller, container } = await renderedCard({
        raw: { advisor: { provider: 'p', model: 'm' } },
    });
    // 派生启用（AC-13）：provider/model 齐备 → enabled=true，无独立开关
    assert.equal(controller.getState().enabled, true);
    assert.equal(controller.getState().disabledReason, undefined);
    assert.equal(findAll(container, (node) => (node.attrs.class ?? '').includes('advisorflow_banner')).length, 0);
    assert.equal(findById(container, 'advisor-enabled'), undefined, '启用开关不复存在');
    // 遗留 enabled 键在 raw 中只是未知键（告警忽略），不影响派生
    const legacy = await renderedCard({ raw: { enabled: true, advisor: { provider: 'p', model: 'm' } } });
    assert.equal(legacy.controller.getState().enabled, true);
});

test('R-02-001/AC-01 宿主拒绝保存时错误可见且表单保留（patch 不丢）', async () => {
    // mutate false = 宿主未收（revision 栅栏/服务态）——草稿保留供重试
    const { controller, container } = await renderedCard({ mutateBehavior: false });
    controller.setField('advisor.model', 'm9');
    const result = await controller.save();
    assert.equal(result.ok, false);
    assert.match(result.error, /保存被宿主拒绝/);
    assert.equal(controller.getState().patch.advisor.model, 'm9'); // 表单保留待重试
    const errorNodes = findAll(container, (node) => (node.attrs.class ?? '').includes('advisor-flow-error'));
    assert.equal(errorNodes.length >= 1, true);
});

test('R-02-001/AC-01 discard 放弃修改：patch 清空且无宿主写入', async () => {
    const { controller, form } = await renderedCard();
    controller.setField('advisor.provider', 'other');
    controller.discard();
    assert.deepEqual(controller.getState().patch, {});
    const result = await controller.save();
    assert.equal(result.ok, true); // 空 patch 也能过（无变化）
    assert.equal(form.mutations.length, 0); // 无变化不发起 mutate
});

test('R-02-001/AC-01 编辑控件映射到正确配置路径；用户级 enabled 开关已退役（T-031/C-030）', async () => {
    const { controller, container } = await renderedCard();
    // 阻断模式下拉：id 定位（全局统一处置档位）
    const failureModeSelect = findById(container, 'advisor-failure-mode');
    assert.ok(failureModeSelect, '阻断模式下拉存在');
    failureModeSelect.listeners.change[0]({ target: { value: 'block-session' } });
    assert.equal(controller.getState().patch.failureMode, 'block-session');
    // 隐私档位下拉 id 定位
    const historySelect = findById(container, 'advisor-privacy-history');
    historySelect.listeners.change[0]({ target: { value: 'off' } });
    assert.equal(controller.getState().patch.privacy.history, 'off');
});

test('R-02-001/AC-04 未配置 raw 的阻断模式下拉选中默认档位（C-017: block-tool）', async () => {
    // gateway get 返回 RAW namespace：未配置时 config.failureMode 为 undefined，
    // 下拉回退绑定 DEFAULT_FAILURE_MODE——展示默认须与运行时默认一致（T-018）。
    const { container } = await renderedCard({ raw: {} });
    const select = findById(container, 'advisor-failure-mode');
    assert.ok(select, '阻断模式下拉存在');
    const selected = select.children.find((node) => node.attrs?.selected === 'selected');
    assert.equal(selected?.attrs?.value, 'block-tool');
});

test('R-02-001/AC-01 官方 Switch 本体可点：门子开关翻转入 patch（目验「点开关无反应」）', async () => {
    const { controller, container } = await renderedCard();
    // 门子开关点击映射到 gates.<kind>.enabled；密钥脱敏同 Switch 形态
    const planGateSwitch = findById(container, 'advisor-gate-plan-enabled');
    assert.equal(planGateSwitch.attrs.role, 'switch', '门子开关为官方 Switch 形态');
    assert.equal(planGateSwitch.attrs.disabled, undefined, '无主开关禁用传播（T-031）');
    planGateSwitch.listeners.click[0]();
    assert.equal(controller.getState().patch.gates.plan.enabled, false);
    assert.equal(findById(container, 'advisor-privacy-redact-secrets').attrs.role, 'switch', '密钥脱敏为官方 Switch 形态');
});

test('R-02-001 循环门阈值随门开关联动禁用；守则门块无策略/阈值控件（东家目验）', async () => {
    const { controller, container } = await renderedCard();
    // RAW: loop 门 enabled + threshold=5 → 关闭循环门
    findById(container, 'advisor-gate-loop-enabled').listeners.click[0]();
    assert.equal(controller.getState().patch.gates.loop.enabled, false);
    // 循环门阈值随门开关联动禁用（refresh 后重新定位）
    const loopThreshold = findById(container, 'advisor-gate-loop-threshold');
    assert.equal(loopThreshold.attrs.disabled, 'disabled', '循环门关闭后阈值禁用');
    // 重新开启循环门 → 阈值恢复可用
    findById(container, 'advisor-gate-loop-enabled').listeners.click[0]();
    const loopThreshold2 = findById(container, 'advisor-gate-loop-threshold');
    assert.equal(loopThreshold2.attrs.disabled, undefined, '循环门重新开启后阈值恢复可用');
    // 清空 → null = 回归默认阈值 3（R-02-001/AC-08 同款清空语义，兑现「留空用默认 3」文案）
    loopThreshold2.listeners.change[0]({ target: { value: '' } });
    assert.equal(controller.getState().patch.gates.loop.threshold, null);
    // 守则门块（plan/failure/completion）不含策略/阈值控件
    assert.equal(findById(container, 'advisor-gate-plan-policy'), undefined);
    assert.equal(findById(container, 'advisor-gate-failure-policy'), undefined);
    assert.equal(findById(container, 'advisor-gate-completion-policy'), undefined);
});

test('R-02-001/AC-08 顾问超时与输出上限数字输入：填写覆盖、清空回归缺省、保存语义一致', async () => {
    const { controller, container, card, rawRef, form } = await renderedCard();
    // RAW 未配置两键 → 输入框为空、占位文案呈现缺省语义
    const maxTokensInput = findById(container, 'advisor-max-tokens');
    const timeoutInput = findById(container, 'advisor-call-timeout-ms');
    assert.ok(maxTokensInput, '输出上限输入存在');
    assert.ok(timeoutInput, '咨询超时输入存在');
    assert.equal(maxTokensInput.attrs.value, undefined);
    assert.equal(maxTokensInput.attrs.placeholder, '跟随所选模型配置');
    assert.equal(timeoutInput.attrs.placeholder, '默认 600000（10 分钟）');
    // 填写 → patch 收正整数
    maxTokensInput.listeners.change[0]({ target: { value: '4096' } });
    timeoutInput.listeners.change[0]({ target: { value: '480000' } });
    const patch = controller.getState().patch;
    assert.equal(patch.advisor.maxTokens, 4096);
    assert.equal(patch.advisor.callTimeoutMs, 480000);
    // 清空 → null = 回归缺省（覆盖后的显式撤销路径）
    maxTokensInput.listeners.change[0]({ target: { value: '' } });
    assert.equal(controller.getState().patch.advisor.maxTokens, null);
    // 保存 → ops 批次（null = 显式缺省载体，与 settings.yaml 同语义）
    const result = await controller.save();
    assert.equal(result.ok, true);
    const ops = form.mutations[0];
    assert.equal(ops.find((op) => op.path[1] === 'callTimeoutMs').value, 480000);
    assert.equal(ops.find((op) => op.path[1] === 'maxTokens').value, null);
    assert.equal(rawRef.current.advisor.callTimeoutMs, 480000);
    assert.equal(rawRef.current.advisor.maxTokens, null);
    // live 同步已让宿主快照吸收新值：null 渲染为空输入（跟随语义），显式值回显数字
    card.refresh();
    assert.equal(findById(container, 'advisor-max-tokens').attrs.value, undefined);
    assert.equal(findById(container, 'advisor-call-timeout-ms').attrs.value, '480000');
});

test('R-02-001/AC-01 保存成功回执：宿主持久化形态（mutate 通道单一回执）', async () => {
    const { controller, container } = await renderedCard();
    controller.setField('advisor.model', 'm2');
    const result = await controller.save();
    assert.equal(result.ok, true);
    assert.equal(result.persisted, true);
    assert.match(result.notice, /已保存并持久化/);
    // 渲染可见
    const notices = findAll(container, (node) => (node.attrs.class ?? '').includes('advisor-flow-notice'));
    assert.equal(notices.length, 1);
    assert.ok(notices[0].textContent.includes('持久化'));
    // 新编辑使旧回执失效
    controller.setField('advisor.provider', 'p2');
    assert.equal(controller.getState().savedNotice, undefined);
});

test('R-02-001/AC-01 保存回执双形态：写缝可得时「已保存并持久化」', async () => {
    const writes = [];
    const { controller, container } = await renderedCard({
        persist: async (raw) => writes.push(raw),
    });
    controller.setField('advisor.model', 'm2');
    const result = await controller.save();
    assert.equal(result.ok, true);
    assert.equal(result.persisted, true);
    assert.match(result.notice, /已保存并持久化/);
    const notices = findAll(container, (node) => (node.attrs.class ?? '').includes('advisor-flow-notice'));
    assert.ok(notices[0].textContent.includes('持久化'));
    assert.equal(writes.length, 1);
});

test('R-02-001/AC-01 mutate 异常：保存失败显性化且草稿保留（宿主通道抛错不吞）', async () => {
    const { controller, container } = await renderedCard({ mutateBehavior: new Error('boom from host') });
    controller.setField('advisor.model', 'm9');
    const result = await controller.save();
    assert.equal(result.ok, false);
    assert.match(result.error, /保存失败.*boom from host/);
    assert.equal(controller.getState().patch.advisor.model, 'm9'); // 草稿保留供重试
    const errorNodes = findAll(container, (node) => (node.attrs.class ?? '').includes('advisor-flow-error'));
    assert.ok(errorNodes[0].textContent.includes('boom from host'));
});

test('R-02-001/AC-01 卡片提供 effort 选择器：渲染、选择进入 patch、save 往返保留', async () => {
    const writes = [];
    const { controller, container, rawRef, form } = await renderedCard({
        persist: async (raw) => writes.push(raw),
    });
    // 渲染含 effort 字段与回退提示（T-007：中文标题 + 说明 hint）
    const html = JSON.stringify(container);
    assert.ok(html.includes('推理档位'));
    assert.ok(html.includes('顾问模型的推理力度；留空跟随模型默认，模型不支持的档位自动回退默认'));
    assert.ok(html.includes('不指定（跟随模型默认）'));
    assert.ok(html.includes('低 (low)'));
    assert.ok(html.includes('最大 (max)'));
    assert.ok(html.includes('关闭 (off)'));

    // 选择档位 → 经 setField 进入 patch → save 往返保留（id 定位）
    const effortSelect = findById(container, 'advisor-reasoning-effort');
    assert.ok(effortSelect, 'effort 下拉存在');
    effortSelect.listeners.change[0]({ target: { value: 'high' } });
    assert.equal(controller.getState().patch.advisor.reasoningEffort, 'high');
    const result = await controller.save();
    assert.equal(result.ok, true);
    assert.equal(form.mutations[0].find((op) => op.path[1] === 'reasoningEffort').value, 'high');
    assert.equal(rawRef.current.advisor.reasoningEffort, 'high'); // 写回内容保留档位

    // 选回「不指定」→ null（可穿越 JSON 序列化的「未配置」载体，非法值校验不拒）
    effortSelect.listeners.change[0]({ target: { value: '' } });
    assert.equal(controller.getState().patch.advisor.reasoningEffort, null);
    assert.equal(controller.validate(), undefined);

    // JSON 往返钉住：undefined 键会被序列化丢弃致 merge 保留旧档位（卡片与
    // 持久真相分歧）；null 穿越往返后解析为缺省、写回内容不含旧档位。
    controller.setField('advisor.model', 'm2'); // 顺带验证同次保存
    const cleared = await controller.save();
    assert.equal(cleared.ok, true);
    const clearedOps = form.mutations[form.mutations.length - 1];
    const effortOp = clearedOps.find((op) => op.path[1] === 'reasoningEffort');
    assert.equal(effortOp?.value, null); // null 穿越序列化（undefined 会被丢弃）
    const writtenCleared = rawRef.current;
    assert.equal(writtenCleared.advisor.reasoningEffort, null); // 持久写内容不含 'high'
    const { resolveAdvisorFlowConfig } = await import('../../lib/config.js');
    const resolved = resolveAdvisorFlowConfig(writtenCleared);
    assert.equal(resolved.config.advisor.reasoningEffort, undefined); // null → 缺省=跟随模型默认
});

test('R-02-003/AC-02 宿主快照不可用 → 错误显性化；恢复 ready 后 live 恢复（describe 镜像契约）', async () => {
    const { controller, container, form } = await renderedCard();
    // 宿主 describe 镜像进入 unavailable（服务/网络瞬态）
    form.publish('unavailable');
    await pump();
    assert.equal(controller.getState().status, 'error');
    assert.match(controller.getState().error, /配置服务不可用/);
    const errorNodes = findAll(container, (node) => (node.attrs.class ?? '').includes('advisor-flow-error'));
    assert.ok(errorNodes[0].textContent.includes('配置服务不可用'));
    // error 态无表单（内容消失形态）但必须提供重试——无恢复手段则表单永久
    // 消失且无法恢复（东家目验缺陷）
    assert.equal(byTag(container, 'fieldset').length, 0);
    const retry = byTag(container, 'button').find((node) => node.textContent === '重试');
    assert.ok(retry, 'error 态渲染重试按钮');
    assert.ok((retry.attrs.class ?? '').includes('advisorflow_retry'), '重试按钮用独立角色类（样式与放弃按钮同款）');
    assert.ok(!(retry.attrs.class ?? '').includes('advisorflow_discard'), '重试按钮不占放弃角色命名空间——按下-抬起/键盘委托不把重试误判为放弃');
    const ensuredBefore = form.ensured;
    retry.listeners.click[0](); // controller.retry()——再拉一次宿主快照
    await pump();
    assert.ok(form.ensured > ensuredBefore, '重试按钮触发宿主 ensure 再拉取');
    // 宿主恢复 ready（describe 镜像自愈/重拉成功）→ live 恢复
    form.publish('ready', structuredClone(RAW));
    await pump();
    assert.equal(controller.getState().status, 'ready');
    assert.ok(findAll(container, (node) => (node.attrs.class ?? '').includes('advisorflow_form')).length > 0, '恢复后表单回归');
});

test('R-02-001/AC-01 宿主只读快照：保存钮禁用、提示文案、按下-抬起委托拒发 mutate', async () => {
    const { controller, container, form } = await renderedCard();
    controller.setField('advisor.model', 'm2'); // 先制造 dirty，排除空 patch 短路干扰
    form.publish('ready', undefined, { writable: false }); // 宿主把表单置只读
    await pump();
    const save = byTag(container, 'button').find((node) => (node.attrs.class ?? '').includes('advisorflow_save'));
    assert.equal(save.attrs.disabled, 'disabled', '只读快照 → 保存钮禁用');
    const html = JSON.stringify(container);
    assert.ok(html.includes('当前配置为只读'), '只读提示文案可见');
    // 委托执行门控与 disabled 语义一致：只读时保存动作被拒
    const root = container.children[0];
    root.listeners.mousedown[0]({ target: save });
    await root.listeners.mouseup[0]({ target: save });
    await pump();
    assert.equal(form.mutations.length, 0, '只读时保存动作不发起 mutate');
    assert.equal(controller.getState().dirty, true, '误点不丢草稿（patch 保留）');
});

const CATALOG_PROVIDERS = [
    { id: 'openai', name: 'OpenAI (CPA)' },
    { id: 'gpu', name: 'GPU 路由' },
];
const CATALOG = {
    routableProviders: ['openai', 'gpu'],
    groups: [
        // 真实宿主形态（T-034）：目录快照只透出 provider/id/name/inputModalities，
        // 不携带 maxTokens/limits——声明值只能经 modelInfo RPC（见默认面用例）。
        { id: 'openai', name: 'OpenAI (CPA)', models: [{ id: 'gpt-x', name: 'GPT X', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' } }] },
        { id: 'gpu', name: 'GPU 路由', models: [{ id: 'glm-5.3', name: 'GLM 5.3', reasoning: { efforts: [{ id: 'max', name: '最大' }], defaultEffort: 'max' } }] },
    ],
};

test('R-02-001 目录 RPC 挂起不得阻塞表单：ready 立即达成，表单照常渲染（目验「详情没了」根因）', async () => {
    // catalog 两端点永不 resolve——旧实现 await loadCatalogs 在 emit 前，
    // 挂起即卡片长期只剩 header；现在 ready 先行、表单立即可渲染。
    const { controller, container } = await renderedCard({
        raw: { advisor: { provider: 'p', model: 'm' } },
        catalog: {
            providers: new Promise(() => {}), // 永不 resolve（模拟挂起）
            catalog: new Promise(() => {}),
        },
    });
    assert.equal(controller.getState().status, 'ready');
    assert.equal(controller.getState().catalogReady, false); // 目录未达
    const html = JSON.stringify(container);
    assert.ok(html.includes('顾问提供方'), '表单在目录挂起时照常渲染');
});

test('R-02-001/AC-01 目录驱动三级联动：provider/model 下拉来自目录，effort 来自模型声明', async () => {
    const { controller, container } = await renderedCard({
        raw: { advisor: { provider: 'openai', model: 'gpt-x' } },
        catalog: { providers: CATALOG_PROVIDERS, catalog: CATALOG },
    });
    assert.equal(controller.getState().catalogReady, true);
    assert.equal(controller.getState().degradations?.catalog, undefined);
    const html = JSON.stringify(container);
    assert.ok(html.includes('OpenAI (CPA)'));
    assert.ok(html.includes('GPT X')); // model 下拉来自所选 provider 的 groups.models
    // effort 选项来自模型声明 reasoning.efforts + defaultEffort 提示
    assert.ok(html.includes('跟随模型默认（default: low）'));
    assert.ok(html.includes('低'));
    assert.ok(html.includes('高'));
    assert.ok(!html.includes('关闭 (off)')); // 硬编码档位不再出现
});

test('R-02-001/AC-01 三级联动级联：provider 变更后不属于新 provider 的 model/effort 清空重置', async () => {
    const { controller } = await renderedCard({
        raw: { advisor: { provider: 'openai', model: 'gpt-x', reasoningEffort: 'high' } },
        catalog: { providers: CATALOG_PROVIDERS, catalog: CATALOG },
    });
    controller.setField('advisor.provider', 'gpu');
    const patch = controller.getState().patch;
    assert.equal(patch.advisor.provider, 'gpu');
    assert.equal(patch.advisor.model, null); // gpt-x 不属于 gpu → 清空重置
    assert.equal(patch.advisor.reasoningEffort, null);
    // 新 provider 的 model 下拉选项
    const models = controller.modelsFor('gpu');
    assert.deepEqual(models.map((option) => option.value), ['glm-5.3']);
    // effort 选项来自新模型声明
    const efforts = controller.effortOptions('glm-5.3');
    assert.deepEqual(efforts.map((option) => option.value), ['', 'max']);
    assert.ok(efforts[0].label.includes('default: max'));
});

test('R-02-001 目录死路回退：provider 目录外或该 provider 无模型声明时，model 回退自由文本输入（东家生产报障回归）', async () => {
    // 生产形态 1：provider 为目录外值（如 gpu 不在目录）——providerOptions
    // 靠「当前值（目录外）」兜底仍可用，但 modelsFor 只剩占位项，若仍渲染
    // 下拉则用户无任何可选项、横幅永挂。
    const outside = await renderedCard({
        raw: { advisor: { provider: 'zzz' } },
        catalog: { providers: CATALOG_PROVIDERS, catalog: CATALOG },
    });
    assert.equal(outside.controller.getState().catalogReady, true);
    assert.equal(findById(outside.container, 'advisor-model').tag, 'input', '目录外 provider 时 model 是自由文本');
    assert.equal(findById(outside.container, 'advisor-model').attrs.type, 'text');
    assert.ok(findById(outside.container, 'advisor-model').attrs.value === undefined
        || findById(outside.container, 'advisor-model').attrs.value === '',
    '空 model 输入框');
    // 直接输入即可补齐路由并即时解除派生禁用（无需目录帮忙）
    outside.controller.setField('advisor.model', 'glm-5.3-flash');
    assert.equal(outside.controller.getState().enabled, true);
    assert.ok(!JSON.stringify(outside.container).includes('advisor 未启用'));

    // 生产形态 2：provider 在目录里但 models 声明为空——同样只剩占位项。
    const bareCatalog = {
        routableProviders: ['bare'],
        groups: [{ id: 'bare', name: 'Bare', models: [] }],
    };
    const bare = await renderedCard({
        raw: { advisor: { provider: 'bare' } },
        catalog: { providers: CATALOG_PROVIDERS, catalog: bareCatalog },
    });
    assert.equal(bare.controller.getState().catalogReady, true);
    assert.equal(findById(bare.container, 'advisor-model').tag, 'input', '无模型声明时 model 是自由文本');
});

test('R-02-001/AC-01 幽灵回显回归：model 未选时下拉必须显示占位项而非首个真实选项（东家生产报障回归）', async () => {
    // 无占位项时 <select> 空值匹配不到任何 option，浏览器把第一个真实
    // 选项渲染成已选中——用户看到「已配置」，实际存储为空、保存发不出
    // model 操作、横幅按真实状态常挂。修复：与 provider 一致补占位项。
    const { container, controller } = await renderedCard({
        raw: { advisor: { provider: 'gpu' } }, // 目录里 gpu 有 glm-5.3，但未选模型
        catalog: { providers: CATALOG_PROVIDERS, catalog: CATALOG },
    });
    const select = findById(container, 'advisor-model');
    assert.equal(select.tag, 'select', '目录里 gpu 有真实模型 → 渲染下拉');
    assert.deepEqual(
        select.children.map((option) => option.attrs.value),
        ['', 'glm-5.3'],
        '占位项 + 该 provider 的真实模型',
    );
    assert.equal(select.children[0].textContent, '— 选择模型 —', '占位文案与 provider 对齐');
    const selected = select.children.find((node) => node.attrs?.selected === 'selected');
    assert.equal(selected?.attrs?.value, '', '空值选中占位项——显示诚实，不幽灵回显真实模型');
    // 横幅按真实状态可见（未选模型 = 派生禁用），占位显示不谎报已配置
    assert.ok(JSON.stringify(container).includes('advisor 未启用'));
    // 用户真正选择后横幅即时消失（派生启用）
    controller.setField('advisor.model', 'glm-5.3');
    assert.equal(controller.getState().enabled, true);
    assert.ok(!JSON.stringify(container).includes('advisor 未启用'));
    const reselected = findById(container, 'advisor-model')
        .children.find((node) => node.attrs?.selected === 'selected');
    assert.equal(reselected?.attrs?.value, 'glm-5.3', '选择后回显真实选中项');
});

test('R-02-001/AC-04 默认面（T-032/T-034）：mode 缺省显示 soft、四门默认开启、maxTokens 占位显示宿主声明值', async () => {
    // 宿主 modelInfo 声明 defaultMaxTokens → 占位追加实际数字（生产 gpu
    // glm-5.3-flash-512k = 131072 同型；目录快照不携带 limits，T-034）
    const modelInfoCalls = [];
    const declared = await renderedCard({
        raw: { advisor: { provider: 'gpu', model: 'glm-5.3' } },
        catalog: {
            providers: CATALOG_PROVIDERS,
            catalog: CATALOG,
            modelInfo: async (payload) => {
                modelInfoCalls.push(payload);
                return { ok: true, value: { defaultMaxTokens: 131072 } };
            },
        },
    });
    assert.equal(
        findById(declared.container, 'advisor-max-tokens').attrs.placeholder,
        '跟随所选模型配置（当前 131072）',
        '占位含宿主声明值',
    );
    assert.deepEqual(modelInfoCalls, [{ args: { provider: 'gpu', model: 'glm-5.3' } }], '声明值按当前路由对查询');
    // 未声明 defaultMaxTokens（键省略）→ 回退原文，不猜测
    const undeclared = await renderedCard({
        raw: { advisor: { provider: 'openai', model: 'gpt-x' } },
        catalog: { providers: CATALOG_PROVIDERS, catalog: CATALOG, modelInfo: async () => ({ ok: true, value: {} }) },
    });
    assert.equal(
        findById(undeclared.container, 'advisor-max-tokens').attrs.placeholder,
        '跟随所选模型配置',
        '无声明回退原文',
    );
    // 通道失败（ok:false 信封）同走回退——信息增强缝失败不干扰配置值流
    const failedChannel = await renderedCard({
        raw: { advisor: { provider: 'gpu', model: 'glm-5.3' } },
        catalog: {
            providers: CATALOG_PROVIDERS,
            catalog: CATALOG,
            modelInfo: async () => ({ ok: false, value: undefined, error: { code: 'resolve-failed', message: 'boom' } }),
        },
    });
    assert.equal(failedChannel.controller.getState().limitsDegraded, true, '信封失败 → 一次性降级');
    assert.equal(
        findById(failedChannel.container, 'advisor-max-tokens').attrs.placeholder,
        '跟随所选模型配置',
        '通道失败回退原文',
    );
    // mode 缺省显示 soft（C-032）：raw 无 mode，控件选中解析缺省
    const modeSelect = findById(undeclared.container, 'advisor-mode');
    const modeSelected = modeSelect.children.find((node) => node.attrs?.selected === 'selected');
    assert.equal(modeSelected?.attrs?.value, 'soft', '介入强度控件缺省选中 soft');
    // 四门默认开启（AC-04 既有承诺）：raw 无 gates，开关默认 aria-checked=true
    for (const kind of ['plan', 'failure', 'loop', 'completion']) {
        assert.equal(
            findById(undeclared.container, `advisor-gate-${kind}-enabled`).attrs['aria-checked'],
            'true',
            `${kind} 门默认开启`,
        );
    }
});

test('T-034 modelInfo 通道降级：rpc 抛错一次性显性化，路由变化不再重试', async () => {
    const { controller, container, rpc } = await renderedCard({
        raw: { advisor: { provider: 'gpu', model: 'glm-5.3' } },
        catalog: { providers: CATALOG_PROVIDERS, catalog: CATALOG }, // 无 modelInfo 处理器 → rpc 抛错
    });
    assert.equal(controller.getState().limitsDegraded, true, '通道抛错 → 一次性降级');
    assert.equal(findById(container, 'advisor-max-tokens').attrs.placeholder, '跟随所选模型配置', '占位回退原文');
    const before = rpc.calls.filter((call) => call.method === 'advisor-flow/modelInfo').length;
    assert.equal(before, 1, '首个路由对仅发一次');
    controller.setField('advisor.model', 'gpt-x'); // 路由变化也不重试（已降级）
    assert.equal(rpc.calls.filter((call) => call.method === 'advisor-flow/modelInfo').length, before, '降级后不再重发');
});

test('R-02-001/AC-01 null effort 保留：选「跟随模型默认」写 null 且往返不丢', async () => {
    const writes = [];
    const { controller } = await renderedCard({
        raw: { advisor: { provider: 'gpu', model: 'glm-5.3', reasoningEffort: 'max' } },
        catalog: { providers: CATALOG_PROVIDERS, catalog: CATALOG },
        persist: async (raw) => writes.push(raw),
    });
    controller.setField('advisor.reasoningEffort', null);
    const result = await controller.save();
    assert.equal(result.ok, true);
    const written = writes[writes.length - 1];
    assert.equal(written.advisor.reasoningEffort, null); // null 穿越序列化（跟随默认语义）
});

test('R-02-001/AC-01 目录拉取失败回退：provider/model 自由文本、effort 硬编码档位、降级一次性显性', async () => {
    const warns = [];
    const { controller, container } = await renderedCard({}); // 无目录桩 → 拉取失败
    const state = controller.getState();
    assert.equal(state.catalogReady, false);
    assert.equal(state.catalogDegraded, true);
    assert.equal(state.degradations.catalog, 'catalog-fetch-failed');
    // 回退形态：provider/model 仍为自由文本输入
    const textInputs = findAll(container, (node) => node.tag === 'input' && node.attrs.type === 'text');
    assert.ok(textInputs.length >= 2, 'provider/model 回退为自由文本输入');
    assert.ok(JSON.stringify(container).includes('顾问提供方'));
    // effort 回退硬编码档位
    assert.ok(JSON.stringify(container).includes('关闭 (off)'));
    // 一次性显性化：连续 load 不重复 warn
    await controller.load();
    const warnCount = (state.degradations.catalog === 'catalog-fetch-failed') ? 1 : 0;
    assert.equal(warnCount, 1);
    void warns;
});

test('R-02-001 setField/emit 重绘后字段存续：改字段不塌卡片（原 T-006 展开存续回归改为平铺存续）', async () => {
    const { controller, container } = await renderedCard();
    assert.ok(findById(container, 'advisor-gate-plan-enabled'));
    // 改字段 → emit → 重绘：卡片常开，字段仍在位
    controller.setField('advisor.model', 'm2');
    assert.ok(findById(container, 'advisor-gate-plan-enabled'), '重绘后字段仍在位');
    assert.ok(findById(container, 'advisor-turn-review-exempt-patterns'), '豁免关键词输入仍在位');
    assert.ok(findById(container, 'advisor-failure-mode'), '阻断模式下拉仍在位');
});

test('R-02-001 T-023 收口评审豁免关键词输入：默认清单回显、逗号分隔解析进 patch、空输入 = 豁免关闭', async () => {
    const { controller, container } = await renderedCard();
    // gateway get 返回 resolved 配置：未配置 raw 时回显缺省双语预置（C-023）
    const input = findById(container, 'advisor-turn-review-exempt-patterns');
    assert.ok(input, '豁免关键词输入存在');
    assert.equal(input.attrs.value, 'review, 审核, 审查, 评审, 复审, 审计');
    // 逗号/中文逗号/换行分隔 → 非空字符串数组进 patch
    input.listeners.change[0]({ target: { value: 'review, 审计' } });
    assert.deepEqual(controller.getState().patch.turnReviewExemptPatterns, ['review', '审计']);
    const reinput = findById(container, 'advisor-turn-review-exempt-patterns');
    reinput.listeners.change[0]({ target: { value: '审计，\nreview' } });
    assert.deepEqual(controller.getState().patch.turnReviewExemptPatterns, ['审计', 'review']);
    // 清空 → 空数组 = 豁免关闭（合法，可保存）
    const clear = findById(container, 'advisor-turn-review-exempt-patterns');
    clear.listeners.change[0]({ target: { value: ', ， \n ' } });
    assert.deepEqual(controller.getState().patch.turnReviewExemptPatterns, []);
    // 派生禁用（C-030）不禁编辑：未配置 raw 的横幅在位，输入仍可编辑
    const bare = await renderedCard({ raw: {} });
    const bareInput = findById(bare.container, 'advisor-turn-review-exempt-patterns');
    assert.equal(bareInput.attrs.disabled, undefined);
    assert.ok(findAll(bare.container, (node) => (node.attrs.class ?? '').includes('advisorflow_banner')).length >= 1);
});

// ─── T-024 保存控件常驻与未保存显性化（R-02-001/AC-09/10/12；C-024） ───

/** 支持 head + querySelector 的独立桩：驱动 injectStyles 真实注入（共享桩跳过样式层）。 */
function createStyleCapableDom() {
    const dom = createDomStub();
    dom.head = dom.createElement('head');
    const rawCreate = dom.createElement.bind(dom);
    dom.createElement = (tag) => {
        const node = rawCreate(tag);
        node.dataset = {}; // injectStyles 写 dataset.plugin / dataset.pluginCss
        return node;
    };
    dom.querySelector = (selector) => {
        const match = selector.match(/^style\[data-plugin-css="(.+)"\]$/);
        if (!match) {
            return null;
        }
        return findAll(dom.head, (node) => node.attrs['data-plugin-css'] === match[1])[0] ?? null;
    };
    return dom;
}

test('R-02-001/AC-09 footer sticky 常驻：样式声明固定于滚动视口底部，按钮组为 body 末尾', async () => {
    const { controller } = await makeCard();
    const dom = createStyleCapableDom(); // 共享桩无 head，injectStyles 被跳过——样式断言须独立桩
    const container = dom.createElement('div');
    renderSettingsCard({ document: dom, container, controller });
    const styleTag = findAll(dom.head, (node) => node.tag === 'style')[0];
    assert.ok(styleTag, '样式表已注入');
    assert.match(styleTag.textContent, /\.advisorflow_footer\{[^}]*position:sticky/);
    assert.match(styleTag.textContent, /\.advisorflow_footer\{[^}]*bottom:0/);
    assert.match(styleTag.textContent, /\.advisorflow_footer\{[^}]*background:var\(--dsw-alias-bg-layer-2\)/);
    // 结构层：footer 为 body 末尾元素，含保存与放弃修改按钮组（须先 load）
    await controller.load();
    await pump();
    const body = findAll(container, (node) => (node.attrs.class ?? '').includes('advisorflow_body'))[0];
    const footer = body.children[body.children.length - 1];
    assert.ok((footer.attrs.class ?? '').includes('advisorflow_footer'), 'footer 为 body 末尾按钮组');
    assert.ok(byTag(footer, 'button').some((node) => (node.attrs.class ?? '').includes('advisor-flow-save')));
    assert.ok(byTag(footer, 'button').some((node) => (node.attrs.class ?? '').includes('advisor-flow-discard')));
});

test('R-02-001/AC-10 未保存徽标：编辑出现在静态标题行，放弃后消失（T-031：徽标常显无折叠态）', async () => {
    const { controller, container } = await renderedCard();
    const badges = () => findAll(container, (node) => (node.attrs.class ?? '').includes('advisorflow_dirtyBadge'));
    assert.equal(controller.getState().dirty, false);
    assert.equal(badges().length, 0, '初始无未保存徽标');
    controller.setField('advisor.model', 'm2');
    assert.equal(controller.getState().dirty, true);
    assert.equal(badges().length, 1, '编辑后头部出现未保存徽标');
    assert.equal(badges()[0].textContent, '未保存');
    controller.discard();
    assert.equal(controller.getState().dirty, false);
    assert.equal(badges().length, 0, '放弃修改后徽标消失');
});

test('R-02-001/AC-12 未保存徽标：保存成功后消失', async () => {
    const { controller, container } = await renderedCard();
    const badges = () => findAll(container, (node) => (node.attrs.class ?? '').includes('advisorflow_dirtyBadge'));
    controller.setField('advisor.model', 'm2');
    assert.equal(badges().length, 1);
    const save = byTag(container, 'button').find((node) => (node.attrs.class ?? '').includes('advisor-flow-save'));
    const root2 = container.children[0];
    root2.listeners.mousedown[0]({ target: save });
    await root2.listeners.mouseup[0]({ target: save });
    await pump();
    assert.equal(controller.getState().dirty, false);
    assert.equal(badges().length, 0, '保存成功后徽标消失');
});

test('R-02-001/AC-12 按下-抬起之间重绘换树时保存仍生效（root 级委托兜底）', async () => {
    const { controller, container, form } = await renderedCard();
    const root = container.children[0];
    assert.ok(root, '卡片 root 存在');
    // 编辑 loop 阈值（change → setField → emit → 重绘，等同 blur 链）
    const loopInput = findById(container, 'advisor-gate-loop-threshold');
    assert.ok(loopInput, 'loop 阈值输入存在');
    loopInput.listeners.change[0]({ target: { value: '7' } });
    assert.equal(controller.getState().patch.gates.loop.threshold, 7, '编辑已入 patch');
    // 按下（旧按钮）→ 换树 → 抬起落在重建后的同位新按钮：仍须保存
    const oldSave = byTag(root, 'button').find((node) => (node.attrs.class ?? '').includes('advisorflow_save'));
    assert.ok(oldSave, '保存按钮存在');
    root.listeners.mousedown[0]({ target: oldSave });
    // 按住期间再次 change：真实浏览器中 blur 重绘正好落在按下-抬起之间
    loopInput.listeners.change[0]({ target: { value: '8' } });
    const newSave = byTag(root, 'button').find((node) => (node.attrs.class ?? '').includes('advisorflow_save'));
    assert.ok(newSave, '重绘后保存按钮存在');
    assert.notEqual(newSave, oldSave, '换树后按钮为重建节点（复现换树序列）');
    root.listeners.mouseup[0]({ target: newSave });
    await pump();
    assert.equal(form.mutations.length, 1, '委托路径提交了保存');
    const op = form.mutations[0].find((item) => item.path.join('.') === 'gates.loop.threshold');
    assert.ok(op, '暂存的阈值编辑随保存提交');
    assert.equal(op.value, 8, '换树期间暂存的编辑随保存提交');
    assert.equal(controller.getState().dirty, false, '保存后 dirty 清除');
    const badges = () => findAll(container, (node) => (node.attrs.class ?? '').includes('advisorflow_dirtyBadge'));
    assert.equal(badges().length, 0, '保存完成后未保存徽标消失（AC-12）');
});

test('R-02-001/AC-12 键盘激活保存（合成 click detail=0）与鼠标 click 不重入', async () => {
    const { controller, container, form } = await renderedCard();
    const root = container.children[0];
    controller.setField('advisor.model', 'm2');
    assert.equal(controller.getState().dirty, true);
    const save = byTag(root, 'button').find((node) => (node.attrs.class ?? '').includes('advisorflow_save'));
    // 键盘激活：Enter/Space 派发 detail=0 的合成 click，无按下-抬起序列
    await root.listeners.click[0]({ target: save, detail: 0 });
    await pump();
    assert.equal(form.mutations.length, 1, '键盘路径提交了保存');
    const kbOp = form.mutations[0].find((op) => op.path.join('.') === 'advisor.model');
    assert.equal(kbOp.value, 'm2');
    assert.equal(controller.getState().dirty, false, '键盘保存后 dirty 清除');
    const kbBadges = () => findAll(container, (node) => (node.attrs.class ?? '').includes('advisorflow_dirtyBadge'));
    assert.equal(kbBadges().length, 0, '键盘保存完成后未保存徽标消失（AC-12）');
    // 鼠标 click（detail≥1）不在此重入：按下-抬起委托已处理，二次执行必须被拒
    const before = form.mutations.length;
    await root.listeners.click[0]({ target: save, detail: 1 });
    await pump();
    assert.equal(form.mutations.length, before, '鼠标 click 不经键盘路径重入');
});

test('R-02-001/AC-01 控制器 dispose 后订阅终止：publish 与宿主旧引用 load 均不复活已弃控制器', async () => {
    const { card, controller, form } = await renderedCard();
    const before = controller.getState().config;
    controller.dispose();
    form.publish('ready', structuredClone(RAW), { writable: true }); // 外部快照变更
    assert.deepEqual(controller.getState().config, before, 'dispose 后外部快照不再渗入状态');
    card.refresh(); // 宿主持旧引用 refresh→load（renderSettingsCard 返回 {refresh}）
    assert.deepEqual(controller.getState().config, before, 'dispose 后 load 不复活订阅');
    assert.equal(controller.getState().dirty, false);
});
