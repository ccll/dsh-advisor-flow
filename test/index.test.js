import test from 'node:test';
import assert from 'node:assert/strict';
import pluginModule, { apply, name, inject, Config } from '../lib/index.js';
import { ADVICE_SOURCE_KIND } from '../lib/delivery.js';
import { createFakeLlm, answer, failure, createFakeSubagents, reviewerSubsessionLease } from './helpers.js';

const endpoints = [];

/** 模拟 cordis ctx 的 get-trap（T-005 实测回归钉住的桩形态）。 */
const SIMULATED_CONTEXT_METHODS = new Set(['on', 'logger', 'root', 'inject', 'reflect']);

function makeCtx({ withTools = true, withEvents = true, llm, settings, commands, typert, agents, systemPrompt } = {}) {
    const registered = [];
    const subscriptions = [];
    const activated = [];
    const unactivated = [];
    const logs = { error: [], warn: [], info: [] };
    const logger = {
        error: (message) => logs.error.push(message),
        warn: (message) => logs.warn.push(message),
        info: (message) => logs.info.push(message),
    };
    const provided = new Map();
    const pendingChildren = new Map();
    function runChild(child) {
        const missing = child.names.filter((name) => !provided.has(name));
        if (missing.length > 0) {
            unactivated.push(child.names);
            return false;
        }
        const index = unactivated.indexOf(child.names);
        if (index >= 0) {
            unactivated.splice(index, 1);
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
    const providedEntries = [];
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
                t[prop] = value;
                return true;
            }
            provide(String(prop), value);
            return true;
        },
    });
    for (const serviceName of inject) {
        provided.set(serviceName, undefined);
    }
    if (llm !== undefined) {
        provide('llm', llm);
    }
    if (agents !== undefined) {
        provide('agents', agents);
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
    if (systemPrompt !== undefined) {
        provide('systemPrompt', systemPrompt);
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
    return { ctx, registered, subscriptions, activated, unactivated, logs, provide, llm, providedService };
}

async function settle(turns = 8) {
    for (let i = 0; i < turns; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

const entryConfig = {
    enabled: true,
    advisor: { provider: 'test', model: 'm' },
    mode: 'soft', // T-026：按需咨询工具面属软模式能力（hard 模式守卫全拒）
};

test('tools 条件子上下文：服务在场即注册；注册抛错向上传播（不锚定 AC）', () => {
    const ok = makeCtx({ llm: createFakeLlm([]) });
    const services = apply(ok.ctx, entryConfig);
    assert.equal(ok.registered.length, 1);
    assert.equal(ok.activated.some((names) => names.includes('tools')), true);
    void services;

    const broken = makeCtx({ llm: createFakeLlm([]) });
    broken.ctx.tools.register = () => {
        throw new Error('registry broken');
    };
    assert.throws(() => apply(broken.ctx, entryConfig), /registry broken/);
    assert.ok(broken.logs.error.some((message) => message.includes('注册失败')));
});

test('未注入服务的顶层属性访问零次：条件子上下文未激活不崩溃（T-005 实测回归钉住）', async () => {
    const { ctx, logs, unactivated } = makeCtx({ llm: createFakeLlm([]) });
    const services = apply(ctx, { enabled: false });
    await settle();
    assert.ok(unactivated.length >= 4); // commands/typert/settings/systemPrompt 均未激活
    const degradations = services.status.snapshot().degradations;
    assert.equal(degradations.guidelines, 'systemprompt-seam-not-activated');
    assert.equal(degradations.commands, 'registry-seam-missing');
    assert.equal(degradations.settingsCard, 'gateway-seam-missing');
    assert.equal(degradations.persistence, 'settings-writer-seam-missing');
    assert.equal(logs.error.filter((message) => message.includes('持久化不可用')).length, 0);
});

test('R-02-001/AC-01 apply 用入口配置创建运行时，返回的服务面可咨询可配置', async () => {
    const llm = createFakeLlm([answer('入口配置意见。'), answer('换配置后的意见。')]);
    const { ctx, registered } = makeCtx({ llm });
    const services = apply(ctx, entryConfig);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, 'ask_advisor');
    assert.equal(services.config().enabled, true);

    const result = await services.askAdvisor.execute({ question: 'q' });
    assert.match(result.adviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/); // R-01-001/AC-05：UUID 形态

    services.applyConfig({
        ...services.config(),
        advisor: { ...services.config().advisor, model: 'm2' },
    });
    const second = await services.askAdvisor.execute({});
    assert.notEqual(second.adviceId, result.adviceId);
    assert.equal(llm.calls[1].options.model, 'm2');

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

test('R-01-003/004/006 守则注入 wiring：systemPrompt 子上下文激活即注册 section，文本随活配置实时求值', async () => {
    const llm = createFakeLlm([answer('ok')]);
    const sectionSpecs = [];
    const { ctx } = makeCtx({
        llm,
        systemPrompt: {
            getSectionOrder: (kind) => (kind === 'PLAN_POLICY' ? 420 : 900),
            section: (spec) => {
                sectionSpecs.push(spec);
                return () => sectionSpecs.pop();
            },
        },
    });
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm' },
        gates: { plan: { enabled: true }, failure: { enabled: true }, completion: { enabled: true } },
        mode: 'soft', // T-026：守则注入属软模式（hard 模式守则族停用）
    });
    assert.equal(services.status.snapshot().degradations.guidelines, undefined); // 激活即清除
    const spec = sectionSpecs[0];
    assert.equal(spec.name, 'advisor-flow:guidelines');
    assert.equal(typeof spec.text, 'function'); // text 为函数形态（实时求值）
    const renderedOn = spec.text({ agent: { id: 's1' } });
    assert.ok(renderedOn.includes('proposed work'));
    assert.ok(renderedOn.includes('no measurable progress'));
    assert.ok(renderedOn.includes('changed work'));
    assert.ok(renderedOn.includes('empty object'));
    assert.ok(renderedOn.startsWith('Advisor invocation settings:\n')); // pi 块头部
});

test('R-01-003/004/006 守则文本随活配置求值：守则全关时整段不注入（配置变更即时生效）', async () => {
    const llm = createFakeLlm([answer('ok')]);
    const sectionSpecs = [];
    const { ctx } = makeCtx({
        llm,
        systemPrompt: {
            section: (spec) => {
                sectionSpecs.push(spec);
                return () => sectionSpecs.pop();
            },
        },
    });
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm' },
        gates: { plan: { enabled: false }, failure: { enabled: false }, completion: { enabled: false } },
        mode: 'soft', // 隔离守则停用变量：本用例只验证全关路径（hard 停用另有 AC-13 用例）
    });
    const spec = sectionSpecs[0];
    assert.equal(spec.text({ agent: {} }), ''); // 全关 → 空串（守则整段不注入）
    // 未启用（enabled:false）→ 同样空串
    services.applyConfig({
        enabled: false,
        advisor: { provider: 'test', model: 'm' },
        gates: { plan: { enabled: true } },
    });
    assert.equal(spec.text({ agent: {} }), '');
    // agentless 组装不出守则
    services.applyConfig({
        enabled: true,
        advisor: { provider: 'test', model: 'm' },
        gates: { plan: { enabled: true } },
    });
    assert.equal(spec.text(undefined), '');
});

