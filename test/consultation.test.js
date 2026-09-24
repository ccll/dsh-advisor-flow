import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdvisorFlowConfig } from '../lib/config.js';
import { createConsultationEngine, parseAdvice, ADVISOR_SYSTEM_PROMPT, ADVISOR_DECISION_SYSTEM } from '../lib/consultation.js';
import { createUsageLedger } from '../lib/usage.js';
import { createFakeLlm, answer, failure, hung, createManualTimers, pump } from './helpers.js';

/** 构造就绪引擎配置：enabled + provider/model 齐备。 */
function resolvedConfig({ advisor = {}, ...rest } = {}) {
    const raw = {
        enabled: true,
        ...rest,
        advisor: { provider: 'test', model: 'test-model', callTimeoutMs: 200, ...advisor },
    };
    const result = resolveAdvisorFlowConfig(raw);
    assert.equal(result.ok, true, `test config must resolve: ${result.error}`);
    return result.config;
}

const quietLogger = { info() {}, warn() {}, debug() {} };

test('R-01-001/AC-01 咨询成功返回含 adviceId 的意见文本（无 severity），adviceId 会话内递增', async () => {
    const llm = createFakeLlm([
        answer('第一点：注意边界条件。'),
        answer('第二点：注意重试策略。'),
    ]);
    const engine = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger });
    const first = await engine.consult({ entry: 'tool', question: '这个方案稳吗？' });
    assert.equal(first.ok, true);
    assert.equal(first.adviceId, 'adv-1');
    assert.ok(first.text.includes('边界条件'));
    assert.equal(first.severity, undefined); // C-007：无 severity 分级
    const second = await engine.consult({ entry: 'manual' });
    assert.equal(second.adviceId, 'adv-2');
    const call = llm.calls[0];
    assert.equal(call.options.provider, 'test');
    assert.equal(call.options.model, 'test-model');
    assert.equal(call.options.system, ADVISOR_SYSTEM_PROMPT);
    assert.equal(call.options.messages.length, 1);
    assert.ok(call.options.messages[0].content[0].text.includes('这个方案稳吗？'));
    assert.equal(typeof call.options.maxTokens, 'number');
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(call.options.reasoningEffort, undefined);
    assert.equal('purpose' in call.options, false);
});

test('R-01-001/AC-02 路由不存在（NO_ADAPTER）返回可诊断的失败结果，失败只影响当次', async () => {
    const llm = createFakeLlm([failure(new Error('no provider adapter for route'), {})]);
    const engine = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger });
    const result = await engine.consult({ entry: 'tool', question: 'q' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ADVISOR_FAILED');
    assert.match(result.reason, /咨询失败/);
    assert.equal(llm.calls.length, 1); // 单次尝试：无重试
    // 单次失败不影响后续：下一次咨询照常发起单次调用并成功（R-01-001/AC-03）
    const recovered = createConsultationEngine({ llm: createFakeLlm([answer('恢复后的意见。')]), config: resolvedConfig(), logger: quietLogger });
    const again = await recovered.consult({ entry: 'tool', question: 'q2' });
    assert.equal(again.ok, true);
});

test('C-007 无重试语义：失败即收敛，不调用 sleep 重试，随后的咨询不受影响', async () => {
    const llm = createFakeLlm([
        failure({ code: 'ECONNRESET', message: 'connection reset' }),
        answer('下一次咨询照常工作。'),
    ]);
    const sleeps = [];
    const engine = createConsultationEngine({
        llm,
        config: resolvedConfig(),
        logger: quietLogger,
        sleep: async (ms) => { sleeps.push(ms); },
    });
    const result = await engine.consult({ entry: 'tool', question: 'q' });
    assert.equal(result.ok, false);
    assert.equal(llm.calls.length, 1); // 单次尝试：失败即收敛（无重试）
    assert.deepEqual(sleeps, []); // 无重试 → 不调用 sleep 退避
    const next = await engine.consult({ entry: 'tool', question: 'again' });
    assert.equal(next.ok, true);
});

