import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateEngine, ADVISOR_TOOL_NAME, adviceSummary } from '../lib/gates/index.js';
import { createSessionObserver } from '../lib/observer.js';

/**
 * 载体契约（T-008 真机实测，dsh 0.1.5-rc.1 / dsh-tools 0.1.5-rc.2，全部用例
 * 按此构造）：
 * - `tools/pre-execute` 以 `(exec, next)` 调监听器，exec 形状
 *   `{ token, callId, rootCallId, name, arguments, agent?, parent?, signal }`——
 *   工具名在 `exec.name`、参数在 `exec.arguments`、会话标识在 `exec.agent.id`；
 * - `agent/turn-stopping` 以单参 payload `{ turn, signal, agent }` 串行派发，
 *   返回值无否决语义，收口反对靠 `agent.steer`；
 * - 监听器返回 `{kind:'allow'}`（必须调 next()）或 `{kind:'deny', reason}`。
 */

/**
 * Fixture: a gate engine with an injectable consultation engine (programmed
 * results, optional deferred), delivery recorder, approver, and a shared
 * logger capturing error/info lines.
 */
function makeGate({
    gates = {},
    results = [],
    approver,
    delivery = () => 'inject',
    observer = createSessionObserver({ logger: { info() {}, error() {} } }),
    consultImpl,
    stopSession,
} = {}) {
    const logs = { error: [], info: [] };
    const logger = {
        error: (message, fields) => logs.error.push({ message, fields }),
        info: (message, fields) => logs.info.push({ message, fields }),
        warn() {},
    };
    const consultCalls = [];
    let index = 0;
    const consult = async (request) => {
        consultCalls.push(request);
        if (consultImpl) {
            return consultImpl(request, consultCalls.length);
        }
        const next = results[index++];
        if (next instanceof Error) {
            throw next;
        }
        if (typeof next === 'function') {
            return next();
        }
        return next ?? { ok: true, adviceId: `adv-${index}`, severity: 'nit', text: '一般性确认。' };
    };
    const delivered = [];
    const engine = createGateEngine({
        consult,
        observer,
        delivery: (sessionId, advice) => {
            delivered.push({ sessionId, advice });
            return delivery(sessionId, advice);
        },
        policyLookup: (gateKind) => gates[gateKind],
        stopSession,
        approver,
        logger,
    });
    const nextCalls = [];
    const next = () => {
        nextCalls.push(1);
        return { kind: 'allow' };
    };
    return { engine, observer, consultCalls, delivered, nextCalls, logs, next };
}

const allow = () => ({ kind: 'allow' });

/** 真实宿主 exec 载体（tools/pre-execute waterfall 形状，dsh-tools 0.1.5-rc.2）。 */
const hostExec = (name, args, sessionId = 's1', callId = 'c1') => ({
    token: `token-${callId}`,
    callId,
    rootCallId: 'root-1',
    name,
    arguments: args,
    agent: { id: sessionId },
    signal: undefined,
});

// ---------------------------------------------------------------------------
// 真实宿主形状回归（T-008 核心证据：测试桩形状曾与宿主同构而掩盖断缝，本组
// 用例钉住「真实载体形状 → 门命中」与「宿主形状之外不误判」）
// ---------------------------------------------------------------------------

test('R-01-005/AC-01 真实宿主形状回归：真实形状 exec 同参三次等价调用，第 3 次执行前命中循环门', async () => {
    const { engine, consultCalls } = makeGate({
        gates: { loop: { enabled: true, policy: 'review', threshold: 3 } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'nit', text: '同样的命令已重试两次，请先诊断。' }],
    });
    // 宿主真实形状：name/arguments/agent（agent.id === 会话 id）/callId/token
    const exec = {
        token: 'tok-1',
        callId: 'c1',
        rootCallId: 'root-1',
        name: 'bash',
        arguments: { command: 'echo hi' },
        agent: { id: 'sess-1' },
        signal: undefined,
    };
    const nextCalls = [];
    const next = () => {
        nextCalls.push(1);
        return { kind: 'allow' };
    };
    await engine.handlePreExecute(exec, next);
    await engine.handlePreExecute(exec, next);
    assert.equal(consultCalls.length, 0); // 前两次不拦
    assert.equal(nextCalls.length, 2);
    const decision = await engine.handlePreExecute(exec, next);
    assert.equal(decision.kind, 'allow');
    assert.equal(consultCalls.length, 1); // 第 3 次等价调用先评审
    assert.equal(nextCalls.length, 3);
    // 会话归属来自 exec.agent.id（sessionOf 的工具载体分支）
    assert.equal(consultCalls[0].session, 'sess-1');
    assert.equal(consultCalls[0].entry, 'gate');
    assert.ok(consultCalls[0].question.includes('bash'));
    assert.ok(consultCalls[0].question.includes('echo hi'));
});

