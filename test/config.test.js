import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdvisorFlowConfig, DEFAULT_CALL_TIMEOUT_MS, DEFAULT_MAX_TOKENS, DEFAULT_MAX_QUEUED } from '../lib/config.js';

test('R-02-001/AC-01 解析后的配置驱动后续咨询，重新应用即时生效', async () => {
    const first = resolveAdvisorFlowConfig({
        enabled: true,
        advisor: { provider: 'p1', model: 'm1' },
    });
    assert.equal(first.ok, true);
    assert.equal(first.config.enabled, true);
    assert.equal(first.config.advisor.provider, 'p1');
    assert.equal(first.config.advisor.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS);
    assert.equal(first.config.advisor.maxTokens, DEFAULT_MAX_TOKENS);

    // 配置变更即时生效：重新解析出的新配置原样替换旧配置对象（引擎侧经
    // applyConfig 在后续咨询生效，见 consultation 测试）。
    const second = resolveAdvisorFlowConfig({
        enabled: true,
        advisor: { provider: 'p2', model: 'm2', maxTokens: 1024 },
    });
    assert.equal(second.config.advisor.provider, 'p2');
    assert.equal(second.config.advisor.maxTokens, 1024);
    assert.notEqual(first.config, second.config);
});

test('R-02-001/AC-02 未知键收集为警告并保留透传，不阻断其他配置生效', () => {
    const result = resolveAdvisorFlowConfig({
        enabled: true,
        advisor: { provider: 'p', model: 'm', unknownAdvisor: 1 },
        gates: { plan: { enabled: true, policy: 'review', extraGate: true }, bogusGate: {} },
        privacy: { history: 'off', mystery: 'x' },
        budget: { maxPerSession: 3, stray: true },
        topLevelExtra: { a: 1 },
    });
    assert.equal(result.ok, true);
    assert.ok(result.warnings.includes('topLevelExtra'));
    assert.ok(result.warnings.includes('advisor.unknownAdvisor'));
    assert.ok(result.warnings.includes('gates.plan.extraGate'));
    assert.ok(result.warnings.includes('gates.bogusGate'));
    assert.ok(result.warnings.includes('privacy.mystery'));
    assert.ok(result.warnings.includes('budget.stray'));
    // 未知键原值保留
    assert.deepEqual(result.config.unknown.topLevelExtra, { a: 1 });
    assert.equal(result.config.advisor.unknownAdvisor, 1);
    assert.equal(result.config.privacy.mystery, 'x');
    // 已知键不受未知键影响
    assert.equal(result.config.enabled, true);
    assert.equal(result.config.gates.plan.enabled, true);
    assert.equal(result.config.privacy.history, 'off');
});

test('R-02-001/AC-03 enabled 但缺 provider/model 时禁用且带原因，引擎返回 NO_ADVISOR_MODEL', async () => {
    const missingModel = resolveAdvisorFlowConfig({ enabled: true, advisor: { provider: 'p' } });
    assert.equal(missingModel.ok, true);
    assert.equal(missingModel.config.enabled, false);
    assert.equal(missingModel.config.reason, 'missing-advisor-model');

    const missingProvider = resolveAdvisorFlowConfig({ enabled: true });
    assert.equal(missingProvider.config.enabled, false);
    assert.equal(missingProvider.config.reason, 'missing-advisor-model');

    const { createConsultationEngine } = await import('../lib/consultation.js');
    const infos = [];
    const engine = createConsultationEngine({
        llm: { stream() { throw new Error('must not be called'); } },
        config: missingModel.config,
        logger: { info: (m, f) => infos.push({ m, f }) },
    });
    const result = await engine.consult({ entry: 'tool', question: 'q' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NO_ADVISOR_MODEL');
    assert.ok(result.reason.length > 0);
    assert.equal(engine.pendingCount, 0);
});

test('R-02-001 非法值被拒绝；未知键不算拒绝；空配置取默认', () => {
    const bad = resolveAdvisorFlowConfig({ enabled: true, advisor: { provider: 'p', model: 'm', maxTokens: 'many' } });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /maxTokens/);

    const badPrivacy = resolveAdvisorFlowConfig({ privacy: { history: 'all' } });
    assert.equal(badPrivacy.ok, false);
    assert.match(badPrivacy.error, /privacy\.history/);

    const badGate = resolveAdvisorFlowConfig({ gates: { failure: { policy: 'block-session', threshold: 0 } } });
    assert.equal(badGate.ok, false);
    assert.match(badGate.error, /threshold/);

    const unknownOnly = resolveAdvisorFlowConfig({ whatever: 1 });
    assert.equal(unknownOnly.ok, true);
    assert.deepEqual(unknownOnly.warnings, ['whatever']);

    const empty = resolveAdvisorFlowConfig(undefined);
    assert.equal(empty.ok, true);
    assert.equal(empty.config.enabled, false);
    assert.equal(empty.config.privacy.history, 'window');
    assert.equal(empty.config.privacy.repoContext, 'summary');
    assert.equal(empty.config.privacy.toolResults, 'capped');
    assert.equal(empty.config.privacy.fileContent, false);
    assert.equal(empty.config.privacy.redactSecrets, true);
    assert.equal(empty.config.budget.maxPerSession, 0);
    assert.equal(empty.config.gates.loop.threshold, 3);
    assert.equal(empty.config.gates.completion.policy, 'review');
});

test('R-02-001 门配置解析为结构化对象（含 failure 的 block-session 档位）', () => {
    const result = resolveAdvisorFlowConfig({
        gates: {
            plan: { enabled: true, policy: 'block' },
            failure: { enabled: true, policy: 'block-session', threshold: 2 },
            loop: { enabled: true, policy: 'ask', threshold: 5 },
            completion: { enabled: false, policy: 'review' },
        },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.config.gates.plan, { enabled: true, policy: 'block' });
    assert.deepEqual(result.config.gates.failure, { enabled: true, policy: 'block-session', threshold: 2 });
    assert.deepEqual(result.config.gates.loop, { enabled: true, policy: 'ask', threshold: 5 });
    assert.deepEqual(result.config.gates.completion, { enabled: false, policy: 'review' });
});
