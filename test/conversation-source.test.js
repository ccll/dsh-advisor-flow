import test from 'node:test';
import assert from 'node:assert/strict';
import { knownNonSurfaceFrom, recentConversation, reconstructSurface, selectRecentEntries } from '../lib/conversation-source.js';

/** 会话事件流 fixture：用户→执行者(带工具调用)→tool/call→tool/result。 */
function sampleEvents() {
    return [
        { type: 'user/message', seq: 1, time: 0, data: { message: { content: [{ type: 'text', text: '请评审这个设计' }] } } },
        { type: 'assistant/message', seq: 2, time: 0, data: { message: { content: [{ type: 'text', text: '好的' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"npm test"}' }] } } },
        { type: 'tool/call', seq: 3, time: 0, data: { callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' } },
        { type: 'tool/result', seq: 4, time: 0, data: { message: { isError: false, source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'all tests pass' }] } } },
    ];
}

test('R-02-006/AC-01 有序面重建：User/Executor/Tool Call/Tool Result 按 pi 口径渲染', () => {
    const text = recentConversation(sampleEvents(), { maxChars: 500 });
    assert.ok(text.includes('User: 请评审这个设计'));
    assert.ok(text.includes('Executor: 好的'));
    assert.ok(text.includes('[Tool Call: bash({"command":"npm test"})]'));
    assert.ok(text.includes('[Tool Result for bash] (output):\nall tests pass'));
});

test('R-02-006/AC-02 per-tool 披露策略：exclude/summary 两态逐条对齐 pi 文案', () => {
    const events = [
        { type: 'assistant/message', seq: 1, time: 0, data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 'secret-tool', arguments: '{"k":"v"}' }] } } },
        { type: 'tool/call', seq: 2, time: 0, data: { callId: 'c1', name: 'secret-tool' } },
        { type: 'tool/result', seq: 3, time: 0, data: { message: { isError: true, source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'boom' }] } } },
    ];
    const excluded = recentConversation(events, { maxChars: 1000, policies: { 'secret-tool': 'exclude' } });
    assert.ok(excluded.includes('[Tool Call: secret-tool] (excluded by Advisor tool policy)'));
    assert.ok(excluded.includes('[Tool Result for secret-tool] (excluded by Advisor tool policy)'));
    const summarized = recentConversation(events, { maxChars: 1000, policies: { 'secret-tool': 'summary' } });
    assert.ok(summarized.includes('(arguments omitted by Advisor tool policy: summary)'));
    assert.ok(summarized.includes('status: error; 1 lines,'));
    assert.ok(!summarized.includes('boom'));
});

test('R-02-006/AC-02 compaction replace：被替换区间出面、摘要节点入面', () => {
    const events = [
        { type: 'user/message', seq: 1, time: 0, data: { message: { content: [{ type: 'text', text: '旧内容' }] } } },
        { type: 'user/message', seq: 2, time: 0, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [1], data: { message: { content: [{ type: 'text', text: '压缩摘要' }] } } },
    ];
    const surface = reconstructSurface(events);
    assert.equal(surface.length, 1);
    const text = recentConversation(events, { maxChars: 500 });
    assert.ok(text.includes('压缩摘要'));
    assert.ok(!text.includes('旧内容'));
});

test('R-02-006/AC-03 selectRecentEntries：超预算时省略标记 + 最新条目优先保留', () => {
    const entries = Array.from({ length: 20 }, (_, i) => `条目${i}${'x'.repeat(50)}`);
    const picked = selectRecentEntries(entries, 300);
    assert.ok(picked.includes('[Older context omitted:'));
    // 最新条目保留（从尾部向前选择）
    assert.ok(picked.includes(entries[entries.length - 1]) || picked.includes('[Newest entry truncated]'));
});

// ---- T-015 回归：宿主非表面事实词汇误判为「必需未知」炸门 -------------------
// 实弹现场：subagent/model-selection-policy（mailai-models 22 次拒绝）、
// session/end-seed（ops 28 次拒绝）。两类型均为宿主已知词汇表成员且追加时
// 不带 ignorable（宿主契约中的必需事件），此前被硬编码白名单遗漏。

test('T-015 回归：subagent/model-selection-policy 跳过而非拒绝重建', () => {
    const events = [
        { type: 'subagent/model-selection-policy', seq: 3, time: 0, data: { allowedModels: [{ provider: 'gpu', model: 'glm-5.3-flash' }] } },
        ...sampleEvents(),
    ];
    assert.doesNotThrow(() => reconstructSurface(events));
    const text = recentConversation(events, { maxChars: 500 });
    assert.ok(text.includes('User: 请评审这个设计'));
    assert.ok(!text.includes('model-selection-policy'));
});

test('T-015 回归：session/end-seed 跳过而非拒绝重建', () => {
    const events = [
        { type: 'session/end-seed', seq: 2, time: 0, data: {} },
        ...sampleEvents(),
    ];
    assert.doesNotThrow(() => reconstructSurface(events));
    const text = recentConversation(events, { maxChars: 500 });
    assert.ok(text.includes('User: 请评审这个设计'));
});

test('T-015 回归：ignorable 未知事件仍跳过（宿主契约不变）', () => {
    const events = [
        { type: 'future-harness/new-fact', seq: 5, time: 0, ignorable: true, data: {} },
        ...sampleEvents(),
    ];
    assert.doesNotThrow(() => reconstructSurface(events));
});

test('T-015 回归：两处词汇都不认识的非 ignorable 事件仍 fail-closed', () => {
    const events = [{ type: 'future-harness/surface-shifting', seq: 9, time: 0, data: {} }];
    assert.throws(() => reconstructSurface(events), /Unrecognized required session event type/);
});

test('T-015 词汇推导：宿主已知词汇 − 插件表面集 ∪ 兜底集（容忍缺失导出）', () => {
    const derived = knownNonSurfaceFrom([
        'user/message', 'assistant/message', 'tool/result', 'system/message',
        'todo/write', 'model/selection', 'subagent/catalog',
    ]);
    assert.ok(derived.has('todo/write'));
    assert.ok(derived.has('model/selection'));
    assert.ok(derived.has('subagent/catalog'));
    assert.ok(derived.has('subagent/model-selection-policy')); // 兜底集成员
    assert.ok(derived.has('session/end-seed')); // 兜底集成员
    assert.ok(!derived.has('user/message'));
    assert.ok(!derived.has('assistant/message'));
    assert.ok(!derived.has('tool/result'));
    // 宿主导出缺失/形态漂移：回落兜底集，不抛错。
    assert.doesNotThrow(() => knownNonSurfaceFrom(undefined));
    assert.ok(knownNonSurfaceFrom(undefined).has('session/end-seed'));
});