test('R-01-004/AC-01 真实宿主形状回归：失败 result 经权威缝计数一次后，同工具下一次调用命中失败门（threshold:1）', async () => {
    const { engine, observer, consultCalls } = makeGate({
        gates: { failure: { enabled: true, policy: 'review', threshold: 1 } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'nit', text: '检查参数编码。' }],
    });
    // 宿主以 (exec, result) 两参投递 tools/result；wiring 据此直喂 recordResult
    observer.recordResult('sess-1', 'bash', false, 'call-1');
    assert.equal(observer.failureStreak('sess-1', 'bash'), 1);
    const decision = await engine.handlePreExecute(
        hostExec('bash', { command: 'ls' }, 'sess-1', 'call-2'),
        allow,
    );
    assert.equal(decision.kind, 'allow');
    assert.equal(consultCalls.length, 1);
    assert.equal(consultCalls[0].session, 'sess-1');
    assert.ok(consultCalls[0].question.includes('bash'));
    // 其他工具不受该失败影响
    await engine.handlePreExecute(hostExec('read_file', {}, 'sess-1', 'call-3'), allow);
    assert.equal(consultCalls.length, 1);
});

test('真实宿主形状回归：旧假设形状载体 {tool,args} 被静默放行且不计数——宿主形状之外不误判', async () => {
    const { engine, observer, consultCalls, nextCalls } = makeGate({
        gates: { loop: { enabled: true, policy: 'block', threshold: 2 } },
    });
    // T-005 时代测试桩的假设形状：宿主从不派发这种载体
    const stale = await engine.handlePreExecute({ tool: 'x', args: {} }, () => {
        nextCalls.push(1);
        return { kind: 'allow' };
    });
    assert.equal(stale.kind, 'allow'); // 静默放行
    assert.equal(nextCalls.length, 1); // 动作照常派发
    assert.equal(consultCalls.length, 0); // 不触发咨询
    assert.equal(observer.loopCount('s1', 'x', {}), 0); // 不计数（无会话可归属）
    // 对照：真实形状同参调用正常计数（证明门只对宿主形状生效）
    await engine.handlePreExecute(hostExec('x', {}, 's1', 'c1'), allow);
    assert.equal(observer.loopCount('s1', 'x', {}), 1);
});

test('R-02-005/AC-02 真实宿主形状回归：turn-stopping 无 agent 的 payload + 完成门启用 + consult 失败 → 不抛、返回 undefined', async () => {
    const { engine, logs } = makeGate({
        gates: { completion: { enabled: true, policy: 'block' } },
        consultImpl: () => {
            throw new Error('consult exploded');
        },
    });
    const decision = await engine.handleTurnStopping({ turn: {}, signal: undefined }); // 无 agent
    assert.equal(decision, undefined); // 收口反对不靠返回值
    assert.ok(logs.error.length >= 1); // fail-open 显性留痕
});

// ---------------------------------------------------------------------------
// 计划门（R-01-003）
// ---------------------------------------------------------------------------

test('R-01-003/AC-01 计划门启用时，退出计划动作执行前完成一次咨询', async () => {
    const { engine, consultCalls, nextCalls } = makeGate({
        gates: { plan: { enabled: true, policy: 'review' } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'nit', text: '计划可行。' }],
    });
    const decision = await engine.handlePreExecute(
        hostExec('exit_plan_mode', { plan: 'x' }),
        () => {
            nextCalls.push(1);
            return { kind: 'allow' };
        },
    );
    assert.equal(decision.kind, 'allow');
    assert.equal(consultCalls.length, 1);
    assert.equal(consultCalls[0].entry, 'gate');
    assert.ok(consultCalls[0].question.includes('exit_plan_mode'));
    assert.equal(nextCalls.length, 1); // 动作在咨询之后放行
});

