import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateEngine, ADVISOR_TOOL_NAME, adviceSummary } from '../lib/gates/index.js';
import { createSessionObserver } from '../lib/observer.js';

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

test('R-01-003/AC-01 计划门启用时，退出计划动作执行前完成一次咨询', async () => {
    const { engine, consultCalls, nextCalls } = makeGate({
        gates: { plan: { enabled: true, policy: 'review' } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'nit', text: '计划可行。' }],
    });
    const decision = await engine.handlePreExecute({ tool: 'exit_plan_mode', args: { plan: 'x' }, session: 's1' }, () => {
        nextCalls.push(1);
        return { kind: 'allow' };
    });
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
    const pending = gate.engine.handlePreExecute({ tool: 'exit_plan_mode', args: {}, session: 's1' }, () => {
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
    const decision = await engine.handlePreExecute({ tool: 'exit_plan_mode', args: {}, session: 's1' }, allow);
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
    const decision = await engine.handlePreExecute({ tool: 'exit_plan_mode', args: {}, session: 's1' }, () => {
        order.push('next');
        return { kind: 'allow' };
    });
    assert.equal(decision.kind, 'allow');
    assert.deepEqual(order, ['deliver', 'next']); // 意见先于动作结果送达
});

test('R-01-004/AC-01 同一工具连续失败达到阈值时，下一次同类调用执行前触发咨询', async () => {
    const { engine, observer, consultCalls } = makeGate({
        gates: { failure: { enabled: true, policy: 'review', threshold: 2 } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'nit', text: '检查参数编码。' }],
    });
    observer.recordResult('s1', 'run_tests', false);
    // 一次失败未达阈值 → 不咨询
    await engine.handlePreExecute({ tool: 'run_tests', args: {}, session: 's1' }, allow);
    assert.equal(consultCalls.length, 0);
    observer.recordResult('s1', 'run_tests', false);
    // 达到阈值 → 下一次调用先评审
    const decision = await engine.handlePreExecute({ tool: 'run_tests', args: {}, session: 's1' }, allow);
    assert.equal(decision.kind, 'allow');
    assert.equal(consultCalls.length, 1);
    // 其他工具不受影响
    await engine.handlePreExecute({ tool: 'read_file', args: {}, session: 's1' }, allow);
    assert.equal(consultCalls.length, 1);
});

test('R-01-004/AC-02 失败门 block 策略且评审存在 blocker 意见时该次调用被阻断并附原因', async () => {
    const { engine, observer, nextCalls } = makeGate({
        gates: { failure: { enabled: true, policy: 'block', threshold: 1 } },
        results: [{ ok: true, adviceId: 'adv-2', severity: 'blocker', text: '命令会删除生产数据，禁止执行。' }],
    });
    observer.recordResult('s1', 'bash', false);
    const decision = await engine.handlePreExecute({ tool: 'bash', args: {}, session: 's1' }, allow);
    assert.equal(decision.kind, 'deny');
    assert.ok(decision.reason.includes('禁止执行'));
    assert.equal(nextCalls.length, 0);
});

test('R-01-004/AC-03 block-session 策略停止会话执行并记录意见汇总，且该处置只在此门发生', async () => {
    const { engine, observer, logs } = makeGate({
        gates: { failure: { enabled: true, policy: 'block-session', threshold: 1 } },
        results: [{ ok: true, adviceId: 'adv-3', severity: 'blocker', text: '连续失败且存在数据损坏风险，停止会话。' }],
    });
    observer.recordResult('s1', 'bash', false);
    const decision = await engine.handlePreExecute({ tool: 'bash', args: {}, session: 's1' }, allow);
    assert.equal(decision.kind, 'deny');
    assert.equal(decision.stopSession, true);
    assert.ok(logs.error.some((entry) => entry.message.includes('block-session') && entry.fields.summary.includes('停止会话')));

    // 对照：其他门的 block 策略绝不产生 stopSession
    const other = makeGate({
        gates: { plan: { enabled: true, policy: 'block' } },
        results: [{ ok: true, adviceId: 'adv-4', severity: 'blocker', text: '阻止。' }],
    });
    const planDecision = await other.engine.handlePreExecute({ tool: 'exit_plan_mode', args: {}, session: 's1' }, allow);
    assert.equal(planDecision.kind, 'deny');
    assert.equal(planDecision.stopSession, undefined);
});

test('R-01-005/AC-01 等价调用重复达到阈值时，该次调用执行前被拦截', async () => {
    const { engine, consultCalls, nextCalls, next: fixtureNext } = makeGate({
        gates: { loop: { enabled: true, policy: 'review', threshold: 3 } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'nit', text: '同样的命令已重试两次，请先诊断。' }],
    });
    const exec = { tool: 'bash', args: { command: 'npm test' }, session: 's1' };
    await engine.handlePreExecute(exec, fixtureNext);
    await engine.handlePreExecute(exec, fixtureNext);
    assert.equal(consultCalls.length, 0); // 前两次不拦
    assert.equal(nextCalls.length, 2);
    const decision = await engine.handlePreExecute(exec, fixtureNext);
    assert.equal(decision.kind, 'allow');
    assert.equal(consultCalls.length, 1); // 第三次等价调用先评审
    assert.equal(nextCalls.length, 3);
});

