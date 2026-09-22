import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, name, inject } from '../lib/index.js';
import { createFakeLlm, answer } from './helpers.js';

function makeCtx({ withTools = true, llm } = {}) {
    const registered = [];
    const logs = { error: [], warn: [], info: [] };
    const logger = {
        error: (message) => logs.error.push(message),
        warn: (message) => logs.warn.push(message),
        info: (message) => logs.info.push(message),
    };
    const ctx = {
        logger: () => logger,
        root: { get: (service) => (service === 'llm' ? llm : undefined) },
        ...(withTools ? { tools: { register: (tool) => registered.push(tool) } } : {}),
    };
    return { ctx, registered, logs };
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
    assert.equal(services.config.enabled, true);

    // 工具面经注册的同一实例工作
    const result = await services.askAdvisor.execute({ question: 'q' });
    assert.equal(result.adviceId, 'adv-1');

    // applyConfig 经返回的 engine 即时生效于后续咨询
    services.engine.applyConfig({
        ...services.config,
        advisor: { ...services.config.advisor, model: 'm2' },
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
    assert.equal(services.config.enabled, false);
    assert.equal(registered[0].name, 'ask_advisor');
    const result = await services.askAdvisor.execute({});
    assert.equal(result.error, true);
    assert.equal(result.code, 'NO_ADVISOR_MODEL');
    assert.equal(name, 'dsh-advisor-flow');
    assert.deepEqual(inject, ['llm']);
});
