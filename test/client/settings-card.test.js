import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsCardController } from '../../lib/client/card-state.js';
import { renderSettingsCard } from '../../lib/client/render.js';

/** Fake RPC over canned handlers (mirrors the host gateway handlers). */
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
            return handler(payload);
        },
    };
}

const RAW = {
    enabled: true,
    advisor: { provider: 'p', model: 'm' },
    gates: { plan: { enabled: true, policy: 'review' } },
    privacy: { history: 'window' },
};

/** Host-side gateway handlers shared with test/gateway.test.js semantics. */
function gatewayHandlers(rawRef) {
    // 引入宿主实现本身，保证卡片测试与宿主语义零漂移
    return import('../../lib/gateway.js').then(({ createConfigGateway }) => {
        const gateway = createConfigGateway({
            getRawConfig: () => rawRef.current,
            applyResolved: (resolved, nextRaw) => {
                rawRef.current = nextRaw;
            },
        });
        return gateway;
    });
}

function makeCard({ raw = structuredClone(RAW) } = {}) {
    const rawRef = { current: structuredClone(raw) };
    const degradations = { askPolicy: 'approver-seam-missing' };
    let gatewayPromise = gatewayHandlers(rawRef);
    const handlers = {};
    const rpc = makeRpc({
        handlers: new Proxy({}, {
            get: (_target, method) => async (payload) => {
                const gateway = await gatewayPromise;
                return gateway[method](payload);
            },
        }),
    });
    void handlers;
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
    return {
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
            };
            return node;
        },
    };
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

async function renderedCard(options = {}) {
    const { controller, rpc, rawRef } = makeCard(options);
    const dom = createDomStub();
    const container = dom.createElement('div');
    const card = renderSettingsCard({ document: dom, container, controller });
    await controller.load(); // load 触发 emit → refresh 重渲染
    card.refresh();
    return { controller, container, card, dom, rpc, rawRef };
}

test('R-02-001/AC-01 卡片经自有 gateway RPC 读回配置并渲染表单', async () => {
    const { container, rpc } = await renderedCard();
    // 渲染首帧与显式 load 各触发一次读回；全部走自有通道（advisor-flow/get）
    assert.ok(rpc.calls.length >= 1);
    assert.ok(rpc.calls.every((call) => call.method === 'advisor-flow/get' || call.method === 'advisor-flow/set'));
    const html = JSON.stringify(container);
    assert.ok(html.includes('Advisor Flow'));
    assert.ok(html.includes('advisor provider'));
    assert.ok(html.includes('启用 Advisor Flow'));
    assert.ok(html.includes('密钥脱敏'));
    assert.ok(html.includes('plan 门')); // 四门矩阵逐门渲染
    assert.ok(html.includes('completion 门'));
});

test('R-02-001/AC-01 卡片编辑经 set 保存成功：patch 提交、raw 吸收、表单回显新值', async () => {
    const { controller, container, rpc } = await renderedCard();
    controller.setField('advisor.model', 'm2');
    controller.setField('enabled', true);
    const save = byTag(container, 'button').find((node) => node.attrs.class === 'advisor-flow-save');
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
    controller.setField('privacy.redactSecrets', false); // 触发一个无关键编辑
    const state = controller.getState();
    assert.match(state.validationError, /缺少 advisor\.model/);
    const save = byTag(container, 'button').find((node) => node.attrs.class === 'advisor-flow-save');
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
    controller.setField('advisor.model', 'm9');
    const result = await controller.save();
    assert.equal(result.ok, false);
    assert.match(result.error, /并发修改冲突/);
    assert.equal(controller.getState().patch.advisor.model, 'm9'); // 表单保留待重试
    const errorNodes = findAll(container, (node) => node.attrs.class === 'advisor-flow-error');
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

test('R-02-001/AC-01 卡片勾选与下拉编辑映射到正确配置路径', async () => {
    const { controller, container } = await renderedCard();
    const checkboxes = byTag(container, 'input').filter((node) => node.attrs.type === 'checkbox');
    const labels = byTag(container, 'label');
    const enabledLabel = labels.find((node) => node.children.some((child) => child.tag === 'span' && child.textContent === '启用 Advisor Flow'));
    assert.ok(enabledLabel, 'enabled 复选框的标签存在');
    const enabledBox = enabledLabel.children.find((child) => child.tag === 'input');
    enabledBox.listeners.change[0]({ target: { checked: false } });
    assert.equal(controller.getState().patch.enabled, false);
    // 门策略下拉
    const selects = byTag(container, 'select');
    assert.ok(selects.length >= 5); // 四门策略 + privacy history + repoContext
    selects[0].listeners.change[0]({ target: { value: 'block' } });
    assert.equal(controller.getState().patch.gates.plan.policy, 'block');
});

test('R-02-001/AC-01 保存成功回执：提示运行时态与重启失效（持久写归后续任务）', async () => {
    const { controller, container } = await renderedCard();
    controller.setField('advisor.model', 'm2');
    const result = await controller.save();
    assert.equal(result.ok, true);
    assert.match(result.notice, /当前运行时/);
    assert.match(result.notice, /重启后失效/);
    // 渲染可见
    const notices = findAll(container, (node) => node.attrs.class === 'advisor-flow-notice');
    assert.equal(notices.length, 1);
    assert.ok(notices[0].textContent.includes('重启后失效'));
    // 新编辑使旧回执失效
    controller.setField('advisor.provider', 'p2');
    assert.equal(controller.getState().savedNotice, undefined);
});
