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
    assert.equal(result.error, undefined);
    assert.equal(result.adviceId, 'adv-1');
    assert.ok(result.content.includes('先补测试'));
    assert.equal(result.severity, 'nit');

    // 零参调用 → 一般性评审
    const general = await tool.execute({});
    assert.equal(general.adviceId, 'adv-2');
});

test('R-01-001/AC-02 未配置模型时工具返回可诊断错误，不抛出异常', async () => {
    const llm = createFakeLlm([]);
    const disabled = resolveAdvisorFlowConfig({ enabled: false }).config;
    const engine = createConsultationEngine({ llm, config: disabled, logger: quietLogger });
    const tool = createAskAdvisorTool({ engine });
    const result = await tool.execute({ question: 'q' });
    assert.equal(result.error, true);
    assert.equal(result.code, 'NO_ADVISOR_MODEL');
    assert.ok(typeof result.message === 'string' && result.message.length > 0);
});

test('R-01-001/AC-02 路由失败与失败分类经工具面转译为诊断码', async () => {
    const llm = createFakeLlm([failure(new Error('no provider adapter'), {})]);
    const engine = createConsultationEngine({ llm, config: config(), logger: quietLogger, sleep: async () => {} });
    const tool = createAskAdvisorTool({ engine });
    const result = await tool.execute({});
    assert.equal(result.error, true);
    assert.equal(result.code, 'ADVISOR_ROUTE_MISSING');
});

test('R-01-001 AC-03 失败后执行者可重试：下一次工具调用照常成功', async () => {
    const llm = createFakeLlm([
        failure({ code: 'ECONNRESET', message: 'boom' }),
        failure({ code: 'ECONNRESET', message: 'boom' }),
        answer('重试成功的意见。'),
    ]);
    const engine = createConsultationEngine({ llm, config: config(), logger: quietLogger, sleep: async () => {} });
    const tool = createAskAdvisorTool({ engine });
    const failed = await tool.execute({});
    assert.equal(failed.error, true);
    assert.equal(failed.code, 'ADVISOR_FAILED');
    const retried = await tool.execute({});
    assert.equal(retried.error, undefined);
    assert.ok(retried.content.includes('重试成功'));
});

test('R-01-001 工具参数校验：非法参数返回错误结果而不进入咨询', async () => {
    const llm = createFakeLlm([answer('ok')]);
    const engine = createConsultationEngine({ llm, config: config(), logger: quietLogger });
    const tool = createAskAdvisorTool({ engine });

    assert.equal((await tool.execute({ question: 42 })).error, true);
    assert.equal((await tool.execute('not an object')).error, true);
    assert.equal((await tool.execute({ bogus: true })).error, true);
    assert.equal(llm.calls.length, 0); // 非法参数不发起咨询

    const ok = await tool.execute({ question: 'q', draft: 'd' });
    assert.equal(ok.error, undefined);
    assert.equal(llm.calls.length, 1);
    assert.ok(llm.calls[0].options.messages[0].content.includes('q'));
    assert.ok(llm.calls[0].options.messages[0].content.includes('d'));
});
