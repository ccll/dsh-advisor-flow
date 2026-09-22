import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdvisorFlowConfig } from '../lib/config.js';
import { createConsultationEngine, parseAdvice, ADVISOR_SYSTEM_PROMPT } from '../lib/consultation.js';
import { createUsageLedger } from '../lib/usage.js';
import { createFakeLlm, answer, failure, hung, createManualTimers, pump } from './helpers.js';

/** Build a ready-to-use engine config: enabled, provider/model set. */
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

test('R-01-001/AC-01 咨询成功返回含 adviceId 的意见文本，adviceId 会话内递增', async () => {
    const llm = createFakeLlm([
        answer('第一点：注意边界条件。'),
        answer('severity: concern\n重试策略会放大故障。'),
        answer('第三条意见。'),
    ]);
    const engine = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger });

    const first = await engine.consult({ entry: 'tool', question: '这个方案稳吗？' });
    assert.equal(first.ok, true);
    assert.equal(first.adviceId, 'adv-1');
    assert.ok(first.text.includes('边界条件'));
    assert.equal(first.severity, 'nit'); // 顾问未显式声明 → 缺省 nit

    const second = await engine.consult({ entry: 'tool', question: '还有吗？' });
    assert.equal(second.severity, 'concern'); // 顾问显式声明优先

    const third = await engine.consult({ entry: 'manual' });
    assert.equal(third.adviceId, 'adv-3');

    // 调用形状：provider/model/system/messages:[user]/maxTokens/signal，无 purpose
    const call = llm.calls[0];
    assert.equal(call.options.provider, 'test');
    assert.equal(call.options.model, 'test-model');
    assert.equal(call.options.system, ADVISOR_SYSTEM_PROMPT);
    assert.equal(call.options.messages.length, 1);
    assert.ok(call.options.messages[0].content.includes('这个方案稳吗？'));
    assert.equal(typeof call.options.maxTokens, 'number');
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(call.options.reasoningEffort, undefined);
    assert.equal('purpose' in call.options, false);
});

test('R-01-001/AC-02 路由不存在（NO_ADAPTER）返回可诊断的 ADVISOR_ROUTE_MISSING', async () => {
    const llm = createFakeLlm([failure(new Error('no provider adapter for route'), {})]);
    const engine = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger });
    const result = await engine.consult({ entry: 'tool', question: 'q' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ADVISOR_ROUTE_MISSING');
    // 永久失败后停机：后续咨询同样可诊断
    const again = await engine.consult({ entry: 'tool', question: 'q' });
    assert.equal(again.code, 'ADVISOR_HALTED');
});