test('R-02-005/AC-01 整调用超时按单次尝试收敛：consult 不抛出，deadline timer 已清理（假 clock）', async () => {
    const llm = createFakeLlm([hung(), answer('超时后恢复。')]);
    const timers = createManualTimers();
    const engine = createConsultationEngine({
        llm,
        config: resolvedConfig({ advisor: { callTimeoutMs: 200 } }),
        logger: quietLogger,
        sleep: async () => {},
        timers,
        clock: timers.clock,
    });
    const pending = engine.consult({ entry: 'tool', question: 'q' });
    await pump(); // 挂起的流已进入 deadline race
    timers.advance(200); // 触发整调用超时 → 单次收敛为失败
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ADVISOR_TIMEOUT');
    assert.match(result.reason, /timed out/);
    assert.equal(timers.pendingCount(), 0); // deadline timer 已清理
    // 主循环继续：下一次咨询照常可用
    const next = await engine.consult({ entry: 'tool', question: 'q2' });
    assert.equal(next.ok, true);
    assert.ok(llm.calls[0].returned); // 挂起的流被尝试收尾，不悬挂
});

test('R-02-005/AC-01 任何失败路径都不得向调用方抛出未处理异常', async () => {
    // llm.stream 同步抛错
    const throwing = { stream() { throw new Error('sync boom'); } };
    const engineA = createConsultationEngine({ llm: throwing, config: resolvedConfig(), logger: quietLogger });
    const a = await engineA.consult({ entry: 'tool' });
    assert.equal(a.ok, false);
    assert.equal(a.code, 'ADVISOR_FAILED');

    // 垃圾入参：null 请求回落默认 tool 入口照常执行；未知入口回落 tool
    const llm = createFakeLlm([answer('ok'), answer('ok')]);
    const engineB = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger });
    assert.equal((await engineB.consult(null)).ok, true);
    assert.equal((await engineB.consult({ entry: 'bogus' })).ok, true);
});

test('R-02-003/AC-01 丢弃/超时留 info 级记录，含原因与入口类型（失败显性化）', async () => {
    const infos = [];
    const llm = createFakeLlm([failure({ code: 'ECONNRESET', message: 'boom once' })]);
    const engine = createConsultationEngine({
        llm,
        config: resolvedConfig(),
        logger: { info: (message, fields) => infos.push({ message, fields }), warn() {} },
    });
    await engine.consult({ entry: 'tool', question: 'q' });
    assert.equal(infos.length, 1);
    assert.match(infos[0].fields.reason, /boom once/);
    assert.equal(infos[0].fields.entry, 'tool');
    assert.ok(typeof infos[0].fields.session === 'string');
});