test('事件订阅形态回归：工具生命周期缝全局订阅；软模式缺省不订阅收口评审（不锚定 AC）', async () => {
    const { ctx, subscriptions } = makeCtx({ llm: createFakeLlm([]) });
    apply(ctx, entryConfig);
    for (const toolEvent of ['tools/pre-execute', 'tools/result', 'session/event', 'agent/created', 'agent/disposed', 'session/disposed']) {
        const registration = subscriptions.find((entry) => entry.event === toolEvent);
        assert.ok(registration, `${toolEvent} 监听已注册`);
        assert.equal(registration.options?.global, true, `${toolEvent} 必须 {global:true}`);
    }
    // 缺省配置（entryConfig 无 mode 键）= 软模式：接线无条件注册监听，评审由处置器按活配置短路（C-021）
    assert.ok(subscriptions.find((entry) => entry.event === 'agent/turn-stopping'), '收口评审监听已注册（处置器按活配置短路）');
});

test('R-01-009/AC-05 硬模式订阅 agent/turn-stopping 收口评审缝', async () => {
    const llm = createFakeLlm([answer('Decision: proceed\n\n本轮行为可收口。')]);
    const { ctx, subscriptions } = makeCtx({ llm });
    apply(ctx, { enabled: true, advisor: { provider: 'test', model: 'm' }, mode: 'hard' });
    const registration = subscriptions.find((entry) => entry.event === 'agent/turn-stopping');
    assert.ok(registration, '硬模式订阅收口评审缝');
    assert.equal(registration.options?.global, true, '必须 {global:true}');
});

test('R-01-005/AC-02 wiring 处置矩阵：决策 proceed → steer 送达 + 计数重置 + 放行', async () => {
    const llm = createFakeLlm([
        answer('Decision: proceed\n\n重复动作已评审，本次放行。'),
        answer('Decision: proceed\n\n评审通过。'),
    ]);
    const steered = [];
    const agents = {
        get: (sessionId) => (sessionId === 's1' ? { id: 's1', steer: (message) => steered.push(message) } : undefined),
    };
    const { ctx, subscriptions } = makeCtx({ llm, agents });
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm' },
        gates: { loop: { enabled: true, threshold: 3 } },
        failureMode: 'warn-and-continue',
    });
    const preExecute = subscriptions.find((s) => s.event === 'tools/pre-execute').handler;
    const exec = { token: 't1', callId: 'c1', rootCallId: 'r1', name: 'bash', arguments: { command: 'npm test' }, agent: { id: 's1' }, signal: undefined };
    await preExecute(exec, () => ({ kind: 'allow' }));
    await preExecute(exec, () => ({ kind: 'allow' }));
    assert.equal(steered.length, 0); // 前两次不拦
    const decision = await preExecute(exec, () => ({ kind: 'allow' }));
    assert.equal(decision.kind, 'allow');
    assert.equal(llm.calls.length, 1); // 第 3 次等价调用先评审
    // pi sendAutomaticGateCall 预告 + sendAutomaticGateResult 结果（**Decision: proceed** + 全文）
    assert.equal(steered.length, 2);
    assert.ok(steered[0].content[0].text.startsWith('Automatic Advisor loop review\nLoop gate: bash repeated 3 times'));
    assert.equal(steered[1].content[0].text, '**Decision: proceed**\n\nDecision: proceed\n\n重复动作已评审，本次放行。');
    assert.equal(steered[0].source.kind, ADVICE_SOURCE_KIND); // dsh 0.2.0 v4 直接来源（T-027）
    // proceed → 等价计数重置：同一 exec 再两次不拦，第 3 次才再次评审
    await preExecute(exec, () => ({ kind: 'allow' }));
    await preExecute(exec, () => ({ kind: 'allow' }));
    assert.equal(llm.calls.length, 1);
    await preExecute(exec, () => ({ kind: 'allow' }));
    assert.equal(llm.calls.length, 2); // 重置后重新计数至阈值
});

test('R-01-005/AC-02 wiring 处置矩阵：决策 revise → steer 送达 + deny（原因含意见全文）', async () => {
    const llm = createFakeLlm([answer('Decision: revise\n\n该命令会删除生产数据，先改用回收站流程。')]);
    const steered = [];
    const agents = {
        get: (sessionId) => (sessionId === 's1' ? { id: 's1', steer: (message) => steered.push(message) } : undefined),
    };
    const { ctx, subscriptions } = makeCtx({ llm, agents });
    apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm' },
        gates: { loop: { enabled: true, threshold: 2 } },
        failureMode: 'warn-and-continue',
    });
    const preExecute = subscriptions.find((s) => s.event === 'tools/pre-execute').handler;
    const exec = { token: 't1', callId: 'c1', rootCallId: 'r1', name: 'bash', arguments: { command: 'rm -rf /' }, agent: { id: 's1' }, signal: undefined };
    // 阈值下界为 2（R-02-001/AC-05）：首次调用低于阈值放行，第二次命中门评审
    const below = await preExecute(exec, () => ({ kind: 'allow' }));
    assert.equal(below.kind, 'allow');
    assert.equal(steered.length, 0);
    const decision = await preExecute(exec, () => ({ kind: 'allow' }));
    assert.equal(decision.kind, 'deny');
    assert.ok(decision.reason.startsWith('Advisor loop review: ')); // pi gateReason
    assert.ok(decision.reason.includes('先改用回收站流程'));
    assert.equal(steered.length, 2); // 预告 + 决策结果
    assert.ok(steered[1].content[0].text.startsWith('**Decision: revise**'));
});


