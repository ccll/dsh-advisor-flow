import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, name, inject } from '../lib/index.js';
import { createFakeLlm, answer } from './helpers.js';

/**
 * 模拟 cordis ctx 的 get-trap：白名单内的模拟上下文方法直取；显式提供的
 * 服务返回实例；「非白名单且未提供」的服务属性抛同型
 * `cannot get property "X" without inject`——使「未注入属性零次访问」的
 * 约束在旧代码形态下真能变红。`provide(name, value)` 支持延迟提供
 * （apply 返回后激活等待中的条件子上下文，模拟宿主服务后到）。
 *
 * 认知注记（与真实 cordis 的已知偏差，均不影响当前断言）：
 * - set-trap 把「任何属性赋值」当作服务提供，是桩内便利假设——真实 cordis
 *   走 ctx.set/reflect 原语，不会把任意赋值当服务注册；
 * - get-trap 白名单未覆盖 cordis isSpecialProperty 类形态（'then'、'_'
 *   前缀、数字属性）——桩比真实 trap 更严：真实宿主对这类属性有特殊分支，
 *   当前插件代码不触达它们，故此处不模拟。
 */
const SIMULATED_CONTEXT_METHODS = new Set(['on', 'logger', 'root', 'inject', 'reflect']);

function makeCtx({ withTools = true, withEvents = true, llm, approvals, settings, commands, typert, agents } = {}) {
    const registered = [];
    const subscriptions = [];
    const activated = [];   // 已激活的条件子上下文（服务名数组）
    const unactivated = []; // 未激活的条件子上下文（缝缺失路径）
    const logs = { error: [], warn: [], info: [] };
    const logger = {
        error: (message) => logs.error.push(message),
        warn: (message) => logs.warn.push(message),
        info: (message) => logs.info.push(message),
    };

    const provided = new Map();       // 服务名 → 实例
    const pendingChildren = new Map(); // 服务名 → 等待激活的子上下文
    function runChild(child) {
        const missing = child.names.filter((name) => !provided.has(name));
        if (missing.length > 0) {
            unactivated.push(child.names); // 未激活（缝缺失路径）——后到激活时移除
            return false;
        }
        const index = unactivated.indexOf(child.names);
        if (index >= 0) {
            unactivated.splice(index, 1); // 后到提供 → 从未激活名单移除
        }
        activated.push(child.names);
        const sub = Object.fromEntries(child.names.map((name) => [name, provided.get(name)]));
        child.fn(sub);
        return true;
    }
    function provide(name, value) {
        provided.set(name, value);
        const waiting = pendingChildren.get(name);
        if (waiting) {
            for (const child of [...waiting]) {
                if (runChild(child)) {
                    for (const name of child.names) {
                        pendingChildren.get(name)?.delete(child);
                    }
                }
            }
        }
    }

    const providedEntries = []; // reflect.provide 注册记录（cordis Service 基类路径）
    const target = {
        logger: () => logger,
        root: { get: (service) => (service === 'llm' ? llm : undefined) },
        reflect: { provide: (name, service) => {
            providedEntries.push({ name, service });
            provide(name, service);
        } },
        ...(withEvents
            ? {
                on: (event, handler, options) => subscriptions.push({ event, handler, options }),
            }
            : {}),
    };
    const ctx = new Proxy(target, {
        get(t, prop) {
            if (typeof prop === 'symbol') {
                return t[prop];
            }
            if (SIMULATED_CONTEXT_METHODS.has(prop)) {
                return t[prop];
            }
            if (provided.has(prop)) {
                return provided.get(prop);
            }
            throw new Error(`cannot get property "${String(prop)}" without inject`);
        },
        has(t, prop) {
            return Reflect.has(t, prop) || provided.has(prop);
        },
        set(t, prop, value) {
            if (SIMULATED_CONTEXT_METHODS.has(prop)) {
                t[prop] = value; // 模拟上下文方法（inject/on/…）走 target，不是服务
                return true;
            }
            provide(String(prop), value);
            return true;
        },
    });
    // 声明的必选服务预置占位（真实宿主恒提供；桩内未给实例则为 undefined
    // 占位，get 不抛——保持「必选服务可安全直访」语义）。
    for (const serviceName of inject) {
        provided.set(serviceName, undefined);
    }
    if (llm !== undefined) {
        provide('llm', llm);
    }
    if (agents !== undefined) {
        provide('agents', agents);
    }
    if (approvals !== undefined) {
        provide('approvals', approvals);
    }
    if (settings !== undefined) {
        provide('settings', settings);
    }
    if (commands !== undefined) {
        provide('commands', commands);
    }
    if (typert !== undefined) {
        provide('typert', typert);
    }
    if (withTools) {
        provide('tools', { register: (tool) => registered.push(tool) });
    }
    ctx.inject = (names, fn) => {
        const child = { names, fn };
        for (const name of names) {
            if (!pendingChildren.has(name)) {
                pendingChildren.set(name, new Set());
            }
            pendingChildren.get(name).add(child);
        }
        runChild(child);
    };
    function providedService(name) {
        return [...providedEntries].reverse().find((entry) => entry.name === name)?.service;
    }
    return { ctx, registered, subscriptions, activated, unactivated, logs, provide, llm, providedService, settle };
}