test('R-01-001 同会话咨询串行（FIFO），满则丢新并记录；门入口队列满按预算耗尽类别收敛', async () => {
    const llm = createFakeLlm([
        { ...answer('first 的意见。'), hangUntilReleased: true },
        answer('排队的意见。'),
    ]);
    const infos = [];
    const engine = createConsultationEngine({
        llm,
        config: resolvedConfig(),
        logger: { info: (m, f) => infos.push({ m, f }), warn() {} },
        maxQueued: 1,
    });
    const first = engine.consult({ entry: 'tool', question: 'first' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = engine.consult({ entry: 'tool', question: 'second' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(engine.pendingCount, 2); // first 进行中 + second 排队

    // 队列容量 1 已满 → 新咨询被丢弃并记录
    const dropped = await engine.consult({ entry: 'tool', question: 'third' });
    assert.equal(dropped.ok, false);
    assert.equal(dropped.code, 'ADVISOR_FAILED');
    assert.match(dropped.reason, /队列已满/);
    assert.ok(infos.some((entry) => entry.f.reason === 'queue-full' && entry.f.entry === 'tool'));

    llm.release(0);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    assert.equal(firstResult.adviceId, 'adv-1');
    assert.equal(secondResult.adviceId, 'adv-2');
});

test('R-01-005/AC-04 门入口咨询队列满：失败带 budget-exhausted 类别（预算耗尽归类）', async () => {
    const llm = createFakeLlm([
        { ...answer('first 的意见。'), hangUntilReleased: true },
        answer('排队的意见。'),
    ]);
    const engine = createConsultationEngine({
        llm,
        config: resolvedConfig(),
        logger: quietLogger,
        maxQueued: 1,
    });
    const first = engine.consult({ entry: 'tool', session: 's1', question: 'first' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = engine.consult({ entry: 'tool', session: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const dropped = await engine.consult({ entry: 'gate', session: 's1' });
    assert.equal(dropped.ok, false);
    assert.equal(dropped.code, 'ADVISOR_FAILED');
    assert.equal(dropped.category, 'budget-exhausted'); // gate 入口丢弃 → 预算耗尽类别
    llm.release(0);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
});

test('R-01-001 effort 能力门控：仅在 resolveModelInfo 声明该档位时发送', async () => {
    const llm = createFakeLlm([answer('a'), answer('b')]);
    llm.setModelInfo({ reasoning: { efforts: [{ id: 'high' }] } });
    const engine = createConsultationEngine({
        llm,
        config: resolvedConfig({ advisor: { reasoningEffort: 'high' } }),
        logger: quietLogger,
    });
    await engine.consult({ entry: 'tool' });
    assert.equal(llm.calls[0].options.reasoningEffort, 'high');
    assert.equal(llm.modelInfoCalls.length, 1); // 判定缓存，不逐次解析

    // 模型未声明该档位 → 不发送
    llm.setModelInfo({ reasoning: { efforts: [{ id: 'low' }] } });
    const engineB = createConsultationEngine({
        llm,
        config: resolvedConfig({ advisor: { reasoningEffort: 'high' } }),
        logger: quietLogger,
    });
    await engineB.consult({ entry: 'tool' });
    assert.equal(llm.calls[1].options.reasoningEffort, undefined);
});

test('R-01-001 effort 能力门控：resolveModelInfo 抛错不缓存失败；方法缺席是确定性判定（可缓存）', async () => {
    // 抛错：不发送、不缓存（第二次咨询重新解析）
    const llmThrowing = createFakeLlm([answer('a'), answer('b')]);
    llmThrowing.setModelInfo(new Error('adapter down'), { throws: true });
    const engine = createConsultationEngine({
        llm: llmThrowing,
        config: resolvedConfig({ advisor: { reasoningEffort: 'high' } }),
        logger: quietLogger,
    });
    await engine.consult({ entry: 'tool' });
    await engine.consult({ entry: 'tool' });
    assert.equal(llmThrowing.calls[0].options.reasoningEffort, undefined);
    assert.equal(llmThrowing.calls[1].options.reasoningEffort, undefined);
    assert.equal(llmThrowing.modelInfoCalls.length, 2); // 失败未缓存

    // 方法缺席：不发送；缺席是确定性判定（可缓存）
    const inner = createFakeLlm([answer('a'), answer('b')]);
    const llmBare = { stream: inner.stream };
    const engineB = createConsultationEngine({
        llm: llmBare,
        config: resolvedConfig({ advisor: { reasoningEffort: 'high' } }),
        logger: quietLogger,
    });
    await engineB.consult({ entry: 'tool' });
    await engineB.consult({ entry: 'tool' });
    assert.equal(inner.calls[0].options.reasoningEffort, undefined);
    assert.equal(inner.calls[1].options.reasoningEffort, undefined);

    // 未配置 effort → 从不发送，也不调用 resolveModelInfo
    const llmSilent = createFakeLlm([answer('a')]);
    llmSilent.setModelInfo({ reasoning: { efforts: [{ id: 'high' }] } });
    const engineC = createConsultationEngine({ llm: llmSilent, config: resolvedConfig(), logger: quietLogger });
    await engineC.consult({ entry: 'tool' });
    assert.equal(llmSilent.calls[0].options.reasoningEffort, undefined);
    assert.equal(llmSilent.modelInfoCalls.length, 0);
});

test('R-02-001/AC-01 applyConfig 即时生效：effort 判定缓存随配置失效', async () => {
    const llm = createFakeLlm([answer('a'), answer('b'), answer('c')]);
    llm.setModelInfo({ reasoning: { efforts: [{ id: 'high' }] } });
    const engine = createConsultationEngine({
        llm,
        config: resolvedConfig({ advisor: { reasoningEffort: 'high' } }),
        logger: quietLogger,
    });
    await engine.consult({ entry: 'tool' });
    assert.equal(llm.calls[0].options.reasoningEffort, 'high');
    assert.equal(llm.modelInfoCalls.length, 1); // 同 (provider, model, effort) 命中缓存

    // 换模型：缓存键随 (provider, model, effort) 变化 → 重新解析；新路由未声明 high → 不发送
    llm.setModelInfo({ reasoning: { efforts: [{ id: 'off' }] } });
    engine.applyConfig(resolvedConfig({ advisor: { reasoningEffort: 'high', model: 'other-model' } }));
    await engine.consult({ entry: 'tool' });
    assert.equal(llm.calls[1].options.model, 'other-model');
    assert.equal(llm.calls[1].options.reasoningEffort, undefined);
    assert.equal(llm.modelInfoCalls.length, 2);

    // 同模型换 effort 档位：同样重新解析（缓存键随 effort 变化），新档位被声明 → 发送
    engine.applyConfig(resolvedConfig({ advisor: { reasoningEffort: 'off', model: 'other-model' } }));
    await engine.consult({ entry: 'tool' });
    assert.equal(llm.calls[2].options.reasoningEffort, 'off');
    assert.equal(llm.modelInfoCalls.length, 3);
});

test('R-02-002 咨询完成时用量进入台账；缺失项 unavailable（引擎集成）', async () => {
    const ledger = createUsageLedger();
    const llm = createFakeLlm([
        answer('带用量的意见。', { usage: { inputTokens: 10, outputTokens: 5 } }),
        answer('无用量的意见。'),
    ]);
    const engine = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger, usageLedger: ledger });
    await engine.consult({ entry: 'tool', question: 'q' });
    await engine.consult({ entry: 'manual' });
    const totals = ledger.totals();
    assert.equal(totals.total.calls, 2);
    assert.equal(totals.total.inputTokens, 10);
    assert.equal(totals.total.outputTokens, 5);
    assert.equal(totals.total.cacheReadTokens, 'unavailable'); // 提供方未给出 → 不可得
    assert.equal(totals.total.cacheWriteTokens, 'unavailable');
    assert.equal(totals.byEntry.manual.calls, 1);
    assert.equal(totals.byEntry.manual.inputTokens, 'unavailable');
});

test('R-01-001 recordOutcome 向终态咨询追加采纳结果；status 行含运行态与计数', async () => {
    const llm = createFakeLlm([answer('意见一。')]);
    const engine = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger });
    const result = await engine.consult({ entry: 'tool' });
    assert.equal(engine.recordOutcome(result.adviceId, 'adopted-partially'), true);
    assert.equal(engine.recordOutcome('adv-999', 'x'), false);
    const statusRows = engine.status();
    assert.equal(statusRows[0].consultations, 1);
    assert.equal(statusRows[0].runtime, 'active');
});

test('R-02-004 咨询素材经隐私裁剪与脱敏后发送（引擎集成）', async () => {
    const llm = createFakeLlm([answer('意见。')]);
    const engine = createConsultationEngine({
        llm,
        config: resolvedConfig({
            privacy: { history: 'window', repoContext: 'none', fileContent: false },
        }),
        logger: quietLogger,
    });
    await engine.consult({
        entry: 'tool',
        question: '评审这个配置',
        materials: {
            history: ['token: supersecret123'],
            repoContext: { summary: '仓库摘要' },
            files: [{ path: 'a.js', content: 'sk-Abc12345_-XYZ98765' }],
        },
    });
    const sent = llm.calls[0].options.messages[0].content[0].text;
    assert.ok(!sent.includes('supersecret123'));
    assert.ok(sent.includes('token: [REDACTED]'));
    assert.ok(!sent.includes('仓库摘要'));
    assert.ok(sent.includes('没有仓库访问'));
    assert.ok(!sent.includes('sk-Abc12345_-XYZ98765'));
    assert.ok(sent.includes('a.js（文件内容未授权外发'));
    assert.ok(sent.includes('评审这个配置'));
});

test('R-01-001 parseAdvice：JSON 帧宽松兼容提取 note，其余整体为意见（无 severity 分级）', () => {
    assert.deepEqual(parseAdvice('前置说明\n```json\n{"note": "建议先补集成测试再合并。"}\n```\n后缀'), { text: '建议先补集成测试再合并。' });
    assert.deepEqual(parseAdvice('{"other": 1} 不是意见帧'), { text: '{"other": 1} 不是意见帧' });
    assert.deepEqual(parseAdvice(undefined), { text: '' });
    assert.equal(parseAdvice('severity: blocker\n先停下').severity, undefined); // 无 severity 分级
});

test('R-01-005/AC-01 门入口 consult 走 Decision 协议：成功返回 {ok:true,adviceId,decision,markdown}', async () => {
    const llm = createFakeLlm([answer('Decision: proceed\n\n评审结论：可以继续。')]);
    const engine = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger });
    const result = await engine.consult({ entry: 'gate', session: 's1', question: '循环门触发' });
    assert.equal(result.ok, true);
    assert.equal(result.adviceId, 'adv-1');
    assert.equal(result.decision, 'proceed');
    assert.equal(result.markdown, 'Decision: proceed\n\n评审结论：可以继续。');
    assert.equal(result.entry, 'gate');
    // gate 入口走 Decision 协议系统提示（按入口切换）
    assert.equal(llm.calls[0].options.system, ADVISOR_DECISION_SYSTEM);
});

test('R-01-005/AC-04 门入口空回复：解析失败收敛为 {ok:false, code:ADVISOR_GATE_INVALID, category:empty-response}', async () => {
    const llm = createFakeLlm([answer('')]);
    const engine = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger });
    const result = await engine.consult({ entry: 'gate', session: 's1' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ADVISOR_GATE_INVALID');
    assert.equal(result.category, 'empty-response');
});

test('R-01-005/AC-04 门入口缺决策行：解析失败收敛为 {ok:false,...,category:missing-decision}', async () => {
    const llm = createFakeLlm([answer('先说结论：一切正常。')]);
    const engine = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger });
    const result = await engine.consult({ entry: 'gate', session: 's1' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ADVISOR_GATE_INVALID');
    assert.equal(result.category, 'missing-decision');
    assert.ok(result.reason.length > 0);
});

test('R-01-005/AC-04 门入口矛盾决策行：解析失败收敛为 {ok:false,...,category:contradictory-decision}', async () => {
    const llm = createFakeLlm([answer('Decision: proceed\n意见正文\nDecision: revise')]);
    const engine = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger });
    const result = await engine.consult({ entry: 'gate', session: 's1' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ADVISOR_GATE_INVALID');
    assert.equal(result.category, 'contradictory-decision');
    assert.ok(result.reason.length > 0);
});

test('R-01-005/AC-04 provider 失败：gate 入口失败带 provider-error 类别；tool 入口无 category', async () => {
    const llm = createFakeLlm([failure({ code: 'ECONNRESET', message: 'connection reset' })]);
    const engine = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger });
    const gateResult = await engine.consult({ entry: 'gate', session: 's1' });
    assert.equal(gateResult.ok, false);
    assert.equal(gateResult.code, 'ADVISOR_FAILED');
    assert.equal(gateResult.category, 'provider-error'); // gate 入口 provider 失败归类
    assert.match(gateResult.reason, /咨询失败/);

    // 对照：tool 入口的失败结果不带 category 字段
    const llmTool = createFakeLlm([failure({ code: 'ECONNRESET', message: 'connection reset' })]);
    const engineTool = createConsultationEngine({ llm: llmTool, config: resolvedConfig(), logger: quietLogger });
    const toolResult = await engineTool.consult({ entry: 'tool', question: 'q' });
    assert.equal(toolResult.ok, false);
    assert.equal(toolResult.code, 'ADVISOR_FAILED');
    assert.equal('category' in toolResult, false); // tool 入口无 category
});

