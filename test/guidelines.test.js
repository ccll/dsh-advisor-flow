import test from 'node:test';
import assert from 'node:assert/strict';
import { GUIDELINE_TEXTS, GUIDELINE_CLOSING, GUIDELINE_HEADER, guidelineTextFactory, installAdvisorGuidelines } from '../lib/guidelines.js';

/** 活配置构造器：三类守则开关独立可切。 */
function config(overrides = {}) {
    return {
        enabled: overrides.enabled === undefined ? true : overrides.enabled,
        advisor: { provider: 'test', model: 'test-model' },
        modelWhitelist: [],
        customInvocation: overrides.customInvocation,
        gates: {
            plan: { enabled: overrides.plan === true },
            failure: { enabled: overrides.failure === true },
            completion: { enabled: overrides.completion === true },
            loop: { enabled: true, threshold: 3 },
        },
    };
}

test('R-01-003/AC-01 计划守则文案要求附上命名拟议工作、验证方式与剩余风险的草稿（英文语义锚）', () => {
    assert.ok(GUIDELINE_TEXTS.plan.includes('ask_advisor'));
    assert.ok(GUIDELINE_TEXTS.plan.includes('proposed work'));
    assert.ok(GUIDELINE_TEXTS.plan.includes('validation'));
    assert.ok(GUIDELINE_TEXTS.plan.includes('remaining risks'));
    // 收尾公共守则：空对象调用即一般性评审；不为请求评审而编造问题
    assert.ok(GUIDELINE_CLOSING.includes('empty object'));
    assert.ok(GUIDELINE_CLOSING.includes('Do not invent a question'));
});

test('R-01-004/AC-01 失败守则覆盖等价失败与无可测进展两类情形，且约束先咨询', () => {
    assert.ok(GUIDELINE_TEXTS.failure.includes('materially equivalent failed attempts'));
    assert.ok(GUIDELINE_TEXTS.failure.includes('no measurable progress'));
    assert.ok(GUIDELINE_TEXTS.failure.includes('Do not make another materially equivalent attempt before consulting'));
});

test('R-01-006/AC-01 完成守则要求草稿命名已变更工作、验证方式与剩余风险', () => {
    assert.ok(GUIDELINE_TEXTS.completion.includes('ask_advisor'));
    assert.ok(GUIDELINE_TEXTS.completion.includes('changed work'));
    assert.ok(GUIDELINE_TEXTS.completion.includes('validation'));
    assert.ok(GUIDELINE_TEXTS.completion.includes('remaining risks'));
});

test('R-01-003/AC-03 守则块头部与行格式对齐 pi：Advisor invocation settings: + - 前缀', () => {
    const render = guidelineTextFactory(() => config({ plan: true, failure: true, completion: true }));
    const text = render({ agent: { id: 's1' } });
    assert.ok(text.startsWith('Advisor invocation settings:\n- '), text);
    for (const line of [GUIDELINE_TEXTS.plan, GUIDELINE_TEXTS.failure, GUIDELINE_TEXTS.completion, GUIDELINE_CLOSING]) {
        assert.ok(text.includes(`- ${line}`), text);
    }
    assert.equal(GUIDELINE_HEADER, 'Advisor invocation settings:');
});

test('R-01-007/AC-01 守则求值：customInvocation 行位于公共收尾行之前（pi advisorCustomInvocationRef 位置）', () => {
    const render = guidelineTextFactory(() => ({ ...config({ plan: true }), customInvocation: '当执行不可逆删除前' }));
    const text = render({ agent: { id: 's1' } });
    assert.ok(text.includes('- Also use ask_advisor when: 当执行不可逆删除前'));
    const customAt = text.indexOf('Also use ask_advisor when:');
    const closingAt = text.indexOf(GUIDELINE_CLOSING);
    assert.ok(customAt > -1 && closingAt > customAt, '定制行在收尾行之前');
});

test('R-01-007/AC-02 守则预算行：配置预算时附余量行且置于末尾，未配置时不出现', () => {
    const render = guidelineTextFactory(
        () => config({ plan: true }),
        { getRemaining: (sessionId) => (sessionId === 's1' ? 2 : undefined) },
    );
    const withBudget = render({ agent: { id: 's1' } });
    assert.ok(withBudget.includes('- Advisor calls remaining this session: 2.\nReserve calls for material decisions, repeated failures, or final review.'), withBudget);
    assert.ok(withBudget.trimEnd().endsWith('final review.'), '预算行在块末尾（pi push 顺序）');
    // 未配置预算（getRemaining 返回 undefined）→ 无预算行
    const without = render({ agent: { id: 'other' } });
    assert.ok(!without.includes('remaining this session'), without);
});

test('R-01-003/AC-01 守则求值实时生效：活配置切换守则开关，下一次求值即时反映', () => {
    const state = { value: config({ plan: true }) };
    const render = guidelineTextFactory(() => state.value);
    assert.ok(render({ agent: {} }).includes(GUIDELINE_TEXTS.plan));
    state.value = config({ completion: true });
    const next = render({ agent: {} });
    assert.ok(!next.includes(GUIDELINE_TEXTS.plan));
    assert.ok(next.includes(GUIDELINE_TEXTS.completion));
});