test('R-01-003/AC-01 门命中同步阻塞受守护动作直至意见形成（C-001 时序）', async () => {
    // 咨询手动放行前，动作不得放行
    let release;
    const gate = makeGate({
        gates: { plan: { enabled: true, policy: 'review' } },
        consultImpl: () => new Promise((resolve) => {
            release = () => resolve({ ok: true, adviceId: 'adv-1', severity: 'nit', text: 'ok' });
        }),
    });
    const pending = gate.engine.handlePreExecute(hostExec('exit_plan_mode', {}), () => {
        gate.nextCalls.push(1);
        return { kind: 'allow' };
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gate.nextCalls.length, 0); // 意见未形成前动作被阻塞
    release();
    const decision = await pending;
    assert.equal(decision.kind, 'allow');
    assert.equal(gate.nextCalls.length, 1);
});

test('R-01-003/AC-02 计划门 block 策略且评审存在 blocker 意见时动作被阻断并附原因', async () => {
    const { engine, delivered, nextCalls } = makeGate({
        gates: { plan: { enabled: true, policy: 'block' } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'blocker', text: '计划缺少回滚方案，先补齐再退出。' }],
    });
    const decision = await engine.handlePreExecute(hostExec('exit_plan_mode', {}), allow);
    assert.equal(decision.kind, 'deny');
    assert.ok(decision.reason.includes('[advisor:blocker]'));
    assert.ok(decision.reason.includes('计划缺少回滚方案'));
    assert.equal(delivered.length, 0); // blocker 拒绝时不再另行注入
    assert.equal(nextCalls.length, 0); // 动作未执行
});

test('R-01-003/AC-03 review 策略放行动作，且意见在动作结果可见前送达执行者', async () => {
    const order = [];
    const { engine } = makeGate({
        gates: { plan: { enabled: true, policy: 'review' } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'nit', text: '建议补充验证步骤。' }],
        delivery: () => {
            order.push('deliver');
            return 'inject';
        },
    });
    const decision = await engine.handlePreExecute(hostExec('exit_plan_mode', {}), () => {
        order.push('next');
        return { kind: 'allow' };
    });
    assert.equal(decision.kind, 'allow');
    assert.deepEqual(order, ['deliver', 'next']); // 意见先于动作结果送达
});

// ---------------------------------------------------------------------------
// 失败门（R-01-004）
// ---------------------------------------------------------------------------

test('R-01-004/AC-01 同一工具连续失败达到阈值时，下一次同类调用执行前触发咨询', async () => {
    const { engine, observer, consultCalls } = makeGate({
        gates: { failure: { enabled: true, policy: 'review', threshold: 2 } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'nit', text: '检查参数编码。' }],
    });
    observer.recordResult('s1', 'run_tests', false);
    // 一次失败未达阈值 → 不咨询
    await engine.handlePreExecute(hostExec('run_tests', {}), allow);
    assert.equal(consultCalls.length, 0);
    observer.recordResult('s1', 'run_tests', false);
    // 达到阈值 → 下一次调用先评审
    const decision = await engine.handlePreExecute(hostExec('run_tests', {}), allow);
    assert.equal(decision.kind, 'allow');
    assert.equal(consultCalls.length, 1);
    // 其他工具不受影响
    await engine.handlePreExecute(hostExec('read_file', {}), allow);
    assert.equal(consultCalls.length, 1);
});

test('R-01-004/AC-02 失败门 block 策略且评审存在 blocker 意见时该次调用被阻断并附原因', async () => {
    const { engine, observer, nextCalls } = makeGate({
        gates: { failure: { enabled: true, policy: 'block', threshold: 1 } },
        results: [{ ok: true, adviceId: 'adv-2', severity: 'blocker', text: '命令会删除生产数据，禁止执行。' }],
    });
    observer.recordResult('s1', 'bash', false);
    const decision = await engine.handlePreExecute(hostExec('bash', {}), allow);
    assert.equal(decision.kind, 'deny');
    assert.ok(decision.reason.includes('禁止执行'));
    assert.equal(nextCalls.length, 0);
});

test('R-01-004/AC-03 block-session 策略保证路径为 deny(reason)，会话停止经注入钩子并留痕', async () => {
    // 钩子已接入：命中时调用 stopSession（带上下文），并留痕 sessionStopped
    const stops = [];
    const { engine, observer, logs } = makeGate({
        gates: { failure: { enabled: true, policy: 'block-session', threshold: 1 } },
        results: [{ ok: true, adviceId: 'adv-3', severity: 'blocker', text: '连续失败且存在数据损坏风险，停止会话。' }],
        stopSession: (context) => stops.push(context),
    });
    observer.recordResult('s1', 'bash', false);
    const decision = await engine.handlePreExecute(hostExec('bash', {}), allow);
    assert.equal(decision.kind, 'deny');
    assert.ok(decision.reason.includes('停止会话'));
    assert.equal(decision.stopSession, undefined); // 字段超出已验证契约，不再外露
    assert.equal(stops.length, 1);
    assert.equal(stops[0].sessionId, 's1');
    assert.equal(stops[0].adviceId, 'adv-3');
    assert.ok(logs.error.some((entry) => entry.message.includes('block-session') && entry.fields.summary.includes('停止会话')));

    // 钩子缺失：deny 兜底照常，且「会话停止未执行」显性化（不静默）
    const withoutHook = makeGate({
        gates: { failure: { enabled: true, policy: 'block-session', threshold: 1 } },
        results: [{ ok: true, adviceId: 'adv-3b', severity: 'blocker', text: '停止会话。' }],
    });
    withoutHook.observer.recordResult('s1', 'bash', false);
    const fallback = await withoutHook.engine.handlePreExecute(hostExec('bash', {}), allow);
    assert.equal(fallback.kind, 'deny');
    assert.ok(withoutHook.logs.error.some((entry) => entry.message.includes('会话停止未执行')));

    // 对照：其他门的 block 策略绝不触发会话停止钩子
    const stopsOther = [];
    const other = makeGate({
        gates: { loop: { enabled: true, policy: 'block', threshold: 1 } },
        results: [{ ok: true, adviceId: 'adv-4', severity: 'blocker', text: '阻止。' }],
        stopSession: (context) => stopsOther.push(context),
    });
    const loopDecision = await other.engine.handlePreExecute(hostExec('bash', {}), allow);
    assert.equal(loopDecision.kind, 'deny');
    assert.equal(stopsOther.length, 0); // 该处置只在此门命中时发生
});