test('R-01-005/AC-03 wiring 处置矩阵：决策 blocked × failureMode 三分支', async () => {
    const makeCase = async (failureMode) => {
        const llm = createFakeLlm([answer('Decision: blocked\n\n会话已进入危险状态，停止会话。')]);
        const steered = [];
        const cancelCalls = [];
        const agents = {
            get: (sessionId) => (sessionId === 's1' ? { id: 's1', steer: (message) => steered.push(message) } : undefined),
            cancel: (context) => cancelCalls.push(context),
        };
        const { ctx, subscriptions } = makeCtx({ llm, agents });
        apply(ctx, {
            enabled: true,
            advisor: { provider: 'test', model: 'm' },
            gates: { loop: { enabled: true, threshold: 2 } },
            failureMode,
        });
        const preExecute = subscriptions.find((s) => s.event === 'tools/pre-execute').handler;
        const exec = { token: 't1', callId: 'c1', rootCallId: 'r1', name: 'bash', arguments: { command: 'npm test' }, agent: { id: 's1' }, signal: undefined };
        return { preExecute, exec, steered, cancelCalls, llm };
    };

    // warn-and-continue：通知后放行（送达但不拦截、不封锁）；首次调用低于阈值放行
    const warn = await makeCase('warn-and-continue');
    const warnBelow = await warn.preExecute(warn.exec, () => ({ kind: 'allow' }));
    assert.equal(warnBelow.kind, 'allow');
    assert.equal(warn.steered.length, 0);
    const warnDecision = await warn.preExecute(warn.exec, () => ({ kind: 'allow' }));
    assert.equal(warnDecision.kind, 'allow');
    assert.equal(warn.steered.length, 2); // 预告 + blocked 决策结果

    // block-tool：仅拦截该次调用
    const tool = await makeCase('block-tool');
    await tool.preExecute(tool.exec, () => ({ kind: 'allow' }));
    const toolDecision = await tool.preExecute(tool.exec, () => ({ kind: 'allow' }));
    assert.equal(toolDecision.kind, 'deny');
    assert.ok(toolDecision.reason.startsWith('Advisor loop review: '));
    assert.ok(toolDecision.reason.includes('危险状态'));
    assert.equal(tool.cancelCalls.length, 0); // 仅拦截该次调用，不停止会话

    // block-session：会话封锁（agents.cancel 尽力停止）+ 后续调用全 deny
    const session = await makeCase('block-session');
    await session.preExecute(session.exec, () => ({ kind: 'allow' }));
    const sessionDecision = await session.preExecute(session.exec, () => ({ kind: 'allow' }));
    assert.equal(sessionDecision.kind, 'deny');
    assert.equal(session.cancelCalls.length, 1); // 尽力停止当前执行
    // 封锁生效：后续一切工具调用一律拦截（拒绝原因 = 封锁原因），不再咨询
    const after = await session.preExecute(session.exec, () => ({ kind: 'allow' }));
    assert.equal(after.kind, 'deny');
    assert.equal(session.llm.calls.length, 1); // 封锁态不再发起咨询
});

test('R-01-005/AC-04 wiring：咨询失败按阻断模式处置（provider 失败 → block-tool deny 留痕）', async () => {
    const llm = createFakeLlm([failure(new Error('no provider adapter for route'), {})]);
    const agents = {
        get: (sessionId) => (sessionId === 's1' ? { id: 's1', steer() {} } : undefined),
    };
    const { ctx, subscriptions } = makeCtx({ llm, agents });
    apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm' },
        gates: { loop: { enabled: true, threshold: 2 } },
        failureMode: 'block-tool',
    });
    const preExecute = subscriptions.find((s) => s.event === 'tools/pre-execute').handler;
    const exec = { token: 't1', callId: 'c1', rootCallId: 'r1', name: 'bash', arguments: { command: 'npm test' }, agent: { id: 's1' }, signal: undefined };
    await preExecute(exec, () => ({ kind: 'allow' })); // 低于阈值放行
    const decision = await preExecute(exec, () => ({ kind: 'allow' }));
    assert.equal(decision.kind, 'deny');
    assert.ok(decision.reason.includes('provider-error')); // 咨询失败按阻断模式处置并留痕
});

test('R-02-003/AC-02 状态快照读活配置：applyConfig 后门配置即时可见', async () => {
    const { ctx } = makeCtx({ llm: createFakeLlm([]) });
    const services = apply(ctx, { enabled: false });
    assert.equal(services.status.snapshot().enabled, false);
    services.applyConfig({
        enabled: true,
        advisor: { provider: 'test', model: 'm2' },
        gates: { loop: { enabled: true, threshold: 7 } },
        failureMode: 'block-session',
    });
    const snapshot = services.status.snapshot();
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.advisor.model, 'm2');
    assert.equal(snapshot.gates.loop.threshold, 7);
    assert.equal(snapshot.failureMode, 'block-session');
});

test('tools/result 权威成败缝：两参投递计数、callId 去重；session/event 结果型记录不再计数（不锚定 AC）', async () => {
    const { ctx, subscriptions } = makeCtx({ llm: createFakeLlm([]) });
    const services = apply(ctx, { enabled: false });
    const sessionEvent = subscriptions.find((s) => s.event === 'session/event');
    const toolsResult = subscriptions.find((s) => s.event === 'tools/result');
    assert.ok(toolsResult, '生命周期 tools/result 权威成败缝必须保留');
    assert.ok(sessionEvent, 'session/event 缝必须保留（承载 reset 类事件与 carrier）');
    toolsResult.handler({ name: 'bash', callId: 'x1', agent: { id: 's1' } }, { isError: true });
    assert.equal(services.observer.failureStreak('s1', 'bash'), 1);
    toolsResult.handler({ name: 'bash', callId: 'x1', agent: { id: 's1' } }, { isError: true });
    assert.equal(services.observer.failureStreak('s1', 'bash'), 1); // 同一执行标识去重
    sessionEvent.handler({ id: 's1' }, { type: 'tool/result', seq: 1, time: 0, data: { message: 'x' } });
    assert.equal(services.observer.failureStreak('s1', 'bash'), 1); // 事件缝不计数
});

