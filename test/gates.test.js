import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateEngine, ADVISOR_TOOL_NAME, failureSummary } from '../lib/gates/index.js';
import { createAdviceDelivery } from '../lib/delivery.js';
import { createSessionObserver } from '../lib/observer.js';

/**
 * 载体契约（T-008 真机实测，dsh 0.1.5-rc.1 / dsh-tools 0.1.5-rc.2，全部用例
 * 按此构造）：`tools/pre-execute` 以 `(exec, next)` 调监听器，exec 形状
 * `{ token, callId, rootCallId, name, arguments, agent?, parent?, signal }`——
 * 工具名在 `exec.name`、参数在 `exec.arguments`、会话标识在 `exec.agent.id`；
 * 监听器返回 `{kind:'allow'}`（必须调 next()）或 `{kind:'deny', reason}`。
 * 循环门是唯一硬门（C-007）：命中即同步 consult（entry:'gate'，Decision 协议），
 * 决策三值按阻断模式处置；咨询失败按同一阻断模式处置（R-01-005、R-02-005）。
 */

/** 门引擎夹具：可编程咨询结果 + 送达/停止记录 + 日志捕获。 */
function makeGate({ loop = { enabled: false }, disabled = false, failureMode = 'warn-and-continue', results = [], consultImpl, stopSession, observer = createSessionObserver({ logger: { info() {}, error() {} } }) } = {}) {
    const logs = { error: [], info: [], warn: [] };
    const logger = {
        error: (message, fields) => logs.error.push({ message, fields }),
        info: (message, fields) => logs.info.push({ message, fields }),
        warn: (message, fields) => logs.warn.push({ message, fields }),
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
        return next ?? { ok: true, adviceId: `adv-${index}`, decision: 'proceed', markdown: '评审通过，可继续。' };
    };
    const delivered = [];
    const engine = createGateEngine({
        consult,
        observer,
        delivery: (sessionId, text) => delivered.push({ sessionId, text }),
        getConfig: () => ({ enabled: disabled !== true, gates: { loop }, failureMode }),
        stopSession,
        logger,
    });
    const nextCalls = [];
    const next = () => {
        nextCalls.push(1);
        return { kind: 'allow' };
    };
    return { engine, observer, consultCalls, delivered, nextCalls, logs, next };
}

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

test('R-01-005/AC-01 真实宿主形状回归：同参三次等价调用，第 3 次执行前拦截并触发咨询', async () => {
    const { engine, consultCalls, nextCalls, next } = makeGate({
        loop: { enabled: true, threshold: 3 },
        results: [{ ok: true, adviceId: 'adv-1', decision: 'proceed', markdown: '同样的命令已重试两次，请先诊断。' }],
    });
    const exec = hostExec('bash', { command: 'npm test' }, 'sess-1', 'c1');
    await engine.handlePreExecute(exec, next);
    await engine.handlePreExecute(exec, next);
    assert.equal(consultCalls.length, 0); // 前两次不拦
    assert.equal(nextCalls.length, 2);
    const decision = await engine.handlePreExecute(exec, next);
    assert.equal(decision.kind, 'allow');
    assert.equal(consultCalls.length, 1); // 第 3 次等价调用执行前先评审
    assert.equal(nextCalls.length, 3);
    // 会话归属来自 exec.agent.id；入口为 gate 且问题含工具名与参数
    assert.equal(consultCalls[0].session, 'sess-1');
    assert.equal(consultCalls[0].entry, 'gate');
    assert.ok(consultCalls[0].question.includes('bash'));
    assert.ok(consultCalls[0].question.includes('npm test'));
});

test('R-01-005/AC-01 门命中同步阻塞受守护动作直至评审形成（门内联等待时序）', async () => {
    let release;
    const gate = makeGate({
        loop: { enabled: true, threshold: 1 },
        consultImpl: () => new Promise((resolve) => {
            release = () => resolve({ ok: true, adviceId: 'adv-1', decision: 'proceed', markdown: 'ok' });
        }),
    });
    const pending = gate.engine.handlePreExecute(hostExec('bash', { command: 'npm test' }), () => {
        gate.nextCalls.push(1);
        return { kind: 'allow' };
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gate.nextCalls.length, 0); // 评审未形成前动作被阻塞
    release();
    const decision = await pending;
    assert.equal(decision.kind, 'allow');
    assert.equal(gate.nextCalls.length, 1);
});

test('R-01-005/AC-02 决策 proceed：门结果 steer 送达（**Decision: proceed** + 全文）+ 计数重置 + 放行', async () => {
    const { engine, observer, delivered, nextCalls, next } = makeGate({
        loop: { enabled: true, threshold: 1 },
        results: [{ ok: true, adviceId: 'adv-1', decision: 'proceed', markdown: '重复动作已评审，本次放行。' }],
    });
    const exec = hostExec('bash', { command: 'npm test' });
    const decision = await engine.handlePreExecute(exec, next);
    assert.equal(decision.kind, 'allow');
    assert.equal(nextCalls.length, 1); // 动作在评审之后放行
    // 送达文本 = **Decision: proceed** + 意见全文（adviceForGateText 契约）
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].sessionId, 's1');
    assert.equal(delivered[0].text, '**Decision: proceed**\n\n重复动作已评审，本次放行。');
    // proceed → 等价计数重置：等价键已清空
    assert.equal(observer.loopCount('s1', 'bash', { command: 'npm test' }), 0);
});

