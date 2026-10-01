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
    assert.equal(snapshot.failureMode, 'block-tool'); // C-017：默认 block-tool（偏离 pi 记档）
});

test('R-02-002/AC-04 逐次明细可见：status 快照携带 usageRecords', () => {
    const ledger = {
        totals: () => ({ total: { calls: 2 } }),
        records: () => [{ adviceId: 'a1', entry: 'tool' }, { adviceId: 'a2', entry: 'manual' }],
    };
    const status = createStatusProvider({ config: { enabled: true, advisor: {} }, engine: {}, usageLedger: ledger, degradations: {} });
    const snapshot = status.snapshot();
    assert.equal(snapshot.usageRecords.length, 2);
});

test('R-02-002/AC-05 预算剩余可查：快照携带逐会话 remainingCalls', () => {
    const engine = {
        status: () => [{ session: 's1', pending: 0 }],
        remainingCalls: (sessionId) => (sessionId === 's1' ? 2 : undefined),
        pendingCount: 0,
    };
    const status = createStatusProvider({ config: { enabled: true, advisor: {} }, engine, usageLedger: undefined, degradations: {} });
    const snapshot = status.snapshot();
    assert.equal(snapshot.budgetRemaining.s1, 2);
});

test('R-02-003/AC-03 门决策统计呈现：revise 计数与干预累计随决策累加', async () => {
    const { createGateEngine } = await import('../lib/gates/index.js');
    const engine = createGateEngine({
        consult: async () => ({ ok: true, adviceId: 'a1', decision: 'revise', markdown: '请改用更小步骤。' }),
        observer: { recordCall: () => ({ count: 3 }), resetRepetition: () => {} },
        delivery: () => {},
        getConfig: () => ({ enabled: true, failureMode: 'block-tool', gates: { loop: { enabled: true, threshold: 2 } } }),
    });
    const denied = await engine.handlePreExecute({ name: 'bash', arguments: 'x', session: 's' }, async () => ({ kind: 'allow' }));
    assert.equal(denied.kind, 'deny');
    const stats = engine.decisionStats();
    assert.equal(stats.revise, 1);
    assert.equal(stats.interventions, 1);
    assert.equal(stats.proceed, 0);
});
