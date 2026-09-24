import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdvisorFlowConfig } from '../lib/config.js';
import { createConsultationEngine } from '../lib/consultation.js';
import { createUsageLedger } from '../lib/usage.js';
import { createStatusProvider } from '../lib/status.js';
import { createFakeLlm, answer } from './helpers.js';

function config(raw) {
    const result = resolveAdvisorFlowConfig(raw);
    assert.equal(result.ok, true, result.error ?? '');
    return result.config;
}

test('R-02-003/AC-02 状态快照展示启用态、模型路由、守则开关、循环门配置、待处理数与最近活动', async () => {
    const llm = createFakeLlm([{ ...answer('恢复后的意见。', { usage: { inputTokens: 3, outputTokens: 2 } }), hangUntilReleased: true }]);
    const usageLedger = createUsageLedger();
    const enabled = config({
        enabled: true,
        advisor: { provider: 'gpu', model: 'glm-5.3-flash', reasoningEffort: 'high', maxTokens: 16384, callTimeoutMs: 180000 },
        gates: { plan: { enabled: true }, loop: { enabled: true, threshold: 5 } },
        failureMode: 'block-tool',
    });
    const engine = createConsultationEngine({
        llm,
        config: enabled,
        logger: { info() {}, warn() {} },
        usageLedger,
    });
    const pending = engine.consult({ entry: 'tool', question: 'q' });
    // 让引擎进入流式等待后再取快照
    await new Promise((resolve) => setTimeout(resolve, 5));
    const provider = createStatusProvider({ config: enabled, engine, usageLedger });

    const snapshot = provider.snapshot();
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.advisor.provider, 'gpu');
    assert.equal(snapshot.advisor.model, 'glm-5.3-flash');
    assert.equal(snapshot.advisor.reasoningEffort, 'high');
    // 守则三门开关 + 循环门配置 + 阻断模式随活配置回显
    assert.equal(snapshot.gates.plan.enabled, true);
    assert.equal(snapshot.gates.loop.threshold, 5);
    assert.equal(snapshot.failureMode, 'block-tool');
    assert.equal(snapshot.pending, 1);
    assert.deepEqual(snapshot.usage.total, usageLedger.totals().total);

    llm.release(0);
    await pending;
    const after = provider.snapshot();
    assert.equal(after.pending, 0);
    assert.ok(typeof after.lastActivity === 'number');
    assert.equal(after.sessions[0].runtime, 'active');
});

test('R-02-003 禁用态与缺失路由在状态中可查询（disabled-with-reason）；阻断模式可查询', () => {
    const disabled = config({ enabled: true, advisor: { provider: 'p' } });
    const provider = createStatusProvider({ config: disabled });
    const snapshot = provider.snapshot();
    assert.equal(snapshot.enabled, false);
    assert.equal(snapshot.reason, 'missing-advisor-model');
    assert.equal(snapshot.pending, 0);
    assert.equal(snapshot.lastActivity, undefined);
    assert.equal(snapshot.failureMode, 'warn-and-continue');
});
