import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, name, inject } from '../lib/index.js';
import { createFakeLlm, answer } from './helpers.js';

function makeCtx({ withTools = true, withEvents = true, llm } = {}) {
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
    assert.equal(logs.error.length, 1);
    assert.match(logs.error[0], /advisor-flow/);
});

test('注册缝调用抛错同样 fail loud，不静默降级', () => {
    const { ctx, logs } = makeCtx({ llm: createFakeLlm([]) });
    ctx.tools.register = () => {
        throw new Error('registry broken');
    };
    assert.throws(() => apply(ctx, entryConfig), /registry broken/);
    assert.match(logs.error[0], /注册失败/);
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
