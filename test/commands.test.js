import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdvisorFlowConfig } from '../lib/config.js';
import {
    advisorGatesText,
    advisorStatusText,
    createCommandController,
    parseAdvisorCommand,
    registerAdvisorFlowCommands,
} from '../lib/commands.js';
import { createConsultationEngine } from '../lib/consultation.js';
import { createUsageLedger } from '../lib/usage.js';
import { createStatusProvider } from '../lib/status.js';
import { isRecord } from '../lib/util.js';
import { createFakeLlm, answer, failure } from './helpers.js';

/** Build a controller wired to a real engine + fake llm + recorder delivery. */
function makeController({ raw = { advisor: { provider: 'test', model: 'm' } }, programs } = {}) {
    const llm = createFakeLlm(programs ?? [answer('手动评审意见。', { usage: { inputTokens: 7, outputTokens: 3 } })]);
    const config = resolveAdvisorFlowConfig(raw).config;
    const logs = { info: [], error: [] };
    const logger = {
        info: (m, f) => logs.info.push({ m, f }),
        error: (m, f) => logs.error.push({ m, f }),
        warn() {},
    };
    const usageLedger = createUsageLedger({ clock: () => 1000 });
    const engine = createConsultationEngine({ llm, config, logger, usageLedger, sleep: async () => {} });
    const delivered = [];
    const statusProvider = createStatusProvider({ config: () => config, engine, usageLedger });
    const controller = createCommandController({
        engine,
        statusProvider,
        delivery: (sessionId, advice) => delivered.push({ sessionId, advice }),
        getConfig: () => config,
        logger,
    });
    return { controller, llm, engine, usageLedger, delivered, config, statusProvider, logs };
}

const invocation = (rawInput, sessionId = 's1') => ({ rawInput, agent: { session: { id: sessionId } } });