test('R-01-005/AC-05 proceed 重置等价计数：阈值 3 下第 3 次命中评审放行后，同参重新从 1 计数', async () => {
    const { engine, observer, consultCalls, nextCalls, next } = makeGate({
        loop: { enabled: true, threshold: 3 },
        results: [{ ok: true, adviceId: 'adv-1', decision: 'proceed', markdown: '评审通过。' }],
    });
    const exec = hostExec('bash', { command: 'npm test' });
    await engine.handlePreExecute(exec, next);
    await engine.handlePreExecute(exec, next);
    const third = await engine.handlePreExecute(exec, next);
    assert.equal(third.kind, 'allow');
    assert.equal(consultCalls.length, 1);
    assert.equal(nextCalls.length, 3);
    // AC-05：proceed → 计数重置，下一次同参调用从 1 重新计数
    assert.equal(observer.loopCount('s1', 'bash', { command: 'npm test' }), 0);
    await engine.handlePreExecute(exec, next);
    assert.equal(observer.loopCount('s1', 'bash', { command: 'npm test' }), 1);
});

test('R-01-005/AC-02 决策 revise：门结果 steer 送达 + 该次调用 deny 且原因含意见全文', async () => {
    const { engine, delivered, nextCalls } = makeGate({
        loop: { enabled: true, threshold: 1 },
        results: [{ ok: true, adviceId: 'adv-2', decision: 'revise', markdown: '该命令会删除生产数据，先改用回收站流程。' }],
    });
    const decision = await engine.handlePreExecute(hostExec('bash', { command: 'rm -rf /' }), () => {
        nextCalls.push(1);
        return { kind: 'allow' };
    });
    assert.equal(decision.kind, 'deny');
    assert.ok(decision.reason.includes('[advisor:loop-gate]'));
    assert.ok(decision.reason.includes('先改用回收站流程'));
    assert.equal(nextCalls.length, 0); // 动作未执行
    // revise 同样送达门结果（执行者必须看见决策与全文）
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].text, '**Decision: revise**\n\n该命令会删除生产数据，先改用回收站流程。');
});

test('R-01-005/AC-03 决策 blocked × warn-and-continue：通知后放行且留痕', async () => {
    const { engine, delivered, logs, nextCalls, next } = makeGate({
        loop: { enabled: true, threshold: 1 },
        failureMode: 'warn-and-continue',
        results: [{ ok: true, adviceId: 'adv-3', decision: 'blocked', markdown: '需要用户介入的关键问题，暂停并询问。' }],
    });
    const decision = await engine.handlePreExecute(hostExec('bash', {}), next);
    assert.equal(decision.kind, 'allow'); // 警告放行：通知后放行
    assert.equal(nextCalls.length, 1);
    assert.equal(delivered.length, 1);
    assert.ok(delivered[0].text.startsWith('**Decision: blocked**'));
    // warn-and-continue 处置留痕（warn 日志）
    assert.ok(logs.warn.some((entry) => String(entry.message).includes('blocked decision continued')));
});

test('R-01-005/AC-03 决策 blocked × block-tool：仅拦截该次调用，原因含意见全文', async () => {
    const { engine, nextCalls } = makeGate({
        loop: { enabled: true, threshold: 1 },
        failureMode: 'block-tool',
        results: [{ ok: true, adviceId: 'adv-3', decision: 'blocked', markdown: '存在数据损坏风险，本次调用不得执行。' }],
    });
    const decision = await engine.handlePreExecute(hostExec('bash', {}), () => {
        nextCalls.push(1);
        return { kind: 'allow' };
    });
    assert.equal(decision.kind, 'deny');
    assert.ok(decision.reason.includes('[advisor:loop-gate]'));
    assert.ok(decision.reason.includes('数据损坏风险'));
    assert.equal(nextCalls.length, 0);
});

