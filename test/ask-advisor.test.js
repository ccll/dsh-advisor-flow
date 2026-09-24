import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdvisorFlowConfig } from '../lib/config.js';
import { createConsultationEngine } from '../lib/consultation.js';
import { createAskAdvisorTool } from '../lib/tools/ask-advisor.js';
import { createFakeLlm, answer, failure } from './helpers.js';

function config(raw = {}) {
    const result = resolveAdvisorFlowConfig({ enabled: true, advisor: { provider: 'test', model: 'm' }, ...raw });
    assert.equal(result.ok, true, result.error ?? '');
    return result.config;
}

const quietLogger = { info() {}, warn() {}, debug() {} };

test('R-01-001/AC-01 工具调用成功返回意见文本与 adviceId', async () => {
    const llm = createFakeLlm([answer('意见：先补测试再合并。'), answer('一般性评审意见。')]);
    const engine = createConsultationEngine({ llm, config: config(), logger: quietLogger });
    const tool = createAskAdvisorTool({ engine });

    const result = await tool.execute({ question: '这个补丁可以吗？' });
    assert.equal(result.ok, true);
    assert.equal(result.adviceId, 'adv-1');
    assert.ok(result.text.includes('先补测试'));
    assert.equal(result.severity, 'nit');

    // 零参调用 → 一般性评审
    const general = await tool.execute({});
    assert.equal(general.ok, true);
    assert.equal(general.adviceId, 'adv-2');
});

test('R-01-001/AC-02 未配置模型时工具返回可诊断错误，不抛出异常', async () => {
    const llm = createFakeLlm([]);
    const disabled = resolveAdvisorFlowConfig({ enabled: false }).config;
    const engine = createConsultationEngine({ llm, config: disabled, logger: quietLogger });
    const tool = createAskAdvisorTool({ engine });
    const result = await tool.execute({ question: 'q' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NO_ADVISOR_MODEL');
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
});

test('R-01-001/AC-02 路由失败与失败分类经工具面转译为诊断码', async () => {
    const llm = createFakeLlm([failure(new Error('no provider adapter'), {})]);
    const engine = createConsultationEngine({ llm, config: config(), logger: quietLogger, sleep: async () => {} });
    const tool = createAskAdvisorTool({ engine });
    const result = await tool.execute({});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ADVISOR_ROUTE_MISSING');
});

test('R-01-001/AC-03 失败后执行者可重试：下一次工具调用照常成功', async () => {
    const llm = createFakeLlm([
        failure({ code: 'ECONNRESET', message: 'boom' }),
        failure({ code: 'ECONNRESET', message: 'boom' }),
        answer('重试成功的意见。'),
    ]);
    const engine = createConsultationEngine({ llm, config: config(), logger: quietLogger, sleep: async () => {} });
    const tool = createAskAdvisorTool({ engine });
    const failed = await tool.execute({});
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'ADVISOR_FAILED');
    const retried = await tool.execute({});
    assert.equal(retried.ok, true);
    assert.ok(retried.text.includes('重试成功'));
});

test('R-01-001 工具参数校验：非法参数返回错误结果而不进入咨询', async () => {
    const llm = createFakeLlm([answer('ok')]);
    const engine = createConsultationEngine({ llm, config: config(), logger: quietLogger });
    const tool = createAskAdvisorTool({ engine });

    assert.equal((await tool.execute({ question: 42 })).ok, false);
    assert.equal((await tool.execute('not an object')).ok, false);
    assert.equal((await tool.execute({ bogus: true })).ok, false);
    assert.equal(llm.calls.length, 0); // 非法参数不发起咨询

    const ok = await tool.execute({ question: 'q', draft: 'd' });
    assert.equal(ok.ok, true);
    assert.equal(llm.calls.length, 1);
    assert.ok(llm.calls[0].options.messages[0].content[0].text.includes('q'));
    assert.ok(llm.calls[0].options.messages[0].content[0].text.includes('d'));
});

test('R-01-001/AC-01 工具定义携带 output {schema, render}——宿主 tools.register 强制契约（T-008 实测回归钉住）', () => {
    const tool = createAskAdvisorTool({ engine: { consult: async () => ({ ok: true, adviceId: 'a', severity: 'nit', text: 't' }) } });
    // 宿主注册校验（dsh-tools 0.1.5-rc.2）：定义缺 output {schema, render} 即 TypeError
    assert.throws(() => validateHostRegister({ name: 'broken', parameters: {}, execute() {} }), TypeError);
    // 插件工具体满足契约：可过宿主校验，render 出 text 块
    const registered = validateHostRegister(tool);
    assert.equal(registered.name, 'ask_advisor');
    assert.ok(tool.output.schema, 'output.schema 随定义声明');
    const blocks = tool.output.render({}, { ok: true, adviceId: 'adv-1', severity: 'nit', text: '意见正文。' });
    assert.deepEqual(blocks, [{ type: 'text', text: '意见正文。\n（adviceId: adv-1）' }]); // adviceId 随渲染输出（staging 实测裁决：结果必须可回查）
    const failureBlocks = tool.output.render({}, { ok: false, code: 'NO_ADVISOR_MODEL', reason: 'advisor 模型未配置' });
    assert.equal(failureBlocks[0].type, 'text');
    assert.ok(failureBlocks[0].text.includes('NO_ADVISOR_MODEL'));
    const emptyBlocks = tool.output.render({}, undefined);
    assert.equal(emptyBlocks[0].text, '顾问未返回内容');
});

/**
 * 宿主 tools.register 的注册校验桩（dsh-tools 0.1.5-rc.2 实测形状）：
 * 定义必须有 `output { schema, render }`，缺失即 TypeError。
 */
function validateHostRegister(definition) {
    if (!definition || typeof definition !== 'object' || !definition.output
        || !definition.output.schema || typeof definition.output.render !== 'function') {
        throw new TypeError('tool definition must declare output { schema, render }');
    }
    return definition;
}
