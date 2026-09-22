import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, name, inject } from '../lib/index.js';
import { createFakeLlm, answer } from './helpers.js';

function makeCtx({ withTools = true, withEvents = true, llm, approvals } = {}) {
    const registered = [];
    const subscriptions = [];
    const logs = { error: [], warn: [], info: [] };
    const logger = {
        error: (message) => logs.error.push(message),
        warn: (message) => logs.warn.push(message),
        info: (message) => logs.info.push(message),
    };
    const ctx = {
        logger: () => logger,
        root: { get: (service) => (service === 'llm' ? llm : undefined) },
        ...(withEvents
            ? {
                on: (event, handler, options) => subscriptions.push({ event, handler, options }),
            }
            : {}),
        ...(approvals ? { approvals } : {}),
        ...(withTools ? { tools: { register: (tool) => registered.push(tool) } } : {}),
    };
    return { ctx, registered, subscriptions, logs };
}

const entryConfig = {
    enabled: true,
    advisor: { provider: 'test', model: 'm' },
};

test('工具注册缝缺失时启动期 logger.error 显性化并 fail loud（注册失败留痕属启动期质量问题，不锚定 AC）', () => {
    const { ctx, registered, logs } = makeCtx({ withTools: false, llm: createFakeLlm([]) });
    assert.throws(() => apply(ctx, entryConfig), /工具注册缝缺失/);
    assert.equal(registered.length, 0);
    assert.equal(logs.error.filter((message) => message.includes('工具注册缝')).length, 1);
    assert.ok(logs.error.some((message) => message.includes('advisor-flow')));
});

test('注册缝调用抛错同样 fail loud，不静默降级', () => {
    const { ctx, logs } = makeCtx({ llm: createFakeLlm([]) });
    ctx.tools.register = () => {
        throw new Error('registry broken');
    };
    assert.throws(() => apply(ctx, entryConfig), /registry broken/);
    assert.ok(logs.error.some((message) => message.includes('注册失败')));
});

test('R-02-001/AC-01 apply 用入口配置创建运行时，返回的服务面可咨询可配置', async () => {
    const llm = createFakeLlm([answer('入口配置意见。'), answer('换配置后的意见。')]);
    const { ctx, registered } = makeCtx({ llm });
    const services = apply(ctx, entryConfig);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, 'ask_advisor');
    assert.equal(services.config().enabled, true);

    // 工具面经注册的同一实例工作
    const result = await services.askAdvisor.execute({ question: 'q' });
    assert.equal(result.adviceId, 'adv-1');

    // applyConfig 经返回的入口即时生效于后续咨询（门配置签名同步重建）
    services.applyConfig({
        ...services.config(),
        advisor: { ...services.config().advisor, model: 'm2' },
    });
    const second = await services.askAdvisor.execute({});
    assert.equal(second.adviceId, 'adv-2');
    assert.equal(llm.calls[1].options.model, 'm2');

    // dispose 路径容错：无 tools 二次 dispose 不抛出
    services.dispose();
    services.dispose();
});

test('R-02-005/AC-01 禁用配置下 apply 仍可用：工具返回 NO_ADVISOR_MODEL 而不抛出', async () => {
    const llm = createFakeLlm([]);
    const { ctx, registered } = makeCtx({ llm });
    const services = apply(ctx, { enabled: false });
    assert.equal(services.config().enabled, false);
    assert.equal(registered[0].name, 'ask_advisor');
    const result = await services.askAdvisor.execute({});
    assert.equal(result.error, true);
    assert.equal(result.code, 'NO_ADVISOR_MODEL');
    assert.equal(name, 'dsh-advisor-flow');
    assert.deepEqual(inject, ['llm']);
});

test('事件订阅缝缺失时启动期 fail loud（与工具注册缝同纪律，不锚定 AC）', () => {
    const { ctx, logs } = makeCtx({ withEvents: false, llm: createFakeLlm([]) });
    assert.throws(() => apply(ctx, entryConfig), /事件订阅缝缺失/);
    assert.match(logs.error[0], /advisor-flow/);
});

