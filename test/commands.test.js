import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdvisorFlowConfig } from '../lib/config.js';
import {
    advisorGatesText,
    advisorStatusText,
    createCommandController,
    parseAdvisorCommand,
    registerAdvisorFlowCommands,
} from '../lib/commands.js';
import { createConsultationEngine } from '../lib/consultation.js';
import { createUsageLedger } from '../lib/usage.js';
import { createStatusProvider } from '../lib/status.js';
import { createAdviceDelivery } from '../lib/delivery.js';
import { createFakeLlm, answer } from './helpers.js';

/** Build a controller wired to a real engine + fake llm + recorder delivery. */
function makeController({ raw = { enabled: true, advisor: { provider: 'test', model: 'm' } }, programs } = {}) {
    const llm = createFakeLlm(programs ?? [answer('手动评审意见。', { usage: { inputTokens: 7, outputTokens: 3 } })]);
    const config = resolveAdvisorFlowConfig(raw).config;
    const logs = { info: [], error: [] };
    const logger = {
        info: (m, f) => logs.info.push({ m, f }),
        error: (m, f) => logs.error.push({ m, f }),
        warn() {},
    };
    const usageLedger = createUsageLedger({ clock: () => 1000 });
    const engine = createConsultationEngine({ llm, config, logger, usageLedger, sleep: async () => {} });
    const delivered = [];
    const delivery = createAdviceDelivery({ logger, immuneTurns: 0 });
    const agent = { id: 's1', inject: () => {}, steer: () => {} };
    delivery.registerAgent(agent);
    const statusProvider = createStatusProvider({ config: () => config, engine, usageLedger });
    const controller = createCommandController({
        engine,
        statusProvider,
        delivery: (sessionId, advice) => delivered.push({ sessionId, advice }),
        getConfig: () => config,
        logger,
    });
    return { controller, llm, engine, usageLedger, delivered, config, statusProvider, logs };
}

const invocation = (rawInput, sessionId = 's1') => ({ rawInput, agent: { session: { id: sessionId } } });

