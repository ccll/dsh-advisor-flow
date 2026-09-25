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