// ---------------------------------------------------------------------------
// 循环门（R-01-005）
// ---------------------------------------------------------------------------

test('R-01-005/AC-02 循环门拦截时，人工决定作为放行/拒绝依据（ask 策略）', async () => {
    const decisions = [];
    const approvals = [false, true];
    const { engine } = makeGate({
        gates: { loop: { enabled: true, policy: 'ask', threshold: 2 } },
        approver: async (request) => {
            assert.equal(request.gate, 'loop');
            assert.ok(request.advice);
            return approvals[decisions.length];
        },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'concern', text: '重复执行风险。' }, { ok: true, adviceId: 'adv-2', severity: 'concern', text: '重复执行风险。' }],
    });
    const exec = hostExec('bash', { command: 'npm test' });
    await engine.handlePreExecute(exec, allow); // count 1，未达阈值
    decisions.push(await engine.handlePreExecute(exec, allow)); // count 2 命中 → 人工拒绝
    assert.equal(decisions[0].kind, 'deny');
    assert.ok(decisions[0].reason.includes('人工拒绝'));
    // deny 后计数重置 → 再次调用重新计数
    decisions.push(await engine.handlePreExecute(exec, allow)); // count 1
    await engine.handlePreExecute(exec, allow); // count 2 命中 → 人工同意
    assert.equal(decisions[1].kind, 'allow');
});

test('R-01-005/AC-03 循环计数因参数实质变化而重置：等价判定以工具名与规范化参数为准', async () => {
    const { engine, consultCalls } = makeGate({
        gates: { loop: { enabled: true, policy: 'review', threshold: 3 } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'nit', text: 'ok' }],
    });
    await engine.handlePreExecute(hostExec('bash', { command: 'npm test' }, 's1', 'c1'), allow);
    await engine.handlePreExecute(hostExec('bash', { command: 'npm run lint' }, 's1', 'c2'), allow);
    assert.equal(consultCalls.length, 0); // 参数变化 → 各自新键，均未达阈值
    // 键序不影响等价
    await engine.handlePreExecute(hostExec('bash', { command: 'npm test', cwd: '/w' }, 's1', 'c3'), allow);
    await engine.handlePreExecute(hostExec('bash', { cwd: '/w', command: 'npm test' }, 's1', 'c4'), allow);
    await engine.handlePreExecute(hostExec('bash', { command: 'npm test', cwd: '/w' }, 's1', 'c5'), allow);
    assert.equal(consultCalls.length, 1); // 同参第三次命中
});

test('R-01-005/AC-01 循环门 deny 后计数重置，同参数不会永久卡死', async () => {
    const { engine, consultCalls } = makeGate({
        gates: { loop: { enabled: true, policy: 'block', threshold: 2 } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'blocker', text: '停止重复。' }, { ok: true, adviceId: 'adv-2', severity: 'nit', text: '这次可以。' }],
    });
    const exec = hostExec('bash', { command: 'npm test' });
    await engine.handlePreExecute(exec, allow); // count 1
    const denied = await engine.handlePreExecute(exec, allow); // count 2 → blocker deny
    assert.equal(denied.kind, 'deny');
    // deny 后重置：下一次同参调用 count=1，不触发咨询直接放行
    const after = await engine.handlePreExecute(exec, allow);
    assert.equal(after.kind, 'allow');
    assert.equal(consultCalls.length, 1);
    // 再两次同参调用才会再次命中，且这次非 blocker → 放行并送达
    await engine.handlePreExecute(exec, allow);
    const secondHit = await engine.handlePreExecute(exec, allow);
    assert.equal(secondHit.kind, 'allow');
    assert.equal(consultCalls.length, 2);
});

