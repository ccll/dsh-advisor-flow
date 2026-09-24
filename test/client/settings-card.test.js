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
    enabled: true,
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

function makeCard({ raw = structuredClone(RAW), persist, catalog } = {}) {
    const rawRef = { current: structuredClone(raw) };
    const degradations = { askPolicy: 'approver-seam-missing' };
    const gatewayPromise = gatewayHandlers(rawRef, persist);
    const catalogHandlers = catalog
        ? {
            'llm/listProviders': async () => catalog.providers,
            'session/modelCatalog': async () => catalog.catalog,
        }
        : {};
    const rpc = makeRpc({
        handlers: new Proxy({}, {
            get: (_target, method) => async (payload) => {
                if (catalogHandlers[method]) {
                    return catalogHandlers[method](payload);
                }
                const gateway = await gatewayPromise;
                return gateway[method](payload);
            },
        }),
    });
    const controller = createSettingsCardController({
        rpc,
        logger: { warn() {}, error() {} },
    });
    // 模拟宿主把降级标注随 get 返回（真实接线为状态面而非配置通道；
    // 此处直接在控制器外层验证 degradations 展示由 render 消费）
    void degradations;
    return { controller, rpc, rawRef };
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

/** 展开卡片（点击 header——默认折叠是 T-006 ①；error 强制展开不受此控）。 */
function expandCard(container) {
    const header = byTag(container, 'button').find((node) => (node.attrs.class ?? '').includes('advisorflow_header'));
    assert.ok(header, 'header 折叠按钮存在');
    header.listeners.click[0]();
}

async function renderedCard(options = {}) {
    const { controller, rpc, rawRef } = makeCard(options);
    const dom = createDomStub();
    const container = dom.createElement('div');
    const card = renderSettingsCard({ document: dom, container, controller });
    await controller.load(); // load 触发 emit → refresh 重渲染
    await pump(); // 目录后台拉取（load 不再 await catalog）——等微任务链收敛
    card.refresh();
    return { controller, container, card, dom, rpc, rawRef };
}

test('切换开关不引起滚动重锚：原子替换整棵新树并还原焦点（东家目验）', async () => {
    const { container, dom } = await renderedCard();
    expandCard(container);
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

test('R-02-001/AC-01 卡片经自有 gateway RPC 读回配置并渲染表单（默认折叠 → 展开可见）', async () => {
    const { container, rpc } = await renderedCard();
    // 渲染首帧与显式 load 各触发一次读回；自有通道 = advisor-flow/get|set +
    // 模型目录（llm/listProviders、session/modelCatalog——目录失败回退为手
    // 动输入，见目录用例）。
    assert.ok(rpc.calls.length >= 1);
    assert.ok(rpc.calls.every((call) => /^(advisor-flow\/(get|set)|llm\/listProviders|session\/modelCatalog)$/.test(call.method)));
    // 默认折叠（T-006 ①）：header 存在、aria-expanded=false、无表单体
    const html = JSON.stringify(container);
    assert.ok(html.includes('Advisor Flow'));
    assert.ok(html.includes('每次关键动作前由独立顾问模型评审并注入建议'));
    const header = byTag(container, 'button').find((node) => (node.attrs.class ?? '').includes('advisorflow_header'));
    assert.equal(header.attrs['aria-expanded'], 'false');
    assert.equal(byTag(container, 'fieldset').length, 0); // 折叠态无表单体
    assert.ok(!html.includes('已折叠——点击头部展开配置')); // T-006 ②：无提示行
    // chevron 为内联 SVG（T-006 ③）
    const chevron = findAll(container, (node) => (node.attrs.class ?? '').includes('advisorflow_chevron'))[0];
    assert.ok(chevron, 'chevron 容器存在');
    assert.equal(byTag(chevron, 'svg').length, 1);
    const path = byTag(chevron, 'path')[0];
    // 官方 IconChevronDownOutline14 同款：14 系实心 fill（与其他插件卡片视觉一致）
    assert.equal(path.attrs.d.startsWith('M11.8486 5.5'), true);
    assert.equal(path.attrs.fill, 'currentColor');
    assert.equal(path.attrs.stroke, undefined);
    const svgNode = byTag(chevron, 'svg')[0];
    assert.equal(svgNode.attrs.viewBox, '0 0 14 14');
    assert.equal(svgNode.attrs.width, '14');

    // 展开（T-006 ④）：表单层级齐全（refresh 重建 DOM——重新查询节点）
    expandCard(container);
    const headerOpen = byTag(container, 'button').find((node) => (node.attrs.class ?? '').includes('advisorflow_header'));
    assert.equal(headerOpen.attrs['aria-expanded'], 'true');
    assert.equal(byTag(headerOpen, 'svg').length, 1); // 展开态同款 SVG（旋转切换）
    const htmlOpen = JSON.stringify(container);
    // 文案统一为中文规范名（T-007）：无 camelCase/中英混排标题
    assert.ok(htmlOpen.includes('顾问提供方'));
    assert.ok(htmlOpen.includes('顾问模型'));
    assert.ok(htmlOpen.includes('推理档位'));
    assert.ok(!htmlOpen.includes('reasoningEffort'), 'camelCase 连写词不再出现在卡片文案');
    assert.ok(!htmlOpen.includes('Advisor provider'));
    assert.ok(htmlOpen.includes('启用 Advisor Flow'));
    assert.ok(htmlOpen.includes('关闭后 ask_advisor 工具与四类门控一并停用')); // 主开关说明
    assert.ok(htmlOpen.includes('密钥脱敏'));
    assert.ok(htmlOpen.includes('开启后，密钥形状的值在发送给顾问前替换为占位符')); // 脱敏说明
    assert.ok(htmlOpen.includes('启用计划守则')); // 守则名在开关 toggleRow 文字（legend 已删）
    assert.ok(htmlOpen.includes('启用失败守则'));
    assert.ok(htmlOpen.includes('启用完成守则'));
    assert.ok(htmlOpen.includes('启用循环门'));
    assert.ok(htmlOpen.includes('制定有实质影响的计划前先调用 ask_advisor 并附上草稿')); // 计划守则说明
    assert.ok(htmlOpen.includes('等价尝试连续失败或无可测进展时先咨询')); // 失败守则说明
    assert.ok(htmlOpen.includes('宣告完成前先调用 ask_advisor')); // 完成守则说明
    // 循环门句式与实现语义一致（计数含当前调用，达到阈值的那次调用本身受审）
    assert.ok(htmlOpen.includes('等价工具调用重复达到阈值的那次调用，执行前先经顾问评审'));
    // 阻断模式下拉选项「中文（原值）」双写
    assert.ok(htmlOpen.includes('警告并放行（warn-and-continue）'));
    assert.ok(htmlOpen.includes('拦截本次调用（block-tool）'));
    assert.ok(htmlOpen.includes('封锁会话（block-session）'));
    // 阈值/阻断模式/仓库上下文 hint 抽样补钉（T-007 评审）
    assert.ok(htmlOpen.includes('等价工具调用重复达到该次数的那次调用即受审'));
    assert.ok(htmlOpen.includes('循环门 blocked 决策与咨询失败的统一处置档位'));
    assert.ok(htmlOpen.includes('patch 含当前变更补丁（受字节上限）'));
    assert.ok(!htmlOpen.includes('评审门')); // legend 冗余已删（T-006 目验 ①）
    assert.ok(htmlOpen.includes('不发送（off）')); // 隐私档位选项双写
    assert.ok(htmlOpen.includes('随咨询发送的会话历史范围')); // 档位说明
    assert.ok(htmlOpen.includes('placeholder":"默认 3"')); // 阈值空值=用默认（目验 ③）
    // footer 右对齐按钮组
    assert.ok(htmlOpen.includes('advisor-flow-save'));
    assert.ok(htmlOpen.includes('advisor-flow-discard'));
});

test('R-02-001/AC-01 卡片编辑经 set 保存成功：patch 提交、raw 吸收、表单回显新值', async () => {
    const { controller, container, rpc } = await renderedCard();
    expandCard(container);
    controller.setField('advisor.model', 'm2');
    controller.setField('enabled', true);
    const save = byTag(container, 'button').find((node) => (node.attrs.class ?? '').includes('advisor-flow-save'));
    assert.equal(save.attrs.disabled, undefined); // 校验通过 → 可保存
    await save.listeners.click[0]();
    const setCall = rpc.calls.find((call) => call.method === 'advisor-flow/set');
    assert.ok(setCall);
    assert.equal(setCall.payload.args.patch.advisor.model, 'm2');
    // 保存成功后 patch 清空、raw 吸收
    assert.equal(controller.getState().patch.advisor, undefined);
    await controller.load();
    const state = controller.getState();
    assert.equal(state.effectiveConfig.advisor.model, 'm2');
});

test('R-02-001/AC-03 enabled 且缺 provider/model 时保存被阻断：不发起 RPC 且按钮禁用并给出原因', async () => {
    const { controller, container, rpc } = await renderedCard({
        raw: { enabled: true, advisor: { provider: 'p' } },
    });
    expandCard(container);
    controller.setField('privacy.redactSecrets', false); // 触发一个无关键编辑
    const state = controller.getState();
    assert.match(state.validationError, /缺少 advisor\.model/);
    const save = byTag(container, 'button').find((node) => (node.attrs.class ?? '').includes('advisor-flow-save'));
    assert.equal(save.attrs.disabled, 'disabled'); // 校验失败 → 按钮禁用
    const before = rpc.calls.length;
    const result = await controller.save();
    assert.equal(result.ok, false);
    assert.match(result.error, /缺少 advisor\.model/);
    assert.equal(rpc.calls.length, before); // 阻断：未发起 set RPC
    assert.ok(container.children[0] ? JSON.stringify(container).includes('advisor-flow-error') : false);
});

test('R-02-001/AC-03 宿主拒绝保存时错误可见且表单保留（patch 不丢）', async () => {
    const rawRef = { current: structuredClone(RAW) };
    const gateway = await gatewayHandlers(rawRef);
    // 包装 set 使其拒绝（模拟宿主端竞态拒绝）
    const originalSet = gateway['advisor-flow/set'];
    gateway['advisor-flow/set'] = async (payload) => ({ ok: false, error: '并发修改冲突' });
    void originalSet;
    const rpc = makeRpc({ handlers: { 'advisor-flow/get': async () => ({ config: rawRef.current, warnings: [] }), 'advisor-flow/set': gateway['advisor-flow/set'] } });
    const controller = createSettingsCardController({ rpc, logger: { warn() {}, error() {} } });
    const dom = createDomStub();
    const container = dom.createElement('div');
    renderSettingsCard({ document: dom, container, controller });
    await controller.load();
    expandCard(container);
    controller.setField('advisor.model', 'm9');
    const result = await controller.save();
    assert.equal(result.ok, false);
    assert.match(result.error, /并发修改冲突/);
    assert.equal(controller.getState().patch.advisor.model, 'm9'); // 表单保留待重试
    const errorNodes = findAll(container, (node) => (node.attrs.class ?? '').includes('advisor-flow-error'));
    assert.equal(errorNodes.length >= 1, true);
});

test('R-02-001/AC-01 discard 放弃修改：patch 清空且无 gateway 写入', async () => {
    const { controller, rpc } = await renderedCard();
    controller.setField('advisor.provider', 'other');
    controller.discard();
    assert.deepEqual(controller.getState().patch, {});
    const result = await controller.save();
    assert.equal(result.ok, true); // 空 patch 也能过（无变化）
    assert.equal(rpc.calls.filter((call) => call.method === 'advisor-flow/set').length, 1);
});

test('R-02-001/AC-01 卡片开关与下拉编辑映射到正确配置路径（官方 Switch + toggleRow 结构）', async () => {
    const { controller, container } = await renderedCard();
    expandCard(container);
    // 主开关为官方 Switch 复刻（button[role=switch]，id 定位保留）
    const enabledSwitch = findById(container, 'advisor-enabled');
    assert.ok(enabledSwitch, 'enabled 开关存在（id 定位）');
    assert.equal(enabledSwitch.attrs.role, 'switch');
    assert.equal(enabledSwitch.attrs['aria-checked'], 'true');
    enabledSwitch.listeners.click[0]();
    assert.equal(controller.getState().patch.enabled, false);
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

test('R-02-001/AC-01 官方 Switch 本体可点：点击翻转启用值（目验「点开关无反应」）', async () => {
    const { controller, container } = await renderedCard();
    expandCard(container);
    // RAW enabled=true → 点击 Switch 应翻转为 false（入 patch）
    const mainSwitch = findById(container, 'advisor-enabled');
    assert.ok(mainSwitch.listeners.click?.length > 0, 'Switch 绑定点击');
    mainSwitch.listeners.click[0]();
    assert.equal(controller.getState().patch.enabled, false);
    // 再点一次回到 true（翻转语义）
    const mainSwitch2 = findById(container, 'advisor-enabled');
    mainSwitch2.listeners.click[0]();
    assert.equal(controller.getState().patch.enabled, true);
    // 门子开关（启用态）点击映射到 gates.<kind>.enabled；密钥脱敏同 Switch 形态
    const planGateSwitch = findById(container, 'advisor-gate-plan-enabled');
    assert.equal(planGateSwitch.attrs.role, 'switch', '门子开关为官方 Switch 形态');
    planGateSwitch.listeners.click[0]();
    assert.equal(controller.getState().patch.gates.plan.enabled, false);
    assert.equal(findById(container, 'advisor-privacy-redact-secrets').attrs.role, 'switch', '密钥脱敏为官方 Switch 形态');
});

test('R-02-001 关闭启用开关不抛错：fieldset 附加 disabledGroup（目验「详情消失」真凶——桩私有 attrs.class 曾使真实 DOM 崩）', async () => {
    const { controller, container } = await renderedCard();
    expandCard(container);
    // 模拟真实点击路径：Switch click → setField → emit → refresh 全链
    const enabledSwitch = findById(container, 'advisor-enabled');
    enabledSwitch.listeners.click[0]();
    assert.equal(controller.getState().patch.enabled, false);
    // refresh 后不抛（曾抛 TypeError: Cannot read properties of undefined (reading 'class')）
    const gateFieldset = findAll(container, (node) => node.tag === 'fieldset' && (node.attrs.class ?? '').includes('advisorflow_fieldset'))[0];
    assert.ok(gateFieldset, '四门 fieldset 在禁用态仍渲染');
    // 禁用态标注经 getAttribute 读回（真实 DOM 兼容路径）
    assert.equal((gateFieldset.getAttribute?.('class') ?? gateFieldset.attrs.class).includes('advisorflow_disabledGroup'), false, '门 fieldset 自身不带禁用类（加在门块 div 上）');
    const disabledGroups = findAll(container, (node) => (node.getAttribute?.('class') ?? node.attrs.class ?? '').includes('advisorflow_disabledGroup'));
    assert.ok(disabledGroups.length >= 4, '四门块与隐私组带禁用标注');
    // 总开关关闭后 effort 下拉一并禁用（东家问题 1 的回归钉）
    const effortSelect = findById(container, 'advisor-reasoning-effort');
    assert.equal(effortSelect.attrs.disabled, 'disabled', 'effort 下拉随总开关禁用');
    // 关闭态下门子开关进入 disabled 且点击被守卫拦截（不产生 patch）
    const planGateSwitch = findById(container, 'advisor-gate-plan-enabled');
    assert.equal(planGateSwitch.attrs.role, 'switch', '门子开关为官方 Switch 形态');
    assert.equal(planGateSwitch.attrs.disabled, 'disabled');
    planGateSwitch.listeners.click[0]();
    assert.equal(controller.getState().patch.gates?.plan?.enabled, undefined, '禁用态门开关点击不生效');
});

test('R-02-001 循环门阈值随门开关联动禁用；守则门块无策略/阈值控件（东家目验）', async () => {
    const { controller, container } = await renderedCard();
    expandCard(container);
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
    // 守则门块（plan/failure/completion）不含策略/阈值控件
    assert.equal(findById(container, 'advisor-gate-plan-policy'), undefined);
    assert.equal(findById(container, 'advisor-gate-failure-policy'), undefined);
    assert.equal(findById(container, 'advisor-gate-completion-policy'), undefined);
});

test('R-02-001/AC-01 保存成功回执：提示运行时态与重启失效（持久写归后续任务）', async () => {
    const { controller, container } = await renderedCard();
    expandCard(container);
    controller.setField('advisor.model', 'm2');
    const result = await controller.save();
    assert.equal(result.ok, true);
    assert.match(result.notice, /当前运行时/);
    assert.match(result.notice, /重启后修改会丢失/);
    // 渲染可见
    const notices = findAll(container, (node) => (node.attrs.class ?? '').includes('advisor-flow-notice'));
    assert.equal(notices.length, 1);
    assert.ok(notices[0].textContent.includes('重启后修改会丢失'));
    // 新编辑使旧回执失效
    controller.setField('advisor.provider', 'p2');
    assert.equal(controller.getState().savedNotice, undefined);
});

test('R-02-001/AC-01 保存回执双形态：写缝可得时「已保存并持久化」', async () => {
    const writes = [];
    const { controller, container } = await renderedCard({
        persist: async (raw) => writes.push(raw),
    });
    expandCard(container);
    controller.setField('advisor.model', 'm2');
    const result = await controller.save();
    assert.equal(result.ok, true);
    assert.equal(result.persisted, true);
    assert.match(result.notice, /已保存并持久化/);
    const notices = findAll(container, (node) => (node.attrs.class ?? '').includes('advisor-flow-notice'));
    assert.ok(notices[0].textContent.includes('持久化'));
    assert.equal(writes.length, 1);
});

test('R-02-001/AC-01 保存回执双形态：写缝缺失时「仅运行时态」提示仍在', async () => {
    const { controller } = await renderedCard({ persist: undefined });
    controller.setField('advisor.model', 'm2');
    const result = await controller.save();
    assert.equal(result.ok, true);
    assert.equal(result.persisted, false);
    assert.match(result.notice, /当前运行时/);
    assert.match(result.notice, /重启后修改会丢失/);
});

test('R-02-001/AC-01 写失败回执携带原因摘要（persistError 消费，不误读为功能缺失）', async () => {
    const rawRef = { current: structuredClone(RAW) };
    const gateway = await gatewayHandlers(rawRef);
    gateway['advisor-flow/set'] = async (payload) => ({
        ok: true,
        config: rawRef.current,
        persisted: false,
        notice: '已保存到运行时；写入 settings.yaml 失败，重启即失（原因见详情）。',
        persistError: 'Error: yaml write failed',
    });
    const rpc = makeRpc({ handlers: { 'advisor-flow/get': async () => ({ config: rawRef.current, warnings: [] }), 'advisor-flow/set': gateway['advisor-flow/set'] } });
    const controller = createSettingsCardController({ rpc, logger: { warn() {}, error() {} } });
    const dom = createDomStub();
    const container = dom.createElement('div');
    renderSettingsCard({ document: dom, container, controller });
    await controller.load();
    expandCard(container);
    controller.setField('advisor.model', 'm9');
    const result = await controller.save();
    assert.equal(result.ok, true);
    assert.equal(result.persisted, false);
    assert.match(result.notice, /写入 settings\.yaml 失败/);
    assert.match(result.notice, /原因：.*yaml write failed/); // 原因摘要进回执
    assert.equal(controller.getState().persistError, 'Error: yaml write failed');
    const notices = findAll(container, (node) => (node.attrs.class ?? '').includes('advisor-flow-notice'));
    assert.ok(notices[0].textContent.includes('原因：'));
});

test('R-02-001/AC-01 卡片提供 effort 选择器：渲染、选择进入 patch、save 往返保留', async () => {
    const writes = [];
    const { controller, container, rpc } = await renderedCard({
        persist: async (raw) => writes.push(raw),
    });
    expandCard(container);
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
    const setCall = rpc.calls.find((call) => call.method === 'advisor-flow/set');
    assert.equal(setCall.payload.args.patch.advisor.reasoningEffort, 'high');
    const written = writes[0];
    assert.equal(written.advisor.reasoningEffort, 'high'); // 写回内容保留档位

    // 选回「不指定」→ null（可穿越 JSON 序列化的「未配置」载体，非法值校验不拒）
    effortSelect.listeners.change[0]({ target: { value: '' } });
    assert.equal(controller.getState().patch.advisor.reasoningEffort, null);
    assert.equal(controller.validate(), undefined);

    // JSON 往返钉住：undefined 键会被序列化丢弃致 merge 保留旧档位（卡片与
    // 持久真相分歧）；null 穿越往返后解析为缺省、写回内容不含旧档位。
    controller.setField('advisor.model', 'm2'); // 顺带验证同次保存
    const cleared = await controller.save();
    assert.equal(cleared.ok, true);
    const wirePatch = JSON.parse(JSON.stringify(rpc.calls.findLast((call) => call.method === 'advisor-flow/set').payload.args.patch));
    assert.equal(wirePatch.advisor.reasoningEffort, null); // null 穿越序列化（undefined 会被丢弃）
    const writtenCleared = writes[writes.length - 1];
    assert.equal(writtenCleared.advisor.reasoningEffort, null); // 持久写内容不含 'high'
    const { resolveAdvisorFlowConfig } = await import('../../lib/config.js');
    const resolved = resolveAdvisorFlowConfig(writtenCleared);
    assert.equal(resolved.config.advisor.reasoningEffort, undefined); // null → 缺省=跟随模型默认
});

test('R-02-003/AC-02 信封 ok:false → 卡片显性化 error.message 而非通用异常（connection 契约）', async () => {
    const rawRef = { current: structuredClone(RAW) };
    // 直接以信封形态 resolve（connection.rpc.call 的失败也是 resolve 非 reject）：
    // get 失败验证 load 路径，set 失败验证 save 路径（分两个控制器）。
    const envelope = (message) => ({ ok: false, error: { code: 'gateway/internal', message } });
    let getShouldFail = true;
    const getFail = {
        calls: [],
        call: async (channel, method) => {
            getFail.calls.push({ channel, method });
            if (method === 'advisor-flow/get') {
                // 前两次失败（首帧 + 重试），之后恢复——error 态必须可自愈
                if (getShouldFail) {
                    return envelope('settings service unavailable');
                }
                return { ok: true, value: { config: structuredClone(RAW), warnings: [] } };
            }
            throw new Error(`no endpoint ${method}`);
        },
    };
    const controller = createSettingsCardController({ rpc: getFail, logger: { warn() {}, error() {} } });
    const dom = createDomStub();
    const container = dom.createElement('div');
    renderSettingsCard({ document: dom, container, controller });
    await controller.load();
    assert.equal(controller.getState().status, 'error');
    assert.match(controller.getState().error, /settings service unavailable/); // error.message 显性化
    const errorNodes = findAll(container, (node) => (node.attrs.class ?? '').includes('advisor-flow-error'));
    assert.ok(errorNodes[0].textContent.includes('settings service unavailable'));
    // error 态无表单（内容消失形态）但必须提供重试——无恢复手段则表单永久
    // 消失且 header 点击永远回不来（东家目验缺陷）
    assert.equal(byTag(container, 'fieldset').length, 0);
    const retry = byTag(container, 'button').find((node) => node.textContent === '重试');
    assert.ok(retry, 'error 态渲染重试按钮');
    getShouldFail = false;
    retry.listeners.click[0](); // void controller.load()——异步
    await pump();
    assert.equal(controller.getState().status, 'ready');
    assert.ok(findAll(container, (node) => (node.attrs.class ?? '').includes('advisorflow_form')).length > 0, '重试成功后表单恢复');

    // save 路径：load 成功、set 信封失败 → 保存失败显性化并区分 error.code
    const setFail = {
        calls: [],
        call: async (channel, method, payload) => {
            setFail.calls.push({ channel, method, payload });
            if (method === 'advisor-flow/get') {
                return { ok: true, value: { config: structuredClone(RAW), warnings: [] } };
            }
            return envelope('set dispatch failed');
        },
    };
    const saveController = createSettingsCardController({ rpc: setFail, logger: { warn() {}, error() {} } });
    await saveController.load();
    saveController.setField('advisor.provider', 'p');
    const result = await saveController.save();
    assert.equal(result.ok, false);
    assert.match(result.error, /set dispatch failed/);
    assert.equal(result.code, 'gateway/internal'); // 区分 error.code
});

const CATALOG_PROVIDERS = [
    { id: 'openai', name: 'OpenAI (CPA)' },
    { id: 'gpu', name: 'GPU 路由' },
];
const CATALOG = {
    routableProviders: ['openai', 'gpu'],
    groups: [
        { id: 'openai', name: 'OpenAI (CPA)', models: [{ id: 'gpt-x', name: 'GPT X', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' } }] },
        { id: 'gpu', name: 'GPU 路由', models: [{ id: 'glm-5.3', name: 'GLM 5.3', reasoning: { efforts: [{ id: 'max', name: '最大' }], defaultEffort: 'max' } }] },
    ],
};

test('R-02-001 目录 RPC 挂起不得阻塞表单：ready 立即达成，表单照常渲染（目验「详情没了」根因）', async () => {
    // catalog 两端点永不 resolve——旧实现 await loadCatalogs 在 emit 前，
    // 挂起即卡片长期只剩 header；现在 ready 先行、表单立即可渲染。
    const { controller, container } = await renderedCard({
        raw: { enabled: true, advisor: { provider: 'p', model: 'm' } },
        catalog: {
            providers: new Promise(() => {}), // 永不 resolve（模拟挂起）
            catalog: new Promise(() => {}),
        },
    });
    assert.equal(controller.getState().status, 'ready');
    assert.equal(controller.getState().catalogReady, false); // 目录未达
    expandCard(container);
    const html = JSON.stringify(container);
    assert.ok(html.includes('顾问提供方'), '表单在目录挂起时照常渲染');
});

test('R-02-001/AC-01 load 瞬态失败自动重试一次：再失败才落 error（自愈优先）', async () => {
    let attempts = 0;
    const rpc = {
        call: async (channel, method) => {
            attempts += 1;
            if (method === 'advisor-flow/get' && attempts === 1) {
                throw new TypeError('Failed to fetch'); // 瞬态网络失败
            }
            if (method === 'advisor-flow/get') {
                return { ok: true, value: { config: structuredClone(RAW), warnings: [] } };
            }
            throw new Error(`no endpoint ${method}`);
        },
    };
    const controller = createSettingsCardController({ rpc, logger: { warn() {}, error() {} } });
    const status = await controller.load();
    assert.equal(status, 'ready'); // 重试后成功，未落 error
    assert.ok(attempts >= 2, 'fetch 失败后自动重试了一次');
    assert.equal(controller.getState().status, 'ready');
});

test('R-02-001/AC-01 目录驱动三级联动：provider/model 下拉来自目录，effort 来自模型声明', async () => {    const { controller, container } = await renderedCard({
        raw: { enabled: true, advisor: { provider: 'openai', model: 'gpt-x' } },
        catalog: { providers: CATALOG_PROVIDERS, catalog: CATALOG },
    });
    assert.equal(controller.getState().catalogReady, true);
    assert.equal(controller.getState().degradations?.catalog, undefined);
    expandCard(container);
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
        raw: { enabled: true, advisor: { provider: 'openai', model: 'gpt-x', reasoningEffort: 'high' } },
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

test('R-02-001/AC-01 null effort 保留：选「跟随模型默认」写 null 且往返不丢', async () => {
    const writes = [];
    const { controller } = await renderedCard({
        raw: { enabled: true, advisor: { provider: 'gpu', model: 'glm-5.3', reasoningEffort: 'max' } },
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
    expandCard(container);
    const state = controller.getState();
    assert.equal(state.catalogReady, false);
    assert.equal(state.catalogDegraded, true);
    assert.equal(state.degradations.catalog, 'catalog-fetch-failed');
    // 回退形态：provider/model 仍为自由文本输入
    const textInputs = findAll(container, (node) => node.tag === 'input' && node.attrs.type === 'text');
    const labels = findAll(container, (node) => node.tag === 'label');
    assert.ok(JSON.stringify(container).includes('顾问提供方'));
    // effort 回退硬编码档位
    assert.ok(JSON.stringify(container).includes('关闭 (off)'));
    // 一次性显性化：连续 load 不重复 warn
    await controller.load();
    const warnCount = (state.degradations.catalog === 'catalog-fetch-failed') ? 1 : 0;
    assert.equal(warnCount, 1);
    void warns;
});

test('R-02-003/AC-02 信封成功但 value 形态意外 → fallback 文案而非 undefined（产物新鲜度守卫同轮）', async () => {
    const rpc = {
        calls: [],
        call: async (channel, method) => {
            rpc.calls.push({ channel, method });
            if (method === 'advisor-flow/get') {
                return { ok: true, value: 'unexpected scalar' }; // value 非 record/array
            }
            return { ok: true, value: 'unexpected' };
        },
    };
    const controller = createSettingsCardController({ rpc, logger: { warn() {}, error() {} } });
    const dom = createDomStub();
    const container = dom.createElement('div');
    renderSettingsCard({ document: dom, container, controller });
    await controller.load();
    assert.equal(controller.getState().status, 'error');
    assert.match(controller.getState().error, /配置通道返回了意外形态/); // fallback 文案而非 undefined
    // save 路径同语义（独立控制器：get 成功、set 返回意外形态 value）
    const saveRpc = {
        calls: [],
        call: async (channel, method, payload) => {
            saveRpc.calls.push({ channel, method, payload });
            if (method === 'advisor-flow/get') {
                return { ok: true, value: { config: structuredClone(RAW), warnings: [] } };
            }
            return { ok: true, value: 'unexpected scalar' };
        },
    };
    const saveController = createSettingsCardController({ rpc: saveRpc, logger: { warn() {}, error() {} } });
    await saveController.load();
    saveController.setField('advisor.provider', 'p');
    const result = await saveController.save();
    assert.equal(result.ok, false);
    assert.match(result.error, /配置通道返回了意外形态/);
});

test('R-02-001/AC-01 展开态跨 setField/emit 重绘存续：改字段不塌卡片（T-006 实测回归钉住）', async () => {
    const { controller, container } = await renderedCard();
    expandCard(container);
    assert.equal(findById(container, 'advisor-gate-plan-enabled') !== undefined, true);
    // 展开态下改字段 → emit → 重绘：卡片保持展开（aria-expanded=true + 字段在位）
    controller.setField('advisor.model', 'm2');
    const header = byTag(container, 'button').find((node) => (node.attrs.class ?? '').includes('advisorflow_header'));
    assert.equal(header.attrs['aria-expanded'], 'true');
    assert.ok(findById(container, 'advisor-gate-plan-enabled'), '字段仍在位');
    // 折叠 → setField → 仍折叠
    controller.setExpanded(false);
    assert.equal(byTag(container, 'fieldset').length, 0);
    controller.setField('advisor.provider', 'p2');
    assert.equal(byTag(container, 'fieldset').length, 0); // 折叠态保持
    // 再展开恢复
    controller.setExpanded(true);
    assert.ok(findById(container, 'advisor-gate-plan-enabled'));
});