/** 等待动态 import（typert-gateway）解析与子上下文异步清理完成。 */
async function settle(turns = 8) {
    for (let i = 0; i < turns; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

const entryConfig = {
    enabled: true,
    advisor: { provider: 'test', model: 'm' },
};

test('tools 条件子上下文：服务在场即注册；注册抛错向上传播（不锚定 AC）', () => {
    // 服务在场 → 子上下文激活 → 注册成功
    const ok = makeCtx({ llm: createFakeLlm([]) });
    const services = apply(ok.ctx, entryConfig);
    assert.equal(ok.registered.length, 1);
    assert.equal(ok.activated.some((names) => names.includes('tools')), true);
    void services;

    // 注册抛错 → 子上下文内 fail loud（向上传播，不静默降级）
    const broken = makeCtx({ llm: createFakeLlm([]) });
    broken.ctx.tools.register = () => {
        throw new Error('registry broken');
    };
    assert.throws(() => apply(broken.ctx, entryConfig), /registry broken/);
    assert.ok(broken.logs.error.some((message) => message.includes('注册失败')));
});

test('未注入服务的顶层属性访问零次：条件子上下文未激活不崩溃（T-005 实测回归钉住）', async () => {
    // 缝探测原语曾使 apply 在 cordis get-trap 下崩溃（cannot get property
    // "approvals" without inject）——本测试以「无任何可选服务」的组合钉住
    // 装载不崩溃 + 降级标注齐全。
    const { ctx, logs, unactivated } = makeCtx({ llm: createFakeLlm([]) });
    const services = apply(ctx, { enabled: false });
    await settle();
    assert.ok(unactivated.length >= 4); // approval×2/commands/typert/settings 均未激活
    const degradations = services.status.snapshot().degradations;
    assert.equal(degradations.askPolicy, 'approver-seam-missing');
    assert.equal(degradations.commands, 'registry-seam-missing');
    assert.equal(degradations.settingsCard, 'gateway-seam-missing');
    assert.equal(degradations.persistence, 'settings-writer-seam-missing');
    // 缺失未经确认（子上下文未激活≠确认失败）前不虚报「持久化不可用」日志
    assert.equal(logs.error.filter((message) => message.includes('持久化不可用')).length, 0);
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
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NO_ADVISOR_MODEL');
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
    assert.equal(name, 'dsh-advisor-flow');
    assert.deepEqual(inject, ['agents', 'llm']);
});

test('事件订阅缝缺失时启动期 fail loud（与工具注册缝同纪律，不锚定 AC）', () => {
    const { ctx, logs } = makeCtx({ withEvents: false, llm: createFakeLlm([]) });
    assert.throws(() => apply(ctx, entryConfig), /事件订阅缝缺失/);
    assert.match(logs.error[0], /advisor-flow/);
});

test('R-01-003/AC-01 apply 接线：pre-execute 门命中同步咨询，工具生命周期与 turn-stopping 缝全局订阅', async () => {
    const llm = createFakeLlm([answer('severity: nit\n计划评审通过。')]);
    const { ctx, subscriptions } = makeCtx({ llm });
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm' },
        gates: { plan: { enabled: true, policy: 'review' } },
    });
    const wired = Object.fromEntries(subscriptions.map((s) => [s.event, s]));
    assert.ok(wired['tools/pre-execute']);
    // 工具生命周期事件以 agent scope 为 carrier 派发（dsh-tools scopeTarget）——必须 {global:true}
    assert.equal(wired['tools/pre-execute'].options?.global, true);
    assert.equal(wired['tools/result'].options?.global, true);
    // 回合收口缝（完成门真实锚点 + 冷却倒数源）同样全局订阅
    assert.equal(wired['agent/turn-stopping'].options?.global, true);
    assert.equal(wired['session/event'].options?.global, true);
    assert.equal(wired['agent/created'].options?.global, true);
    assert.equal(wired['agent/disposed'].options?.global, true);

    // 门命中：exit_plan_mode 在 pre-execute 被同步评审后放行（真实宿主载体形状）
    const decision = await wired['tools/pre-execute'].handler(
        { token: 't1', callId: 'c1', rootCallId: 'r1', name: 'exit_plan_mode', arguments: {}, agent: { id: 's1' }, signal: undefined },
        () => ({ kind: 'allow' }),
    );
    assert.equal(decision.kind, 'allow');
    assert.equal(llm.calls.length, 1);
    // 普通工具不命中
    await wired['tools/pre-execute'].handler({ name: 'read_file', arguments: {}, agent: { id: 's1' }, callId: 'c2' }, () => ({ kind: 'allow' }));
    assert.equal(llm.calls.length, 1);
    // ask_advisor 豁免
    await wired['tools/pre-execute'].handler({ name: 'ask_advisor', arguments: {}, agent: { id: 's1' }, callId: 'c3' }, () => ({ kind: 'allow' }));
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

test('session/event 只承载 reset 类事件；冷却倒数改由 agent/turn-stopping 缝承载（载体契约 T-008，不锚定 AC）', async () => {
    const llm = createFakeLlm([answer('severity: nit\n计划评审通过。')]);
    const { ctx, subscriptions } = makeCtx({ llm });
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm' },
        gates: { plan: { enabled: true, policy: 'review' } },
    });
    const sessionEvent = subscriptions.find((s) => s.event === 'session/event');
    assert.equal(sessionEvent.options?.global, true);

    // 门命中：exit_plan_mode 在 pre-execute 被同步评审（真实宿主载体形状）
    const preExecute = subscriptions.find((s) => s.event === 'tools/pre-execute');
    await preExecute.handler({ name: 'exit_plan_mode', arguments: {}, agent: { id: 's1' }, callId: 'c1' }, () => ({ kind: 'allow' }));
    assert.ok(llm.calls.length >= 1);
    // 直接驱动送达以武装冷却（避免依赖顾问 severity）
    services.delivery.registerAgent({ id: 's1', inject() {}, steer() {} });
    services.delivery.deliver('s1', { adviceId: 'adv-x', severity: 'blocker', text: 't' });
    assert.equal(services.delivery.status().cooldowns.s1, 2);
    // session/event 的 turn/end 不再承载倒数（收口信号已迁移）
    sessionEvent.handler({ id: 's1' }, { type: 'turn/end' });
    assert.equal(services.delivery.status().cooldowns.s1, 2);
    // agent/turn-stopping 串行监听承载倒数
    const turnStopping = subscriptions.find((s) => s.event === 'agent/turn-stopping');
    await turnStopping.handler({ turn: {}, signal: undefined, agent: { id: 's1' } });
    assert.equal(services.delivery.status().cooldowns.s1, 1);
    // 压缩事件 → 冷却与观察状态重置
    sessionEvent.handler({ id: 's1' }, { type: 'session/compact' });
    assert.equal(services.delivery.status().cooldowns.s1, undefined);
    // 未知类型被忽略（不抛出、不误触发）
    sessionEvent.handler({ id: 's1' }, { type: 'whatever/new' });
    assert.equal(services.delivery.status().cooldowns.s1, undefined);
});