// ---------------------------------------------------------------------------
// 完成门（R-01-006）——真实锚点是 agent/turn-stopping 串行派发（宿主无名为
// concludesTurn 的工具，pre-execute 时点不可判定，T-008 实测裁决）
// ---------------------------------------------------------------------------

test('R-01-006/AC-01 完成门启用时，回合收口提交前完成一次评审咨询（agent/turn-stopping）', async () => {
    const steerCalls = [];
    const { engine, consultCalls, delivered } = makeGate({
        gates: { completion: { enabled: true, policy: 'review' } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'nit', text: '可以收尾。' }],
    });
    const decision = await engine.handleTurnStopping({
        turn: { id: 'turn-1' },
        signal: undefined,
        agent: { id: 's1', steer: (message) => steerCalls.push(message), inject() {} },
    });
    assert.equal(decision, 'delivered'); // 送达 + 放行收口（宿主续步后同回合再收口将去重跳过）
    assert.equal(consultCalls.length, 1); // 咨询发生在收口前
    assert.equal(consultCalls[0].entry, 'gate');
    assert.equal(consultCalls[0].session, 's1');
    assert.ok(consultCalls[0].question.includes('收口'));
    assert.equal(delivered.length, 1); // review → 送达 + 放行收口
    assert.equal(delivered[0].sessionId, 's1');
    assert.equal(delivered[0].advice.severity, 'nit');
});

test('R-01-006/AC-02 完成门 block 策略且评审存在 blocker 意见时经 agent.steer 反对收口', async () => {
    const steerCalls = [];
    const { engine, delivered } = makeGate({
        gates: { completion: { enabled: true, policy: 'block' } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'blocker', text: '还有两个验收点未验证，不能收尾。' }],
    });
    const decision = await engine.handleTurnStopping({
        turn: { id: 'turn-1' },
        signal: undefined,
        agent: { id: 's1', steer: (message) => steerCalls.push(message), inject() {} },
    });
    assert.equal(decision, 'objected'); // 反对收口：不落去重标记，同回合再收口会重新评审
    assert.equal(steerCalls.length, 1); // 反对收口 = steer 数据（inbox 续步）
    const message = steerCalls[0];
    assert.equal(message.role, 'user');
    assert.equal(typeof message.id, 'string'); // 宿主消息契约带稳定 id
    assert.ok(Array.isArray(message.content)); // content 是 ContentBlock 数组
    assert.ok(message.content[0].text.startsWith('[advisor:blocker] '));
    assert.ok(message.content[0].text.includes('不能收尾'));
    assert.equal(message.source.plugin, 'advisor-flow');
    assert.equal(delivered.length, 0); // blocker 反对路径不另行 inject 送达
});

test('R-01-006/AC-02 完成门 ask 策略：审批拒绝经 agent.steer 反对收口，同意则放行', async () => {
    const run = async (approved) => {
        const steerCalls = [];
        const delivered = [];
        const decisions = [];
        const { engine } = makeGate({
            gates: { completion: { enabled: true, policy: 'ask' } },
            results: [{ ok: true, adviceId: 'adv-2', severity: 'concern', text: '还差验收，先补齐。' }],
            approver: async (request) => {
                decisions.push(request);
                return approved;
            },
            delivery: () => {
                delivered.push(1);
                return 'inject';
            },
        });
        const decision = await engine.handleTurnStopping({
            turn: { id: 'turn-1' },
            signal: undefined,
            agent: { id: 's1', steer: (message) => steerCalls.push(message), inject() {} },
        });
        return { decision, decisions: decisions.length, gate: decisions[0]?.gate, delivered: delivered.length, steered: steerCalls.length };
    };
    const rejected = await run(false);
    assert.equal(rejected.decision, 'objected');
    assert.equal(rejected.decisions, 1);
    assert.equal(rejected.gate, 'completion'); // 审批缝征询发生在收口前
    assert.equal(rejected.delivered, 1); // ask 先送达再征询
    assert.equal(rejected.steered, 1); // 拒绝 → steer 反对收口
    const approved = await run(true);
    assert.equal(approved.decision, 'delivered');
    assert.equal(approved.delivered, 1);
    assert.equal(approved.steered, 0); // 同意 → 放行收口
});