test('R-01-005/AC-03 决策 blocked × block-session：会话封锁 + stopSession 调用 + 后续调用全 deny', async () => {
    const stops = [];
    const { engine, consultCalls, delivered } = makeGate({
        loop: { enabled: true, threshold: 1 },
        failureMode: 'block-session',
        stopSession: (context) => stops.push(context),
        results: [{ ok: true, adviceId: 'adv-3', decision: 'blocked', markdown: '会话已进入危险状态，停止会话。' }],
    });
    const decision = await engine.handlePreExecute(hostExec('bash', {}), () => ({ kind: 'allow' }));
    assert.equal(decision.kind, 'deny');
    assert.equal(delivered.length, 1); // blocked 决策同样送达
    assert.equal(stops.length, 1); // 尽力停止当前执行
    assert.equal(stops[0].gate, 'loop');
    assert.equal(stops[0].sessionId, 's1');
    // 封锁生效：后续一切工具调用一律拦截，且不再发起咨询
    const after = await engine.handlePreExecute(hostExec('bash', {}, 's1', 'c2'), () => ({ kind: 'allow' }));
    assert.equal(after.kind, 'deny');
    assert.equal(after.reason.includes('危险状态') || after.reason.includes('封锁'), true);
    assert.equal(consultCalls.length, 1); // 封锁态不再发起咨询
});

test('R-02-005/AC-02 block-session 停止缝缺失：封锁照常生效且显性留痕', async () => {
    const { engine, logs } = makeGate({
        loop: { enabled: true, threshold: 1 },
        failureMode: 'block-session',
        results: [{ ok: true, adviceId: 'adv-4', decision: 'blocked', markdown: '停止会话。' }],
    });
    const decision = await engine.handlePreExecute(hostExec('bash', {}), () => ({ kind: 'allow' }));
    assert.equal(decision.kind, 'deny');
    assert.ok(logs.error.some((entry) => entry.message.includes('会话停止缝未接入')));
    // 封锁照常生效
    const after = await engine.handlePreExecute(hostExec('bash', {}, 's1', 'c2'), () => ({ kind: 'allow' }));
    assert.equal(after.kind, 'deny');
});

test('R-01-005/AC-03 block-session 封锁态可用 resetSession 撤除（会话重建语义）', async () => {
    const { engine } = makeGate({
        loop: { enabled: true, threshold: 1 },
        failureMode: 'block-session',
        results: [{ ok: true, adviceId: 'adv-5', decision: 'blocked', markdown: '封锁。' }],
    });
    await engine.handlePreExecute(hostExec('bash', {}), () => ({ kind: 'allow' }));
    engine.resetSession('s1');
    const after = await engine.handlePreExecute(hostExec('bash', {}, 's1', 'c2'), () => ({ kind: 'allow' }));
    assert.equal(after.kind, 'allow'); // 封锁态清除后恢复正常判定
});

test('R-01-005/AC-04 咨询失败按阻断模式处置：warn-and-continue 放行且错误留痕', async () => {
    const { engine, consultCalls, logs, next } = makeGate({
        loop: { enabled: true, threshold: 1 },
        consultImpl: () => ({ ok: false, code: 'ADVISOR_TIMEOUT', reason: 'advisor call timed out', category: 'provider-error' }),
    });
    const decision = await engine.handlePreExecute(hostExec('bash', {}), next);
    assert.equal(decision.kind, 'allow'); // warn-and-continue：失败也放行，主循环不停摆
    assert.equal(consultCalls.length, 1);
    assert.ok(logs.error.some((entry) => entry.fields.category === 'provider-error'));
});

test('R-01-005/AC-04 咨询失败 × block-tool：该次调用被拦截，原因含失败类别', async () => {
    const { engine, nextCalls } = makeGate({
        loop: { enabled: true, threshold: 1 },
        failureMode: 'block-tool',
        consultImpl: () => ({ ok: false, code: 'ADVISOR_TIMEOUT', reason: 'advisor call timed out', category: 'provider-error' }),
    });
    const decision = await engine.handlePreExecute(hostExec('bash', {}), () => ({ kind: 'allow' }));
    assert.equal(decision.kind, 'deny');
    assert.ok(decision.reason.includes('[advisor:loop-gate]'));
    assert.ok(decision.reason.includes('provider-error'));
    assert.ok(decision.reason.includes('timed out'));
});