test('agent/turn-stopping 冷却口径：完成门送达/反对不倒数，自由收口才倒数（不锚定 AC）', async () => {
    const llm = createFakeLlm([answer('severity: nit\n可以收尾。')]);
    const { ctx, subscriptions } = makeCtx({ llm });
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm' },
        gates: { completion: { enabled: true, policy: 'review' } },
    });
    services.delivery.registerAgent({ id: 's1', inject() {}, steer() {} });
    services.delivery.deliver('s1', { adviceId: 'adv-x', severity: 'blocker', text: 't' });
    assert.equal(services.delivery.status().cooldowns.s1, 2);
    const turnStopping = subscriptions.find((s) => s.event === 'agent/turn-stopping');
    // review + nit → 'delivered'：意见注入已让宿主续步——非真实收口，不倒数
    await turnStopping.handler({ turn: 1, signal: undefined, agent: { id: 's1' } });
    assert.equal(services.delivery.status().cooldowns.s1, 2);
    // 同回合放行后去重跳过 → 自由收口 → 倒数
    await turnStopping.handler({ turn: 1, signal: undefined, agent: { id: 's1' } });
    assert.equal(services.delivery.status().cooldowns.s1, 1);
});

test('tools/result 权威成败缝：两参投递计数、callId 去重；session/event 结果型记录不再计数（T-008 裁决，不锚定 AC）', async () => {
    const { ctx, subscriptions } = makeCtx({ llm: createFakeLlm([]) });
    const services = apply(ctx, { enabled: false });
    const sessionEvent = subscriptions.find((s) => s.event === 'session/event');
    const toolsResult = subscriptions.find((s) => s.event === 'tools/result');
    assert.ok(toolsResult, '生命周期 tools/result 权威成败缝必须保留');
    assert.ok(sessionEvent, 'session/event 缝必须保留（承载 reset 类事件与 carrier）');
    // 宿主以 (exec, result) 两参投递：exec.name + exec.callId + exec.agent.id，失败真值 result.isError
    toolsResult.handler({ name: 'bash', callId: 'x1', agent: { id: 's1' } }, { isError: true });
    assert.equal(services.observer.failureStreak('s1', 'bash'), 1);
    // 同一执行标识的重复投递只计一次
    toolsResult.handler({ name: 'bash', callId: 'x1', agent: { id: 's1' } }, { isError: true });
    assert.equal(services.observer.failureStreak('s1', 'bash'), 1);
    // 新执行照常累加
    toolsResult.handler({ name: 'bash', callId: 'x2', agent: { id: 's1' } }, { isError: true });
    assert.equal(services.observer.failureStreak('s1', 'bash'), 2);
    // session/event 的 tool/result 存储记录不带工具名——不再作为计数缝
    sessionEvent.handler({ id: 's1' }, { type: 'tool/result', seq: 1, time: 0, data: { message: 'x' } });
    assert.equal(services.observer.failureStreak('s1', 'bash'), 2); // 未被事件扰动
});