test('R-01-002/AC-01 /advisor-manual 携带聚焦词时咨询素材包含该聚焦词，命令立即返回进行状态', async () => {
    const { controller, llm, delivered } = makeController();
    const registryCalls = [];
    const registry = { register: (spec) => registryCalls.push(spec) || (() => {}) };
    registerAdvisorFlowCommands(registry, controller);
    const manual = registryCalls.find((spec) => spec.name === 'advisor-manual');
    assert.ok(manual);

    const result = manual.handler(invocation('重点审查退避策略'));
    assert.equal(result.kind, 'success');
    assert.match(result.text, /手动咨询已发起/);
    assert.match(result.text, /进行中/); // 命令不阻塞，立即返回进行状态
    assert.equal(controller.manualRunning('s1'), true);

    // 等待咨询完成并送达（命令层不暴露 promise，以状态收敛为准）
    for (let i = 0; i < 50 && controller.manualRunning('s1'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(llm.calls.length >= 1);
    assert.ok(llm.calls[0].options.messages[0].content[0].text.includes('重点审查退避策略'));
    assert.equal(delivered.length, 1); // 意见经送达进入会话
    assert.equal(controller.manualRunning('s1'), false);
});

test('R-01-002/AC-02 手动咨询进行中状态可见且可取消，取消无用量副作用', async () => {
    const { controller, usageLedger } = makeController({
        programs: [{ hangUntilReleased: true, chunks: [{ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }] }],
    });
    const started = controller.startManual('s1', '审查重点');
    assert.equal(started.started, true);
    await new Promise((resolve) => setTimeout(resolve, 5));

    // 进行状态可见
    const statusText = advisorStatusText(controller.snapshotFor('s1'));
    assert.match(statusText, /手动咨询: 进行中/);
    assert.match(statusText, /审查重点/);

    // 取消：立即生效、无用量副作用、状态清除
    assert.equal(controller.cancelManual('s1'), true);
    const result = await started.promise;
    assert.equal(result.ok, false); // 取消返回诊断结果
    assert.equal(controller.manualRunning('s1'), false);
    assert.equal(usageLedger.totals().total.calls, 0); // 取消不留用量记录
    assert.match(advisorStatusText(controller.snapshotFor('s1')), /Advisor: enabled/);
    assert.doesNotMatch(advisorStatusText(controller.snapshotFor('s1')), /进行中/);
});

test('R-02-003/AC-02 /advisor status 展示启用态、路由、门状态、待处理、最近活动、用量摘要与降级项', async () => {
    const raw = {
        advisor: { provider: 'gpu', model: 'glm-5.3-flash' },
        gates: { plan: { enabled: true }, failure: { enabled: true }, completion: { enabled: false }, loop: { enabled: true, threshold: 5 } },
        failureMode: 'block-tool',
    };
    const { controller } = makeController({ raw });
    const registryCalls = [];
    registerAdvisorFlowCommands({ register: (spec) => registryCalls.push(spec) || (() => {}) }, controller);
    const advisor = registryCalls.find((spec) => spec.name === 'advisor');
    const result = advisor.handler(invocation(' status'));
    assert.equal(result.kind, 'success');
    const text = result.text;
    assert.match(text, /Advisor: enabled/);
    assert.match(text, /模型: gpu\/glm-5.3-flash/);
    assert.match(text, /输出上限: 跟随模型配置/); // R-02-001/AC-07：缺省呈现跟随语义（C-015）
    assert.match(text, /超时: 600000ms/); // R-02-001/AC-06：默认 10 分钟
    assert.match(text, /plan=on/);
    assert.match(text, /failure=on/);
    assert.match(text, /loop=on threshold=5/);
    assert.match(text, /completion=off/);
    assert.match(text, /待处理: 0/);
    assert.match(text, /最近活动: 无/);
    assert.match(text, /用量累计: calls=0 inputTokens=unavailable/); // 缺失项呈现不可得
    // gates 只读回读
    const gates = advisor.handler(invocation(' gates'));
    assert.match(gates.text, /门配置（只读回读）/);
    assert.match(gates.text, /plan=on/);
    assert.match(gates.text, /loop=on threshold=5/);
    assert.match(gates.text, /failureMode=block-tool/);
});

test('R-02-001/AC-03 顾问路由不完整（缺 model）时命令面给出明确原因且状态可查询（T-031/C-030 派生禁用）', async () => {
    const { controller } = makeController({ raw: { advisor: { provider: 'p' } } });
    const registryCalls = [];
    registerAdvisorFlowCommands({ register: (spec) => registryCalls.push(spec) || (() => {}) }, controller);
    const manual = registryCalls.find((spec) => spec.name === 'advisor-manual');
    const result = manual.handler(invocation(''));
    assert.equal(result.kind, 'error');
    assert.match(result.text, /advisor 模型未配置|missing-advisor-model|provider/);
    const status = advisorStatusText(controller.snapshotFor('s1'));
    assert.match(status, /Advisor: disabled/);
    assert.match(status, /原因: missing-advisor-model/);
});

test('R-01-002/AC-02 /advisor on|off 是会话级临时覆盖：立即生效且绝不写持久配置', async () => {
    const { controller, engine, config } = makeController();
    const registryCalls = [];
    registerAdvisorFlowCommands({ register: (spec) => registryCalls.push(spec) || (() => {}) }, controller);
    const advisor = registryCalls.find((spec) => spec.name === 'advisor');
    const configBefore = JSON.stringify(config);

    // off → 本会话临时关闭，manual 被拒
    const off = advisor.handler(invocation(' off'));
    assert.match(off.text, /临时关闭/);
    assert.equal(engine.sessionEnabled('s1'), false);
    const manualBlocked = registryCalls.find((spec) => spec.name === 'advisor-manual').handler(invocation(''));
    assert.equal(manualBlocked.kind, 'error');
    assert.match(manualBlocked.text, /临时关闭/);
    // 持久配置未被写入
    assert.equal(JSON.stringify(config), configBefore);

    // on → 恢复
    const on = advisor.handler(invocation(' on'));
    assert.match(on.text, /临时启用/);
    assert.equal(engine.sessionEnabled('s1'), true);
    const manualOk = registryCalls.find((spec) => spec.name === 'advisor-manual').handler(invocation(''));
    assert.equal(manualOk.kind, 'success');
    // 其他会话不受该覆盖影响
    assert.equal(engine.sessionEnabled('s2'), undefined);
    assert.equal(JSON.stringify(config), configBefore);

    // status 显示临时覆盖标记
    const status = advisor.handler(invocation(' status'));
    assert.match(status.text, /本会话开关: on（临时覆盖，不写持久配置）/);
});

test('R-01-002/AC-04 进行中重复发起：新请求中止并替换在飞（被替换方取消终态），cancel 无进行中时礼貌提示', async () => {
    const hangProgram = { hangUntilReleased: true, chunks: [{ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }] };
    const { controller } = makeController({ programs: [hangProgram, { ...hangProgram }] });
    const first = controller.startManual('s1', 'a');
    assert.equal(first.started, true);
    // 替换语义：新请求直接启动并中止在飞请求（旧契约的「重复发起被拒」退役）
    const second = controller.startManual('s1', 'b');
    assert.equal(second.started, true);
    // 被替换方以取消终态收敛（ok:false，且不误报失败通告）
    const replaced = await first.promise;
    assert.equal(replaced.ok, false);
    assert.equal(replaced.code, 'ADVISOR_FAILED');
    assert.equal(controller.manualRunning('s1'), true); // 新请求在飞
    controller.cancelManual('s1');
    const registryCalls = [];
    registerAdvisorFlowCommands({ register: (spec) => registryCalls.push(spec) || (() => {}) }, controller);
    const advisor = registryCalls.find((spec) => spec.name === 'advisor');
    const cancel = advisor.handler(invocation(' cancel'));
    assert.match(cancel.text, /没有进行中的手动咨询/);
});

test('R-01-002/AC-01 命令解析与 usage：未知子命令返回用法文本', () => {
    assert.equal(parseAdvisorCommand(' on').kind, 'on');
    assert.equal(parseAdvisorCommand('off').kind, 'off');
    assert.equal(parseAdvisorCommand('status').kind, 'status');
    assert.equal(parseAdvisorCommand('gates').kind, 'gates');
    assert.equal(parseAdvisorCommand('cancel').kind, 'cancel');
    assert.equal(parseAdvisorCommand('').kind, 'toggle');
    assert.equal(parseAdvisorCommand('bogus').kind, 'usage');
    const { controller } = makeController();
    const registryCalls = [];
    registerAdvisorFlowCommands({ register: (spec) => registryCalls.push(spec) || (() => {}) }, controller);
    const advisor = registryCalls.find((spec) => spec.name === 'advisor');
    assert.match(advisor.handler(invocation('bogus')).text, /用法: \/advisor/);
    assert.equal(advisorGatesText({}).includes('completion'), true);
});

test('R-01-002/AC-03 手动咨询失败：会话经唤醒式消息看到含原因的失败通告（pi 文案逐字）', async () => {
    const { controller, delivered } = makeController({ programs: [failure(new Error('no provider adapter for route'))] });
    controller.startManual('s1', '焦点');
    for (let i = 0; i < 50 && controller.manualRunning('s1'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(controller.manualRunning('s1'), false);
    const notify = delivered.find((entry) => typeof entry.advice === 'string');
    assert.ok(notify, '失败通告经唤醒式消息送达');
    assert.equal(notify.advice, 'Manual Advisor consultation failed: no provider adapter for route'); // pi 文案逐字
});

test('R-01-009/AC-10 status 与 gates 呈现介入强度与收口评审计数', () => {
    const { controller } = makeController({ raw: { advisor: { provider: 'p', model: 'm' }, mode: 'hard' } });
    const snapshot = controller.snapshotFor('s1');
    const text = advisorStatusText({ ...snapshot, turnReviewStats: { triggers: 2, proceed: 1, revise: 1, blocked: 0, failed: 0, skipped: 0 } });
    assert.match(text, /介入强度: hard/);
    assert.match(text, /收口评审: 触发=2 proceed=1 revise=1 blocked=0 failed=0 skipped=0/);
    const gatesText = advisorGatesText(snapshot.gates, snapshot.failureMode, snapshot.mode);
    assert.match(gatesText, /mode=hard/);
    // 软模式缺省呈现
    const softText = advisorStatusText({ ...snapshot, mode: 'soft' });
    assert.match(softText, /介入强度: soft/);
    assert.doesNotMatch(softText, /收口评审/); // 无计数访问器时不呈现（非零值虚构禁令）
});

test('R-01-001/AC-09、R-01-009/AC-13 status 呈现工具面拒绝计数与 hard 模式守则停用注记（C-025）', () => {
    const { controller } = makeController({ raw: { advisor: { provider: 'p', model: 'm' }, mode: 'hard' } });
    const snapshot = controller.snapshotFor('s1');
    // 拒绝计数：有访问器时呈现，无访问器时不呈现（非零值虚构禁令同口径）。
    const refusedText = advisorStatusText({ ...snapshot, toolFaceStats: { refused: 3, byCode: { SESSION_EXEMPT: 3 } } });
    assert.match(refusedText, /工具面拒绝: 3 次/);
    assert.doesNotMatch(advisorStatusText(snapshot), /工具面拒绝/);
    // hard 模式注记：status 与 gates 回读均如实反映守则停用。
    assert.match(refusedText, /守则: 停用/);
    const hardGates = advisorGatesText(snapshot.gates, snapshot.failureMode, 'hard');
    assert.match(hardGates, /三类守则停用/);
    const softGates = advisorGatesText(snapshot.gates, snapshot.failureMode, 'soft');
    assert.doesNotMatch(softGates, /三类守则停用/);
    const softStatus = advisorStatusText({ ...snapshot, mode: 'soft', toolFaceStats: { refused: 1, byCode: { SESSION_EXEMPT: 1 } } });
    assert.doesNotMatch(softStatus, /守则: 停用/);
});

test('R-02-007/AC-05 status 呈现子会话工具否决计数（T-035；C-034）', () => {
    const { controller } = makeController({ raw: { advisor: { provider: 'p', model: 'm' }, mode: 'hard' } });
    const snapshot = controller.snapshotFor('s1');
    // 否决计数：有访问器时呈现，无访问器时不呈现（非零值虚构禁令同口径）。
    const deniedText = advisorStatusText({ ...snapshot, subsessionGuardStats: { denied: 2, byTool: { subagent: 2 } } });
    assert.match(deniedText, /子会话工具否决: 2 次/);
    assert.doesNotMatch(advisorStatusText(snapshot), /子会话工具否决/);
});

test('R-01-010/AC-08 手动双顾问咨询成功：两家意见分别 steer 送达（按模型标识、独立 adviceId，不汇总）', async () => {
    const { controller, llm, delivered } = makeController({
        raw: { advisor: { provider: 'test', model: 'm' }, secondaryAdvisor: { provider: 'test2', model: 'm2' } },
        programs: [
            answer('主顾问手动意见。', { usage: { inputTokens: 1 } }),
            answer('副顾问手动意见。', { usage: { inputTokens: 2 } }),
        ],
    });
    controller.startManual('s1', '焦点审查');
    for (let i = 0; i < 50 && controller.manualRunning('s1'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(llm.calls.length, 2);
    const advices = delivered.filter((entry) => isRecord(entry.advice));
    assert.equal(advices.length, 2); // 分别送达，不汇总
    assert.ok(advices[0].advice.text.includes('主顾问手动意见。'));
    assert.ok(advices[1].advice.text.includes('副顾问手动意见。'));
    assert.equal(advices[0].advice.model, 'test/m');
    assert.equal(advices[1].advice.model, 'test2/m2');
    assert.match(advices[0].advice.adviceId, /^[0-9a-f-]{36}$/);
    assert.notEqual(advices[1].advice.adviceId, advices[0].advice.adviceId);
});

test('R-01-010/AC-04、AC-08 手动双顾问部分失败：成功意见照常送达，失败方以含模型与原因的标记送达', async () => {
    const { controller, delivered } = makeController({
        raw: { advisor: { provider: 'test', model: 'm' }, secondaryAdvisor: { provider: 'test2', model: 'm2' } },
        programs: [failure({ code: 'ECONNRESET', message: 'primary down' }), answer('副顾问意见。')],
    });
    controller.startManual('s1', '焦点');
    for (let i = 0; i < 50 && controller.manualRunning('s1'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const advices = delivered.filter((entry) => isRecord(entry.advice));
    assert.equal(advices.length, 1);
    assert.ok(advices[0].advice.text.includes('副顾问意见。'));
    const notice = delivered.find((entry) => typeof entry.advice === 'string');
    assert.ok(notice, '失败方标记经唤醒式消息送达');
    assert.match(notice.advice, /Manual Advisor consultation failed/);
    assert.match(notice.advice, /test\/m/); // 失败方路由标记
    assert.match(notice.advice, /primary down/);
});

test('R-01-010/AC-04 手动双顾问两家均失败：保持既有失败通告形态（含原因），主循环继续', async () => {
    const { controller, delivered } = makeController({
        raw: { advisor: { provider: 'test', model: 'm' }, secondaryAdvisor: { provider: 'test2', model: 'm2' } },
        programs: [failure({ code: 'ECONNRESET', message: 'primary down' }), failure({ code: 'ETIMEOUT', message: 'secondary down' })],
    });
    controller.startManual('s1', '焦点');
    for (let i = 0; i < 50 && controller.manualRunning('s1'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const advices = delivered.filter((entry) => isRecord(entry.advice));
    assert.equal(advices.length, 0); // 无成功意见送达
    const notice = delivered.find((entry) => typeof entry.advice === 'string');
    assert.ok(notice);
    assert.match(notice.advice, /^Manual Advisor consultation failed: /); // pi 文案形态不变
    assert.match(notice.advice, /primary down/);
    assert.match(notice.advice, /secondary down/); // 副顾问失败原因可诊断
});

test('R-01-010/AC-08 手动双顾问取消：收束两家在飞调用、无用量副作用、状态收敛', async () => {
    const hangProgram = { hangUntilReleased: true, chunks: [{ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }] };
    const { controller, usageLedger, llm } = makeController({
        raw: { advisor: { provider: 'test', model: 'm' }, secondaryAdvisor: { provider: 'test2', model: 'm2' } },
        programs: [{ ...hangProgram }, { ...hangProgram }],
    });
    const started = controller.startManual('s1', '审查');
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 先取消再断言：失败态也不得悬挂在飞调用（deadline timer 必须被清理）
    assert.equal(controller.cancelManual('s1'), true);
    const result = await started.promise;
    llm.release(0);
    llm.release(1);
    assert.equal(result.ok, false); // 取消终态
    assert.equal(controller.manualRunning('s1'), false);
    assert.equal(usageLedger.totals().total.calls, 0); // 取消不留用量记录
    assert.equal(llm.calls.length, 2); // 两家均在飞后被一并收束
    assert.ok(llm.calls.every((call) => call.returned === true)); // 在飞流均被收束，不悬挂
});

test('R-01-010/AC-05 status 呈现副顾问路由与批次合计用量（按顾问分列 + batchId 合计）', async () => {
    const { controller } = makeController({
        raw: { advisor: { provider: 'test', model: 'm' }, secondaryAdvisor: { provider: 'test2', model: 'm2' } },
        programs: [
            answer('主意见。', { usage: { inputTokens: 3, outputTokens: 2 } }),
            answer('副意见。', { usage: { inputTokens: 4, outputTokens: 1 } }),
        ],
    });
    controller.startManual('s1', '用量验收');
    for (let i = 0; i < 50 && controller.manualRunning('s1'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const snapshot = controller.snapshotFor('s1');
    assert.equal(snapshot.secondaryAdvisor.provider, 'test2');
    assert.equal(snapshot.secondaryAdvisor.model, 'm2');
    assert.equal(snapshot.usageBatches.length, 1);
    assert.equal(snapshot.usageBatches[0].calls, 2);
    assert.equal(snapshot.usageBatches[0].inputTokens, 7);
    assert.equal(snapshot.usageBatches[0].outputTokens, 3);
    const text = advisorStatusText(snapshot);
    assert.match(text, /模型: test\/m/);
    assert.match(text, /副顾问: test2\/m2/);
    assert.match(text, /批次 [0-9a-f-]{36}: calls=2 .*inputTokens=7/); // 批次合计
});
