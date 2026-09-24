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

test('R-01-005/AC-05 循环等价以工具名与规范化参数为准：键序无关、参数实质变化即新键', () => {
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

test('R-01-005/AC-05 参数规范化：长字符串截断保留长度标记，同参仍等价', () => {
    const long = 'x'.repeat(5000);
    assert.equal(normalizeToolArgs({ blob: long }), normalizeToolArgs({ blob: long }));
    const key = normalizeToolArgs({ blob: long });
    assert.ok(key.includes('len=5000'));
    assert.ok(key.length < 1000); // 序列化有界
    assert.notEqual(normalizeToolArgs({ blob: long }), normalizeToolArgs({ blob: `${long}y` }));
});

test('R-01-005 resetLoopKey 清一个等价键（proceed 放行后的计数重置缝）', () => {
    const { observer } = makeObserver();
    const first = observer.recordCall('s1', 'bash', { command: 'npm test' });
    assert.equal(first.count, 1);
    const second = observer.recordCall('s1', 'bash', { command: 'npm test' });
    assert.equal(second.count, 2);
    observer.resetLoopKey('s1', first.key);
    assert.equal(observer.loopCount('s1', 'bash', { command: 'npm test' }), 0);
    // reset 后同一等价键重新从 1 计数
    const after = observer.recordCall('s1', 'bash', { command: 'npm test' });
    assert.equal(after.count, 1);
});

test('R-01-005 压缩/重写事件重置观察状态：循环等价表不跨压缩继承', () => {
    const { observer } = makeObserver();
    observer.recordCall('s1', 'write_file', { path: 'a' });
    observer.recordCall('s1', 'bash', { command: 'x' });
    // 宿主 session/event 存储记录形状：{type, seq, time, data}，wiring 以 session 载体补会话标识
    observer.onEvent({ type: 'session/compact', seq: 7, time: 0, data: {}, session: 's1' });
    assert.equal(observer.snapshot('s1').loopKeys, 0);
    // reset 后同一等价键重新从 1 计数
    const after = observer.recordCall('s1', 'write_file', { path: 'a' });
    assert.equal(after.count, 1);
});

test('R-02-005 观察器容错：垃圾事件与内部异常不外抛、不断事件管线', () => {
    const { observer, logs } = makeObserver();
    assert.equal(observer.onEvent(null), undefined);
    assert.equal(observer.onEvent('garbage'), undefined);
    assert.equal(observer.onEvent({ type: 'unknown/type', session: 's1' }), undefined);
    // 内部抛错被包含（reset 阶段）
    const logs2 = [];
    const breaking = createSessionObserver({ logger: { info: () => logs.info.push(1), warn() {}, error: (m) => logs.error.push(m) } });
    breaking.reset = () => {
        throw new Error('boom');
    };
    assert.equal(breaking.onEvent({ type: 'session/compact', session: 's' }), undefined);
    assert.equal(logs.error.length, 1);
});

test('R-01-005 sessionOf 宽窄两种形态：agent 载体分支、字符串直传、窄版不吞裸 id 与 agent', async () => {
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