test('approver 缝缺失显性化：一次性 error + 状态快照 degraded 标注（不锚定 AC）', () => {
    const { ctx, logs: captured } = makeCtx({ llm: createFakeLlm([]) });
    const services = apply(ctx, { enabled: false });
    assert.ok(captured.error.some((message) => message.includes('人工审批缝未接入')));
    assert.equal(captured.error.filter((message) => message.includes('人工审批缝未接入')).length, 1); // 仅一次性
    assert.equal(services.status.snapshot().degradations.askPolicy, 'approver-seam-missing');
});

test('approval 条件子上下文激活：审批缝接入后降级清除（恢复语义）', () => {
    const decisions = [];
    const { ctx } = makeCtx({
        llm: createFakeLlm([]),
        approvals: { request: async (request) => decisions.push(request) || true },
    });
    const services = apply(ctx, { enabled: false });
    assert.equal(services.status.snapshot().degradations.askPolicy, undefined); // 激活即清除
    assert.ok(services.commandController, '控制器就绪');
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
    const decision = await preExecute({ name: 'bash', arguments: { command: 'npm test' }, agent: { id: 's1' }, callId: 'c1' }, () => ({ kind: 'allow' }));
    assert.equal(decision.kind, 'deny');
    assert.ok(decision.reason.includes('人工拒绝'));
    assert.equal(decisions.length, 1); // ask 策略经宿主审批缝征询
    assert.equal(decisions[0].gate, 'loop');
});

test('commands/gateway 缝缺失时显性化降级而非拒绝启动（不锚定 AC）', () => {
    const { ctx } = makeCtx({ llm: createFakeLlm([]) });
    const services = apply(ctx, { enabled: false });
    assert.equal(services.status.snapshot().degradations.commands, 'registry-seam-missing');
    assert.equal(services.status.snapshot().degradations.settingsCard, 'gateway-seam-missing');
    // ask approval 缺失的降级标注同在
    assert.equal(services.status.snapshot().degradations.askPolicy, 'approver-seam-missing');
});

test('commands 条件子上下文激活：命令经注册表缝挂载并可执行（不锚定 AC）', () => {
    const registeredSpecs = [];
    const { ctx } = makeCtx({
        llm: createFakeLlm([answer('命令手动评审。')]),
        commands: { register: (spec) => registeredSpecs.push(spec) || (() => {}) },
    });
    const services = apply(ctx, entryConfig);
    assert.equal(services.status.snapshot().degradations.commands, undefined); // 激活即清除
    const manual = registeredSpecs.find((spec) => spec.name === 'advisor-manual');
    assert.ok(manual, '/advisor-manual 已挂载');
    const result = manual.handler({ rawInput: '聚焦词', agent: { session: { id: 's1' } } });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /手动咨询已发起/);
});

test('R-02-001/AC-01 gateway 缝可得时：卡片 set 经 RPC 即时生效于后续咨询', async () => {
    const gatewayEndpoints = [];
    const llm = createFakeLlm([answer('一。'), answer('二。')]);
    const { ctx, registered: tools, providedService } = makeCtx({
        llm,
        typert: { register: (name, handler) => gatewayEndpoints.push({ name, handler }) },
    });
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm1' },
    });
    await settle();
    assert.equal(services.status.snapshot().degradations.settingsCard, undefined); // 动态装配完成后清除
    const gateway = providedService('advisor-flow');
    const got = await gateway.get();
    assert.equal(got.config.advisor.model, 'm1');
    const result = await gateway.set({ advisor: { model: 'm2' } });
    assert.equal(result.ok, true);

    // 即时生效：set 后的下一次咨询用新模型（R-02-001/AC-01）
    const consulted = await services.askAdvisor.execute({});
    assert.equal(consulted.adviceId, 'adv-1');
    assert.equal(llm.calls[0].options.model, 'm2');
});

test('R-01-002/AC-02 会话销毁清理：临时覆盖与进行中手动咨询随 session/disposed 一并清除', async () => {
    const llm = createFakeLlm([{ hangUntilReleased: true, chunks: [{ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }] }]);
    const { ctx, subscriptions } = makeCtx({ llm });
    const services = apply(ctx, { enabled: true, advisor: { provider: 'test', model: 'm' } });
    const disposed = subscriptions.find((s) => s.event === 'session/disposed');
    assert.equal(disposed.options?.global, true);

    // 会话级 off + 进行中手动咨询
    services.engine.setSessionEnabled('s1', false);
    services.commandController.startManual('s1', '焦点');
    assert.equal(services.engine.sessionEnabled('s1'), false);
    assert.equal(services.commandController.manualRunning('s1'), true);

    disposed.handler({ id: 's1' });
    // 覆盖清除（不留残留）、手动咨询记录清理（中止，无用量副作用）
    assert.equal(services.engine.sessionEnabled('s1'), undefined);
    assert.equal(services.commandController.manualRunning('s1'), false);
    // 观察与送达状态同被清理
    assert.equal(services.observer.snapshot('s1').loopKeys, 0);
    assert.equal(services.delivery.status().agents.includes('s1'), false);
});