test('R-01-005/AC-02 循环门拦截时，人工决定作为放行/拒绝依据（ask 策略）', async () => {
    const decisions = [];
    const approvals = [false, true];
    let call = 0;
    const { engine } = makeGate({
        gates: { loop: { enabled: true, policy: 'ask', threshold: 2 } },
        approver: async (request) => {
            assert.equal(request.gate, 'loop');
            assert.ok(request.advice);
            return approvals[call++];
        },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'concern', text: '重复执行风险。' }, { ok: true, adviceId: 'adv-2', severity: 'concern', text: '重复执行风险。' }],
    });
    const exec = { tool: 'bash', args: { command: 'npm test' }, session: 's1' };
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
    await engine.handlePreExecute({ tool: 'bash', args: { command: 'npm test' }, session: 's1' }, allow);
    await engine.handlePreExecute({ tool: 'bash', args: { command: 'npm run lint' }, session: 's1' }, allow);
    assert.equal(consultCalls.length, 0); // 参数变化 → 各自新键，均未达阈值
    // 键序不影响等价
    await engine.handlePreExecute({ tool: 'bash', args: { command: 'npm test', cwd: '/w' }, session: 's1' }, allow);
    await engine.handlePreExecute({ tool: 'bash', args: { cwd: '/w', command: 'npm test' }, session: 's1' }, allow);
    await engine.handlePreExecute({ tool: 'bash', args: { command: 'npm test', cwd: '/w' }, session: 's1' }, allow);
    assert.equal(consultCalls.length, 1); // 同参第三次命中
});

test('R-01-005/AC-01 循环门 deny 后计数重置，同参数不会永久卡死', async () => {
    const { engine, consultCalls } = makeGate({
        gates: { loop: { enabled: true, policy: 'block', threshold: 2 } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'blocker', text: '停止重复。' }, { ok: true, adviceId: 'adv-2', severity: 'nit', text: '这次可以。' }],
    });
    const exec = { tool: 'bash', args: { command: 'npm test' }, session: 's1' };
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

test('R-01-006/AC-01 完成门启用时，结束会话轮次动作生效前完成一次咨询', async () => {
    const { engine, consultCalls, nextCalls } = makeGate({
        gates: { completion: { enabled: true, policy: 'review' } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'nit', text: '可以收尾。' }],
    });
    const decision = await engine.handlePreExecute({ tool: 'concludesTurn', args: { summary: 'done' }, session: 's1' }, allow);
    assert.equal(decision.kind, 'allow');
    assert.equal(consultCalls.length, 1);
    assert.ok(consultCalls[0].question.includes('concludesTurn'));
    assert.equal(nextCalls.length, 0); // next 由 fixture 计数，命中的放行走内部 allow
});

test('R-01-006/AC-02 完成门 block 策略且评审存在 blocker 意见时结束动作被阻断并返回原因', async () => {
    const { engine } = makeGate({
        gates: { completion: { enabled: true, policy: 'block' } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'blocker', text: '还有两个验收点未验证，不能收尾。' }],
    });
    const decision = await engine.handlePreExecute({ tool: 'concludesTurn', args: {}, session: 's1' }, allow);
    assert.equal(decision.kind, 'deny');
    assert.ok(decision.reason.includes('不能收尾'));
});

test('R-01-006/AC-03 顾问不可用（未配置或调用失败）时完成动作放行，且不得悬挂等待', async () => {
    // 未配置 → NO_ADVISOR_MODEL
    const unavailable = makeGate({
        gates: { completion: { enabled: true, policy: 'block' } },
        results: [{ ok: false, code: 'NO_ADVISOR_MODEL', reason: 'advisor 模型未配置' }],
    });
    const decisionA = await unavailable.engine.handlePreExecute({ tool: 'concludesTurn', args: {}, session: 's1' }, allow);
    assert.equal(decisionA.kind, 'allow');
    assert.ok(unavailable.logs.error.some((entry) => entry.fields.code === 'NO_ADVISOR_MODEL'));

    // 调用失败 → 也放行（block 策略下顾问不可用仍 fail-open）
    const failed = makeGate({
        gates: { completion: { enabled: true, policy: 'block' } },
        results: [{ ok: false, code: 'ADVISOR_TIMEOUT', reason: 'advisor call timed out' }],
    });
    const decisionB = await failed.engine.handlePreExecute({ tool: 'concludesTurn', args: {}, session: 's1' }, allow);
    assert.equal(decisionB.kind, 'allow');
    assert.ok(failed.logs.error.some((entry) => entry.fields.code === 'ADVISOR_TIMEOUT'));
});

