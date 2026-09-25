import test from 'node:test';
import assert from 'node:assert/strict';
import { GUIDELINE_TEXTS, GUIDELINE_CLOSING, guidelineTextFactory, installAdvisorGuidelines } from '../lib/guidelines.js';

/** 活配置构造器：三类守则开关独立可切。 */
function config(overrides = {}) {
    return {
        enabled: overrides.enabled === undefined ? true : overrides.enabled,
        gates: {
            plan: { enabled: overrides.plan === true },
            failure: { enabled: overrides.failure === true },
            completion: { enabled: overrides.completion === true },
            loop: { enabled: true, threshold: 3 },
        },
    };
}

test('R-01-003/AC-01 计划守则文案要求附上命名拟议工作、验证方式与剩余风险的草稿', () => {
    assert.ok(GUIDELINE_TEXTS.plan.includes('ask_advisor'));
    assert.ok(GUIDELINE_TEXTS.plan.includes('草稿'));
    assert.ok(GUIDELINE_TEXTS.plan.includes('拟议工作'));
    assert.ok(GUIDELINE_TEXTS.plan.includes('验证方式'));
    assert.ok(GUIDELINE_TEXTS.plan.includes('剩余风险'));
    // 收尾公共守则：空对象调用即一般性评审；不为请求评审而编造问题
    assert.ok(GUIDELINE_CLOSING.includes('空对象'));
    assert.ok(GUIDELINE_CLOSING.includes('编造问题'));
});

test('R-01-004/AC-01 失败守则覆盖等价失败与无可测进展两类情形，且约束先咨询', () => {
    assert.ok(GUIDELINE_TEXTS.failure.includes('等价'));
    assert.ok(GUIDELINE_TEXTS.failure.includes('无可测进展'));
    assert.ok(GUIDELINE_TEXTS.failure.includes('不要再做实质等价的尝试'));
});

test('R-01-006/AC-01 完成守则要求草稿命名已变更工作、验证方式与剩余风险', () => {
    assert.ok(GUIDELINE_TEXTS.completion.includes('ask_advisor'));
    assert.ok(GUIDELINE_TEXTS.completion.includes('已变更工作'));
    assert.ok(GUIDELINE_TEXTS.completion.includes('验证方式'));
    assert.ok(GUIDELINE_TEXTS.completion.includes('剩余风险'));
});

test('R-01-003/AC-01 守则求值：三守则全开时逐行产出并附公共收尾行', () => {
    const render = guidelineTextFactory(() => config({ plan: true, failure: true, completion: true }));
    const text = render({ agent: { id: 's1' } });
    assert.ok(text.startsWith('Advisor 咨询守则（advisor-flow）：'));
    for (const line of [GUIDELINE_TEXTS.plan, GUIDELINE_TEXTS.failure, GUIDELINE_TEXTS.completion, GUIDELINE_CLOSING]) {
        assert.ok(text.includes(`- ${line}`), text);
    }
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
    assert.ok(!onlyPlanText.includes('两次实质等价的尝试'), '失败守则禁用→不含失败守则行');
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

test('R-01-007/AC-04 工具缝缺失不注入：ask_advisor 未激活时守则文本为空', () => {
    const live = () => ({
        enabled: true,
        gates: { plan: { enabled: true }, failure: { enabled: false }, completion: { enabled: false } },
    });
    // 咨询工具缝未激活（degradations.askAdvisorTool 在场）→ 守则不得指向不存在的工具
    const inactive = guidelineTextFactory(live)({ agent: {}, askAdvisorActive: false });
    assert.equal(inactive, '');
    const active = guidelineTextFactory(live)({ agent: {}, askAdvisorActive: true });
    assert.ok(active.length > 0);
});
