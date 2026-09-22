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
    observer.onEvent({ type: 'session/compact', session: 's1' });
    assert.equal(observer.failureStreak('s1', 'write_file'), 0);
    assert.equal(observer.snapshot('s1').loopKeys, 0);
    // reset 后同一等价键重新从 1 计数
    const after = observer.recordCall('s1', 'write_file', { path: 'a' });
    assert.equal(after.count, 1);
});

test('R-01-004/AC-01 result 事件经 onEvent 消费：显式失败入计数、成功清零', () => {
    const { observer } = makeObserver();
    observer.onEvent({ type: 'tool/result', session: 's1', tool: 'bash', ok: false });
    observer.onEvent({ type: 'tool/result', session: 's1', tool: 'bash', ok: false });
    assert.equal(observer.failureStreak('s1', 'bash'), 2);
    observer.onEvent({ type: 'tool/result', session: 's1', tool: 'bash', ok: true });
    assert.equal(observer.failureStreak('s1', 'bash'), 0);
});

test('R-02-005 观察器容错：垃圾事件与内部异常不外抛、不断事件管线', () => {
    const { observer, logs } = makeObserver();
    assert.equal(observer.onEvent(null), undefined);
    assert.equal(observer.onEvent('garbage'), undefined);
    assert.equal(observer.onEvent({ type: 'unknown/type', session: 's1' }), undefined);
    // 内部抛错被包含
    const breaking = createSessionObserver({ logger: { info: () => logs.info.push(1), warn() {}, error: (m) => logs.error.push(m) } });
    breaking.recordResult = () => {
        throw new Error('boom');
    };
    assert.equal(breaking.onEvent({ type: 'tool/result', session: 's', tool: 't', ok: false }), undefined);
    assert.equal(logs.error.length, 1);
});

test('R-01-004/AC-01 双缝去重：同一执行结果经两缝先后投递只计一次', () => {
    const { observer } = makeObserver();
    // 生命周期缝（tools/result）与 session/event 缝携带同一执行标识
    observer.onEvent({ type: 'tool/result', session: 's1', tool: 'bash', ok: false, execId: 'exec-1' });
    observer.onEvent({ type: 'result', session: 's1', tool: 'bash', ok: false, execId: 'exec-1' });
    assert.equal(observer.failureStreak('s1', 'bash'), 1);
    // 同一执行标识的后续投递（含矛盾的成功报告）都被去重：首报定成败
    observer.onEvent({ type: 'tool/result', session: 's1', tool: 'bash', ok: true, execId: 'exec-1' });
    assert.equal(observer.failureStreak('s1', 'bash'), 1);
    // 新执行的真正成功照常清零
    observer.onEvent({ type: 'result', session: 's1', tool: 'bash', ok: true, execId: 'exec-2' });
    assert.equal(observer.failureStreak('s1', 'bash'), 0);
});

test('R-01-004/AC-01 仅单缝投递时正常计数（两种实测结论下都稳健）', () => {
    const { observer } = makeObserver();
    observer.onEvent({ type: 'tool/result', session: 's1', tool: 'bash', ok: false, execId: 'e1' });
    observer.onEvent({ type: 'tool/result', session: 's1', tool: 'bash', ok: false, execId: 'e2' });
    assert.equal(observer.failureStreak('s1', 'bash'), 2);
    // 无执行标识的事件保守逐次计数（宁可阈值偏差一格，不可让失败门失去输入）
    // ——临时偏置；若联调确认两缝无共享标识，idempotency token 方案见
    // T-002 联调清单（b5d82eb）。
    observer.onEvent({ type: 'tool/result', session: 's1', tool: 'bash', ok: false });
    assert.equal(observer.failureStreak('s1', 'bash'), 3);
});

test('R-01-004/AC-01 同工具两次不同执行（不同标识）均正常计数，不被去重误并', () => {
    const { observer } = makeObserver();
    observer.onEvent({ type: 'tool/result', session: 's1', tool: 'bash', ok: false, execId: 'exec-A' });
    observer.onEvent({ type: 'tool/result', session: 's1', tool: 'bash', ok: false, execId: 'exec-B' });
    // 去重键必须逐执行区分：若未来放宽为 session+toolName 宽键，这里会塌成
    // 1 而漏计失败门输入——该断言钉住「键必含执行标识字段」的约束（实现侧
    // resultIdentity 仅从 execId/callId/executionId/seq/id 提取，宽键不成立）。
    assert.equal(observer.failureStreak('s1', 'bash'), 2);
    // 数字形态的标识同样逐执行区分
    observer.onEvent({ type: 'tool/result', session: 's1', tool: 'bash', ok: false, seq: 1 });
    observer.onEvent({ type: 'tool/result', session: 's1', tool: 'bash', ok: false, seq: 2 });
    assert.equal(observer.failureStreak('s1', 'bash'), 4);
    // 跨会话同标识互不影响（键含 sessionId）
    observer.onEvent({ type: 'tool/result', session: 's2', tool: 'bash', ok: false, execId: 'exec-A' });
    assert.equal(observer.failureStreak('s2', 'bash'), 1);
});

test('R-01-004/AC-01 result 事件只带无关 id 字段时落共享桶，不产生孤桶（窄版会话解析钉住）', () => {
    const { observer } = makeObserver();
    // result 事件的 id 字段是执行标识而非会话：窄版解析不得以它开孤桶
    observer.onEvent({ type: 'tool/result', id: 'exec-9', tool: 'bash', ok: false });
    assert.equal(observer.failureStreak('default', 'bash'), 1); // 落 default 共享桶，计数照常
    assert.equal(observer.failureStreak('exec-9', 'bash'), 0); // 无以执行 id 命名的孤桶
    // 带 sessionId 的正常事件仍按会话归桶
    observer.onEvent({ type: 'tool/result', sessionId: 's1', tool: 'bash', ok: false, id: 'exec-9' });
    assert.equal(observer.failureStreak('s1', 'bash'), 1);
});

test('R-02-005 sessionOf 宽窄两种形态：字符串直传、载体 id 兜底、result 窄版不吞裸 id', async () => {
    const { sessionOf, sessionOfEvent } = await import('../lib/util.js');
    // 字符串直传（session/disposed 可能以纯字符串 id 直传）
    assert.equal(sessionOf('s1'), 's1');
    assert.equal(sessionOfEvent('s1'), 's1');
    // 载体对象 id 兜底仅限宽版
    assert.equal(sessionOf({ id: 's1' }), 's1');
    assert.equal(sessionOfEvent({ id: 's1' }), 'default'); // 窄版不看裸 id
    // result 事件只带无关 id 字段 → 共享桶（失败门不静默失明）
    const { observer } = makeObserver();
    observer.onEvent({ type: 'tool/result', id: 'exec-9', tool: 'bash', ok: false });
    assert.equal(observer.failureStreak('default', 'bash'), 1);
    assert.equal(observer.failureStreak('exec-9', 'bash'), 0);
});