test('R-01-006/AC-03 顾问不可用（未配置或调用失败）时放行收口，且不得悬挂等待', async () => {
    // 未配置 → NO_ADVISOR_MODEL
    const unavailable = makeGate({
        gates: { completion: { enabled: true, policy: 'block' } },
        results: [{ ok: false, code: 'NO_ADVISOR_MODEL', reason: 'advisor 模型未配置' }],
    });
    const decisionA = await unavailable.engine.handleTurnStopping({
        turn: { id: 'turn-1' },
        signal: undefined,
        agent: { id: 's1', steer() {}, inject() {} },
    });
    assert.equal(decisionA, undefined);
    assert.ok(unavailable.logs.error.some((entry) => entry.fields.code === 'NO_ADVISOR_MODEL'));

    // 调用失败 → 也放行收口（block 策略下顾问不可用仍 fail-open）
    const failed = makeGate({
        gates: { completion: { enabled: true, policy: 'block' } },
        results: [{ ok: false, code: 'ADVISOR_TIMEOUT', reason: 'advisor call timed out' }],
    });
    const decisionB = await failed.engine.handleTurnStopping({
        turn: { id: 'turn-1' },
        signal: undefined,
        agent: { id: 's1', steer() {}, inject() {} },
    });
    assert.equal(decisionB, undefined);
    assert.ok(failed.logs.error.some((entry) => entry.fields.code === 'ADVISOR_TIMEOUT'));
});

test('R-01-006/AC-03 完成门禁用时不咨询：turn-stopping 直接放行收口（旧「自有工具名单」假设已随锚点迁移作废）', async () => {
    const { engine, consultCalls } = makeGate({
        gates: { completion: { enabled: false, policy: 'block' } },
    });
    const decision = await engine.handleTurnStopping({
        turn: { id: 'turn-1' },
        signal: undefined,
        agent: { id: 's1', steer() {}, inject() {} },
    });
    assert.equal(decision, undefined);
    assert.equal(consultCalls.length, 0); // disabled → 不咨询
});

test('R-01-006 真实锚点钉住：完成门不再参与 tools/pre-execute 判定（宿主无名为 concludesTurn 的工具）', async () => {
    const { engine, consultCalls, nextCalls } = makeGate({
        gates: { completion: { enabled: true, policy: 'block' } },
    });
    // completion 门只挂在 agent/turn-stopping；pre-execute 对任意工具名不做完成门判定
    const decision = await engine.handlePreExecute(hostExec('concludesTurn', { summary: 'done' }), () => {
        nextCalls.push(1);
        return { kind: 'allow' };
    });
    assert.equal(decision.kind, 'allow');
    assert.equal(nextCalls.length, 1); // 动作照常派发
    assert.equal(consultCalls.length, 0); // 不触发咨询
});

test('R-01-006/AC-02 完成门回合去重边界：放行收口落标记（同回合再收口跳过），反对收口不落标记（同回合再收口重新评审）', async () => {
    // 放行路径（review + nit）：同回合第二次收口尝试去重跳过，循环有界
    const allowed = makeGate({
        gates: { completion: { enabled: true, policy: 'review' } },
        results: [
            { ok: true, adviceId: 'adv-1', severity: 'nit', text: '可以收尾。' },
            { ok: true, adviceId: 'adv-2', severity: 'nit', text: '再评一次。' },
        ],
    });
    const turnPayload = (steerCalls) => ({ turn: 7, signal: undefined, agent: { id: 's1', steer: (m) => steerCalls.push(m), inject() {} } });
    const first = await allowed.engine.handleTurnStopping(turnPayload());
    assert.equal(first, 'delivered'); // 首次评审：送达 + 放行（注入已让宿主续步）
    const second = await allowed.engine.handleTurnStopping(turnPayload());
    assert.equal(second, undefined); // 同回合放行后去重跳过——不再咨询
    assert.equal(allowed.consultCalls.length, 1);

    // 反对路径：block + blocker 的同回合再收口必须重新评审（AC-02 不被绕过）
    const objected = makeGate({
        gates: { completion: { enabled: true, policy: 'block' } },
        results: [
            { ok: true, adviceId: 'adv-3', severity: 'blocker', text: '不能收尾。' },
            { ok: true, adviceId: 'adv-4', severity: 'blocker', text: '仍不能收尾。' },
        ],
    });
    const steerCalls = [];
    const steerAgent = () => ({ id: 's9', steer: (m) => steerCalls.push(m), inject() {} });
    const firstObjection = await objected.engine.handleTurnStopping({ turn: 7, signal: undefined, agent: steerAgent() });
    assert.equal(firstObjection, 'objected');
    assert.equal(steerCalls.length, 1);
    const secondObjection = await objected.engine.handleTurnStopping({ turn: 7, signal: undefined, agent: steerAgent() });
    assert.equal(secondObjection, 'objected'); // 二次评审仍反对收口（去重标记未落）
    assert.equal(steerCalls.length, 2);
    assert.equal(objected.consultCalls.length, 2); // 反对不落标记：同回合再收口重新评审
});