test('R-01-009/AC-04 wiring 级：压缩/重写事件后软模式送达守则提醒；整体停用不发', async () => {
    const llm = createFakeLlm([]);
    const steered = [];
    const agents = {
        get: (sessionId) => (sessionId === 's1' ? { id: 's1', steer: (message) => steered.push(message) } : undefined),
    };
    const { ctx, subscriptions } = makeCtx({ llm, agents });
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm' },
        mode: 'soft',
    });
    const sessionEvent = subscriptions.find((s) => s.event === 'session/event');
    assert.ok(sessionEvent, 'session/event 缝在场');
    sessionEvent.handler({ id: 's1' }, { type: 'session/compact', seq: 1, time: 0, data: {} });
    assert.equal(steered.length, 1); // 软模式压缩后送达一条守则提醒
    assert.match(steered[0].content[0].text, /compacted/);
    // 硬模式下压缩不提醒（每回合收口已强制评审）
    steered.length = 0;
    services.applyConfig({
        enabled: true,
        advisor: { provider: 'test', model: 'm' },
        mode: 'hard',
    });
    sessionEvent.handler({ id: 's1' }, { type: 'session/compact', seq: 2, time: 0, data: {} });
    assert.equal(steered.length, 0); // 硬模式不发提醒
    // 整体停用后不发提醒
    services.applyConfig({ enabled: false });
    sessionEvent.handler({ id: 's1' }, { type: 'session/compact', seq: 3, time: 0, data: {} });
    assert.equal(steered.length, 0);
});

test('R-01-002/AC-01 wiring 级端到端：startManual → agent.steer 收到意见（附 adviceId 回查行）', async () => {
    // 钉住「index.js 传入的是函数而非路由对象」的接线形态（commands.js
    // startManual 以回调 delivery(sessionId, advice) 送达；手动意见经
    // delivery.steerAdvice 送达，文本附 adviceId 回查行，无 severity 前缀）。
    const llm = createFakeLlm([answer('手动评审意见正文。')]);
    const steered = [];
    const agents = {
        get: (sessionId) => (sessionId === 's1' ? { id: 's1', steer: (message) => steered.push(message) } : undefined),
    };
    const { ctx } = makeCtx({ llm, agents });
    const services = apply(ctx, entryConfig);

    const manual = services.commandController.startManual('s1', '种子焦点');
    assert.equal(services.commandController.manualRunning('s1'), true); // startManual 同步置进行态
    const result = await manual.promise;
    assert.equal(result.ok, true);
    assert.equal(services.commandController.manualRunning('s1'), false); // 完成后清除
    assert.equal(llm.calls[0].options.messages[0].content[0].text.includes('种子焦点'), true);
    // 意见经 steerAdvice 送达（ContentBlock 数组 + 稳定 id + adviceId 回查行）
    assert.equal(steered.length, 1);
    assert.ok(Array.isArray(steered[0].content));
    assert.ok(steered[0].content[0].text.includes('手动评审意见正文'));
    assert.ok(/（adviceId: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}）/.test(steered[0].content[0].text)); // 回查行随 UUID
    assert.equal(typeof steered[0].id, 'string');
    assert.equal(services.commandController.manualRunning('s1'), false);
});

test('R-02-001/AC-01 gateway 缝可得时：卡片 set 经 RPC 即时生效于后续咨询', async () => {
    const llm = createFakeLlm([answer('一。'), answer('二。')]);
    const { ctx, providedService } = makeCtx({
        llm,
        typert: { register: (name, handler) => registered.push({ name, handler }) },
    });
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm1' },
        mode: 'soft',
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
    assert.match(consulted.adviceId, /^[0-9a-f-]{36}$/);
});

test('R-01-002/AC-02 会话销毁清理：临时覆盖与进行中手动咨询随 session/disposed 一并清除', async () => {
    const llm = createFakeLlm([{ hangUntilReleased: true, chunks: [{ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }] }]);
    const { ctx, subscriptions } = makeCtx({ llm });
    const services = apply(ctx, { enabled: true, advisor: { provider: 'test', model: 'm' } });
    const disposed = subscriptions.find((s) => s.event === 'session/disposed');
    assert.equal(disposed.options?.global, true);

    services.engine.setSessionEnabled('s1', false);
    services.commandController.startManual('s1', '焦点');
    assert.equal(services.engine.sessionEnabled('s1'), false);
    assert.equal(services.commandController.manualRunning('s1'), true);

    subscriptions.find((s) => s.event === 'session/disposed').handler({ id: 's1' });
    assert.equal(services.engine.sessionEnabled('s1'), undefined); // 覆盖清除
    assert.equal(services.commandController.manualRunning('s1'), false); // 手动咨询随会话清理
    assert.equal(services.observer.snapshot('s1').repetitionCount, 0); // 观察状态清理
    assert.equal(services.delivery.status().agents.includes('s1'), false); // 送达注册清理
});

test('tools 缝缺失显性化：degradations.askAdvisorTool 标注，激活即清除（五缝显性化对齐）', async () => {
    const missing = makeCtx({ withTools: false, llm: createFakeLlm([]) });
    const services = apply(missing.ctx, { enabled: false });
    assert.equal(services.status.snapshot().degradations.askAdvisorTool, 'tools-seam-not-activated');
    assert.ok(missing.unactivated.some((names) => names.includes('tools')));

    const present = makeCtx({ llm: createFakeLlm([]) });
    const presentServices = apply(present.ctx, { enabled: false });
    assert.equal(presentServices.status.snapshot().degradations.askAdvisorTool, undefined);
    assert.equal(present.registered.length, 1);
});

test('R-02-001/AC-01 SettingsForms 契约：default 导出承载 Config，每顶层声明键 volatile（T-028）', () => {
    // 宿主发现点：runtime.Config = default.Config（cordis unwrapExports 取 default）
    assert.equal(pluginModule.Config, Config);
    const dict = Config.dict ?? {};
    assert.equal(Object.keys(dict).length, 16, 'Config 声明 16 个顶层键（与 config.js 字段表双清单对齐；enabled 已退役，T-031）');
    for (const [key, child] of Object.entries(dict)) {
        assert.equal(child.meta?.volatile, true, `${key} 必须 volatile（0.2.0 编辑面判定）`);
    }
});