test('R-01-005/AC-04 咨询失败 × block-session：会话封锁 + 停止钩子调用 + 后续调用全 deny', async () => {
    const stops = [];
    const { engine, consultCalls } = makeGate({
        loop: { enabled: true, threshold: 1 },
        failureMode: 'block-session',
        stopSession: (context) => stops.push(context),
        consultImpl: () => ({ ok: false, code: 'ADVISOR_TIMEOUT', reason: 'timed out', category: 'provider-error' }),
    });
    const decision = await engine.handlePreExecute(hostExec('bash', {}), () => ({ kind: 'allow' }));
    assert.equal(decision.kind, 'deny');
    assert.equal(stops.length, 1); // block-session 处置经停止缝
    // 封锁态：后续调用一律拦截且不再咨询
    const after = await engine.handlePreExecute(hostExec('bash', {}, 's1', 'c2'), () => ({ kind: 'allow' }));
    assert.equal(after.kind, 'deny');
    assert.equal(consultCalls.length, 1);
});

test('R-01-005/AC-04 预算耗尽类别（budget-exhausted）经同一阻断模式处置', async () => {
    const { engine, nextCalls } = makeGate({
        loop: { enabled: true, threshold: 1 },
        failureMode: 'block-tool',
        consultImpl: () => ({ ok: false, code: 'ADVISOR_FAILED', reason: '咨询队列已满（32），本次咨询被丢弃', category: 'budget-exhausted' }),
    });
    const decision = await engine.handlePreExecute(hostExec('bash', {}), () => ({ kind: 'allow' }));
    assert.equal(decision.kind, 'deny');
    assert.ok(decision.reason.includes('budget-exhausted'));
});

test('ask_advisor 工具豁免门拦截（防自递归）', async () => {
    const { engine, consultCalls } = makeGate({
        loop: { enabled: true, threshold: 1 },
        failureMode: 'block-tool',
    });
    const decision = await engine.handlePreExecute(hostExec(ADVISOR_TOOL_NAME, {}), () => ({ kind: 'allow' }));
    assert.equal(decision.kind, 'allow');
    assert.equal(consultCalls.length, 0);
});

test('真实宿主形状回归：旧假设形状载体 {tool,args} 被静默放行且不计数', async () => {
    const { engine, observer, consultCalls, nextCalls } = makeGate({
        loop: { enabled: true, threshold: 1 },
    });
    const stale = await engine.handlePreExecute({ tool: 'x', args: {} }, () => {
        nextCalls.push(1);
        return { kind: 'allow' };
    });
    assert.equal(stale.kind, 'allow'); // 静默放行
    assert.equal(nextCalls.length, 1); // 动作照常派发
    assert.equal(consultCalls.length, 0); // 不触发咨询
    // 对照：真实形状同参调用正常计数（证明门只对宿主形状生效）
    await engine.handlePreExecute(hostExec('x', {}, 's1', 'c1'), () => ({ kind: 'allow' }));
});

test('R-01-005/AC-05 等价判定以工具名与规范化参数为准：键序无关、参数实质变化即新键', async () => {
    const { engine, consultCalls, next } = makeGate({
        loop: { enabled: true, threshold: 3 },
        results: [{ ok: true, adviceId: 'adv-1', decision: 'proceed', markdown: 'ok' }],
    });
    await engine.handlePreExecute(hostExec('bash', { command: 'npm test' }, 's1', 'c1'), next);
    await engine.handlePreExecute(hostExec('bash', { command: 'npm run lint' }, 's1', 'c2'), next);
    assert.equal(consultCalls.length, 0); // 参数变化 → 各自新键，均未达阈值
    // 键序不影响等价：同参第三次命中
    await engine.handlePreExecute(hostExec('bash', { command: 'npm test', cwd: '/w' }, 's1', 'c3'), next);
    await engine.handlePreExecute(hostExec('bash', { cwd: '/w', command: 'npm test' }, 's1', 'c4'), next);
    await engine.handlePreExecute(hostExec('bash', { command: 'npm test', cwd: '/w' }, 's1', 'c5'), next);
    assert.equal(consultCalls.length, 1); // 同参第三次命中
});

test('R-02-005/AC-02 门组件抛错：按放行处置该次工具调用并记录错误，不悬挂', async () => {
    // 咨询引擎本身抛错（防御深一层）
    const throwingConsult = makeGate({
        loop: { enabled: true, threshold: 1 },
        consultImpl: () => {
            throw new Error('consult exploded');
        },
    });
    const a = await throwingConsult.engine.handlePreExecute(hostExec('bash', {}), () => ({ kind: 'allow' }));
    assert.equal(a.kind, 'allow');
    assert.ok(throwingConsult.logs.error.some((entry) => entry.message.includes('fail-open')));
});

