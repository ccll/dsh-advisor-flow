import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdviceDelivery, buildAdviceMessage } from '../lib/delivery.js';

function makeAgent({ steerThrows = false } = {}) {
    const calls = [];
    const agent = {
        id: 's1',
        inject: (message) => calls.push({ channel: 'inject', message }),
        ...(steerThrows
            ? { steer: () => { throw new Error('steer broken'); } }
            : { steer: (message) => calls.push({ channel: 'steer', message }) }),
    };
    return { agent, calls };
}

function advice(overrides = {}) {
    return { adviceId: 'adv-1', severity: 'nit', text: '建议先补测试。', ...overrides };
}

test('R-01-003/AC-03 review 意见经送达到达会话：nit 走 inject 非唤醒通道', () => {
    const { agent, calls } = makeAgent();
    const delivery = createAdviceDelivery({});
    delivery.registerAgent(agent);
    const channel = delivery.deliver('s1', advice());
    assert.equal(channel, 'inject');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, 'inject');
    assert.ok(calls[0].message.content.startsWith('[advisor:nit] 建议先补测试。'));
    assert.ok(calls[0].message.content.includes('adviceId: adv-1')); // 意见正文附 adviceId 引用
    assert.equal(calls[0].message.source.plugin, 'advisor-flow');
    assert.ok(calls[0].message.source.summary.length <= 120);
});

test('R-01-003/AC-03 冷却窗口内仅压制同级 interrupting；不同级照常唤醒送达', () => {
    const { agent, calls } = makeAgent();
    const delivery = createAdviceDelivery({ immuneTurns: 2 });
    delivery.registerAgent(agent);

    assert.equal(delivery.deliver('s1', advice({ severity: 'concern' })), 'steer');
    // 冷却窗口内：同级 concern 降级为 inject（「不再送同级」）
    assert.equal(delivery.deliver('s1', advice({ severity: 'concern' })), 'inject');
    // 窗口内不同级 blocker：照常唤醒送达，并以 blocker 重新武装冷却
    assert.equal(delivery.deliver('s1', advice({ severity: 'blocker' })), 'steer');
    // 窗口内同级 blocker 降级
    assert.equal(delivery.deliver('s1', advice({ severity: 'blocker' })), 'inject');
    // 冷却耗尽后恢复 steer
    delivery.onSteppedTurnEnd('s1');
    delivery.onSteppedTurnEnd('s1');
    assert.equal(delivery.deliver('s1', advice({ severity: 'blocker' })), 'steer');
    assert.equal(calls.filter((c) => c.channel === 'steer').length, 3);
    assert.equal(calls.filter((c) => c.channel === 'inject').length, 2);
    // nit 永远 inject，不受冷却影响
    assert.equal(delivery.deliver('s1', advice({ severity: 'nit' })), 'inject');
});

test('R-01-003/AC-03 无 agent 的会话意见被丢弃并留 warn，不抛出', () => {
    const logs = [];
    const delivery = createAdviceDelivery({ logger: { warn: (m) => logs.push(m) } });
    assert.equal(delivery.deliver('nobody', advice()), undefined);
    assert.equal(logs.length, 1);
    // 注册表回退：lookupAgent 命中即可送达
    const { agent, calls } = makeAgent();
    const withFallback = createAdviceDelivery({ lookupAgent: (sessionId) => (sessionId === 's1' ? agent : undefined) });
    assert.equal(withFallback.deliver('s1', advice()), 'inject');
    assert.equal(calls.length, 1);
});

test('R-01-003/AC-03 送达通道抛错被包含：deliver 不外抛、返回 undefined', () => {
    const { agent } = makeAgent({ steerThrows: true });
    const logs = [];
    const delivery = createAdviceDelivery({ logger: { error: (m) => logs.push(m) } });
    delivery.registerAgent(agent);
    assert.equal(delivery.deliver('s1', advice({ severity: 'blocker' })), undefined);
    assert.equal(logs.length, 1);
});

test('R-01-003/AC-03 agent/disposed 清理会话冷却；压缩重置冷却', () => {
    const { agent } = makeAgent();
    const delivery = createAdviceDelivery({ immuneTurns: 3 });
    delivery.registerAgent(agent);
    delivery.deliver('s1', advice({ severity: 'concern' })); // steer, 冷却=3
    assert.equal(delivery.status().cooldowns.s1, 3);
    delivery.reset('s1');
    assert.equal(delivery.deliver('s1', advice({ severity: 'concern' })), 'steer'); // 冷却重置后再次 steer
    delivery.unregisterAgent('s1');
    assert.equal(delivery.status().agents.length, 0);
    assert.equal(delivery.deliver('s1', advice()), undefined); // agent 已移除
});

test('R-01-003/AC-03 消息形态：severity 标签 + 摘要有界 + 插件身份', () => {
    const message = buildAdviceMessage(advice({ severity: 'blocker', text: '长'.repeat(300) }));
    assert.ok(message.content.startsWith('[advisor:blocker] '));
    assert.equal(message.source.kind, 'plugin');
    assert.ok(message.source.summary.endsWith('…'));
    // 非法 severity 归一为 nit
    assert.ok(buildAdviceMessage(advice({ severity: 'catastrophic' })).content.startsWith('[advisor:nit] '));
});