test('R-02-001/AC-01 宿主热更新（loader/volatile-update）→ live re-apply：entry 变更即时生效于后续咨询', async () => {
    const llm = createFakeLlm([answer('一。'), answer('二。')]);
    const { ctx, subscriptions } = makeCtx({ llm });
    const entry = {
        enabled: true,
        advisor: { provider: 'test', model: 'm1' },
        mode: 'soft',
    };
    const services = apply(ctx, entry);
    const updateEvent = subscriptions.find((s) => s.event === 'loader/volatile-update');
    assert.ok(updateEvent, '桥必须监听宿主 volatile 热更新事件（T-028 事件缝）');
    await settle();
    const before = await services.askAdvisor.execute({});
    assert.equal(llm.calls[0].options.model, 'm1');

    // 宿主热更新：entry 变更（模拟 loader 热提交 cell）+ 事件触发 → live re-apply
    entry.advisor = { provider: 'test', model: 'm2' };
    updateEvent.handler();
    const after = await services.askAdvisor.execute({});
    assert.match(after.adviceId, /^[0-9a-f-]{36}$/);
    assert.notEqual(after.adviceId, before.adviceId);
    assert.equal(llm.calls[1].options.model, 'm2');
    services.dispose();
});

test('R-02-001/AC-01 source 未变化时读时求值不回退：运行时写入（保存）不被陈旧 entry 覆盖', async () => {
    const llm = createFakeLlm([answer('一。'), answer('二。')]);
    const writes = [];
    const { ctx, subscriptions, providedService } = makeCtx({
        llm,
        typert: { register: () => {} },
        settings: { update: async (namespace, raw) => writes.push({ namespace, raw }) },
    });
    const services = apply(ctx, { enabled: true, advisor: { provider: 'p', model: 'm1' }, mode: 'soft' });
    await settle();
    const gateway = providedService('advisor-flow');
    // 卡片保存：运行时与 raw 前进到 m2；宿主 cell 尚未追平（异步 reconcile 窗口）
    const saved = await gateway.set({ advisor: { model: 'm2' } });
    assert.equal(saved.ok, true);
    // source 未变化（entry 仍 m1）：volatile-update 事件到达也不得回退
    subscriptions.find((s) => s.event === 'loader/volatile-update').handler();
    await services.askAdvisor.execute({});
    assert.equal(llm.calls[0].options.model, 'm2');
    // 保存后无重复写缝（source 未变化不触发持久化）
    assert.equal(writes.length, 1);
    services.dispose();
});

test('R-02-001/AC-01 持久写缝可得时：保存经 settings.update 写回 advisor-flow 命名空间', async () => {
    const writes = [];
    const { ctx, providedService } = makeCtx({
        llm: createFakeLlm([answer('ok')]),
        typert: { register: () => {} },
        settings: {
            update: async (namespace, raw) => writes.push({ namespace, raw }),
        },
    });
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'p', model: 'm1', maxTokens: 4096 },
        privacy: { history: 'off' },
        customKey: { keep: true }, // 文档层未知键（宿主 strip+mergeLayers 保留）
    });
    await settle();
    const gateway = providedService('advisor-flow');
    const result = await gateway.set({ advisor: { model: 'm2' } });
    assert.equal(result.ok, true);
    assert.equal(result.persisted, true);
    assert.match(result.notice, /已保存并持久化/);
    // merge 语义：只写 advisor-flow 命名空间键，raw 为合并后的完整命名空间
    assert.equal(writes.length, 1);
    assert.equal(writes[0].namespace, 'advisor-flow');
    assert.equal(writes[0].raw.advisor.model, 'm2');
    assert.equal(writes[0].raw.advisor.maxTokens, 4096); // 兄弟键保留
    // 写缝投影（T-028）：宿主 validatePaths 拒绝 schema 外顶层键——补丁只含
    // 声明键，未知键留在文档层（T-005 junk 保留语义不破坏）。enabled 已退役
    // （T-031/C-030）：不再声明 → 与 customKey 同为未知键，被投影剥除。
    assert.equal('customKey' in writes[0].raw, false);
    assert.equal('enabled' in writes[0].raw, false);
    assert.equal(services.status.snapshot().degradations.persistence, undefined);
});

test('R-02-001/AC-01 持久写缝缺失：degradations.persistence 标注且不虚报日志（服务缺失≠确认失败）', async () => {
    const { ctx, logs } = makeCtx({ llm: createFakeLlm([]) });
    const services = apply(ctx, { enabled: false });
    await settle();
    assert.equal(services.status.snapshot().degradations.persistence, 'settings-writer-seam-missing');
    assert.equal(logs.error.filter((message) => message.includes('持久化不可用')).length, 0);
});

test('R-02-001/AC-01 entry 就绪时序无关：装载时 entry 为空、宿主后写入——读时求值使 engine/get 读到就绪值', async () => {
    const llm = createFakeLlm([answer('种子配置意见。')]);
    const writes = [];
    const readyRaw = {
        enabled: true,
        advisor: { provider: 'persisted-p', model: 'persisted-m', maxTokens: 8192 },
        privacy: { history: 'delta' },
        mode: 'soft',
    };
    const entry = {}; // 装载时 entry config 为空（文档尚未产出 advisor-flow 行配置）
    const { ctx, providedService, subscriptions } = makeCtx({
        llm,
        settings: { update: async (namespace, raw) => writes.push({ namespace, raw }) },
        typert: { register: () => {} },
    });
    const services = apply(ctx, entry);
    await settle();

    // attach 种子读到空值 → 空值跳过（raw 不被清空、引擎保持默认态）
    assert.equal(services.status.snapshot().degradations.persistence, undefined); // 写缝已接入
    assert.equal(services.status.snapshot().enabled, false); // entry 空 → 默认禁用

    // 宿主写入就绪后（模拟 reconcile/热提交）——读时求值：gateway get 读到就绪值
    Object.assign(entry, structuredClone(readyRaw));
    subscriptions.find((s) => s.event === 'loader/volatile-update')?.handler?.();
    const gateway = providedService('advisor-flow');
    const got = await gateway.get();
    assert.equal(got.config.advisor.model, 'persisted-m');
    assert.equal(got.config.privacy.history, 'delta');

    // 咨询入口同样读时求值：真实使用就绪配置（无任何 set 触发）
    const consulted = await services.askAdvisor.execute({});
    assert.match(consulted.adviceId, /^[0-9a-f-]{36}$/);
    assert.equal(llm.calls[0].options.model, 'persisted-m');
    assert.equal(writes.length, 0); // 未发生任何持久写
});

test('R-02-001/AC-03 启动配置被拒时 raw 保留真实键：卡片可读回并修复，保存不丢键', async () => {
    const { ctx, providedService } = makeCtx({
        llm: createFakeLlm([answer('ok')]),
        typert: { register: () => {} },
    });
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'p', model: 'm', maxTokens: 'broken' },
        privacy: { history: 'off' },
        customKey: { keep: true },
    });
    assert.equal(services.status.snapshot().enabled, false); // 运行时禁用

    await settle();
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

