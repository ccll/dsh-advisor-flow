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
    assert.match(result.adviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/); // R-01-001/AC-05：UUID 形态

    // 零参调用 → 一般性评审
    const general = await tool.execute({});
    assert.equal(general.ok, true);
    assert.notEqual(general.adviceId, result.adviceId); // UUID 互不相同
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

test('R-01-001/AC-02 路由失败经工具面转译为可诊断错误（无重试无停机）', async () => {
    const llm = createFakeLlm([failure(new Error('no provider adapter'), {})]);
    const engine = createConsultationEngine({ llm, config: config(), logger: quietLogger });
    const tool = createAskAdvisorTool({ engine });
    const result = await tool.execute({});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ADVISOR_FAILED');
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
});

test('R-01-001/AC-03 失败后执行者可重试：下一次工具调用单次尝试照常成功', async () => {
    const llm = createFakeLlm([
        failure({ code: 'ECONNRESET', message: 'boom' }),
        answer('重试成功的意见。'),
    ]);
    const engine = createConsultationEngine({ llm, config: config(), logger: quietLogger });
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
    const tool = createAskAdvisorTool({ engine: { consult: async () => ({ ok: true, adviceId: 'a', text: 't' }) } });
    // 宿主注册校验（dsh-tools 0.1.5-rc.2）：定义缺 output {schema, render} 即 TypeError
    assert.throws(() => validateHostRegister({ name: 'broken', parameters: {}, execute() {} }), TypeError);
    // 插件工具体满足契约：可过宿主校验，render 出 text 块
    const registered = validateHostRegister(tool);
    assert.equal(registered.name, 'ask_advisor');
    assert.ok(tool.output.schema, 'output.schema 随定义声明');
    const blocks = tool.output.render({}, { ok: true, adviceId: 'adv-1', text: '意见正文。', model: 'test/test-model' });
    // R-01-001/AC-05：结果文本以 `Advisor (model)` 前缀起始并附意见全文；adviceId 随渲染输出（staging 实测裁决：结果必须可回查）
    assert.deepEqual(blocks, [{ type: 'text', text: 'Advisor (test/test-model)\n\n意见正文。\n（adviceId: adv-1）' }]);
    const failureBlocks = tool.output.render({}, { ok: false, code: 'NO_ADVISOR_MODEL', reason: 'advisor 模型未配置' });
    assert.equal(failureBlocks[0].type, 'text');
    assert.ok(failureBlocks[0].text.includes('NO_ADVISOR_MODEL'));
    const emptyBlocks = tool.output.render({}, undefined);
    assert.equal(emptyBlocks[0].text, '(Advisor returned no advice.)'); // pi renderAdvisorResult 兜底文案
});

test('R-01-001/AC-09 工具面守卫拒绝短路：拒绝结果返回且不进入咨询（guard 接线）', async () => {
    const llm = createFakeLlm([answer('不应被调用的意见。')]);
    const engine = createConsultationEngine({ llm, config: config(), logger: quietLogger });
    const tool = createAskAdvisorTool({
        engine,
        guard: async () => ({ code: 'SESSION_EXEMPT', reason: 'refused by guard' }),
    });
    const result = await tool.execute({}, { agent: { id: 'review-child' } });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SESSION_EXEMPT');
    assert.equal(result.reason, 'refused by guard');
    assert.equal(llm.calls.length, 0); // 守卫命中：不发起咨询
    // 守卫放行（undefined）→ 照常咨询。
    const openTool = createAskAdvisorTool({
        engine,
        guard: async () => undefined,
    });
    const allowed = await openTool.execute({ question: 'q' });
    assert.equal(allowed.ok, true);
    assert.equal(llm.calls.length, 1);
});

test('R-01-001/AC-09、AC-10 拒绝码渲染：SESSION_EXEMPT 与 TOOL_FACE_CLOSED 经既有失败面呈现', () => {
    const tool = createAskAdvisorTool({ engine: { consult: async () => ({ ok: true, adviceId: 'a', text: 't' }) } });
    for (const code of ['SESSION_EXEMPT', 'TOOL_FACE_CLOSED']) {
        const blocks = tool.output.render({}, { ok: false, code, reason: 'This refusal is expected; do not retry ask_advisor.' });
        assert.equal(blocks[0].type, 'text');
        assert.ok(blocks[0].text.includes(code));
        assert.ok(blocks[0].text.includes('do not retry ask_advisor'));
    }
});