test('R-01-002/AC-01 /advisor-manual 携带聚焦词时咨询素材包含该聚焦词，命令立即返回进行状态', async () => {
    const { controller, llm, delivered } = makeController();
    const registryCalls = [];
    const registry = { register: (spec) => registryCalls.push(spec) || (() => {}) };
    registerAdvisorFlowCommands(registry, controller);
    const manual = registryCalls.find((spec) => spec.name === 'advisor-manual');
    assert.ok(manual);

    const result = manual.handler(invocation('重点审查退避策略'));
    assert.equal(result.kind, 'success');
    assert.match(result.text, /手动咨询已发起/);
    assert.match(result.text, /进行中/); // 命令不阻塞，立即返回进行状态
    assert.equal(controller.manualRunning('s1'), true);

    // 等待咨询完成并送达（命令层不暴露 promise，以状态收敛为准）
    for (let i = 0; i < 50 && controller.manualRunning('s1'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(llm.calls.length >= 1);
    assert.ok(llm.calls[0].options.messages[0].content.includes('重点审查退避策略'));
    assert.equal(delivered.length, 1); // 意见经送达进入会话
    assert.equal(controller.manualRunning('s1'), false);
});

test('R-01-002/AC-02 手动咨询进行中状态可见且可取消，取消无用量副作用', async () => {
    const { controller, usageLedger } = makeController({
        programs: [{ hangUntilReleased: true, chunks: [{ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }] }],
    });
    const started = controller.startManual('s1', '审查重点');
    assert.equal(started.started, true);
    await new Promise((resolve) => setTimeout(resolve, 5));

    // 进行状态可见
    const statusText = advisorStatusText(controller.snapshotFor('s1'));
    assert.match(statusText, /手动咨询: 进行中/);
    assert.match(statusText, /审查重点/);

    // 取消：立即生效、无用量副作用、状态清除
    assert.equal(controller.cancelManual('s1'), true);
    const result = await started.promise;
    assert.equal(result.ok, false); // 取消返回诊断结果
    assert.equal(controller.manualRunning('s1'), false);
    assert.equal(usageLedger.totals().total.calls, 0); // 取消不留用量记录
    assert.match(advisorStatusText(controller.snapshotFor('s1')), /Advisor: enabled/);
    assert.doesNotMatch(advisorStatusText(controller.snapshotFor('s1')), /进行中/);
});

test('R-02-003/AC-02 /advisor status 展示启用态、路由、门状态、待处理、最近活动、用量摘要与降级项', async () => {
    const raw = {
        enabled: true,
        advisor: { provider: 'gpu', model: 'glm-5.3-flash' },
        gates: { plan: { enabled: true, policy: 'review' }, failure: { enabled: true, policy: 'block-session', threshold: 2 } },
    };
    const { controller } = makeController({ raw });
    const registryCalls = [];
    registerAdvisorFlowCommands({ register: (spec) => registryCalls.push(spec) || (() => {}) }, controller);
    const advisor = registryCalls.find((spec) => spec.name === 'advisor');
    const result = advisor.handler(invocation(' status'));
    assert.equal(result.kind, 'success');
    const text = result.text;
    assert.match(text, /Advisor: enabled/);
    assert.match(text, /模型: gpu\/glm-5.3-flash/);
    assert.match(text, /plan=on\(review\)/);
    assert.match(text, /failure=on\(block-session\) threshold=2/);
    assert.match(text, /待处理: 0/);
    assert.match(text, /最近活动: 无/);
    assert.match(text, /用量累计: calls=0 inputTokens=unavailable/); // 缺失项呈现不可得
    // gates 只读回读
    const gates = advisor.handler(invocation(' gates'));
    assert.match(gates.text, /门配置（只读回读）/);
    assert.match(gates.text, /loop=off\(review\) threshold=3/);
});

test('R-02-001/AC-03 enabled 但缺 provider/model 时命令面给出明确原因且状态可查询', async () => {
    const { controller } = makeController({ raw: { enabled: true, advisor: { provider: 'p' } } });
    const registryCalls = [];
    registerAdvisorFlowCommands({ register: (spec) => registryCalls.push(spec) || (() => {}) }, controller);
    const manual = registryCalls.find((spec) => spec.name === 'advisor-manual');
    const result = manual.handler(invocation(''));
    assert.equal(result.kind, 'error');
    assert.match(result.text, /advisor 模型未配置|missing-advisor-model|provider/);
    const status = advisorStatusText(controller.snapshotFor('s1'));
    assert.match(status, /Advisor: disabled/);
    assert.match(status, /原因: missing-advisor-model/);
});

test('R-01-002/AC-02 /advisor on|off 是会话级临时覆盖：立即生效且绝不写持久配置', async () => {
    const { controller, engine, config } = makeController();
    const registryCalls = [];
    registerAdvisorFlowCommands({ register: (spec) => registryCalls.push(spec) || (() => {}) }, controller);
    const advisor = registryCalls.find((spec) => spec.name === 'advisor');
    const configBefore = JSON.stringify(config);

    // off → 本会话临时关闭，manual 被拒
    const off = advisor.handler(invocation(' off'));
    assert.match(off.text, /临时关闭/);
    assert.equal(engine.sessionEnabled('s1'), false);
    const manualBlocked = registryCalls.find((spec) => spec.name === 'advisor-manual').handler(invocation(''));
    assert.equal(manualBlocked.kind, 'error');
    assert.match(manualBlocked.text, /临时关闭/);
    // 持久配置未被写入
    assert.equal(JSON.stringify(config), configBefore);

    // on → 恢复
    const on = advisor.handler(invocation(' on'));
    assert.match(on.text, /临时启用/);
    assert.equal(engine.sessionEnabled('s1'), true);
    const manualOk = registryCalls.find((spec) => spec.name === 'advisor-manual').handler(invocation(''));
    assert.equal(manualOk.kind, 'success');
    // 其他会话不受该覆盖影响
    assert.equal(engine.sessionEnabled('s2'), undefined);
    assert.equal(JSON.stringify(config), configBefore);

    // status 显示临时覆盖标记
    const status = advisor.handler(invocation(' status'));
    assert.match(status.text, /本会话开关: on（临时覆盖，不写持久配置）/);
});

test('R-01-002/AC-02 /advisor-manual 重复发起被拒，/advisor cancel 无进行中时礼貌提示', async () => {
    const { controller } = makeController({
        programs: [{ hangUntilReleased: true, chunks: [{ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }] }],
    });
    const first = controller.startManual('s1', 'a');
    assert.equal(first.started, true);
    const second = controller.startManual('s1', 'b');
    assert.equal(second.started, false);
    assert.match(second.reason, /已有手动咨询进行中/);
    controller.cancelManual('s1');
    const registryCalls = [];
    registerAdvisorFlowCommands({ register: (spec) => registryCalls.push(spec) || (() => {}) }, controller);
    const advisor = registryCalls.find((spec) => spec.name === 'advisor');
    const cancel = advisor.handler(invocation(' cancel'));
    assert.match(cancel.text, /没有进行中的手动咨询/);
});

test('R-01-002/AC-01 命令解析与 usage：未知子命令返回用法文本', () => {
    assert.equal(parseAdvisorCommand(' on').kind, 'on');
    assert.equal(parseAdvisorCommand('off').kind, 'off');
    assert.equal(parseAdvisorCommand('status').kind, 'status');
    assert.equal(parseAdvisorCommand('gates').kind, 'gates');
    assert.equal(parseAdvisorCommand('cancel').kind, 'cancel');
    assert.equal(parseAdvisorCommand('').kind, 'toggle');
    assert.equal(parseAdvisorCommand('bogus').kind, 'usage');
    const { controller } = makeController();
    const registryCalls = [];
    registerAdvisorFlowCommands({ register: (spec) => registryCalls.push(spec) || (() => {}) }, controller);
    const advisor = registryCalls.find((spec) => spec.name === 'advisor');
    assert.match(advisor.handler(invocation('bogus')).text, /用法: \/advisor/);
    assert.equal(advisorGatesText({}).includes('completion'), true);
});