test('commands/gateway 缝缺失时显性化降级而非拒绝启动（不锚定 AC）；服务后到仍激活子上下文', async () => {
    const { ctx, provide } = makeCtx({ llm: createFakeLlm([]) });
    const services = apply(ctx, { enabled: false });
    assert.equal(services.status.snapshot().degradations.commands, 'registry-seam-missing');
    assert.equal(services.status.snapshot().degradations.settingsCard, 'gateway-seam-missing');

    // 服务后到：逐一延迟提供 → 子上下文激活、降级清除
    provide('commands', { register: (spec) => () => {} });
    provide('typert', { register: () => {} });
    provide('settings', { update: async () => {} });
    await settle();
    const degradations = services.status.snapshot().degradations;
    assert.equal(degradations.commands, undefined);
    assert.equal(degradations.settingsCard, undefined);
    assert.equal(degradations.persistence, undefined);

    // 激活后的缝真实可用：命令面挂载
    void provide;
});


test('commands 条件子上下文激活：命令经注册表缝挂载并可执行（不锚定 AC）', async () => {
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

test('R-02-001/AC-01 entry volatile cell：装载后 cell 值经 .get() 解包为普通配置（T-028）', async () => {
    const llm = createFakeLlm([answer('ok')]);
    const cell = Object.freeze({
        get: () => structuredClone({ provider: 'test', model: 'cell-m' }),
        [Symbol.for('cosmokit.volatile.write')]: (value) => {},
    });
    const { ctx, providedService } = makeCtx({
        llm,
        typert: { register: () => {} },
    });
    apply(ctx, {
        enabled: true,
        advisor: cell, // 0.2.0 声明 Config 后 cordis 对 volatile 节点包 cell——非透传 proxy
        mode: 'soft',
    });
    await settle(); // gateway 经动态 import 异步注册
    const got = await providedService('advisor-flow').get();
    assert.deepEqual(got.config.advisor, { provider: 'test', model: 'cell-m' });
});

test('R-02-001/AC-01 settings 服务缺失时桥仍装配：source 即 entry，写缝降级标注（0.2.0 无需注册动作，T-028）', async () => {
    const { ctx, logs } = makeCtx({ llm: createFakeLlm([]) });
    const services = apply(ctx, { enabled: false });
    await settle();
    const degradations = services.status.snapshot().degradations;
    assert.equal(degradations.persistence, 'settings-writer-seam-missing');
    assert.equal(degradations.settingsSection, undefined); // 桥不依赖 settings 服务——正常态无 section 标注
    assert.ok(!logs.error.some((message) => message.includes('settings section 未注册')));
});


test('R-02-001/AC-01 持久化失败→恢复→再失败：degradations 随恢复清除，再失败再次显性（一次性日志重新武装）', async () => {
    let shouldThrow = true;
    const { ctx, providedService, logs } = makeCtx({
        llm: createFakeLlm([]),
        typert: { register: () => {} },
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
    assert.equal(logs.error.filter((message) => message.includes('持久化不可用')).length, 2);
});

test('T-014 Scout 接线计量：scout.enabled 时二次调用 usage 以 scout 口径入台账', async () => {
    // 程序序：策展二次调用先于主咨询（callAdvisor 装配阶段先跑 scout）
    const programs = [
        answer('{"groups":[{"id":"g1","required":true,"text":"策展组"}],"synthesis":""}', { usage: { inputTokens: 3, outputTokens: 2 } }),
        answer('意见一。'),
    ];
    const llm = createFakeLlm(programs);
    const { ctx } = makeCtx({ llm });
    ctx.sessionQuery = { observeSession: async () => ({ events: [{ type: 'user/message', seq: 1, time: 0, data: { message: { content: [{ type: 'text', text: '内容' }] } } }] }) }; // 经 proxy set 登记（inject 先于 apply 激活）
    const services = apply(ctx, { enabled: true, advisor: { provider: 'test', model: 'test-model' }, scout: { enabled: true }, mode: 'soft' });
    await services.askAdvisor.execute({ question: 'q' });
    await settle();
    const totals = services.usage.totals();
    assert.equal(totals.byEntry.scout?.calls, 1); // 二次调用以 scout 口径计量（T-014）
    assert.ok(totals.total.calls >= 2); // 主咨询 + scout 二次调用
    services.dispose();
});

test('R-02-001/AC-07 Scout 二次调用与主咨询同语义跟随宿主模型 maxTokens（C-015）', async () => {
    const programs = [
        answer('{"groups":[{"id":"g1","required":true,"text":"策展组"}],"synthesis":""}'),
        answer('意见一。'),
    ];
    const llm = createFakeLlm(programs);
    llm.setModelInfo({ reasoning: { efforts: [{ id: 'high' }] }, defaultMaxTokens: 131072 });
    const { ctx } = makeCtx({ llm });
    ctx.sessionQuery = { observeSession: async () => ({ events: [{ type: 'user/message', seq: 1, time: 0, data: { message: { content: [{ type: 'text', text: '内容' }] } } }] }) };
    const services = apply(ctx, { enabled: true, advisor: { provider: 'test', model: 'test-model' }, scout: { enabled: true }, mode: 'soft' });
    await services.askAdvisor.execute({ question: 'q' });
    await settle();
    // 程序序：scout 二次调用先于主咨询（T-014 实证）——两笔都跟随模型声明值
    assert.equal(llm.calls[0].options.maxTokens, 131072); // scout 二次调用不再回落上游默认
    assert.equal(llm.calls[1].options.maxTokens, 131072); // 主咨询同语义
    // 共享 (provider, model) 解析缓存：两次调用只解析一次模型信息
    assert.equal(llm.modelInfoCalls.length, 1);
    // scout 路径以裸 AbortSignal（AbortSignal.timeout）传入解析缝——可中止性不丢失
    assert.ok(llm.modelInfoCalls[0].signal instanceof AbortSignal);
    services.dispose();
});

/** 假 subagents 缝：每次 start 发布一个即时结算为 proceed 裁决的 one-shot 顾问子会话。 */
function fakeAdvisorSubagents() {
    return createFakeSubagents({
        makeRun: (callIndex) => ({
            id: `advisor-child-${callIndex}`,
            result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'Decision: proceed\n\nAdvisor 子会话意见。' }] }),
            dispose: async () => {},
        }),
    });
}