test('R-02-005/AC-02 完成门反对降级：steer 缝缺失/抛错时收口降级放行（自由收口返回 undefined），不得悬挂', async () => {
    // steer 缝缺失 → 反对无法表达 → 收口照常（error 留痕、返回 undefined）
    const noSeam = makeGate({
        gates: { completion: { enabled: true, policy: 'block' } },
        results: [{ ok: true, adviceId: 'adv-5', severity: 'blocker', text: '不能收尾。' }],
    });
    const decisionA = await noSeam.engine.handleTurnStopping({
        turn: 9, signal: undefined, agent: { id: 's1', inject() {} }, // 无 steer 方法
    });
    assert.equal(decisionA, undefined); // 降级放行 = 自由收口
    assert.ok(noSeam.logs.error.some((entry) => String(entry.message).includes('could not steer')));
    // steer 抛错 → 同样降级放行
    const throwing = makeGate({
        gates: { completion: { enabled: true, policy: 'block' } },
        results: [{ ok: true, adviceId: 'adv-6', severity: 'blocker', text: '不能收尾。' }],
    });
    const decisionB = await throwing.engine.handleTurnStopping({
        turn: 9, signal: undefined, agent: { id: 's1', steer() { throw new Error('steer seam broken'); }, inject() {} },
    });
    assert.equal(decisionB, undefined);
    assert.ok(throwing.logs.error.some((entry) => String(entry.message).includes('steer failed')));
});

test('R-01-006/AC-02 完成门 ask 策略 fail-open：审批缝缺失/抛错时已送达的意见按 delivered 处置（宿主续步），不得悬挂', async () => {
    const run = async (approverSetup) => {
        const delivered = [];
        const steerCalls = [];
        const { engine, logs } = makeGate({
            gates: { completion: { enabled: true, policy: 'ask' } },
            results: [{ ok: true, adviceId: 'adv-7', severity: 'concern', text: '还差验收。' }],
            approver: approverSetup,
            delivery: (sessionId, advice) => {
                delivered.push(advice);
                return 'inject';
            },
        });
        const decision = await engine.handleTurnStopping({
            turn: 4, signal: undefined, agent: { id: 's1', steer: (m) => steerCalls.push(m), inject() {} },
        });
        return { decision, delivered: delivered.length, steered: steerCalls.length, logs };
    };
    // 审批缝缺失 → fail-open 放行，但意见已送达（宿主将续步）→ delivered
    const missing = await run(undefined);
    assert.equal(missing.decision, 'delivered');
    assert.equal(missing.delivered, 1);
    assert.equal(missing.steered, 0);
    assert.ok(missing.logs.error.some((entry) => String(entry.message).includes('no approver')));
    // 审批抛错 → 同样 delivered
    const throwing = await run(async () => { throw new Error('approval seam broken'); });
    assert.equal(throwing.decision, 'delivered');
    assert.equal(throwing.delivered, 1);
    assert.equal(throwing.steered, 0);
    assert.ok(throwing.logs.error.some((entry) => String(entry.message).includes('approver failed')));
});

// ---------------------------------------------------------------------------
// 非阻断不变量与边界（R-02-005）
// ---------------------------------------------------------------------------

test('R-02-005/AC-02 门组件抛错：按放行处置该次工具调用并记录错误，不悬挂', async () => {
    // 咨询引擎本身抛错（防御深一层）
    const throwingConsult = makeGate({
        gates: { loop: { enabled: true, policy: 'review', threshold: 1 } },
        consultImpl: () => {
            throw new Error('consult exploded');
        },
    });
    const a = await throwingConsult.engine.handlePreExecute(hostExec('bash', {}), allow);
    assert.equal(a.kind, 'allow');
    assert.ok(throwingConsult.logs.error.some((entry) => entry.message.includes('fail-open')));

    // 送达通道抛错 → 处置仍完成（review 放行）
    const throwingDelivery = makeGate({
        gates: { loop: { enabled: true, policy: 'review', threshold: 1 } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'nit', text: 'ok' }],
        delivery: () => {
            throw new Error('delivery exploded');
        },
    });
    const b = await throwingDelivery.engine.handlePreExecute(hostExec('bash', {}), allow);
    assert.equal(b.kind, 'allow');
    assert.ok(throwingDelivery.logs.error.some((entry) => entry.message.includes('fail-open') || entry.message.includes('delivery')));

    // 观察器抛错（计数阶段）→ fail-open
    const breakingObserver = createSessionObserver({});
    breakingObserver.recordCall = () => {
        throw new Error('observer exploded');
    };
    const throwingObserver = makeGate({
        gates: { loop: { enabled: true, policy: 'block' } },
        observer: breakingObserver,
    });
    const c = await throwingObserver.engine.handlePreExecute(hostExec('bash', {}), allow);
    assert.equal(c.kind, 'allow');
    assert.ok(throwingObserver.logs.error.some((entry) => entry.message.includes('fail-open')));
});