test('R-01-010/AC-01、AC-03 配置副顾问时工具 value 为 {ok:true,batchId,results}；未配置时旧 value 契约逐字不变', async () => {
    const dualLlm = createFakeLlm([answer('主顾问意见。'), answer('副顾问意见。')]);
    const dualResolved = resolveAdvisorFlowConfig({
        enabled: true,
        advisor: { provider: 'test', model: 'm' },
        secondaryAdvisor: { provider: 'test2', model: 'm2' },
    });
    assert.equal(dualResolved.ok, true, dualResolved.error ?? '');
    const dualEngine = createConsultationEngine({ llm: dualLlm, config: dualResolved.config, logger: quietLogger });
    const dualTool = createAskAdvisorTool({ engine: dualEngine });
    const dual = await dualTool.execute({ question: '这个方案稳吗？' });
    assert.equal(dual.ok, true);
    assert.match(dual.batchId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(dual.results.length, 2);
    assert.equal(dual.results[0].text, '主顾问意见。');
    assert.equal(dual.results[0].model, 'test/m');
    assert.equal(dual.results[1].text, '副顾问意见。');
    assert.equal(dual.results[1].model, 'test2/m2');
    assert.equal(dualLlm.calls.length, 2);
    assert.match(dual.results[0].adviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/); // 每家独立意见 UUID
    assert.match(dual.results[1].adviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(dual.results[1].adviceId, dual.results[0].adviceId);

    // 旧契约：无副顾问时 value 形态逐字不变（无 batchId/results 键）
    const legacyLlm = createFakeLlm([answer('旧形态意见。')]);
    const legacyResolved = resolveAdvisorFlowConfig({ enabled: true, advisor: { provider: 'test', model: 'm' } });
    const legacyEngine = createConsultationEngine({ llm: legacyLlm, config: legacyResolved.config, logger: quietLogger });
    const legacyTool = createAskAdvisorTool({ engine: legacyEngine });
    const legacy = await legacyTool.execute({ question: 'q' });
    assert.equal(legacy.ok, true);
    assert.deepEqual(Object.keys(legacy).sort(), ['adviceId', 'model', 'ok', 'text']);
    assert.equal(legacy.batchId, undefined);
    assert.equal(legacy.results, undefined);
    assert.equal(legacyLlm.calls.length, 1);
});

test('R-01-010/AC-03 双顾问 render 按模型分块展示：成功块附 adviceId、失败块带 code/reason 标记与批次行；旧 render 形态回归', () => {
    const tool = createAskAdvisorTool({ engine: { consult: async () => ({ ok: true }) } });
    const batchId = '11111111-2222-4333-8444-555555555555';
    const blocks = tool.output.render({}, {
        ok: true,
        batchId,
        results: [
            { ok: true, adviceId: 'aaaaaaaa-0000-4000-8000-000000000001', text: '主顾问意见。', model: 'test/m' },
            { ok: false, code: 'ADVISOR_TIMEOUT', reason: 'advisor call timed out after 100ms', model: 'test2/m2' },
        ],
    });
    assert.deepEqual(blocks, [
        { type: 'text', text: 'Advisor (test/m)\n\n主顾问意见。\n（adviceId: aaaaaaaa-0000-4000-8000-000000000001）' },
        { type: 'text', text: 'Advisor (test2/m2) failed (ADVISOR_TIMEOUT): advisor call timed out after 100ms' },
        { type: 'text', text: `（batchId: ${batchId}）` },
    ]);
    // output schema 增补 batchId/results（宿主注册契约 output {schema, render} 不变）
    assert.equal(tool.output.schema.properties.batchId.type, 'string');
    assert.equal(tool.output.schema.properties.results.type, 'array');
    assert.equal(tool.output.schema.additionalProperties, false);
    // 旧单顾问 render 逐字回归
    const legacyBlocks = tool.output.render({}, { ok: true, adviceId: 'adv-1', text: '意见正文。', model: 'test/m' });
    assert.deepEqual(legacyBlocks, [{ type: 'text', text: 'Advisor (test/m)\n\n意见正文。\n（adviceId: adv-1）' }]);
    // 双顾问全失败经工具面沿用旧失败渲染（{ok:false,code,reason} 无 results 时不走分块）
    const bothFailed = tool.output.render({}, { ok: false, code: 'ADVISOR_FAILED', reason: 'primary down（副顾问亦失败：secondary down）' });
    assert.equal(bothFailed[0].type, 'text');
    assert.ok(bothFailed[0].text.includes('ADVISOR_FAILED'));
    assert.ok(bothFailed[0].text.includes('primary down'));
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