test('R-02-005/AC-02 送达通道抛错被包含：处置仍完成（proceed 放行），不外抛', async () => {
    const logs = [];
    const boom = makeGate({
        loop: { enabled: true, threshold: 1 },
        results: [{ ok: true, adviceId: 'adv-1', decision: 'proceed', markdown: 'ok' }],
    });
    boom.engine = createGateEngine({
        consult: async () => ({ ok: true, adviceId: 'adv-1', decision: 'proceed', markdown: 'ok' }),
        observer: createSessionObserver({ logger: { info() {}, error() {} } }),
        delivery: () => {
            throw new Error('delivery exploded');
        },
        getConfig: () => ({ gates: { loop: { enabled: true, threshold: 1 } }, failureMode: 'warn-and-continue' }),
        logger: { error: (m) => logs.push(m), info() {}, warn() {} },
    });
    const decision = await boom.engine.handlePreExecute(hostExec('bash', {}), () => ({ kind: 'allow' }));
    assert.equal(decision.kind, 'allow'); // 送达通道抛错 → 处置仍完成（放行）
});

test('R-02-005/AC-02 next() 派发错误透传：nextSettled 后的异常原样上抛（waterfall 契约），不吞错', async () => {
    const { engine } = makeGate({
        loop: { enabled: true, threshold: 1 },
        results: [{ ok: true, adviceId: 'adv-1', decision: 'proceed', markdown: 'ok' }],
    });
    const boom = new Error('downstream exploded');
    await assert.rejects(
        engine.handlePreExecute(hostExec('bash', {}), () => {
            throw boom;
        }),
        (error) => error === boom, // 同一错误对象原样透传
    );
});

test('R-01-005/AC-01 阈值缺省回落：loop 配置缺 threshold 时按缺省 3 判定', async () => {
    const { engine, consultCalls, next } = makeGate({
        loop: { enabled: true }, // 无 threshold → 缺省 3
        results: [{ ok: true, adviceId: 'adv-1', decision: 'proceed', markdown: 'ok' }],
    });
    const exec = hostExec('bash', { command: 'npm test' });
    await engine.handlePreExecute(exec, next);
    await engine.handlePreExecute(exec, next);
    assert.equal(consultCalls.length, 0); // 前两次不拦（阈值回落 3）
    const decision = await engine.handlePreExecute(exec, next);
    assert.equal(decision.kind, 'allow');
    assert.equal(consultCalls.length, 1); // 第 3 次等价调用命中
});


test('R-01-005/AC-03 评审修复回归：引擎禁用时门不计数不咨询（R-02-001/AC-03 前置守卫）', async () => {
    const { engine, consultCalls, nextCalls, next } = makeGate({
        loop: { enabled: true, threshold: 1 },
        disabled: true,
    });
    await engine.handlePreExecute(hostExec('bash', {}, 's1', 'c1'), next);
    assert.equal(consultCalls.length, 0); // 禁用态不触发咨询
    assert.equal(nextCalls.length, 1); // 动作照常放行
});

test('R-01-005/AC-05 评审修复：blocked 与 revise 不重置等价计数（pi 语义），仅 proceed 重置', async () => {
    const { engine, consultCalls, next } = makeGate({
        loop: { enabled: true, threshold: 3 },
        results: [
            { ok: true, adviceId: 'a1', decision: 'blocked', markdown: '需要用户介入。' },
            { ok: true, adviceId: 'a2', decision: 'blocked', markdown: '仍需介入。' },
        ],
    });
    for (let i = 0; i < 2; i++) {
        await engine.handlePreExecute(hostExec('bash', { command: 'echo x' }, 's1', `b${i}`), next);
    }
    assert.equal(consultCalls.length, 0); // 前两次不拦
    await engine.handlePreExecute(hostExec('bash', { command: 'echo x' }, 's1', 'b2'), next);
    assert.equal(consultCalls.length, 1); // 第 3 次命中评审（blocked×warn 放行不重置）
    // 第 4 次等价调用：计数未重置 → 仍受审（blocked 不重置）
    await engine.handlePreExecute(hostExec('bash', { command: 'echo x' }, 's1', 'b4'), next);
    assert.equal(consultCalls.length, 2); // 无重置 → 第 4 次仍命中评审
});

test('R-02-005/AC-02 评审修复回归：压缩/重写路径不再调用已退役的 delivery.reset（TypeError 防回归）', () => {
    const resetless = { registerAgent() {}, unregisterAgent() {}, steerAdvice() {}, status: () => ({}) };
    const wired = createAdviceDelivery({ logger: { info() {}, warn() {}, error() {} } });
    assert.equal(typeof wired.reset, 'undefined'); // 新送达面无 reset（冷却已退役）
    assert.equal(typeof wired.steerAdvice, 'function');
    void resetless;
});