test('R-02-005/AC-02 门组件异常不悬挂：整条处置链在有限时间内返回放行', async () => {
    const { engine } = makeGate({
        gates: { loop: { enabled: true, policy: 'review', threshold: 1 } },
        consultImpl: () => Promise.reject(new Error('hang-free rejection')),
    });
    const decision = await engine.handlePreExecute(hostExec('bash', {}), allow);
    assert.equal(decision.kind, 'allow');
});

test('ask_advisor 工具豁免门拦截（防自递归属实现约束，不锚定 AC）', async () => {
    const { engine, consultCalls, nextCalls, next: fixtureNext } = makeGate({
        gates: {
            plan: { enabled: true, policy: 'block' },
            loop: { enabled: true, policy: 'block', threshold: 1 },
            failure: { enabled: true, policy: 'block', threshold: 1 },
        },
    });
    const decision = await engine.handlePreExecute(hostExec(ADVISOR_TOOL_NAME, {}), fixtureNext);
    assert.equal(decision.kind, 'allow');
    assert.equal(consultCalls.length, 0);
    assert.equal(nextCalls.length, 1);
});

test('R-02-005/AC-02 门禁用时不触发咨询：边界配置下门全关直接放行', async () => {
    const { engine, consultCalls } = makeGate({
        gates: {
            plan: { enabled: false, policy: 'block' },
            loop: { enabled: false, policy: 'block', threshold: 1 },
            failure: { enabled: false, policy: 'block-session', threshold: 1 },
            completion: { enabled: false, policy: 'block' },
        },
    });
    for (const tool of ['exit_plan_mode', 'bash', 'read_file']) {
        const decision = await engine.handlePreExecute(hostExec(tool, {}), allow);
        assert.equal(decision.kind, 'allow');
    }
    assert.equal(consultCalls.length, 0);
});

test('R-01-004/AC-01 不同会话的门状态互相隔离', async () => {
    const { engine, observer, consultCalls } = makeGate({
        gates: { failure: { enabled: true, policy: 'review', threshold: 1 } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'nit', text: 'ok' }],
    });
    observer.recordResult('s1', 'bash', false);
    await engine.handlePreExecute(hostExec('bash', {}, 's1', 'c1'), allow);
    assert.equal(consultCalls.length, 1);
    // s2 无失败记录 → 不触发
    await engine.handlePreExecute(hostExec('bash', {}, 's2', 'c2'), allow);
    assert.equal(consultCalls.length, 1);
});

test('R-01-004/AC-02 block 策略非 blocker 意见时放行并将意见送达到会话', async () => {
    const { engine, observer, delivered } = makeGate({
        gates: { failure: { enabled: true, policy: 'block', threshold: 1 } },
        results: [{ ok: true, adviceId: 'adv-9', severity: 'concern', text: '先检查磁盘空间。' }],
    });
    observer.recordResult('s1', 'bash', false);
    const decision = await engine.handlePreExecute(hostExec('bash', {}), allow);
    assert.equal(decision.kind, 'allow'); // 非 blocker → 放行
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].sessionId, 's1');
    assert.equal(delivered[0].advice.severity, 'concern');
    assert.equal(delivered[0].advice.adviceId, 'adv-9');
});

test('R-01-003/AC-02 deny 原因摘要有界且 adviceSummary 折叠空白', () => {
    assert.equal(adviceSummary({ text: 'a\n\nb   c' }), 'a b c');
    const long = 'x'.repeat(500);
    const summary = adviceSummary({ text: long });
    assert.ok(summary.length <= 200);
    assert.ok(summary.endsWith('…'));
});

test('next() 派发错误透传：nextSettled 后的异常原样上抛（waterfall 契约），不吞错', async () => {
    const { engine } = makeGate({
        gates: { loop: { enabled: true, policy: 'review', threshold: 1 } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'nit', text: 'ok' }],
    });
    const boom = new Error('downstream exploded');
    await assert.rejects(
        engine.handlePreExecute(hostExec('bash', {}), () => {
            throw boom;
        }),
        (error) => error === boom, // 同一错误对象原样透传
    );
    // 对照：门自身逻辑的错误仍 fail-open 放行，不上抛
    const failing = makeGate({
        gates: { loop: { enabled: true, policy: 'review', threshold: 1 } },
        consultImpl: () => {
            throw new Error('gate-side failure');
        },
    });
    const decision = await failing.engine.handlePreExecute(hostExec('bash', {}), allow);
    assert.equal(decision.kind, 'allow');
});
