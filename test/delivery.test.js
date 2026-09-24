import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdviceDelivery } from '../lib/delivery.js';

/**
 * 意见送达契约（R-01-005；SOLUTION.md#意见送达，C-007）：
 * - 门结果一律 steer（唤醒式，pi 原生语义：无 severity 分流、无冷却）；
 * - 消息为 user 角色、content 为 ContentBlock 数组且带稳定 id，插件身份在
 *   `source.plugin`；
 * - 无 agent 的会话丢弃消息并留 warn（advisory only）；
 * - 送达路由绝不抛出：通道损坏不得让门 fail-open 崩溃。
 */

function makeAgent({ steerThrows = false } = {}) {
    const calls = [];
    const agent = {
        id: 's1',
        ...(steerThrows
            ? { steer: () => { throw new Error('steer broken'); } }
            : { steer: (message) => calls.push(message) }),
    };
    return { agent, calls };
}

test('R-01-005/AC-02 门结果一律 steer 送达：块数组、稳定 id、插件身份与折叠摘要', () => {
    const { agent, calls } = makeAgent();
    const delivery = createAdviceDelivery({});
    delivery.registerAgent(agent);
    assert.equal(delivery.steerAdvice('s1', '**Decision: revise**\n\n先改用回收站流程。'), true);
    assert.equal(calls.length, 1);
    const message = calls[0];
    assert.equal(message.role, 'user');
    assert.equal(typeof message.id, 'string'); // 宿主消息契约带稳定 id
    assert.ok(Array.isArray(message.content)); // content 是 ContentBlock 数组
    assert.equal(message.content[0].type, 'text');
    assert.equal(message.content[0].text, '**Decision: revise**\n\n先改用回收站流程。');
    assert.equal(message.source.kind, 'plugin');
    assert.equal(message.source.plugin, 'advisor-flow');
    assert.equal(message.source.form, 'notice');
    assert.ok(message.source.summary.length <= 120); // 折叠行摘要有界
});

test('R-01-005/AC-02 steerAdvice 一律 steer：无 severity 路由、无冷却（连续送达不压制）', async () => {
    const { agent, calls } = makeAgent();
    const delivery = createAdviceDelivery({});
    delivery.registerAgent(agent);
    for (let i = 0; i < 3; i++) {
        assert.equal(delivery.steerAdvice('s1', `**Decision: revise**\n\n第 ${i} 次意见。`), true);
    }
    assert.equal(calls.length, 3); // 一律 steer，无冷却压制
});

test('R-01-005/AC-02 无 agent 的会话意见被丢弃并留 warn，不抛出；注册表回退命中即可送达', () => {
    const logs = [];
    const delivery = createAdviceDelivery({ logger: { warn: (m) => logs.push(m) } });
    assert.equal(delivery.steerAdvice('nobody', '**Decision: proceed**\n\nok'), false);
    assert.equal(logs.length, 1); // 丢弃留 warn，不静默
    // 注册表回退：lookupAgent 命中即可送达
    const { agent, calls } = makeAgent();
    const withFallback = createAdviceDelivery({ lookupAgent: (sessionId) => (sessionId === 's1' ? agent : undefined) });
    assert.equal(withFallback.steerAdvice('s1', '**Decision: proceed**\n\nok'), true);
    assert.equal(calls.length, 1);
});

test('R-01-005/AC-03 送达通道抛错被包含：steerAdvice 不外抛、返回 false', () => {
    const { agent } = makeAgent({ steerThrows: true });
    const logs = [];
    const delivery = createAdviceDelivery({ logger: { error: (m) => logs.push(m) } });
    delivery.registerAgent(agent);
    assert.equal(delivery.steerAdvice('s1', '**Decision: blocked**\n\n停止。'), false);
    assert.equal(logs.length, 1);
});

test('R-01-005 非法文本输入容错：非字符串文本被 String() 归一，消息契约不破坏', () => {
    const { agent, calls } = makeAgent();
    const delivery = createAdviceDelivery({});
    delivery.registerAgent(agent);
    assert.equal(delivery.steerAdvice('s1', 42), true); // 非字符串归一为 String()
    assert.equal(calls[0].content[0].text, '42');
    assert.equal(typeof calls[0].id, 'string');
    assert.equal(delivery.status().agents.includes('s1'), true);
    delivery.unregisterAgent('s1');
    assert.equal(delivery.status().agents.length, 0);
    assert.equal(delivery.steerAdvice('s1', 'x'), false); // agent 已移除 → 丢弃
});

test('C-007 契约面单点：不再有 deliver 方法与 severity 路由（退役面显性回归钉住）', () => {
    const delivery = createAdviceDelivery({});
    assert.equal(typeof delivery.deliver, 'undefined'); // 旧 deliver 分流已退役
    assert.equal(typeof delivery.onSteppedTurnEnd, 'undefined'); // 冷却倒数已退役
});