test('R-02-005/AC-02 门组件抛错：按放行处置该次工具调用并记录错误，不悬挂', async () => {
    // 咨询引擎本身抛错（防御深一层）
    const throwingConsult = makeGate({
        gates: { plan: { enabled: true, policy: 'review' } },
        consultImpl: () => {
            throw new Error('consult exploded');
        },
    });
    const a = await throwingConsult.engine.handlePreExecute({ tool: 'exit_plan_mode', args: {}, session: 's1' }, allow);
    assert.equal(a.kind, 'allow');
    assert.ok(throwingConsult.logs.error.some((entry) => entry.message.includes('fail-open')));

    // 送达通道抛错 → 处置仍完成（review 放行）
    const throwingDelivery = makeGate({
        gates: { plan: { enabled: true, policy: 'review' } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'nit', text: 'ok' }],
        delivery: () => {
            throw new Error('delivery exploded');
        },
    });
    const b = await throwingDelivery.engine.handlePreExecute({ tool: 'exit_plan_mode', args: {}, session: 's1' }, allow);
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
    const c = await throwingObserver.engine.handlePreExecute({ tool: 'bash', args: {}, session: 's1' }, allow);
    assert.equal(c.kind, 'allow');
    assert.ok(throwingObserver.logs.error.some((entry) => entry.message.includes('fail-open')));
});

test('R-02-005/AC-02 门组件异常不悬挂：整条处置链在有限时间内返回放行', async () => {
    const { engine } = makeGate({
        gates: { plan: { enabled: true, policy: 'review' } },
        consultImpl: () => Promise.reject(new Error('hang-free rejection')),
    });
    const decision = await engine.handlePreExecute({ tool: 'exit_plan_mode', args: {}, session: 's1' }, allow);
    assert.equal(decision.kind, 'allow');
});

test('ask_advisor 工具豁免门拦截（防自递归属实现约束，不锚定 AC）', async () => {
    const { engine, consultCalls, nextCalls, next: fixtureNext } = makeGate({
        gates: {
            plan: { enabled: true, policy: 'block' },
            loop: { enabled: true, policy: 'block', threshold: 1 },
            failure: { enabled: true, policy: 'block', threshold: 1 },
            completion: { enabled: true, policy: 'block' },
        },
    });
    const decision = await engine.handlePreExecute({ tool: ADVISOR_TOOL_NAME, args: {}, session: 's1' }, fixtureNext);
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
    for (const tool of ['exit_plan_mode', 'concludesTurn', 'bash']) {
        const decision = await engine.handlePreExecute({ tool, args: {}, session: 's1' }, allow);
        assert.equal(decision.kind, 'allow');
    }
    assert.equal(consultCalls.length, 0);
});

test('R-01-006/AC-03 门策略可配置：完成门可配自有工具名单（tools 透传）', async () => {
    const { engine, consultCalls } = makeGate({
        gates: { completion: { enabled: true, policy: 'review', tools: ['task_complete', 'finish_turn'] } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'nit', text: 'ok' }],
    });
    await engine.handlePreExecute({ tool: 'task_complete', args: {}, session: 's1' }, allow);
    assert.equal(consultCalls.length, 1);
    await engine.handlePreExecute({ tool: 'concludesTurn', args: {}, session: 's1' }, allow); // 名单外不命中
    assert.equal(consultCalls.length, 1);
});

test('R-01-004/AC-01 不同会话的门状态互相隔离', async () => {
    const { engine, observer, consultCalls } = makeGate({
        gates: { failure: { enabled: true, policy: 'review', threshold: 1 } },
        results: [{ ok: true, adviceId: 'adv-1', severity: 'nit', text: 'ok' }],
    });
    observer.recordResult('s1', 'bash', false);
    await engine.handlePreExecute({ tool: 'bash', args: {}, session: 's1' }, allow);
    assert.equal(consultCalls.length, 1);
    // s2 无失败记录 → 不触发
    await engine.handlePreExecute({ tool: 'bash', args: {}, session: 's2' }, allow);
    assert.equal(consultCalls.length, 1);
});

test('R-01-004/AC-02 block 策略非 blocker 意见时放行并将意见送达到会话', async () => {
    const { engine, observer, delivered } = makeGate({
        gates: { failure: { enabled: true, policy: 'block', threshold: 1 } },
        results: [{ ok: true, adviceId: 'adv-9', severity: 'concern', text: '先检查磁盘空间。' }],
    });
    observer.recordResult('s1', 'bash', false);
    const decision = await engine.handlePreExecute({ tool: 'bash', args: {}, session: 's1' }, allow);
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
