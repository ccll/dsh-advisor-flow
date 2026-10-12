import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createToolFaceGuard,
    TOOL_FACE_CLOSED_CODE,
    SESSION_EXEMPT_CODE,
    TOOL_FACE_CLOSED_REASON,
    SESSION_EXEMPT_REASON,
} from '../lib/tool-guard.js';
import { createReviewerClassifier } from '../lib/reviewer-classifier.js';
import { reviewerSubsessionEvents } from './helpers.js';

/**
 * 咨询工具面守卫（T-026；R-01-001/AC-09、AC-10；C-025）：
 * - soft 模式拒绝审核类子会话（共享分类器阳性）与已登记顾问子会话（呈现
 *   登记表命中——防线纵深，toolFilter 失效时阻断自我再入）。
 * - hard 模式拒绝一切会话的工具调用（收口评审是唯一自动 advisor）。
 * - fail-open：未启用放行（沿用引擎路径）、守卫抛错放行；仅阳性判定拒绝。
 * - 时序缝：判定前先应用文件配置——盘上 mode 切换后的首次调用按新档位。
 * - 拒绝 reason 明示属预期、勿重试、替代路径；拒绝计数按 code 累计。
 */

const quietLogger = { info() {}, warn() {}, error() {} };

/** 判定日志捕获夹具。 */
function makeGuard({ config, applyConfig, classifier, isAdvisorSubsession } = {}) {
    const logs = { info: [] };
    const logger = { info: (message, fields) => logs.info.push({ message, fields }) };
    const guard = createToolFaceGuard({
        getConfig: () => config,
        applyConfig,
        classifier,
        isAdvisorSubsession,
        logger,
    });
    return { guard, logs };
}

const softConfig = (extra = {}) => ({ enabled: true, mode: 'soft', turnReviewExemptPatterns: ['review'], ...extra });

test('R-01-001/AC-09 软模式拒绝审核类子会话：共享分类器阳性即拒（真实分类器 + 实测形状日志）', async () => {
    const classifier = createReviewerClassifier({
        getConfig: () => softConfig(),
        getEvents: async () => reviewerSubsessionEvents(),
        logger: quietLogger,
    });
    const { guard, logs } = makeGuard({ config: softConfig(), classifier });
    const refusal = await guard('review-child');
    assert.equal(refusal.code, SESSION_EXEMPT_CODE);
    assert.equal(refusal.reason, SESSION_EXEMPT_REASON);
    // reason 三点：属预期 / 勿重试 / 替代路径（模型面英文）。
    assert.ok(refusal.reason.includes('This refusal is expected'));
    assert.ok(refusal.reason.includes('do not retry ask_advisor'));
    assert.ok(refusal.reason.includes('advisor consultation remains available to the main session'));
    assert.ok(logs.info.some((row) => row.message.includes('ask_advisor refused — SESSION_EXEMPT')));
});

test('R-01-001/AC-09 软模式拒绝已登记顾问子会话（呈现登记表命中，防线纵深）', async () => {
    const { guard } = makeGuard({
        config: softConfig(),
        isAdvisorSubsession: (sessionId) => sessionId === 'advisor-child-1',
    });
    const refusal = await guard('advisor-child-1');
    assert.equal(refusal.code, SESSION_EXEMPT_CODE);
    // 登记命中优先于分类器：分类器缺失（未注入）仍拒绝。
    assert.ok(await guard('other-session') === undefined);
});

test('R-01-001/AC-09 软模式放行主会话与执行类子会话（判定面收敛，不外溢）', async () => {
    const classifier = createReviewerClassifier({
        getConfig: () => softConfig(),
        getEvents: async () => reviewerSubsessionEvents({ header: { type: 'session', seq: 0, id: 'main-1' }, label: '数据整理', prompt: '搜索实现并汇报。' }),
        logger: quietLogger,
    });
    const { guard } = makeGuard({ config: softConfig(), classifier });
    assert.equal(await guard('main-1'), undefined); // 主会话：自证前置不成立
    assert.equal(await guard('worker-1'), undefined); // 子会话但双源不命中
});

