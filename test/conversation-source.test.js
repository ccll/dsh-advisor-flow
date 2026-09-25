import test from 'node:test';
import assert from 'node:assert/strict';
import { recentConversation, reconstructSurface, selectRecentEntries } from '../lib/conversation-source.js';

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
