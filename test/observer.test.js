import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionObserver, normalizeToolArgs } from '../lib/observer.js';

/** Drive the observer through a compact fixture. */
function makeObserver() {
    const logs = { info: [], warn: [], error: [] };
    const observer = createSessionObserver({
        logger: {
            info: (m, f) => logs.info.push({ m, f }),
            warn: (m) => logs.warn.push(m),
            error: (m) => logs.error.push(m),
        },
    });
    return { observer, logs };
}

test('R-01-004/AC-01 观察器维护失败计数：连续失败累加，成功清零', () => {
    const { observer } = makeObserver();
    observer.recordResult('s1', 'write_file', false);
    observer.recordResult('s1', 'write_file', false);
    assert.equal(observer.failureStreak('s1', 'write_file'), 2);
    assert.equal(observer.failureStreak('s1', 'read_file'), 0); // 按工具隔离
    observer.recordResult('s1', 'write_file', true);
    assert.equal(observer.failureStreak('s1', 'write_file'), 0);
});

test('R-01-005/AC-03 循环等价以工具名与规范化参数为准：键序无关、参数实质变化即新键', () => {
    const { observer } = makeObserver();
    const first = observer.recordCall('s1', 'write_file', { path: 'a.js', mode: 'w', content: 'x' });
    assert.equal(first.count, 1);
    // 键序不同但内容等价 → 同键累加
    const second = observer.recordCall('s1', 'write_file', { content: 'x', mode: 'w', path: 'a.js' });
    assert.equal(second.count, 2);
    assert.equal(second.key, first.key);
    // 参数实质变化 → 新键从 1 起算
    const changed = observer.recordCall('s1', 'write_file', { path: 'b.js', mode: 'w', content: 'x' });
    assert.notEqual(changed.key, first.key);
    assert.equal(changed.count, 1);
    // 工具名参与等价键
    const otherTool = observer.recordCall('s1', 'edit_file', { path: 'a.js', mode: 'w', content: 'x' });
    assert.notEqual(otherTool.key, first.key);
});

test('R-01-005/AC-03 参数规范化：长字符串截断保留长度标记，同参仍等价', () => {
    const long = 'x'.repeat(5000);
    assert.equal(normalizeToolArgs({ blob: long }), normalizeToolArgs({ blob: long }));
    const key = normalizeToolArgs({ blob: long });
    assert.ok(key.includes('len=5000'));
    assert.ok(key.length < 1000); // 序列化有界
    assert.notEqual(normalizeToolArgs({ blob: long }), normalizeToolArgs({ blob: `${long}y` }));
});

test('R-01-004/AC-01 压缩/重写事件重置观察状态，失败计数不跨压缩继承', () => {
    const { observer } = makeObserver();
    observer.recordResult('s1', 'write_file', false);
    observer.recordResult('s1', 'write_file', false);
    observer.recordCall('s1', 'write_file', { path: 'a' });
    // 宿主 session/event 存储记录形状：{type, seq, time, data}，wiring 以 session 载体补会话标识
    observer.onEvent({ type: 'session/compact', seq: 7, time: 0, data: {}, session: 's1' });
    assert.equal(observer.failureStreak('s1', 'write_file'), 0);
    assert.equal(observer.snapshot('s1').loopKeys, 0);
    // reset 后同一等价键重新从 1 计数
    const after = observer.recordCall('s1', 'write_file', { path: 'a' });
    assert.equal(after.count, 1);
});

test('R-01-004/AC-01 结果经权威缝 recordResult 消费：显式失败入计数、成功清零；session/event 的结果型存储记录不再计数（T-008 裁决）', () => {
    const { observer } = makeObserver();
    // 权威成败缝：tools/result 两参 (exec, result) → wiring 直喂 recordResult
    observer.recordResult('s1', 'bash', false, 'call-1');
    observer.recordResult('s1', 'bash', false, 'call-2');
    assert.equal(observer.failureStreak('s1', 'bash'), 2);
    observer.recordResult('s1', 'bash', true, 'call-3');
    assert.equal(observer.failureStreak('s1', 'bash'), 0);
    // session/event 的 tool/result 存储记录不带工具名，无法归属——onEvent 不再计数
    assert.equal(observer.onEvent({ type: 'tool/result', seq: 1, time: 0, data: {}, session: 's1' }), undefined);
    assert.equal(observer.failureStreak('s1', 'bash'), 0); // 计数未被事件扰动
});

test('R-02-005 观察器容错：垃圾事件与内部异常不外抛、不断事件管线', () => {
    const { observer, logs } = makeObserver();
    assert.equal(observer.onEvent(null), undefined);
    assert.equal(observer.onEvent('garbage'), undefined);
    assert.equal(observer.onEvent({ type: 'unknown/type', session: 's1' }), undefined);
    // 内部抛错被包含（reset 阶段）
    const breaking = createSessionObserver({ logger: { info: () => logs.info.push(1), warn() {}, error: (m) => logs.error.push(m) } });
    breaking.reset = () => {
        throw new Error('boom');
    };
    assert.equal(breaking.onEvent({ type: 'session/compact', session: 's' }), undefined);
    assert.equal(logs.error.length, 1);
});