test('R-02-001/AC-03 启动配置被拒时 raw 保留真实键：卡片可读回并修复，保存不丢键', async () => {
    const gatewayEndpoints = [];
    const llm = createFakeLlm([answer('ok')]);
    const { ctx, providedService } = makeCtx({
        llm,
        typert: { register: (name, handler) => gatewayEndpoints.push({ name, handler }) },
    });
    // 启动配置含非法值 + 真实存在的合法键（若 raw 被丢弃为 {}，这些键会丢）
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'p', model: 'm', maxTokens: 'broken' },
        privacy: { history: 'off' },
        customKey: { keep: true },
    });
    assert.equal(services.status.snapshot().enabled, false); // 运行时禁用

    await settle();
    assert.equal(services.status.snapshot().degradations.settingsCard, undefined); // 动态装配完成后清除
    const gateway = providedService('advisor-flow');
    const got = await gateway.get();
    // raw 保留了真实键（非法 maxTokens 与合法 privacy/customKey 都在）
    assert.equal(got.config.advisor.maxTokens, 'broken');
    assert.equal(got.config.privacy.history, 'off');
    assert.equal(got.config.customKey.keep, true);
    assert.equal(got.error !== undefined, true);

    // 修复保存：只修 maxTokens —— 合法键与未知键都不丢
    const result = await gateway.set({ advisor: { maxTokens: 8192 } });
    assert.equal(result.ok, true);
    const after = await gateway.get();
    assert.equal(after.config.advisor.maxTokens, 8192);
    assert.equal(after.config.privacy.history, 'off');
    assert.equal(after.config.customKey.keep, true);
    assert.equal(after.config.advisor.model, 'm');
});

test('R-02-001/AC-01 持久写缝可得时：保存经 settings.update 写回 advisor-flow 命名空间', async () => {
    const writes = [];
    const llm = createFakeLlm([answer('ok')]);
    const { ctx, registered, providedService } = makeCtx({
        llm,
        settings: { update: async (namespace, raw) => writes.push({ namespace, raw }) },
        typert: { register: (name, handler) => registered.push({ name, handler }) },
    });
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'p', model: 'm1', maxTokens: 4096 },
        privacy: { history: 'off' },
    });
    await settle(); // 动态装配（typert-gateway 服务注册 + 端点声明）完成
    const gateway = services && providedService('advisor-flow');
    const result = await gateway.set({ advisor: { model: 'm2' } });
    assert.equal(result.ok, true);
    assert.equal(result.persisted, true);
    assert.match(result.notice, /已保存并持久化/);
    // merge 语义：只写 advisor-flow 命名空间键，raw 为合并后的完整命名空间
    assert.equal(writes.length, 1);
    assert.equal(writes[0].namespace, 'advisor-flow');
    assert.equal(writes[0].raw.advisor.model, 'm2');
    assert.equal(writes[0].raw.advisor.maxTokens, 4096); // 兄弟键保留
    assert.equal(writes[0].raw.privacy.history, 'off');
    // 无持久化降级标注
    assert.equal(services.status.snapshot().degradations.persistence, undefined);
});

test('R-02-001/AC-01 持久写缝缺失：degradations.persistence 标注且不虚报日志（服务缺失≠确认失败）', async () => {
    const { ctx, logs } = makeCtx({ llm: createFakeLlm([]) });
    const services = apply(ctx, { enabled: false });
    await settle();
    assert.equal(services.status.snapshot().degradations.persistence, 'settings-writer-seam-missing');
    // settings 服务整个缺失时子上下文永不激活——缺失是推断而非确认，
    // 不写「持久化不可用」一次性日志（写失败/装配失败才确认）。
    assert.equal(logs.error.filter((message) => message.includes('持久化不可用')).length, 0);
});

test('R-02-001/AC-01 持久化失败→恢复→再失败：degradations 随恢复清除，再失败再次显性（一次性日志重新武装）', async () => {
    let shouldThrow = true;
    const llm = createFakeLlm([]);
    const { ctx, registered, logs, providedService } = makeCtx({
        llm,
        typert: { register: (name, handler) => registered.push({ name, handler }) },
        settings: {
            update: async () => {
                if (shouldThrow) {
                    throw new Error('yaml write failed');
                }
            },
        },
    });
    const services = apply(ctx, { enabled: true, advisor: { provider: 'p', model: 'm' } });
    await settle();
    const gateway = providedService('advisor-flow');

    // 失败 → 标注 + 一次性 error
    const first = await gateway.set({ advisor: { model: 'm2' } });
    assert.equal(first.persisted, false);
    assert.equal(services.status.snapshot().degradations.persistence, 'persist-write-failed');
    assert.equal(logs.error.filter((message) => message.includes('持久化不可用')).length, 1);

    // 恢复（写入修好）→ 保存成功 → 标注清除
    shouldThrow = false;
    const recovered = await gateway.set({ advisor: { model: 'm3' } });
    assert.equal(recovered.persisted, true);
    assert.match(recovered.notice, /已保存并持久化/);
    assert.equal(services.status.snapshot().degradations.persistence, undefined);

    // 再失败 → 再次显性（错误日志第二次出现）
    shouldThrow = true;
    const again = await gateway.set({ advisor: { model: 'm4' } });
    assert.equal(again.persisted, false);
    assert.equal(services.status.snapshot().degradations.persistence, 'persist-write-failed');
    assert.equal(logs.error.filter((message) => message.includes('持久化不可用')).length, 2);
});