test('R-01-003/AC-02 守则全关、功能未启用或 agentless 组装时求值为空串；getConfig 缺失不抛出', () => {
    // 同时覆盖 R-01-004/AC-02 与 R-01-006/AC-02（守则禁用→系统提示不含该守则）。
    const render = guidelineTextFactory(() => config({}));
    assert.equal(render(undefined), '');
    assert.equal(render({ agent: {} }), '');
    assert.equal(guidelineTextFactory(() => ({ enabled: false, gates: { plan: { enabled: true } } }))({ agent: {} }), '');
    const allOff = { enabled: true, gates: { plan: { enabled: false }, failure: { enabled: false }, completion: { enabled: false } } };
    assert.equal(guidelineTextFactory(() => allOff)({ agent: {} }), '');
    // R-01-004/AC-02 / R-01-006/AC-02：单门禁用时该行缺席（其余守则仍在）
    const onlyPlan = { enabled: true, gates: { plan: { enabled: true }, failure: { enabled: false }, completion: { enabled: false } } };
    const onlyPlanText = guidelineTextFactory(() => onlyPlan)({ agent: {} });
    assert.ok(!onlyPlanText.includes('materially equivalent failed attempts'), '失败守则禁用→不含失败守则行');
    assert.ok(onlyPlanText.includes(GUIDELINE_TEXTS.plan), '其余守则不受影响');
    assert.equal(guidelineTextFactory(undefined)({ agent: {} }), '');
    assert.equal(guidelineTextFactory(() => null)({ agent: {} }), '');
});

test('R-01-004/AC-02 与 R-01-006/AC-02 禁用锚定：逐门禁用时该门守则行不出现，其余守则照常', () => {
    const onlyPlan = { enabled: true, gates: { plan: { enabled: true }, failure: { enabled: false }, completion: { enabled: false } } };
    const text = guidelineTextFactory(() => onlyPlan)({ agent: {} });
    assert.ok(text.includes(GUIDELINE_TEXTS.plan));
    assert.ok(!text.includes(GUIDELINE_TEXTS.failure));
    assert.ok(!text.includes(GUIDELINE_TEXTS.completion));
    void [1];
});

test('installAdvisorGuidelines：注册 advisor-flow:guidelines section（text 函数实时求值，disposer 撤除）', () => {
    const specs = [];
    const systemPrompt = {
        getSectionOrder: (kind) => (kind === 'PLAN_POLICY' ? 410 : 900),
        section: (spec) => {
            specs.push(spec);
            return () => specs.pop();
        },
    };
    let current = config({ plan: true });
    const disposer = installAdvisorGuidelines(systemPrompt, () => current, { info() {} });
    assert.equal(specs.length, 1);
    assert.equal(specs[0].name, 'advisor-flow:guidelines');
    assert.equal(typeof specs[0].text, 'function');
    assert.equal(specs[0].order, 410);
    assert.ok(specs[0].text({ agent: {} }).includes(GUIDELINE_TEXTS.plan));
    disposer();
    assert.equal(specs.length, 0);
    assert.doesNotThrow(() => disposer());
});

test('installAdvisorGuidelines：systemPrompt 缝形态不符时守则未注入（降级留痕 + no-op disposer）', () => {
    const logs = [];
    const disposer = installAdvisorGuidelines({}, () => ({}), { info: (message) => logs.push(message) });
    assert.equal(typeof disposer, 'function');
    assert.doesNotThrow(() => disposer());
    assert.ok(logs.some((message) => message.includes('systemPrompt 缝形态不符')));
    assert.doesNotThrow(() => installAdvisorGuidelines(undefined, () => ({}), { info() {} }));
});

test('R-01-007/AC-04 工具缝缺失不注入：ask_advisor 未激活时守则文本为空（接线旗标 hooks）', () => {
    const live = () => config({ plan: true });
    // 咨询工具缝未激活（isAskAdvisorActive=false）→ 守则不得指向不存在的工具
    const inactive = guidelineTextFactory(live, { isAskAdvisorActive: () => false })({ agent: { id: 's1' } });
    assert.equal(inactive, '');
    const active = guidelineTextFactory(live, { isAskAdvisorActive: () => true })({ agent: { id: 's1' } });
    assert.ok(active.length > 0);
    // 未接线 hooks（缺省）视为激活——向后兼容既有调用
    const defaultActive = guidelineTextFactory(live)({ agent: { id: 's1' } });
    assert.ok(defaultActive.length > 0);
});

test('R-01-007/AC-03 模型白名单不可用时守则不注入（pi advisorModelAccess 前置）', () => {
    const blocked = {
        ...config({ plan: true }),
        advisor: { provider: 'test', model: 'other-model' },
        modelWhitelist: ['allowed-model'],
    };
    assert.equal(guidelineTextFactory(() => blocked)({ agent: { id: 's1' } }), '');
    const allowed = { ...blocked, advisor: { provider: 'test', model: 'allowed-model' } };
    assert.ok(guidelineTextFactory(() => allowed)({ agent: { id: 's1' } }).includes(GUIDELINE_TEXTS.plan));
});