test('T-022 接线级递归守卫：收口评审生成的顾问子会话，其收口不再触发评审；会话清理摘除登记', async () => {
    const llm = createFakeLlm([answer('Decision: proceed\n\n兜底直调意见。')]);
    const subagents = fakeAdvisorSubagents();
    const { ctx, subscriptions, provide } = makeCtx({ llm });
    apply(ctx, { enabled: true, advisor: { provider: 'test', model: 'm' }, mode: 'hard' });
    provide('subagents', subagents);
    const handler = subscriptions.find((s) => s.event === 'agent/turn-stopping').handler;
    // 执行者收口：发起一次收口评审，经子会话呈现发布一个顾问子会话（零工具 + turn-review 标签）。
    await handler({ turn: 'turn-1', signal: undefined, agent: { id: 'exec-1' } });
    await settle();
    assert.equal(subagents.startCalls, 1);
    assert.equal(subagents.requests[0].request.label, 'Advisor review (turn-review)');
    assert.equal(subagents.requests[0].request.toolFilter.allow.length, 0);
    // 顾问子会话自己的收口：命中呈现登记，豁免——不再发布子会话（递归被阻断）。
    await handler({ turn: 'turn-1', signal: undefined, agent: { id: 'advisor-child-1' } });
    await settle();
    assert.equal(subagents.startCalls, 1);
    // 会话清理摘除登记：判定源失效后同 id 收口恢复评审语义（登记不泄漏）。
    const disposedHandler = subscriptions.find((s) => s.event === 'session/disposed').handler;
    disposedHandler({ id: 'advisor-child-1' });
    await handler({ turn: 'turn-1', signal: undefined, agent: { id: 'advisor-child-1' } });
    await settle();
    assert.equal(subagents.startCalls, 2);
});

test('T-035 接线级执行面守卫：已登记顾问子会话的工具调用在 pre-execute 被否决（NG-1 能力面）', async () => {
    const llm = createFakeLlm([answer('Decision: proceed\n\n兜底直调意见。')]);
    const subagents = fakeAdvisorSubagents();
    const { ctx, subscriptions, provide } = makeCtx({ llm });
    apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm' },
        mode: 'hard', // 硬模式：收口评审生效，发布顾问子会话进入登记表
        gates: { loop: { enabled: true, threshold: 2 } },
    });
    provide('subagents', subagents);
    const handler = subscriptions.find((s) => s.event === 'agent/turn-stopping').handler;
    await handler({ turn: 'turn-1', signal: undefined, agent: { id: 'exec-1' } }); // 发布 → advisor-child-1 入登记表
    await settle();
    const preExecute = subscriptions.find((s) => s.event === 'tools/pre-execute').handler;
    // 顾问子会话内委派（真机复现形状）：执行边界否决，短路在门引擎之前。
    const denial = await preExecute({ token: 't1', callId: 'c1', name: 'subagent', arguments: {}, agent: { id: 'advisor-child-1' } }, () => ({ kind: 'allow' }));
    assert.equal(denial.kind, 'deny');
    assert.ok(denial.reason.includes('Tool execution is disabled'));
    // 未登记会话照常走门引擎：同 exec 两次不拦（阈值 2 未达，门计数正常推进）。
    const exec = { token: 't1', callId: 'c1', rootCallId: 'r1', name: 'bash', arguments: { command: 'npm test' }, agent: { id: 'exec-1' } };
    assert.equal((await preExecute(exec, () => ({ kind: 'allow' }))).kind, 'allow');
    assert.equal((await preExecute(exec, () => ({ kind: 'allow' }))).kind, 'allow');
    // 会话清理摘除登记后，同 id 的工具调用恢复门引擎路径（登记不泄漏）。
    subscriptions.find((s) => s.event === 'session/disposed').handler({ id: 'advisor-child-1' });
    const afterDispose = await preExecute({ token: 't2', callId: 'c2', name: 'subagent', arguments: {}, agent: { id: 'advisor-child-1' } });
    assert.equal(afterDispose.kind, 'allow'); // 未登记 → 门引擎路径（未达阈值放行）
});

test('T-035 deny 短路不进循环门计数：同签名被否决调用零咨询（审核缺口 G1 回归）', async () => {
    const llm = createFakeLlm([answer('Decision: proceed\n\n不应被调用的门评审。')]);
    const subagents = fakeAdvisorSubagents();
    const { ctx, subscriptions, provide } = makeCtx({ llm });
    apply(ctx, {
        enabled: true,
        advisor: { provider: 'test', model: 'm' },
        mode: 'hard',
        gates: { loop: { enabled: true, threshold: 2 } },
    });
    provide('subagents', subagents);
    const handler = subscriptions.find((s) => s.event === 'agent/turn-stopping').handler;
    await handler({ turn: 'turn-1', signal: undefined, agent: { id: 'exec-1' } }); // 发布 → advisor-child-1 入登记表
    await settle();
    const preExecute = subscriptions.find((s) => s.event === 'tools/pre-execute').handler;
    const exec = { token: 't1', callId: 'c1', rootCallId: 'r1', name: 'subagent', arguments: {}, agent: { id: 'advisor-child-1' } };
    assert.equal((await preExecute(exec, () => ({ kind: 'allow' }))).kind, 'deny');
    // 同签名第二次：守卫仍否决；若否决被错误计入循环门（阈值 2），此处将
    // 触发门评审（llm.calls>=1）——零咨询即证明 deny 先于 recordCall 短路。
    assert.equal((await preExecute(exec, () => ({ kind: 'allow' }))).kind, 'deny');
    assert.equal(llm.calls.length, 0); // 否决不推进等价计数（审核 G1）
});

/** T-023 子会话租约夹具（共享单点：test/helpers.js::reviewerSubsessionLease；T-036 租约形状）。 */
function reviewSubsessionLog({ label = 'Standards review of T-032', prompt = 'Review the changes since main.' } = {}) {
    return reviewerSubsessionLease({ label, prompt });
}

