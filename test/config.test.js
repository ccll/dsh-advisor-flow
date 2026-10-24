import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdvisorFlowConfig, DEFAULT_CALL_TIMEOUT_MS, DEFAULT_GATE_THRESHOLD, DEFAULT_FAILURE_MODE, FAILURE_MODES, DEFAULT_PRESENTATION, PRESENTATION_MODES, DEFAULT_TURN_REVIEW_EXEMPT_PATTERNS } from '../lib/config.js';

test('R-02-001/AC-01 解析后的配置驱动后续咨询，重新应用即时生效', async () => {
    const first = resolveAdvisorFlowConfig({
        advisor: { provider: 'p1', model: 'm1' },
    });
    assert.equal(first.ok, true);
    assert.equal(first.config.enabled, true);
    assert.equal(first.config.advisor.provider, 'p1');
    assert.equal(first.config.advisor.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS);
    assert.equal(first.config.advisor.callTimeoutMs, 600000); // R-02-001/AC-06：默认 10 分钟（C-015，偏离 pi 180s）
    assert.equal(first.config.advisor.maxTokens, undefined); // R-02-001/AC-07：缺省跟随宿主模型配置（C-015）

    // 配置变更即时生效：重新解析出的新配置原样替换旧配置对象（引擎侧经
    // applyConfig 在后续咨询生效，见 consultation 测试）。
    const second = resolveAdvisorFlowConfig({
        advisor: { provider: 'p2', model: 'm2', maxTokens: 1024 },
    });
    assert.equal(second.config.advisor.provider, 'p2');
    assert.equal(second.config.advisor.maxTokens, 1024);
    assert.notEqual(first.config, second.config);
});

test('R-02-001/AC-06 callTimeoutMs 缺省 600000（10 分钟），显式配置覆盖生效（C-015）', () => {
    const defaultTimeout = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm' } });
    assert.equal(defaultTimeout.config.advisor.callTimeoutMs, 600000); // 偏离 pi 180s，分歧记账 C-015
    const override = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm', callTimeoutMs: 480000 } });
    assert.equal(override.config.advisor.callTimeoutMs, 480000);
    const bad = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm', callTimeoutMs: 0 } });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /callTimeoutMs/);
});

test('R-02-001/AC-02 未知键收集为警告并保留透传（含旧键 policy 与 retryAttempts），不阻断其他配置生效', () => {
    const result = resolveAdvisorFlowConfig({
        advisor: { provider: 'p', model: 'm', retryAttempts: 2, unknownAdvisor: 1 },
        gates: { plan: { enabled: true, policy: 'review', extraGate: true }, bogusGate: {} },
        privacy: { history: 'off', mystery: 'x' },
        budget: { maxPerSession: 3, stray: true },
        topLevelExtra: { a: 1 },
    });
    assert.equal(result.ok, true);
    assert.ok(result.warnings.includes('topLevelExtra'));
    assert.ok(result.warnings.includes('advisor.retryAttempts')); // 旧键走未知键警告保留
    assert.ok(result.warnings.includes('advisor.unknownAdvisor'));
    assert.ok(result.warnings.includes('gates.plan.policy'));
    assert.ok(result.warnings.includes('gates.bogusGate'));
    assert.ok(result.warnings.includes('privacy.mystery'));
    assert.ok(result.warnings.includes('budget.stray'));
    // 未知键原值保留
    assert.deepEqual(result.config.unknown.topLevelExtra, { a: 1 });
    assert.equal(result.config.advisor.retryAttempts, 2);
    assert.equal(result.config.gates.plan.policy, 'review');
    // 已知键不受未知键影响
    assert.equal(result.config.enabled, true);
    assert.equal(result.config.gates.plan.enabled, true);
    assert.equal(result.config.privacy.history, 'off');
});


