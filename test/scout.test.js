import test from 'node:test';
import assert from 'node:assert/strict';
import { curateAdvisorConversation } from '../lib/scout.js';

test('T-014 Scout 策展重建：required 组强制保留（重建保留）', async () => {
    const result = await curateAdvisorConversation({
        legacy: 'LEGACY',
        budget: 1000,
        runScout: async () => ({
            groups: [{ id: 'g1', required: true, text: '关键上下文' }],
            synthesis: 'syn',
        }),
    });
    assert.ok(result.conversation.includes('关键上下文'));
});

test('T-014 Scout 非取消失败回退 legacy 会话（回退）', async () => {
    const result = await curateAdvisorConversation({
        legacy: 'LEGACY',
        budget: 1000,
        runScout: async () => {
            throw new Error('scout provider down');
        },
    });
    assert.equal(result.conversation, 'LEGACY');
});

test('T-014 Scout 超时按回退处理且受 timeoutMs 约束（边界）', async () => {
    const result = await curateAdvisorConversation({
        legacy: 'LEGACY',
        budget: 1000,
        timeoutMs: 10,
        runScout: async () => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            return { groups: [] };
        },
    });
    assert.equal(result.conversation, 'LEGACY');
});

test('T-014 Scout 硬截断与注记：synthesis 附不可信注记、整体超预算前缀截断、按原始顺序保序', async () => {
    const result = await curateAdvisorConversation({
        legacy: 'LEGACY',
        budget: 40,
        runScout: async () => ({
            groups: [
                { id: 'g1', required: false, text: '可选甲' },
                { id: 'g2', required: true, text: '必须乙' },
            ],
            synthesis: '推断内容',
        }),
    });
    // B3：整体硬截断（required 也受总预算约束——40 字符预算内前缀截断）
    assert.ok(result.conversation.length <= 40, `硬截断：实际 ${result.conversation.length} ≤ 40`);
    // B4：synthesis 附注记（预算充足时）
    const note = await curateAdvisorConversation({
        legacy: 'LEGACY',
        budget: 1000,
        runScout: async () => ({ groups: [{ id: 'g1', required: true, text: '关键上下文' }], synthesis: '推断内容' }),
    });
    assert.ok(result_note_check(note));
    function result_note_check(r) { return r.conversation.includes('[Scout synthesis — untrusted, non-authoritative inference; not evidence]'); }
    // B7：保序——required 组与可选组按原始顺序交错，不强制 required 前置
    const ordered = await curateAdvisorConversation({
        legacy: 'LEGACY',
        budget: 1000,
        runScout: async () => ({
            groups: [
                { id: 'g1', required: false, text: '可选甲' },
                { id: 'g2', required: true, text: '必须乙' },
            ],
            synthesis: '',
        }),
    });
    assert.ok(ordered.conversation.indexOf('可选甲') < ordered.conversation.indexOf('必须乙'), '保序：甲在乙前');
});