test('R-01-001/AC-10 硬模式拒绝一切会话：主会话、子会话与未分类会话同拒', async () => {
    const { guard } = makeGuard({
        config: { enabled: true, mode: 'hard', turnReviewExemptPatterns: ['review'] },
        isAdvisorSubsession: () => false,
        classifier: { isReviewerSubsession: async () => false },
    });
    for (const sessionId of ['main-1', 'sub-1', undefined]) {
        const refusal = await guard(sessionId);
        assert.equal(refusal.code, TOOL_FACE_CLOSED_CODE);
        assert.equal(refusal.reason, TOOL_FACE_CLOSED_REASON);
        assert.ok(refusal.reason.includes('This refusal is expected'));
        assert.ok(refusal.reason.includes('do not retry ask_advisor'));
        assert.ok(refusal.reason.includes('turn review'));
    }
});

test('R-01-001/AC-10 未启用（enabled=false）放行：沿用引擎禁用路径，不加新拒绝', async () => {
    const { guard } = makeGuard({
        config: { enabled: false, mode: 'hard' },
        classifier: { isReviewerSubsession: async () => true },
    });
    assert.equal(await guard('main-1'), undefined);
});

test('R-01-001/AC-10 mode 未定义归一缺省（hard）：不构成 fail-open 旁路（C-025）', async () => {
    const cfg = { enabled: true, turnReviewExemptPatterns: ['review'] }; // 无 mode 键
    const { guard } = makeGuard({ config: cfg, classifier: { isReviewerSubsession: async () => false } });
    const refusal = await guard('main-1');
    assert.equal(refusal.code, TOOL_FACE_CLOSED_CODE); // 归一 hard：拒绝而非放行
});

test('R-01-001/AC-10 时序缝：盘上 mode 切换后首次调用按新档位判定（applyConfig 先于判定）', async () => {
    // 复刻接线时序：config getter 读活变量；applyConfig 模拟 applyFromSource
    // 从盘上刷新该变量。守卫若未先刷新，首次调用将按旧 mode 放行。
    let live = { enabled: true, mode: 'soft' };
    const disk = { enabled: true, mode: 'hard' };
    const guard = createToolFaceGuard({
        getConfig: () => live,
        applyConfig: () => { live = disk; }, // applyFromSource 同型：读盘刷新活配置
        classifier: { isReviewerSubsession: async () => false },
        logger: quietLogger,
    });
    const refusal = await guard('main-1');
    assert.equal(refusal.code, TOOL_FACE_CLOSED_CODE); // 首次调用即按 hard 拒绝
});

test('守卫组件失败 fail-open：分类器抛错与 applyConfig 抛错一律放行并留痕', async () => {
    const { guard, logs } = makeGuard({
        config: softConfig(),
        classifier: { isReviewerSubsession: async () => { throw new Error('classifier down'); } },
    });
    assert.equal(await guard('sub-1'), undefined);
    assert.ok(logs.info.some((row) => row.message.includes('guard failed — fail-open')));
    const applying = createToolFaceGuard({
        getConfig: () => { throw new Error('config boom'); },
        logger: quietLogger,
    });
    assert.equal(await applying('sub-1'), undefined);
});

test('R-01-001/AC-09 拒绝计数按 code 累计且快照访问器可用', async () => {
    const { guard } = makeGuard({
        config: softConfig(),
        isAdvisorSubsession: (sessionId) => sessionId === 'advisor-child-1',
    });
    await guard('advisor-child-1'); // SESSION_EXEMPT
    await guard('advisor-child-1'); // SESSION_EXEMPT
    const hardGuard = createToolFaceGuard({ getConfig: () => ({ enabled: true, mode: 'hard' }), logger: quietLogger });
    await hardGuard('main-1'); // TOOL_FACE_CLOSED
    const stats = hardGuard.decisionStats();
    assert.equal(stats.refused, 1);
    assert.deepEqual(stats.byCode, { TOOL_FACE_CLOSED: 1 });
    const softStats = guard.decisionStats();
    assert.equal(softStats.refused, 2);
    assert.deepEqual(softStats.byCode, { SESSION_EXEMPT: 2 });
});