test('R-01-005/AC-01 按需咨询入口走 Verdict 协议系统提示（tool 入口）', async () => {
    const llm = createFakeLlm([answer('意见。')]);
    const engine = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger });
    await engine.consult({ entry: 'tool', question: 'q' });
    assert.equal(llm.calls[0].options.system, ADVISOR_SYSTEM_PROMPT);
});

test('R-01-002/AC-01 手动入口携带聚焦词时咨询素材包含该聚焦词', async () => {
    const llm = createFakeLlm([answer('手动评审意见。')]);
    const engine = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger });
    const result = await engine.consult({ entry: 'manual', question: '聚焦：审查重试退避策略' });
    assert.equal(result.ok, true);
    const sent = llm.calls[0].options.messages[0].content[0].text;
    assert.ok(sent.includes('聚焦：审查重试退避策略'));
    assert.equal(llm.calls[0].options.messages.length, 1);
});

test('R-01-002/AC-02 手动咨询进行中可取消：取消返回诊断且不留用量副作用', async () => {
    const ledger = createUsageLedger();
    const llm = createFakeLlm([{ hangUntilReleased: true, chunks: [{ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }] }, answer('恢复后意见。')]);
    const engine = createConsultationEngine({
        llm,
        config: resolvedConfig(),
        logger: quietLogger,
        usageLedger: ledger,
    });
    const controller = new AbortController();
    const pending = engine.consult({ entry: 'manual', question: 'q', signal: controller.signal });
    await pump(2);
    controller.abort(new Error('user cancel'));
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ADVISOR_FAILED');
    assert.equal(ledger.totals().total.calls, 0); // 取消不留用量记录
    assert.equal(engine.status()[0].runtime, 'active'); // 无残留运行态副作用
    // 可再次发起
    const again = await engine.consult({ entry: 'manual', question: 'q2' });
    assert.equal(again.ok, true);
});