test('tools 缝缺失显性化：degradations.askAdvisorTool 标注，激活即清除（五缝显性化对齐）', () => {
    // 未激活（withTools=false → tools 服务缺失）
    const missing = makeCtx({ withTools: false, llm: createFakeLlm([]) });
    const services = apply(missing.ctx, { enabled: false });
    assert.equal(services.status.snapshot().degradations.askAdvisorTool, 'tools-seam-not-activated');
    assert.ok(missing.unactivated.some((names) => names.includes('tools')));

    // 激活 → 注册成功 → 标注清除
    const present = makeCtx({ llm: createFakeLlm([]) });
    const presentServices = apply(present.ctx, { enabled: false });
    assert.equal(presentServices.status.snapshot().degradations.askAdvisorTool, undefined);
    assert.equal(present.registered.length, 1);
});

test('服务后到（延迟 provide）仍激活子上下文并清除降级（宿主服务后到时序）', async () => {
    const decisions = [];
    const writes = [];
    const endpoints = [];
    const { ctx, provide, registered, subscriptions, logs, llm, providedService } = makeCtx({ llm: createFakeLlm([answer('意见。')]) });
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm' },
        gates: { loop: { enabled: true, policy: 'ask', threshold: 1 } },
    });
    // apply 时四缝均缺失 → 降级齐全
    let degradations = services.status.snapshot().degradations;
    assert.equal(degradations.askPolicy, 'approver-seam-missing');
    assert.equal(degradations.commands, 'registry-seam-missing');
    assert.equal(degradations.settingsCard, 'gateway-seam-missing');
    assert.equal(degradations.persistence, 'settings-writer-seam-missing');

    // 服务后到：逐一延迟提供 → 子上下文激活、降级清除
    provide('approvals', { request: async (request) => {
        decisions.push(request);
        return false; // 人工拒绝
    } });
    provide('commands', { register: (spec) => registered.push(spec) || (() => {}) });
    provide('settings', { update: async (namespace, raw) => writes.push({ namespace, raw }) });
    provide('typert', { register: (name, handler) => endpoints.push({ name, handler }) });
    await settle(); // 动态装配完成（服务注册 + 端点声明）
    degradations = services.status.snapshot().degradations;
    assert.equal(degradations.askPolicy, undefined);
    assert.equal(degradations.commands, undefined);
    assert.equal(degradations.settingsCard, undefined);
    assert.equal(degradations.persistence, undefined);
    const gateway = providedService('advisor-flow');

    // 激活后的缝真实可用：ask 门经审批拒绝 → deny；gateway set 可用
    const preExecute = subscriptions.find((s) => s.event === 'tools/pre-execute').handler;
    const decision = await preExecute({ name: 'bash', arguments: { command: 'npm test' }, agent: { id: 's1' }, callId: 'c1' }, () => ({ kind: 'allow' }));
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /人工拒绝/);
    assert.equal(decisions.length, 1); // ask 策略经审批缝征询
    const saved = await gateway.set({ advisor: { model: 'm2' } });
    assert.equal(saved.ok, true);
    assert.equal(saved.persisted, true); // settings 写缝激活后保存即持久化
});

test('R-02-001/AC-01 settings section 注册：installSection 以 advisor-flow 命名空间调用，describe 可服务', async () => {
    const installed = [];
    const { ctx, registered } = makeCtx({
        llm: createFakeLlm([answer('ok')]),
        settings: {
            update: async () => {},
            installSection: (sectionCtx, namespace, schema, entry, hooks) => {
                installed.push({ namespace, schema, entry, hooks });
            },
        },
        typert: { register: (name, handler) => registered.push({ name, handler }) },
    });
    apply(ctx, entryConfig);
    await settle();
    assert.equal(installed.length, 1);
    assert.equal(installed[0].namespace, 'advisor-flow'); // describe 服务本命名空间 → 卡片交集成立
    assert.ok(installed[0].schema, 'schema 随注册声明');
    assert.equal(installed[0].entry.enabled, true); // entry = 配置基线
    assert.equal(typeof installed[0].hooks.onChange, 'function');
    assert.equal(typeof installed[0].hooks.setSource, 'function');
});

test('R-02-001/AC-01 onChange → applyConfig：settings 段变更即时生效于后续咨询', async () => {
    const llm = createFakeLlm([answer('一。'), answer('二。')]);
    let hooks;
    const { ctx } = makeCtx({
        llm,
        settings: {
            update: async () => {},
            installSection: (sectionCtx, namespace, schema, entry, sectionHooks) => {
                hooks = sectionHooks;
            },
        },
    });
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm1' },
    });
    await settle();
    const before = await services.askAdvisor.execute({});
    assert.equal(llm.calls[0].options.model, 'm1');

    // settings 文件段变更：source-thunk 更新（宿主契约传 thunk）+ onChange 触发 → live re-apply
    hooks.setSource(() => ({ enabled: true, advisor: { provider: 'test', model: 'm2' } }));
    hooks.onChange();
    const after = await services.askAdvisor.execute({});
    assert.equal(after.adviceId, 'adv-2');
    assert.equal(llm.calls[1].options.model, 'm2');
});