test('T-023 接线级豁免：审核子会话（真实形状日志）收口不评审；缓存复用与 disposed 复位', async () => {
    const llm = createFakeLlm([answer('Decision: proceed\n\n不应被调用的意见。')]);
    const { ctx, subscriptions } = makeCtx({ llm });
    const observeCalls = [];
    ctx.sessionQuery = {
        observeSession: async (sessionId) => {
            observeCalls.push(sessionId);
            return { ...reviewSubsessionLog(), [Symbol.dispose]() {} };
        },
    };
    apply(ctx, { enabled: true, advisor: { provider: 'test', model: 'm' }, mode: 'hard' });
    const handler = subscriptions.find((s) => s.event === 'agent/turn-stopping').handler;
    // 审核子会话收口：自证（header origin）+ label 'review' 命中默认清单 → 豁免（零咨询、日志读取恰一次）。
    await handler({ turn: 'turn-1', signal: undefined, agent: { id: 'review-child' } });
    await settle();
    assert.equal(llm.calls.length, 0);
    assert.equal(observeCalls.length, 1);
    assert.equal(observeCalls[0], 'review-child');
    // 同会话第二回合收口：判定缓存复用，零重读（continuable 子会话多回合不放大读取）。
    await handler({ turn: 'turn-2', signal: undefined, agent: { id: 'review-child' } });
    await settle();
    assert.equal(observeCalls.length, 1);
    assert.equal(llm.calls.length, 0);
    // 会话清理摘除缓存：同 id 收口重新判定（observeSessionLease 再次调用）。
    const disposedHandler = subscriptions.find((s) => s.event === 'session/disposed').handler;
    disposedHandler({ id: 'review-child' });
    await handler({ turn: 'turn-1', signal: undefined, agent: { id: 'review-child' } });
    await settle();
    assert.equal(observeCalls.length, 2);
    assert.equal(llm.calls.length, 0); // 重判仍命中豁免
});

test('T-023 接线级豁免 fail-open：sessionQuery 缝缺失时审核子会话照常评审（R-01-009/AC-12）', async () => {
    const llm = createFakeLlm([answer('Decision: proceed\n\n直调路径意见。')]);
    const { ctx, subscriptions } = makeCtx({ llm }); // 不注入 sessionQuery
    apply(ctx, { enabled: true, advisor: { provider: 'test', model: 'm' }, mode: 'hard' });
    const handler = subscriptions.find((s) => s.event === 'agent/turn-stopping').handler;
    await handler({ turn: 'turn-1', signal: undefined, agent: { id: 'review-child' } });
    await settle();
    // 缝缺失 → 判定失败 fail-open → 评审照常（经子会话呈现或直调，llm 至少一笔）
    assert.ok(llm.calls.length >= 1);
});

test('T-026 接线级守卫：软模式审核子会话工具调用被拒（零咨询、计数入快照），主会话照常', async () => {
    const llm = createFakeLlm([answer('不应被调用的意见。'), answer('主会话意见。')]);
    const { ctx } = makeCtx({ llm });
    ctx.sessionQuery = {
        observeSession: async (sessionId) => {
            if (sessionId !== 'review-child') {
                return undefined; // 缝对其余会话不可得 → 分类器 fail-open 放行
            }
            return { ...reviewerSubsessionLease(), [Symbol.dispose]() {} };
        },
    };
    const services = apply(ctx, { enabled: true, advisor: { provider: 'test', model: 'm' }, mode: 'soft' });
    // 审核子会话：自证 + label 'review' 命中默认清单 → 工具面拒绝，零咨询。
    const refused = await services.askAdvisor.execute({}, { agent: { id: 'review-child' } });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'SESSION_EXEMPT');
    assert.ok(refused.reason.includes('do not retry ask_advisor'));
    assert.equal(llm.calls.length, 0);
    assert.equal(services.status.snapshot().toolFaceStats.refused, 1);
    // 主会话（缝不可得 → fail-open）：照常咨询。
    const allowed = await services.askAdvisor.execute({}, { agent: { id: 'main-1' } });
    assert.equal(allowed.ok, true);
    assert.equal(llm.calls.length, 1);
    assert.equal(services.status.snapshot().toolFaceStats.refused, 1); // 放行不计数
});

test('T-026 接线级守卫：硬模式工具面对一切会话关闭（含主会话），零咨询且按 code 计数', async () => {
    const llm = createFakeLlm([answer('不应被调用的意见。')]);
    const { ctx } = makeCtx({ llm });
    const services = apply(ctx, { enabled: true, advisor: { provider: 'test', model: 'm' }, mode: 'hard' });
    for (const sessionId of ['main-1', 'review-child']) {
        const refused = await services.askAdvisor.execute({}, { agent: { id: sessionId } });
        assert.equal(refused.ok, false);
        assert.equal(refused.code, 'TOOL_FACE_CLOSED');
        assert.ok(refused.reason.includes('This refusal is expected'));
    }
    assert.equal(llm.calls.length, 0); // 守卫拒绝：不发起咨询
    assert.deepEqual(services.status.snapshot().toolFaceStats, { refused: 2, byCode: { TOOL_FACE_CLOSED: 2 } });
});

test('T-035 接线级会话工作区 cwd：sessionQuery header.cwd 驱动仓库上下文采集（缺陷二回归）', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const { join } = await import('node:path');
    const dir = mkdtempSync('.idx-ws-');
    try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        writeFileSync(join(dir, 'committed.js'), 'base\n');
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'committed.js'], { cwd: dir });
        // 工作树弄脏：探针文件名须出现在仓库变更区——证明采集现场 = header.cwd。
        writeFileSync(join(dir, 'probe-ws-marker.js'), 'drift');
        const observeCalls = [];
        const llm = createFakeLlm([answer('接线级意见。')]);
        const { ctx } = makeCtx({ llm });
        ctx.sessionQuery = {
            observeSession: async (sessionId) => {
                observeCalls.push(sessionId);
                return { header: { cwd: dir }, events: [], [Symbol.dispose]() {} };
            },
        };
        const services = apply(ctx, { enabled: true, advisor: { provider: 'test', model: 'm' }, mode: 'soft' });
        const allowed = await services.askAdvisor.execute({}, { agent: { id: 'main-1' } });
        assert.equal(allowed.ok, true);
        assert.ok(observeCalls.length >= 1 && observeCalls.every((id) => id === 'main-1')); // 钩子收到发起会话标识
        const sent = llm.calls[0].options.messages[0].content[0].text;
        assert.ok(sent.includes('<repository_changes'));
        assert.ok(sent.includes('probe-ws-marker.js')); // header.cwd 现场的变更出境
        assert.ok(!sent.includes('not-a-repository'));  // 不再误判为非仓库
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