test('R-01-004/AC-01 执行标识去重：同一执行结果经权威缝重复投递只计一次，首报定成败', () => {
    const { observer } = makeObserver();
    // 同一执行标识（exec.callId）的重复投递只计一次
    observer.recordResult('s1', 'bash', false, 'exec-1');
    observer.recordResult('s1', 'bash', false, 'exec-1'); // 同一执行标识的重复投递（如换名缝）
    assert.equal(observer.failureStreak('s1', 'bash'), 1);
    // 同一执行标识的后续投递（含矛盾的成功报告）都被去重：首报定成败
    observer.recordResult('s1', 'bash', true, 'exec-1');
    assert.equal(observer.failureStreak('s1', 'bash'), 1);
    // 新执行的真正成功照常清零
    observer.recordResult('s1', 'bash', true, 'exec-2');
    assert.equal(observer.failureStreak('s1', 'bash'), 0);
});

test('R-01-004/AC-01 无执行标识的投递保守逐次计数（两种实测结论下都稳健）', () => {
    const { observer } = makeObserver();
    observer.recordResult('s1', 'bash', false, 'e1');
    observer.recordResult('s1', 'bash', false, 'e2');
    assert.equal(observer.failureStreak('s1', 'bash'), 2);
    // 无标识的结果保守逐次计数（宁可阈值偏差一格，不可让失败门失去输入）
    observer.recordResult('s1', 'bash', false);
    assert.equal(observer.failureStreak('s1', 'bash'), 3);
});

test('R-01-004/AC-01 同工具两次不同执行（不同标识）均正常计数，不被去重误并', () => {
    const { observer } = makeObserver();
    observer.recordResult('s1', 'bash', false, 'exec-A');
    observer.recordResult('s1', 'bash', false, 'exec-B');
    // 去重键必须逐执行区分：若放宽为 session+toolName 宽键，这里会塌成 1 而
    // 漏计失败门输入——该断言钉住「键必含执行标识字段」的约束（权威缝以
    // exec.callId 为执行标识，wiring 逐执行投递）。
    assert.equal(observer.failureStreak('s1', 'bash'), 2);
    // 数字形态的标识同样逐执行区分
    observer.recordResult('s1', 'bash', false, 1);
    observer.recordResult('s1', 'bash', false, 2);
    assert.equal(observer.failureStreak('s1', 'bash'), 4);
    // 跨会话同标识互不影响（键含 sessionId）
    observer.recordResult('s2', 'bash', false, 'exec-A');
    assert.equal(observer.failureStreak('s2', 'bash'), 1);
});

test('R-01-004/AC-01 session/event 结果型存储记录被显式忽略：不计数、不开孤桶', () => {
    const { observer } = makeObserver();
    // 存储记录 {type, seq, time, data} 不带工具名；即使带无关 id 字段也不产生任何计数副作用
    assert.equal(observer.onEvent({ type: 'tool/result', id: 'exec-9', seq: 1, time: 0, data: {} }), undefined);
    assert.equal(observer.failureStreak('default', 'bash'), 0); // 无计数（权威缝唯一化）
    assert.equal(observer.failureStreak('exec-9', 'bash'), 0); // 无以执行 id 命名的孤桶
    // reset 类事件仍按会话归桶生效
    observer.recordResult('s1', 'bash', false, 'call-1');
    observer.onEvent({ type: 'session/compact', seq: 2, time: 0, data: {}, session: 's1' });
    assert.equal(observer.failureStreak('s1', 'bash'), 0);
});

test('R-02-005 sessionOf 宽窄两种形态：agent 载体分支、字符串直传、窄版不吞裸 id 与 agent', async () => {
    const { sessionOf, sessionOfEvent } = await import('../lib/util.js');
    // 字符串直传（session/disposed 可能以纯字符串 id 直传）
    assert.equal(sessionOf('s1'), 's1');
    assert.equal(sessionOfEvent('s1'), 's1');
    // 工具载体形态（T-008 实测）：会话标识在 exec.agent.id——宽版新增分支
    assert.equal(sessionOf({ agent: { id: 'sess-1' } }), 'sess-1');
    // 载体对象 id 兜底仅限宽版
    assert.equal(sessionOf({ id: 's1' }), 's1');
    assert.equal(sessionOfEvent({ id: 's1' }), 'default'); // 窄版不看裸 id
    // 窄版不含 agent 分支（reset 事件只认显式会话字段）
    assert.equal(sessionOfEvent({ agent: { id: 'sess-1' } }), 'default');
    // 优先级：显式 session 胜于 agent
    assert.equal(sessionOf({ session: 's1', agent: { id: 'sess-1' } }), 's1');
});