test('R-02-001/AC-01 onChange 携非法用户层：disabled-with-reason 兜底且 raw 保留真实键（不楔住热路径）', async () => {
    const llm = createFakeLlm([answer('ok')]);
    let hooks;
    const { ctx, providedService } = makeCtx({
        llm,
        settings: {
            update: async () => {},
            installSection: (sectionCtx, namespace, schema, entry, sectionHooks) => {
                hooks = sectionHooks;
            },
        },
        typert: { register: () => {} },
    });
    const services = apply(ctx, entryConfig);
    await settle();
    hooks.setSource(() => ({ enabled: true, advisor: { provider: 'p', model: 'm', maxTokens: 'broken' }, customKey: { keep: true } }));
    hooks.onChange();
    const snapshot = services.status.snapshot();
    assert.equal(snapshot.enabled, false); // 非法层 → disabled-with-reason 兜底
    assert.match(snapshot.reason, /配置无效/);
    assert.equal(snapshot.degradations.persistence, undefined);
    // 卡片可修复：gateway get 读回保留真实键
    const gateway = providedService('advisor-flow');
    const got = await gateway.get();
    assert.equal(got.config.customKey.keep, true);
    assert.equal(got.config.advisor.maxTokens, 'broken');
});

test('R-02-003/AC-02 重复注册守卫：already registered 降级为 entry-source 兜底，状态可查询不崩装载', async () => {
    const { ctx } = makeCtx({
        llm: createFakeLlm([]),
        settings: {
            update: async () => {},
            installSection: () => {
                throw new Error('settings namespace "advisor-flow" is already registered');
            },
        },
    });
    const services = apply(ctx, { enabled: false });
    await settle();
    // 命名空间已在（describe 照常服务）→ 能力视为在，降级清除
    assert.equal(services.status.snapshot().degradations.settingsSection, undefined);
    assert.equal(services.status.snapshot().enabled, false); // 状态照常可查询
});

test('settings 服务缺 installSection 能力：section 缺失显性化（联调验证项，不锚定 AC）', async () => {
    const { ctx, logs } = makeCtx({ llm: createFakeLlm([]), settings: { update: async () => {} } });
    const services = apply(ctx, { enabled: false });
    await settle();
    assert.equal(services.status.snapshot().degradations.settingsSection, 'install-section-missing');
    assert.ok(logs.error.some((message) => message.includes('settings section 未注册')));
});

test('R-01-005/AC-01 工具生命周期监听注册形态：tools/* 必须携带 {global:true}（全局可达性回归钉住）', () => {
    // 断言强度边界：makeCtx 桩不模拟 cordis carrier scope 派发语义——本测试
    // 只钉「注册形态必须带 {global:true}」（防全局性回归的机械可测征兆），
    // 真实全局可达性由 staging/生产实测双轨承载（T-005 冒烟）。
    const { ctx, subscriptions } = makeCtx({ llm: createFakeLlm([]) });
    apply(ctx, { enabled: false });
    // 工具事件以 agent scope 为 carrier 派发（dsh-tools scopeTarget 实证），
    // 裸监听收不到子代理/会话 scope 的调用——T-005 实测第六发现（门在真实
    // 会话零触发）的根因即缺 {global:true}；dsh-tools 自带 invariant 监听
    // tools/* 事件亦用 {global:true}。此断言拦截该全局性回归。
    for (const toolEvent of ['tools/pre-execute', 'tools/result', 'agent/turn-stopping']) {
        const registration = subscriptions.find((entry) => entry.event === toolEvent);
        assert.ok(registration, `${toolEvent} 监听已注册`);
        assert.equal(registration.options?.global, true, `${toolEvent} 必须 {global:true}`);
    }
});

test('R-02-001/AC-01 启动种子时序无关：attach 时 source 为空、之后就绪——读时求值使 engine/get 读到就绪值', async () => {
    const llm = createFakeLlm([answer('种子配置意见。')]);
    const writes = [];
    const persistedRaw = {
        enabled: true,
        advisor: { provider: 'persisted-p', model: 'persisted-m', maxTokens: 8192 },
        privacy: { history: 'delta' },
    };
    // sourceHolder：attach 时为空（文档未加载完成），之后就绪（宿主异步加载）
    const sourceHolder = { value: {} };
    const { ctx, registered, providedService } = makeCtx({
        llm,
        settings: {
            update: async (namespace, raw) => writes.push({ namespace, raw }),
            installSection: (sectionCtx, namespace, schema, entry, hooks) => {
                hooks.setSource(() => structuredClone(sourceHolder.value));
                // 宿主 onChange 在 attach 时机不触发（实测第八发现的前提）
            },
        },
        typert: { register: (name, handler) => registered.push({ name, handler }) },
    });
    const services = apply(ctx, entryConfig);
    await settle();

    // attach 种子读到空值 → 空值跳过（raw 不被清空、引擎保持 entry 态）
    assert.equal(services.status.snapshot().degradations.persistence, undefined); // 写缝已接入
    assert.equal(services.status.snapshot().enabled, true); // entry 态（种子空值跳过，配置未被清空）

    // source 就绪后（无 onChange、无 set）——读时求值：gateway get 读到持久化值
    sourceHolder.value = structuredClone(persistedRaw);
    const gateway = providedService('advisor-flow');
    const got = await gateway.get();
    assert.equal(got.config.enabled, true);
    assert.equal(got.config.advisor.provider, 'persisted-p');
    assert.equal(got.config.advisor.model, 'persisted-m');
    assert.equal(got.config.privacy.history, 'delta');

    // 咨询入口同样读时求值：真实使用持久化配置（无任何 set 触发）
    const consulted = await services.askAdvisor.execute({});
    assert.equal(consulted.adviceId, 'adv-1');
    assert.equal(llm.calls[0].options.model, 'persisted-m');
    assert.equal(writes.length, 0); // 未发生任何持久写
});

