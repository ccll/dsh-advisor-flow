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

test('R-02-003/AC-02 状态快照展示启用态、模型路由、门状态、待处理数与最近活动', async () => {
    const llm = createFakeLlm([{ hangUntilReleased: true }, answer('重试后的意见。')]);
    const usageLedger = createUsageLedger();
    const enabled = config({
        enabled: true,
        advisor: { provider: 'gpu', model: 'glm-5.3-flash', reasoningEffort: 'high', maxTokens: 16384, callTimeoutMs: 180000 },
        gates: { plan: { enabled: true, policy: 'review' }, failure: { enabled: true, policy: 'block-session', threshold: 2 } },
    });
    const engine = createConsultationEngine({
        llm,
        config: enabled,
        logger: { info() {}, warn() {} },
        usageLedger,
        sleep: async () => {},
    });
    const pending = engine.consult({ entry: 'tool', question: 'q' });
    // 让引擎进入流式等待后再取快照（ensure the stream call has started）
    await new Promise((resolve) => setTimeout(resolve, 5));
    const provider = createStatusProvider({ config: enabled, engine, usageLedger });

    const snapshot = provider.snapshot();
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.advisor.provider, 'gpu');
    assert.equal(snapshot.advisor.model, 'glm-5.3-flash');
    assert.equal(snapshot.advisor.reasoningEffort, 'high');
    assert.equal(snapshot.gates.plan.enabled, true);
    assert.equal(snapshot.gates.failure.threshold, 2);
    assert.equal(snapshot.pending, 1);
    assert.deepEqual(snapshot.usage.total, usageLedger.totals().total);

    llm.release(0);
    await pending;
    const after = provider.snapshot();
    assert.equal(after.pending, 0);
    assert.ok(typeof after.lastActivity === 'number');
    assert.equal(after.sessions[0].runtime, 'active');
});

test('R-02-003 禁用态与缺失路由在状态中可查询（disabled-with-reason）', () => {
    const disabled = config({ enabled: true, advisor: { provider: 'p' } });
    const provider = createStatusProvider({ config: disabled });
    const snapshot = provider.snapshot();
    assert.equal(snapshot.enabled, false);
    assert.equal(snapshot.reason, 'missing-advisor-model');
    assert.equal(snapshot.pending, 0);
    assert.equal(snapshot.lastActivity, undefined);
});