test('R-01-003/AC-01 apply 接线：pre-execute 门命中同步咨询，session/event 全局订阅', async () => {
    const llm = createFakeLlm([answer('severity: nit\n计划评审通过。')]);
    const { ctx, subscriptions } = makeCtx({ llm });
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm' },
        gates: { plan: { enabled: true, policy: 'review' } },
    });
    const wired = Object.fromEntries(subscriptions.map((s) => [s.event, s]));
    assert.ok(wired['tools/pre-execute']);
    assert.equal(wired['session/event'].options?.global, true);
    assert.equal(wired['agent/created'].options?.global, true);
    assert.equal(wired['agent/disposed'].options?.global, true);

    // 门命中：exit_plan_mode 在 pre-execute 被同步评审后放行
    const decision = await wired['tools/pre-execute'].handler({ tool: 'exit_plan_mode', args: {}, session: 's1' }, () => ({ kind: 'allow' }));
    assert.equal(decision.kind, 'allow');
    assert.equal(llm.calls.length, 1);
    // 普通工具不命中
    await wired['tools/pre-execute'].handler({ tool: 'read_file', args: {}, session: 's1' }, () => ({ kind: 'allow' }));
    assert.equal(llm.calls.length, 1);
    // ask_advisor 豁免
    await wired['tools/pre-execute'].handler({ tool: 'ask_advisor', args: {}, session: 's1' }, () => ({ kind: 'allow' }));
    assert.equal(llm.calls.length, 1);
});

test('R-02-003/AC-02 状态快照读活配置：applyConfig 后门配置即时可见', async () => {
    const { ctx } = makeCtx({ llm: createFakeLlm([]) });
    const services = apply(ctx, { enabled: false });
    assert.equal(services.status.snapshot().enabled, false);
    services.applyConfig({
        enabled: true,
        advisor: { provider: 'test', model: 'm2' },
        gates: { plan: { enabled: true, policy: 'block' } },
    });
    const snapshot = services.status.snapshot();
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.advisor.model, 'm2');
    assert.equal(snapshot.gates.plan.enabled, true);
});

test('session/event 接线：stepped turn 与压缩事件转调 delivery 冷却与重置（事件形状为联调验证项，不锚定 AC）', async () => {
    const llm = createFakeLlm([answer('意见。'), answer('意见2。')]);
    const { ctx, subscriptions } = makeCtx({ llm });
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm' },
        gates: { plan: { enabled: true, policy: 'review' } },
    });
    const sessionEvent = subscriptions.find((s) => s.event === 'session/event');
    assert.equal(sessionEvent.options?.global, true);

    // blocker 命中 → gate 送达（steer，冷却武装）
    const preExecute = subscriptions.find((s) => s.event === 'tools/pre-execute');
    const agent = { id: 's1', inject() {}, steer() {} };
    services.delivery.registerAgent(agent);
    await preExecute.handler({ tool: 'exit_plan_mode', args: {}, session: 's1' }, () => ({ kind: 'allow' }));
    // 用 blocker 咨询结果武装冷却
    const llmPrograms = llm.calls.length;
    assert.ok(llmPrograms >= 1);
    // 直接驱动送达以武装冷却（避免依赖顾问 severity）
    services.delivery.deliver('s1', { adviceId: 'adv-x', severity: 'blocker', text: 't' });
    assert.equal(services.delivery.status().cooldowns.s1, 2);
    // stepped turn 完成 → 冷却倒数
    sessionEvent.handler({ id: 's1' }, { type: 'turn/end' });
    assert.equal(services.delivery.status().cooldowns.s1, 1);
    // 压缩事件 → 冷却与观察状态重置
    sessionEvent.handler({ id: 's1' }, { type: 'session/compact' });
    assert.equal(services.delivery.status().cooldowns.s1, undefined);
    // 未知类型被忽略（不抛出、不误触发）
    sessionEvent.handler({ id: 's1' }, { type: 'whatever/new' });
    assert.equal(services.delivery.status().cooldowns.s1, undefined);
});

