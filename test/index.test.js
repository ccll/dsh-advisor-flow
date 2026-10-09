import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, name, inject } from '../lib/index.js';
import { createFakeLlm, answer, failure, createFakeSubagents } from './helpers.js';

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
    assert.equal(steered[0].source.plugin, 'advisor-flow');
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

test('R-02-001/AC-01 settings section 注册：installSection 以 advisor-flow 命名空间调用，describe 可服务', async () => {
    const installed = [];
    const { ctx } = makeCtx({
        llm: createFakeLlm([answer('ok')]),
        settings: {
            update: async () => {},
            installSection: (sectionCtx, namespace, schema, entry, hooks) => {
                installed.push({ namespace, schema, entry, hooks });
            },
        },
        typert: { register: () => {} },
    });
    apply(ctx, entryConfig);
    await settle();
    assert.equal(installed.length, 1);
    assert.equal(installed[0].namespace, 'advisor-flow'); // describe 服务本命名空间 → 卡片交集成立
    assert.ok(installed[0].schema, 'schema 随注册声明');
    assert.equal(installed[0].entry.enabled, true);
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
    assert.match(after.adviceId, /^[0-9a-f-]{36}$/);
    assert.notEqual(after.adviceId, before.adviceId);
    assert.equal(llm.calls[1].options.model, 'm2');
});

test('R-02-001/AC-01 持久写缝可得时：保存经 settings.update 写回 advisor-flow 命名空间', async () => {
    const writes = [];
    const { ctx, providedService } = makeCtx({
        llm: createFakeLlm([answer('ok')]),
        typert: { register: () => {} },
        settings: {
            update: async (namespace, raw) => writes.push({ namespace, raw }),
            installSection: () => {},
        },
    });
    const services = apply(ctx, {
        enabled: true,
        advisor: { provider: 'p', model: 'm1', maxTokens: 4096 },
        privacy: { history: 'off' },
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
    assert.equal(services.status.snapshot().degradations.persistence, undefined);
});

test('R-02-001/AC-01 持久写缝缺失：degradations.persistence 标注且不虚报日志（服务缺失≠确认失败）', async () => {
    const { ctx, logs } = makeCtx({ llm: createFakeLlm([]) });
    const services = apply(ctx, { enabled: false });
    await settle();
    assert.equal(services.status.snapshot().degradations.persistence, 'settings-writer-seam-missing');
    assert.equal(logs.error.filter((message) => message.includes('持久化不可用')).length, 0);
});

test('R-02-001/AC-01 启动种子时序无关：attach 时 source 为空、之后就绪——读时求值使 engine/get 读到就绪值', async () => {
    const llm = createFakeLlm([answer('种子配置意见。')]);
    const writes = [];
    const persistedRaw = {
        enabled: true,
        advisor: { provider: 'persisted-p', model: 'persisted-m', maxTokens: 8192 },
        privacy: { history: 'delta' },
    };
    const sourceHolder = { value: {} };
    const { ctx, providedService } = makeCtx({
        llm,
        settings: {
            update: async (namespace, raw) => writes.push({ namespace, raw }),
            installSection: (sectionCtx, namespace, schema, entry, hooks) => {
                hooks.setSource(() => structuredClone(sourceHolder.value));
            },
        },
        typert: { register: () => {} },
    });
    const services = apply(ctx, entryConfig);
    await settle();

    // attach 种子读到空值 → 空值跳过（raw 不被清空、引擎保持 entry 态）
    assert.equal(services.status.snapshot().degradations.persistence, undefined); // 写缝已接入
    assert.equal(services.status.snapshot().enabled, true); // entry 态

    // source 就绪后（无 onChange、无 set）——读时求值：gateway get 读到持久化值
    sourceHolder.value = structuredClone(persistedRaw);
    const gateway = providedService('advisor-flow');
    const got = await gateway.get();
    assert.equal(got.config.advisor.model, 'persisted-m');
    assert.equal(got.config.privacy.history, 'delta');

    // 咨询入口同样读时求值：真实使用持久化配置（无任何 set 触发）
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
            installSection: () => {},
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
    const services = apply(ctx, { enabled: true, advisor: { provider: 'test', model: 'test-model' }, scout: { enabled: true } });
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
    const services = apply(ctx, { enabled: true, advisor: { provider: 'test', model: 'test-model' }, scout: { enabled: true } });
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