test('R-01-001/AC-03 单次失败只终止当次咨询；transient 重试 1 次后成功', async () => {
    const llm = createFakeLlm([
        failure({ code: 'ECONNRESET', message: 'connection reset' }),
        answer('重试后成功的意见。'),
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
    assert.equal(result.ok, true);
    assert.equal(llm.calls.length, 2); // 首次失败 + 1 次重试（重试预算耗尽前成功）
    assert.deepEqual(sleeps, [1000]); // 1s 退避
    const next = await engine.consult({ entry: 'tool', question: 'again' });
    assert.equal(next.ok, true);
});

test('R-01-001/AC-03 transient 重试耗尽后丢弃当次且不抛出，随后的咨询不受影响', async () => {
    const llm = createFakeLlm([
        failure({ code: 'ECONNRESET', message: 'boom' }),
        failure({ code: 'ECONNRESET', message: 'boom' }),
        answer('恢复后的意见。'),
    ]);
    const logs = [];
    const engine = createConsultationEngine({
        llm,
        config: resolvedConfig(),
        logger: {
            info: (message, fields) => logs.push({ message, fields }),
            warn() {},
        },
        sleep: async () => {},
    });
    const result = await engine.consult({ entry: 'tool', question: 'q' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ADVISOR_FAILED');
    const recovered = await engine.consult({ entry: 'tool', question: 'q2' });
    assert.equal(recovered.ok, true);
    assert.equal(llm.calls.length, 3);
});

test('R-02-005/AC-01 整调用超时按 transient 收敛：重试后丢弃，consult 不抛出（假 clock）', async () => {
    const llm = createFakeLlm([hung(), hung(), answer('超时后恢复。')]);
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
    await pump(); // 第一次尝试挂起，deadline timer 已排定
    timers.advance(200); // 触发第一次超时
    await pump(); // 重试（退避已注入为即时）→ 第二次挂起
    timers.advance(200); // 触发第二次超时 → 重试预算耗尽 → 丢弃
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ADVISOR_TIMEOUT');
    assert.match(result.reason, /timed out/);
    assert.equal(timers.pendingCount(), 0); // deadline timer 已清理
    // 主循环继续：下一次咨询照常可用（真返回，无需推进时钟）
    const next = await engine.consult({ entry: 'tool', question: 'q2' });
    assert.equal(next.ok, true);
    // 挂起的流被尝试收尾（iterator.return 被调用），不悬挂
    assert.ok(llm.calls[0].returned && llm.calls[1].returned);
});

test('R-02-005/AC-01 任何失败路径都不得向调用方抛出未处理异常', async () => {
    // llm.stream 同步抛错
    const throwing = { stream() { throw new Error('sync boom'); } };
    const engineA = createConsultationEngine({ llm: throwing, config: resolvedConfig(), logger: quietLogger, sleep: async () => {} });
    const a = await engineA.consult({ entry: 'tool' });
    assert.equal(a.ok, false);
    assert.equal(a.code, 'ADVISOR_FAILED');

    // 垃圾入参：null 请求回落默认 tool 入口照常执行；未知入口回落 tool
    const llm = createFakeLlm([answer('ok'), answer('ok')]);
    const engineB = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger });
    assert.equal((await engineB.consult(null)).ok, true);
    assert.equal((await engineB.consult({ entry: 'bogus' })).ok, true);
});

test('R-02-003/AC-01 丢弃/超时/停机留 info 级记录，含原因与入口类型', async () => {
    const infos = [];
    const llm = createFakeLlm([
        failure({ code: 'ECONNRESET', message: 'boom once' }),
        failure({ code: 'ECONNRESET', message: 'boom twice' }),
    ]);
    const engine = createConsultationEngine({
        llm,
        config: resolvedConfig(),
        logger: { info: (message, fields) => infos.push({ message, fields }), warn() {} },
        sleep: async () => {},
    });
    await engine.consult({ entry: 'tool', question: 'q' });
    assert.equal(infos.length, 1);
    assert.match(infos[0].fields.reason, /boom twice/);
    assert.equal(infos[0].fields.entry, 'tool');
    assert.ok(typeof infos[0].fields.session === 'string');
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

test('R-01-001 effort 能力门控：resolveModelInfo 缺失或抛错时不发送且不缓存失败', async () => {
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

    // 缺失：不发送；方法缺席是确定性判定（可缓存）
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

test('R-01-001 同会话咨询串行（FIFO），满则丢新并记录', async () => {
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
        sleep: async () => {},
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

test('R-01-001 quota 失败使顾问暂停；resume 后恢复', async () => {
    const llm = createFakeLlm([
        failure({ code: 'QUOTA_EXCEEDED', message: 'quota exhausted' }),
        answer('恢复后的意见。'),
        answer('再次受限。'),
        answer('再次恢复。'),
    ]);
    const engine = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger, sleep: async () => {} });

    const paused = await engine.consult({ entry: 'tool', question: 'q' });
    assert.equal(paused.ok, false);
    assert.equal(paused.code, 'ADVISOR_PAUSED');

    // 暂停期间新咨询被拒（不排队等待，非阻断）
    const rejected = await engine.consult({ entry: 'tool', question: 'q2' });
    assert.equal(rejected.code, 'ADVISOR_PAUSED');

    engine.resume();
    const resumed = await engine.consult({ entry: 'tool', question: 'q3' });
    assert.equal(resumed.ok, true);
});

test('R-01-001 永久失败（模型不存在）使顾问停机，后续咨询返回 ADVISOR_HALTED', async () => {
    const llm = createFakeLlm([
        failure({ code: 'UNKNOWN', message: 'model not found: test-model' }),
        answer('never'),
    ]);
    const engine = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger, sleep: async () => {} });
    const halted = await engine.consult({ entry: 'tool', question: 'q' });
    assert.equal(halted.code, 'ADVISOR_HALTED');
    const after = await engine.consult({ entry: 'tool', question: 'q2' });
    assert.equal(after.code, 'ADVISOR_HALTED');
    assert.equal(llm.calls.length, 1); // 停机后不再发起调用
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
    assert.equal(totals.total.cacheTokens, 'unavailable'); // 提供方未给出 → 不可得
    assert.equal(totals.byEntry.manual.calls, 1);
    assert.equal(totals.byEntry.manual.inputTokens, 'unavailable');
});

test('R-01-001 recordOutcome 向终态咨询追加采纳结果', async () => {
    const llm = createFakeLlm([answer('意见一。')]);
    const engine = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger });
    const result = await engine.consult({ entry: 'tool' });
    assert.equal(engine.recordOutcome(result.adviceId, 'adopted-partially'), true);
    assert.equal(engine.recordOutcome('adv-999', 'x'), false);
    const statusRows = engine.status();
    assert.equal(statusRows[0].consultations, 1);
    assert.equal(statusRows[0].runtime, 'active');
});

test('R-01-001 咨询素材经隐私裁剪与脱敏后发送（引擎集成）', async () => {
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
    const sent = llm.calls[0].options.messages[0].content;
    assert.ok(!sent.includes('supersecret123'));
    assert.ok(sent.includes('token: [REDACTED]'));
    assert.ok(!sent.includes('仓库摘要'));
    assert.ok(sent.includes('没有仓库访问'));
    assert.ok(!sent.includes('sk-Abc12345_-XYZ98765'));
    assert.ok(sent.includes('a.js（文件内容未授权外发'));
    assert.ok(sent.includes('评审这个配置'));
});

test('R-01-001 parseAdvice：severity 显式声明生效，缺省 nit', () => {
    assert.equal(parseAdvice('severity: blocker\n先停下').severity, 'blocker');
    assert.equal(parseAdvice('SEVERITY = "concern"').severity, 'concern');
    assert.equal(parseAdvice('普通意见，未声明严重度').severity, 'nit');
    assert.equal(parseAdvice('severity: 看情况').severity, 'nit');
    assert.equal(parseAdvice(undefined).severity, 'nit');
});

test('R-01-001/AC-01 宽松 JSON 兼容：JSON 帧回复提取 note/severity 转自由文本', async () => {
    const llm = createFakeLlm([
        answer('前置说明\n```json\n{"note": "建议先补集成测试再合并。", "severity": "concern"}\n```\n后缀'),
        answer('{"note": "  ", "severity": "blocker"}\n其实 severity: blocker\n正文意见。'),
        answer('{"other": 1} 不是意见帧'),
    ]);
    const engine = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger });

    const framed = await engine.consult({ entry: 'tool', question: 'q' });
    assert.equal(framed.ok, true);
    assert.equal(framed.severity, 'concern');
    assert.equal(framed.text, '建议先补集成测试再合并。'); // 不再透传 JSON 原文
    assert.ok(!framed.text.includes('{'));

    // note 为空的帧不采纳 → 回落自由文本路径（severity 行 + 全文）
    const fallback = await engine.consult({ entry: 'tool' });
    assert.equal(fallback.severity, 'blocker');
    assert.ok(fallback.text.includes('正文意见。'));

    // 无 note 字段的 JSON 只是普通文本，不当作帧
    const plain = await engine.consult({ entry: 'tool' });
    assert.equal(plain.severity, 'nit');
    assert.ok(plain.text.includes('{"other": 1}'));

    // 单元面：解析函数直接断言
    assert.deepEqual(parseAdvice('{"note":"意见A","severity":"BLOCKER"}'), { text: '意见A', severity: 'blocker' });
    assert.equal(parseAdvice('{"note":"意见B"}').severity, 'nit');
    assert.equal(parseAdvice('{"note":"意见C","severity":"catastrophic"}').severity, 'nit');
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

test('R-01-001/AC-03 重试预算按配置生效：retryAttempts=2 瞬态失败重试 2 次', async () => {
    // 预算内成功：3 次尝试（首试 + 2 次重试），第 3 次成功
    const llm = createFakeLlm([
        failure({ code: 'ECONNRESET', message: 'boom-1' }),
        failure({ code: 'ECONNRESET', message: 'boom-2' }),
        answer('第三次成功的意见。'),
    ]);
    const engine = createConsultationEngine({
        llm,
        config: resolvedConfig({ advisor: { retryAttempts: 2 } }),
        logger: quietLogger,
        sleep: async () => {},
    });
    const ok = await engine.consult({ entry: 'tool', question: 'q' });
    assert.equal(ok.ok, true);
    assert.equal(llm.calls.length, 3);

    // 预算耗尽：3 次全失败 → 丢弃当次（不抛出），丢弃记录携带 retryAttempts
    const infos = [];
    const llm2 = createFakeLlm([
        failure({ code: 'ECONNRESET', message: 'boom-a' }),
        failure({ code: 'ECONNRESET', message: 'boom-b' }),
        failure({ code: 'ECONNRESET', message: 'boom-c' }),
    ]);
    const engine2 = createConsultationEngine({
        llm: llm2,
        config: resolvedConfig({ advisor: { retryAttempts: 2 } }),
        logger: { info: (m, f) => infos.push({ m, f }), warn() {} },
        sleep: async () => {},
    });
    const dropped = await engine2.consult({ entry: 'manual', question: 'q' });
    assert.equal(dropped.ok, false);
    assert.equal(dropped.code, 'ADVISOR_FAILED');
    assert.equal(llm2.calls.length, 3);
    assert.ok(infos.some((entry) => entry.f.entry === 'manual' && entry.f.retryAttempts === 2));
});

test('R-02-005/AC-01 调用方取消中止后，排队咨询按丢弃策略收敛而非悬挂', async () => {
    const llm = createFakeLlm([
        { hangUntilReleased: true, chunks: [{ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }] },
        answer('never'),
        answer('never'),
    ]);
    const infos = [];
    const engine = createConsultationEngine({
        llm,
        config: resolvedConfig(),
        logger: { info: (m, f) => infos.push({ m, f }), warn() {} },
        maxQueued: 2,
        sleep: async () => {},
    });
    const controller = new AbortController();
    const first = engine.consult({ entry: 'tool', question: 'first', signal: controller.signal });
    const second = engine.consult({ entry: 'tool', question: 'second' });
    await pump(2);
    assert.equal(engine.pendingCount, 2); // first 进行中 + second 排队

    controller.abort(new Error('caller cancelled'));
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.ok, false);
    assert.equal(firstResult.code, 'ADVISOR_FAILED');
    assert.equal(secondResult.ok, false); // 排队者被收敛，而非悬挂
    assert.equal(secondResult.code, 'ADVISOR_FAILED');
    assert.equal(engine.pendingCount, 0);
    assert.ok(infos.some((entry) => entry.f.entry === 'tool' && /丢弃|收敛/.test(entry.f.reason)));
    // 引擎仍可用
    const after = await engine.consult({ entry: 'tool', question: 'again' });
    assert.equal(after.ok, true);
});

test('R-01-002/AC-01 手动入口携带聚焦词时咨询素材包含该聚焦词', async () => {
    const llm = createFakeLlm([answer('手动评审意见。')]);
    const engine = createConsultationEngine({ llm, config: resolvedConfig(), logger: quietLogger });
    const result = await engine.consult({ entry: 'manual', question: '聚焦：审查重试退避策略' });
    assert.equal(result.ok, true);
    const sent = llm.calls[0].options.messages[0].content;
    assert.ok(sent.includes('聚焦：审查重试退避策略'));
    assert.equal(llm.calls[0].options.messages.length, 1);
});

test('手动咨询进行中可取消：取消返回诊断且不留用量副作用（进行状态可见属命令面，不锚定 AC）', async () => {
    const ledger = createUsageLedger();
    const llm = createFakeLlm([{ hangUntilReleased: true, chunks: [{ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }] }, answer('恢复后意见。')]);
    const engine = createConsultationEngine({
        llm,
        config: resolvedConfig(),
        logger: quietLogger,
        usageLedger: ledger,
        sleep: async () => {},
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