test('双缝观测保留：tools/result 与 session/event 均投喂观察器，执行标识去重（缝取舍归联调，不锚定 AC）', async () => {
    const { ctx, subscriptions } = makeCtx({ llm: createFakeLlm([]) });
    const services = apply(ctx, { enabled: false });
    const sessionEvent = subscriptions.find((s) => s.event === 'session/event');
    const toolsResult = subscriptions.find((s) => s.event === 'tools/result');
    assert.ok(toolsResult, '生命周期 tools/result 缝必须保留投喂');
    assert.ok(sessionEvent, 'session/event 缝必须投喂');
    // 两缝投递同一执行 → 失败计数只 +1
    toolsResult.handler({ type: 'tool/result', session: 's1', tool: 'bash', ok: false, execId: 'x1' });
    sessionEvent.handler({ id: 's1' }, { type: 'tool/result', tool: 'bash', ok: false, execId: 'x1' });
    assert.equal(services.observer.failureStreak('s1', 'bash'), 1);
    // 仅单缝（session/event）继续投递 → 正常累加
    sessionEvent.handler({ id: 's1' }, { type: 'tool/result', tool: 'bash', ok: false, execId: 'x2' });
    assert.equal(services.observer.failureStreak('s1', 'bash'), 2);
});

test('approver 缝缺失显性化：一次性 error + 状态快照 degraded 标注（不锚定 AC）', () => {
    const { ctx, logs: captured } = makeCtx({ llm: createFakeLlm([]) });
    const services = apply(ctx, { enabled: false });
    assert.ok(captured.error.some((message) => message.includes('人工审批缝不可得')));
    assert.equal(captured.error.filter((message) => message.includes('人工审批缝不可得')).length, 1); // 仅一次性
    assert.equal(services.status.snapshot().degradations.askPolicy, 'approver-seam-missing');
});

test('R-01-005/AC-02 接线：宿主 approval 缝可得时 ask 策略接上人工决定（拒绝 → deny）', async () => {
    const decisions = [];
    const { ctx, subscriptions } = makeCtx({
        llm: createFakeLlm([answer('重复执行存在风险。')]),
        approvals: { request: async (request) => {
            decisions.push(request);
            return false;
        } },
    });
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm' },
        gates: { loop: { enabled: true, policy: 'ask', threshold: 1 } },
    });
    assert.equal(services.status.snapshot().degradations.askPolicy, undefined); // 缝可得 → 不降级
    const preExecute = subscriptions.find((s) => s.event === 'tools/pre-execute').handler;
    const decision = await preExecute({ tool: 'bash', args: { command: 'npm test' }, session: 's1' }, () => ({ kind: 'allow' }));
    assert.equal(decision.kind, 'deny');
    assert.ok(decision.reason.includes('人工拒绝'));
    assert.equal(decisions.length, 1); // ask 策略经宿主审批缝征询
    assert.equal(decisions[0].gate, 'loop');
});

test('commands/gateway 缝缺失时显性化降级而非拒绝启动（不锚定 AC）', () => {
    const { ctx, logs } = makeCtx({ llm: createFakeLlm([]) });
    const services = apply(ctx, { enabled: false });
    assert.equal(services.status.snapshot().degradations.commands, 'registry-seam-missing');
    assert.equal(services.status.snapshot().degradations.settingsCard, 'gateway-seam-missing');
    assert.ok(logs.warn.some((message) => message.includes('命令注册缝缺失')));
    assert.ok(logs.warn.some((message) => message.includes('gateway 缝缺失')));
    // ask approval 缺失的降级标注同在
    assert.equal(services.status.snapshot().degradations.askPolicy, 'approver-seam-missing');
});

test('R-02-001/AC-01 gateway 缝可得时：卡片 set 经 RPC 即时生效于后续咨询', async () => {
    const registered = [];
    const llm = createFakeLlm([answer('一。'), answer('二。')]);
    const { ctx, registered: tools } = makeCtx({ llm });
    ctx.gateway = { register: (name, handler) => registered.push({ name, handler }) };
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm1' },
    });
    const get = registered.find((entry) => entry.name === 'advisor-flow/get').handler;
    const set = registered.find((entry) => entry.name === 'advisor-flow/set').handler;

    const got = await get({});
    assert.equal(got.config.advisor.model, 'm1');
    const result = await set({ args: { patch: { advisor: { model: 'm2' } } } });
    assert.equal(result.ok, true);

    // 即时生效：set 后的下一次咨询用新模型（R-02-001/AC-01）
    const consulted = await services.askAdvisor.execute({});
    assert.equal(consulted.adviceId, 'adv-1');
    assert.equal(llm.calls[0].options.model, 'm2');
});