test('R-02-001/AC-03 顾问路由不完整时派生禁用且带原因，引擎返回 NO_ADVISOR_MODEL；遗留 enabled 键告警忽略（T-031/C-030）', async () => {
    // 派生启用（C-030）：无 enabled 开关，provider/model 齐备即启用
    const derived = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm' } });
    assert.equal(derived.ok, true);
    assert.equal(derived.config.enabled, true);
    assert.equal(derived.config.reason, undefined);

    const missingModel = resolveAdvisorFlowConfig({ advisor: { provider: 'p' } });
    assert.equal(missingModel.ok, true);
    assert.equal(missingModel.config.enabled, false);
    assert.equal(missingModel.config.reason, 'missing-advisor-model');

    const missingProvider = resolveAdvisorFlowConfig({});
    assert.equal(missingProvider.config.enabled, false);
    assert.equal(missingProvider.config.reason, 'missing-advisor-model');

    // 遗留 enabled 键：布尔与非布尔都只告警、不再拒绝（与 unknown 键同语义）
    const legacy = resolveAdvisorFlowConfig({ enabled: true, advisor: { provider: 'p', model: 'm' } });
    assert.equal(legacy.ok, true);
    assert.equal(legacy.config.enabled, true); // 忽略该键，按派生真值
    assert.ok(legacy.warnings.some((w) => w.includes('enabled')));
    const legacyBad = resolveAdvisorFlowConfig({ enabled: 'yes' });
    assert.equal(legacyBad.ok, true);
    assert.equal(legacyBad.config.enabled, false);
    assert.ok(legacyBad.warnings.some((w) => w.includes('enabled')));

    const { createConsultationEngine } = await import('../lib/consultation.js');
    const engine = createConsultationEngine({
        llm: { stream() { throw new Error('must not be called'); } },
        config: missingModel.config,
        logger: { info() {} },
    });
    const result = await engine.consult({ entry: 'tool', question: 'q' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NO_ADVISOR_MODEL');
    assert.ok(result.reason.length > 0);
    assert.equal(engine.pendingCount, 0);
});

test('R-02-001 非法值被拒绝；未知键不算拒绝；空配置取默认（守则三门布尔 + 循环门阈值 + 阻断模式；阈值下界另见 R-01-005/AC-08）', () => {
    const bad = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm', maxTokens: 'many' } });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /maxTokens/);

    // R-02-001/AC-07：maxTokens 为 0 或负数非法（可选正整数，缺省 = 跟随宿主）
    const zeroMaxTokens = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm', maxTokens: 0 } });
    assert.equal(zeroMaxTokens.ok, false);
    assert.match(zeroMaxTokens.error, /maxTokens/);
    const negativeMaxTokens = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm', maxTokens: -1 } });
    assert.equal(negativeMaxTokens.ok, false);
    assert.match(negativeMaxTokens.error, /maxTokens/);

    // R-02-001/AC-07：null 与缺省同义（跟随宿主），显式正整数保留
    const nullMaxTokens = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm', maxTokens: null } });
    assert.equal(nullMaxTokens.ok, true);
    assert.equal(nullMaxTokens.config.advisor.maxTokens, undefined);
    const explicitMaxTokens = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm', maxTokens: 4096 } });
    assert.equal(explicitMaxTokens.config.advisor.maxTokens, 4096);

    // privacy.history 已退役为未知键（警告保留）；非法值拒绝改用仍受验证的 repoContext
    const badPrivacy = resolveAdvisorFlowConfig({ privacy: { repoContext: 'bogus' } });
    assert.equal(badPrivacy.ok, false);
    assert.match(badPrivacy.error, /privacy\.repoContext/);

    const badFailureMode = resolveAdvisorFlowConfig({ failureMode: 'halt-everything' });
    assert.equal(badFailureMode.ok, false);
    assert.match(badFailureMode.error, /failureMode/);

    const badPresentation = resolveAdvisorFlowConfig({ presentation: 'floating' });
    assert.equal(badPresentation.ok, false);
    assert.match(badPresentation.error, /presentation/);

    const badLoopThreshold = resolveAdvisorFlowConfig({ gates: { loop: { enabled: true, threshold: 0 } } });
    assert.equal(badLoopThreshold.ok, false);
    assert.match(badLoopThreshold.error, /threshold/);

    // R-02-001/AC-05 + R-01-005/AC-08：阈值下界 2（pi advisorLoopThreshold ≥2）
    const thresholdOne = resolveAdvisorFlowConfig({ gates: { loop: { enabled: true, threshold: 1 } } });
    assert.equal(thresholdOne.ok, false);
    assert.match(thresholdOne.error, /threshold/);

    // R-02-004/AC-03 前置：repoContext 旧值警告回落（none/patch → summary）
    const legacyRepo = resolveAdvisorFlowConfig({ privacy: { repoContext: 'patch' } });
    assert.equal(legacyRepo.ok, true);
    assert.equal(legacyRepo.config.privacy.repoContext, 'summary');
    assert.ok(legacyRepo.warnings.some((w) => w.includes('repoContext')));

    const unknownOnly = resolveAdvisorFlowConfig({ whatever: 1 });
    assert.equal(unknownOnly.ok, true);
    assert.deepEqual(unknownOnly.warnings, ['whatever']);

    // 旧键（privacy.history / privacy.toolResults）降级为未知键警告保留
    const legacyKeys = resolveAdvisorFlowConfig({ privacy: { history: 'window', toolResults: 'capped' } });
    assert.equal(legacyKeys.ok, true);
    assert.ok(legacyKeys.warnings.includes('privacy.history'));
    assert.ok(legacyKeys.warnings.includes('privacy.toolResults'));

    const empty = resolveAdvisorFlowConfig(undefined);
    assert.equal(empty.ok, true);
    assert.equal(empty.config.enabled, false);
    assert.equal(empty.config.failureMode, DEFAULT_FAILURE_MODE);
    assert.deepEqual(FAILURE_MODES, ['warn-and-continue', 'block-tool', 'block-session']);
    // 默认值对齐 pi 0.8.2（C-008 ②）；偏离项 failureMode=block-tool（C-017）
    assert.equal(empty.config.privacy.fileContent, false);
    assert.equal(empty.config.privacy.untrackedContent, false);
    assert.equal(empty.config.privacy.redactSecrets, false);
    assert.equal(empty.config.privacy.repoContext, 'summary');
    assert.equal(empty.config.budget.maxPerSession, undefined);
    assert.equal(empty.config.contextMaxChars, 15000);
    assert.equal(empty.config.gitContextMaxChars, 20000);
    assert.equal(empty.config.blockOnBlocked, true);
    assert.deepEqual(empty.config.modelWhitelist, []);
    assert.deepEqual(empty.config.toolPolicies, {});
    assert.equal(empty.config.outcomeLogging, false);
    assert.equal(empty.config.customInvocation, undefined);
    // R-02-007：presentation 缺省 subagent（C-020）
    assert.equal(empty.config.presentation, DEFAULT_PRESENTATION);
    assert.deepEqual(PRESENTATION_MODES, ['subagent', 'direct']);
    // 守则三门与循环门默认开启（C-008 ②），循环门阈值缺省 3
    assert.equal(empty.config.gates.plan.enabled, true);
    assert.equal(empty.config.gates.failure.enabled, true);
    assert.equal(empty.config.gates.completion.enabled, true);
    assert.equal(empty.config.gates.loop.threshold, DEFAULT_GATE_THRESHOLD);
    assert.equal(empty.config.gates.loop.enabled, true);
});

test('R-02-001 门配置解析为结构化对象（三布尔 + 循环门阈值 + failureMode 三值）', () => {
    const result = resolveAdvisorFlowConfig({
        gates: {
            plan: { enabled: true },
            failure: { enabled: true },
            loop: { enabled: true, threshold: 5 },
            completion: { enabled: false },
        },
        failureMode: 'block-session',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.config.gates.plan, { enabled: true });
    assert.deepEqual(result.config.gates.failure, { enabled: true });
    assert.deepEqual(result.config.gates.loop, { enabled: true, threshold: 5 });
    assert.deepEqual(result.config.gates.completion, { enabled: false });
    assert.equal(result.config.failureMode, 'block-session');

    // 三值阻断模式逐一可解析
    for (const mode of FAILURE_MODES) {
        const resolved = resolveAdvisorFlowConfig({ failureMode: mode });
        assert.equal(resolved.ok, true);
        assert.equal(resolved.config.failureMode, mode);
    }

    // R-02-007：presentation 两值逐一可解析
    for (const mode of PRESENTATION_MODES) {
        const resolved = resolveAdvisorFlowConfig({ presentation: mode });
        assert.equal(resolved.ok, true);
        assert.equal(resolved.config.presentation, mode);
    }
});

test('R-02-001/AC-04 默认值：failureMode=block-tool（偏离 pi 0.8.2 记 C-017）、三门与循环门默认开启、脱敏默认关闭、repoContext 摘要档、阈值 3、豁免清单双语预置（C-023）', () => {
    const resolved = resolveAdvisorFlowConfig({});
    assert.equal(resolved.ok, true);
    assert.equal(resolved.config.failureMode, 'block-tool');
    assert.equal(resolved.config.gates.plan.enabled, true);
    assert.equal(resolved.config.gates.failure.enabled, true);
    assert.equal(resolved.config.gates.completion.enabled, true);
    assert.equal(resolved.config.gates.loop.enabled, true);
    assert.equal(resolved.config.gates.loop.threshold, 3);
    assert.equal(resolved.config.privacy.redactSecrets, false);
    assert.equal(resolved.config.privacy.repoContext, 'summary');
    assert.deepEqual(resolved.config.turnReviewExemptPatterns, DEFAULT_TURN_REVIEW_EXEMPT_PATTERNS); // T-023：豁免清单缺省为双语预置
});

test('R-02-001/AC-05 循环门阈值下界：小于 2 的配置被拒绝', () => {
    const low = resolveAdvisorFlowConfig({ gates: { loop: { threshold: 1 } } });
    assert.equal(low.ok, false);
});


test('R-01-009/AC-01 mode 非法值拒绝且原因可查；合法值透传（C-021）', () => {
    const bad = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm' }, mode: 'aggressive' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /mode 必须为 soft\|hard 之一/);
    for (const value of ['soft', 'hard']) {
        const ok = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm' }, mode: value });
        assert.equal(ok.ok, true);
        assert.equal(ok.config.mode, value);
    }
});

test('R-01-009/AC-02 mode 缺省 soft（开箱温和，pi 行为；C-032 废弃 C-022 缺省 hard）', () => {
    const result = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm' } });
    assert.equal(result.ok, true);
    assert.equal(result.config.mode, 'soft'); // 与 DEFAULT_INTERVENTION_MODE 一致（解析层单点缺省）
});

test('R-01-010/AC-07 secondaryAdvisor 半配、同路由、非法值与非对象形态拒绝且原因可诊断；合法配置字段齐备解析', () => {
    // 半配：仅 provider / 仅 model 均拒绝
    const halfProvider = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm' }, secondaryAdvisor: { provider: 'p2' } });
    assert.equal(halfProvider.ok, false);
    assert.match(halfProvider.error, /secondaryAdvisor/);
    const halfModel = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm' }, secondaryAdvisor: { model: 'm2' } });
    assert.equal(halfModel.ok, false);
    assert.match(halfModel.error, /secondaryAdvisor/);
    // 与主顾问同 provider/model 路由拒绝
    const sameRoute = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm' }, secondaryAdvisor: { provider: 'p', model: 'm' } });
    assert.equal(sameRoute.ok, false);
    assert.match(sameRoute.error, /secondaryAdvisor/);
    // 同 provider 不同 model 合法（路由按 provider+model 对判定）
    const sameProviderOtherModel = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm' }, secondaryAdvisor: { provider: 'p', model: 'm2' } });
    assert.equal(sameProviderOtherModel.ok, true);
    // 非法字段值拒绝（复用主顾问字段表）
    const invalidTimeout = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm' }, secondaryAdvisor: { provider: 'p2', model: 'm2', callTimeoutMs: 0 } });
    assert.equal(invalidTimeout.ok, false);
    assert.match(invalidTimeout.error, /secondaryAdvisor\.callTimeoutMs/);
    const invalidMaxTokens = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm' }, secondaryAdvisor: { provider: 'p2', model: 'm2', maxTokens: -1 } });
    assert.equal(invalidMaxTokens.ok, false);
    assert.match(invalidMaxTokens.error, /secondaryAdvisor\.maxTokens/);
    // 非对象形态拒绝
    const notObject = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm' }, secondaryAdvisor: 'p2/m2' });
    assert.equal(notObject.ok, false);
    assert.match(notObject.error, /secondaryAdvisor/);

    // 合法配置：字段齐备、effort/maxTokens/callTimeoutMs 独立解析
    const valid = resolveAdvisorFlowConfig({
        advisor: { provider: 'p', model: 'm', reasoningEffort: 'low' },
        secondaryAdvisor: { provider: 'p2', model: 'm2', reasoningEffort: 'high', maxTokens: 4096, callTimeoutMs: 30000 },
    });
    assert.equal(valid.ok, true);
    assert.equal(valid.config.secondaryAdvisor.provider, 'p2');
    assert.equal(valid.config.secondaryAdvisor.model, 'm2');
    assert.equal(valid.config.secondaryAdvisor.reasoningEffort, 'high');
    assert.equal(valid.config.secondaryAdvisor.maxTokens, 4096);
    assert.equal(valid.config.secondaryAdvisor.callTimeoutMs, 30000);
    // callTimeoutMs 缺省填默认（独立 deadline 缺省同主顾问口径）
    const defaulted = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm' }, secondaryAdvisor: { provider: 'p2', model: 'm2' } });
    assert.equal(defaulted.ok, true);
    assert.equal(defaulted.config.secondaryAdvisor.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS);
    // 未知子键警告保留透传（与主顾问段同语义）
    const stray = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm' }, secondaryAdvisor: { provider: 'p2', model: 'm2', strayKey: 1 } });
    assert.equal(stray.ok, true);
    assert.ok(stray.warnings.includes('secondaryAdvisor.strayKey'));
    assert.equal(stray.config.secondaryAdvisor.strayKey, 1);
});

test('R-01-010/AC-01 未配置副顾问（含双空段）时旧单顾问配置、派生启用与返回行为不变', () => {
    const legacy = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm' } });
    assert.equal(legacy.ok, true);
    assert.equal(legacy.config.secondaryAdvisor, undefined); // 缺省不启用双发
    assert.equal(legacy.config.enabled, true); // primary 派生启用规则不变
    // 设置卡「留空整段」语义：provider/model 均空（null）= 未配置副顾问
    const emptySecondary = resolveAdvisorFlowConfig({ advisor: { provider: 'p', model: 'm' }, secondaryAdvisor: { provider: null, model: null } });
    assert.equal(emptySecondary.ok, true);
    assert.equal(emptySecondary.config.secondaryAdvisor, undefined);
    assert.equal(emptySecondary.config.enabled, true);
    // 主顾问缺失时派生禁用不变——即使副顾问路由齐备也不反向启用
    const missingPrimary = resolveAdvisorFlowConfig({ secondaryAdvisor: { provider: 'p2', model: 'm2' } });
    assert.equal(missingPrimary.ok, true);
    assert.equal(missingPrimary.config.enabled, false);
    assert.equal(missingPrimary.config.reason, 'missing-advisor-model');
});

test('R-02-001/AC-04 T-023 turnReviewExemptPatterns 解析：默认双语预置（C-023）、显式覆盖、空数组关闭、非法拒绝', () => {
    const base = { advisor: { provider: 'p', model: 'm' } };
    const def = resolveAdvisorFlowConfig(base);
    assert.equal(def.ok, true);
    assert.deepEqual(def.config.turnReviewExemptPatterns, DEFAULT_TURN_REVIEW_EXEMPT_PATTERNS);
    assert.ok(def.config.turnReviewExemptPatterns.includes('review')); // 英文词
    assert.ok(def.config.turnReviewExemptPatterns.includes('审核')); // 中文词
    assert.ok(def.config.turnReviewExemptPatterns.includes('复审')); // T-033 增补词
    // 显式覆盖生效
    const override = resolveAdvisorFlowConfig({ ...base, turnReviewExemptPatterns: ['audit'] });
    assert.deepEqual(override.config.turnReviewExemptPatterns, ['audit']);
    // 空数组合法 = 豁免关闭
    const empty = resolveAdvisorFlowConfig({ ...base, turnReviewExemptPatterns: [] });
    assert.deepEqual(empty.config.turnReviewExemptPatterns, []);
    // 非法值：含空串的数组 / 非数组类型均拒绝且原因可查
    const badItem = resolveAdvisorFlowConfig({ ...base, turnReviewExemptPatterns: ['ok', ''] });
    assert.equal(badItem.ok, false);
    assert.match(badItem.error, /turnReviewExemptPatterns/);
    const badType = resolveAdvisorFlowConfig({ ...base, turnReviewExemptPatterns: 'review' });
    assert.equal(badType.ok, false);
    assert.match(badType.error, /turnReviewExemptPatterns/);
});