test('R-02-001/AC-01 attach 时 source 就绪：启动种子立即可用（尽力早刷路径保留）', async () => {
    const llm = createFakeLlm([answer('种子配置意见。')]);
    const persistedRaw = {
        enabled: true,
        advisor: { provider: 'persisted-p', model: 'persisted-m', maxTokens: 8192 },
    };
    const { ctx } = makeCtx({
        llm,
        settings: {
            update: async () => {},
            installSection: (sectionCtx, namespace, schema, entry, hooks) => {
                hooks.setSource(() => structuredClone(persistedRaw));
            },
        },
    });
    const services = apply(ctx, entryConfig);
    await settle();
    const snapshot = services.status.snapshot();
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.advisor.provider, 'persisted-p');
    assert.equal(snapshot.advisor.model, 'persisted-m');
    assert.equal(snapshot.degradations.persistence, undefined);
});

test('R-01-002/AC-01 手动命令入口读时求值：consult 前应用最新文件配置（与工具/门路径一致）', async () => {
    const llm = createFakeLlm([answer('手动意见。')]);
    const sourceHolder = { value: {} }; // attach 时为空
    const { ctx, provide, logs } = makeCtx({
        llm,
        settings: {
            update: async () => {},
            installSection: (sectionCtx, namespace, schema, entry, hooks) => {
                hooks.setSource(() => structuredClone(sourceHolder.value));
            },
        },
    });
    const services = apply(ctx, entryConfig);
    await settle();
    // source 就绪（无 onChange、无 set）→ 手动命令 consult 使用持久化模型
    sourceHolder.value = {
        enabled: true,
        advisor: { provider: 'persisted-p', model: 'persisted-m' },
    };
    const manual = services.commandController.startManual('s1', '种子');
    const result = await manual.promise;
    assert.equal(result.ok, true);
    assert.equal(llm.calls[0].options.model, 'persisted-m'); // 读时求值生效
    void provide;
    void logs;
});

test('R-01-002/AC-01 wiring 级端到端：startManual → agent.inject 收到 [advisor: 前缀意见', async () => {
    // 钉住「index.js 传入的是函数而非路由对象」的真实缺陷形态（注入桩掩盖
    // 接线形态）——commands.js startManual 以回调 delivery(sessionId, advice)
    // 送达，index.js 必须传函数（曾误传 delivery 对象致意见静默失败）。
    const llm = createFakeLlm([answer('手动评审意见正文。')]);
    const injected = [];
    const steerCalls = [];
    const agents = {
        get: (sessionId) => (sessionId === 's1'
            ? { id: 's1', inject: (message) => injected.push({ channel: 'inject', message }), steer: (message) => steerCalls.push({ channel: 'steer', message }) }
            : undefined),
    };
    const { ctx } = makeCtx({ llm, agents });
    const services = apply(ctx, entryConfig);

    const manual = services.commandController.startManual('s1', '种子焦点');
    assert.equal(services.commandController.manualRunning('s1'), true); // startManual 同步置进行态
    const result = await manual.promise;
    assert.equal(result.ok, true);
    assert.equal(services.commandController.manualRunning('s1'), false); // 完成后清除
    assert.equal(llm.calls[0].options.messages[0].content.includes('种子焦点'), true);
    // agent.inject（或 steer）收到含 [advisor: 前缀的意见消息——wiring 级钉住
    // index.js 传入 commands 的是 delivery 回调（曾误传对象致送达静默失败）。
    // 送达消息契约（T-008 实测）：content 是 ContentBlock 数组且带稳定 id。
    assert.equal(injected.length + steerCalls.length, 1);
    const delivered = injected[0] ?? steerCalls[0];
    assert.ok(Array.isArray(delivered.message.content));
    assert.ok(delivered.message.content[0].text.includes('[advisor:'));
    assert.ok(delivered.message.content[0].text.includes('手动评审意见正文'));
    assert.equal(delivered.message.content[0].text.includes('adviceId: adv-1'), true);
    assert.equal(typeof delivered.message.id, 'string');
    assert.equal(services.commandController.manualRunning('s1'), false);
});
