import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnReview, TURN_REVIEW_QUESTION } from '../lib/turn-review.js';
import { createAdviceDelivery, GUIDELINE_REMINDER_TEXT } from '../lib/delivery.js';
import { DEFAULT_TURN_REVIEW_EXEMPT_PATTERNS } from '../lib/config.js';

/**
 * 收口评审（R-01-009；C-021）行为面：
 * - `agent/turn-stopping` 缝载体 `{turn, signal, agent}`（T-008 实测形状）；
 *   会话标识经 `sessionOf(payload)` 取 `payload.agent.id`。
 * - 硬模式（enabled && mode==='hard'）同步评审一次；proceed 放行收口（不
 *   steer），revise/blocked 意见全文 steer 送达（执行者带意见续跑）。
 * - 同回合同一收口事件至多一次评审（已评审 turn 的后续派发放行）。
 * - fail-open：评审失败（consult 抛错/空意见/预算耗尽）一律放行收口。
 * - 软模式永不触发。
 */

const payload = (turn, sessionId = 's1') => ({ turn, signal: undefined, agent: { id: sessionId } });

/** 收口评审夹具：可编程裁决与咨询行为 + 送达/日志捕获。 */
function makeReview({ mode = 'hard', enabled = true, outcomes = [], consultImpl, budgetExhausted, sessionEnabled, isAdvisorSubsession, getEvents, config } = {}) {
    const logs = { error: [], info: [], warn: [] };
    const logger = {
        error: (message, fields) => logs.error.push({ message, fields }),
        info: (message, fields) => logs.info.push({ message, fields }),
        warn: (message, fields) => logs.warn.push({ message, fields }),
    };
    const consultCalls = [];
    let index = 0;
    const consult = async (request) => {
        consultCalls.push(request);
        if (consultImpl) {
            return consultImpl(request, consultCalls.length);
        }
        const next = outcomes[index++];
        if (next instanceof Error) {
            throw next;
        }
        return next ?? { ok: true, adviceId: `adv-${index}`, decision: 'proceed', markdown: '本轮行为可收口。' };
    };
    const delivered = [];
    const review = createTurnReview({
        consult,
        delivery: (sessionId, text) => delivered.push({ sessionId, text }),
        getConfig: () => (config ?? { enabled, mode }),
        budgetExhausted,
        sessionEnabled,
        isAdvisorSubsession,
        getEvents,
        logger,
    });
    return { review, consultCalls, delivered, logs };
}

test('R-01-009/AC-05 硬模式收口触发同步评审：entry turn-review、问句聚焦本轮行为（英文模型面）', async () => {
    const { review, consultCalls } = makeReview({});
    await review.handleTurnStopping(payload('turn-1'));
    assert.equal(consultCalls.length, 1);
    assert.equal(consultCalls[0].entry, 'turn-review');
    assert.equal(consultCalls[0].session, 's1');
    assert.match(consultCalls[0].question, /end this turn/);
    assert.ok(consultCalls[0].question.includes('Decision: proceed'));
    assert.equal(TURN_REVIEW_QUESTION, consultCalls[0].question);
});

test('R-01-009/AC-06 proceed 放行收口：不 steer（意见仅日志留痕）', async () => {
    const { review, delivered, logs } = makeReview({
        outcomes: [{ ok: true, adviceId: 'adv-1', decision: 'proceed', markdown: '本轮行为可收口。' }],
    });
    await review.handleTurnStopping(payload('turn-1'));
    assert.equal(delivered.length, 0); // proceed：不 steer（无预通告、无意见）
    assert.ok(logs.info.some((row) => row.message.includes('proceed — stop allowed')));
});

test('R-01-009/AC-06 revise/blocked 意见全文 steer 送达（执行者带意见续跑）', async () => {
    for (const decision of ['revise', 'blocked']) {
        const { review, delivered } = makeReview({
            outcomes: [{ ok: true, adviceId: `adv-${decision}`, decision, markdown: `本轮有${decision}级问题，请先修订。` }],
        });
        await review.handleTurnStopping(payload(`turn-${decision}`));
        assert.ok(delivered.some((row) => row.text.startsWith('**Decision: ') && row.text.includes(`本轮有${decision}级问题`)),
            `${decision} 意见全文应送达`);
    }
});

test('R-01-009/AC-07 同回合同一收口事件去重：已评审 turn 的后续派发放行且不重复评审', async () => {
    const { review, consultCalls } = makeReview({});
    await review.handleTurnStopping(payload('turn-1'));
    await review.handleTurnStopping(payload('turn-1'));
    assert.equal(consultCalls.length, 1); // 第二次派发不再评审
    await review.handleTurnStopping(payload('turn-2'));
    assert.equal(consultCalls.length, 2); // 新 turn 正常评审
});

test('R-01-009/AC-08 fail-open：consult 抛错/空意见/决策行缺失一律放行收口', async () => {
    const { review, consultCalls, delivered, logs } = makeReview({
        consultImpl: (request, call) => {
            if (call === 1) {
                throw new Error('provider down');
            }
            if (call === 2) {
                return { ok: true, adviceId: 'adv-empty', decision: undefined, text: '' };
            }
            return { ok: false, code: 'ADVISOR_GATE_INVALID', reason: 'missing decision line' };
        },
    });
    await review.handleTurnStopping(payload('turn-1'));
    await review.handleTurnStopping(payload('turn-2'));
    await review.handleTurnStopping(payload('turn-3'));
    assert.equal(consultCalls.length, 3);
    assert.ok(!delivered.some((row) => row.text.includes('**Decision:')), '失败路径不得送达意见');
    // 留痕分级：consult 抛错 = error 级兜底；评审收敛但无有效裁决 = info 级。
    assert.equal(logs.error.filter((row) => row.message.includes('fail-open allow stop')).length, 1);
    assert.equal(logs.info.filter((row) => row.message.includes('fail-open allow stop')).length, 2);
});

test('R-01-009/AC-08 预算耗尽 fail-open：不发起评审直接放行收口', async () => {
    const { review, consultCalls, logs } = makeReview({ budgetExhausted: () => true });
    await review.handleTurnStopping(payload('turn-1'));
    assert.equal(consultCalls.length, 0);
    assert.ok(logs.info.some((row) => row.message.includes('budget exhausted')));
});

test('R-01-009/AC-03 软模式永不触发：不评审不送达', async () => {
    const { review, consultCalls, delivered } = makeReview({ mode: 'soft' });
    await review.handleTurnStopping(payload('turn-1'));
    assert.equal(consultCalls.length, 0);
    assert.equal(delivered.length, 0);
});

test('R-01-009/AC-03 处置器对缺 mode 键的兜底：非 hard 即不评审（解析层缺省为准）', async () => {
    const logs = { error: [], info: [], warn: [] };
    const logger = { error: (m, f) => logs.error.push({ m, f }), info: (m, f) => logs.info.push({ m, f }), warn: (m, f) => logs.warn.push({ m, f }) };
    const consultCalls = [];
    const review = createTurnReview({
        consult: async (request) => { consultCalls.push(request); return { ok: true, adviceId: 'adv-1', decision: 'proceed', markdown: 'ok' }; },
        delivery: () => {},
        getConfig: () => ({ enabled: true }), // 无 mode 键：处置器按非 hard fail-safe 兜底（解析层缺省以 config.js 为准）
        logger,
    });
    await review.handleTurnStopping(payload('turn-1'));
    assert.equal(consultCalls.length, 0);
});

test('R-01-009/AC-01 整体禁用（enabled=false）时硬模式也不触发', async () => {
    const { review, consultCalls, delivered } = makeReview({ enabled: false, mode: 'hard' });
    await review.handleTurnStopping(payload('turn-1'));
    assert.equal(consultCalls.length, 0);
    assert.equal(delivered.length, 0);
});

test('R-01-009/AC-04 软模式压缩提醒：压缩/重写后经 steer 送达一条守则提醒（非阻断）', () => {
    const lookup = new Map([['s1', { id: 's1', steer: (message) => steered.push(message) }]]);
    const steered = [];
    const delivery = createAdviceDelivery({ lookupAgent: (id) => lookup.get(id) });
    delivery.registerAgent({ id: 's1', steer: (message) => steered.push(message) });
    const sent = delivery.steerReminder('s1');
    assert.equal(sent, true);
    assert.equal(steered.length, 1);
    assert.equal(steered[0].role, 'user');
    assert.match(steered[0].content[0].text, /compacted/);
    assert.match(steered[0].content[0].text, /before committing to a materially consequential plan/);
    assert.equal(GUIDELINE_REMINDER_TEXT, steered[0].content[0].text);
});

test('R-01-009/AC-09 mode 变更即时生效：getConfig 读时求值驱动处置分叉', async () => {
    let mode = 'soft';
    const logs = { error: [], info: [], warn: [] };
    const logger = { error: (m, f) => logs.error.push({ m, f }), info: (m, f) => logs.info.push({ m, f }), warn: (m, f) => logs.warn.push({ m, f }) };
    const consultCalls = [];
    const review = createTurnReview({
        consult: async (request) => { consultCalls.push(request); return { ok: true, adviceId: 'adv-1', decision: 'proceed', markdown: 'ok' }; },
        delivery: () => {},
        getConfig: () => ({ enabled: true, mode }), // 读时求值：处置器每次判活配置
        logger,
    });
    await review.handleTurnStopping(payload('turn-1'));
    assert.equal(consultCalls.length, 0); // soft：不评审
    mode = 'hard';
    await review.handleTurnStopping(payload('turn-2'));
    assert.equal(consultCalls.length, 1); // hard：评审生效，无需重订阅
});

test('R-01-009/AC-03 会话级停用短路：/advisor off 时收口评审跳过并留痕', async () => {
    const { review, consultCalls, delivered, logs } = makeReview({ sessionEnabled: () => false });
    await review.handleTurnStopping(payload('turn-1'));
    assert.equal(consultCalls.length, 0);
    assert.equal(delivered.length, 0);
    assert.ok(logs.info.some((row) => row.message.includes('session advisor off')));
});

test('T-022 顾问子会话豁免：呈现登记会话的收口不评审且留痕（阻断评审—呈现—再收口递归）', async () => {
    // 判定源：呈现缝登记表（接线注入）；命中 'sub-1' 的会话收口直接放行。
    const { review, consultCalls, delivered, logs } = makeReview({ isAdvisorSubsession: (id) => id === 'sub-1' });
    await review.handleTurnStopping(payload('turn-1', 'sub-1'));
    assert.equal(consultCalls.length, 0); // 豁免：不发起评审
    assert.equal(delivered.length, 0);
    assert.ok(logs.info.some((row) => row.message.includes('advisor subsession')));
    // 未登记会话照常评审：豁免面收敛于呈现登记，不外溢到执行者与工作子代理。
    await review.handleTurnStopping(payload('turn-1', 's1'));
    assert.equal(consultCalls.length, 1);
    assert.equal(consultCalls[0].session, 's1');
});

test('R-01-009/AC-08 模型白名单不满足时跳过并留痕（skipped 计数与预算路径对称）', async () => {
    const { review, consultCalls, logs } = makeReview({
        outcomes: [],
        consultImpl: (request) => ({ ok: true, adviceId: 'adv-1', decision: 'proceed', markdown: 'ok', request }),
    });
    // 白名单前置：顾问模型不在白名单内 → 不评审（advisorModelAllowed 共享谓词）。
    const reviewNotAllowed = createTurnReview({
        consult: async (request) => { consultCalls.push(request); return { ok: true, adviceId: 'adv-2', decision: 'proceed', markdown: 'ok' }; },
        delivery: () => {},
        getConfig: () => ({ enabled: true, mode: 'hard', modelWhitelist: ['allowed-model'], advisor: { provider: 'p', model: 'other-model' } }),
        logger: { error() {}, info: (m, f) => logs.info.push({ message: m, fields: f }), warn() {} },
    });
    await reviewNotAllowed.handleTurnStopping(payload('turn-1'));
    assert.ok(!consultCalls.some((row) => row.entry === 'turn-review' && row.session === 's1'));
    assert.ok(logs.info.some((row) => (row.message ?? '').includes('advisor model not allowed')));
});

test('R-01-009/AC-04 提醒送达失败 contained：无 agent 时返回 false 不掷出', () => {
    const delivery = createAdviceDelivery({ lookupAgent: () => undefined });
    assert.equal(delivery.steerReminder('missing'), false);
});

/** T-023 子会话事件流夹具（实测形状：header origin 顶层、inbox splice、descriptor）。 */
function subsessionLog({ header = { type: 'session', seq: 0, id: 'sub-1', origin: 'subagent' }, label = 'Standards review of T-032', prompt = 'Review the changes since main.' } = {}) {
    const events = [];
    if (header) {
        events.push(header);
    }
    if (prompt !== undefined) {
        events.push({ type: 'agent/inbox/spliced', seq: 3, data: { target: 'next-turn', inserted: [{ content: [{ type: 'text', text: prompt }] }] } });
    }
    if (label !== undefined) {
        events.push({ type: 'subagent/descriptor', seq: 6, data: { mode: 'one-shot', label } });
    }
    return events;
}

/** T-023 豁免判定夹具：config 携带默认豁免清单。 */
const exemptConfig = (extra = {}) => ({ enabled: true, mode: 'hard', turnReviewExemptPatterns: DEFAULT_TURN_REVIEW_EXEMPT_PATTERNS, ...extra });

test('T-023 审核类子会话豁免：自证 + label 或首条提示词命中即跳过并留痕（R-01-009/AC-11）', async () => {
    // 创建标签命中（prompt 不含关键词）
    const byLabel = makeReview({
        config: exemptConfig(),
        getEvents: async () => subsessionLog({ label: 'Standards review of T-032', prompt: '请独立完成差异核对并汇报。' }),
    });
    await byLabel.review.handleTurnStopping(payload('turn-1', 'sub-1'));
    assert.equal(byLabel.consultCalls.length, 0);
    assert.ok(byLabel.logs.info.some((row) => row.message.includes('exempt patterns')));
    // 首条提示词命中（label 不含关键词）
    const byPrompt = makeReview({
        config: exemptConfig(),
        getEvents: async () => subsessionLog({ label: '数据整理', prompt: 'Please REVIEW the diff before reporting.' }),
    });
    await byPrompt.review.handleTurnStopping(payload('turn-1', 'sub-2'));
    assert.equal(byPrompt.consultCalls.length, 0); // 大小写不敏感命中
    // 双源不命中：执行类子会话照常评审
    const worker = makeReview({
        config: exemptConfig(),
        getEvents: async () => subsessionLog({ label: '数据整理', prompt: '搜索仓库中的相关实现并汇报结论。' }),
    });
    await worker.review.handleTurnStopping(payload('turn-1', 'sub-3'));
    assert.equal(worker.consultCalls.length, 1);
});

test('T-023 主会话不豁免：header 无 subagent origin（根会话与 fork 形态）时 prompt 命中仍照常评审（R-01-009/AC-11 自证前置）', async () => {
    // 根会话：无 header origin 字段（undefined），prompt 含 review
    const root = makeReview({
        config: exemptConfig(),
        getEvents: async () => subsessionLog({ header: { type: 'session', seq: 0, id: 'root-1' }, label: undefined, prompt: 'review this repo for issues' }),
    });
    await root.review.handleTurnStopping(payload('turn-1', 'root-1'));
    assert.equal(root.consultCalls.length, 1); // 主会话是评审对象本位：照常评审
    // fork 形态：isSeeded 但无 origin 字段
    const fork = makeReview({
        config: exemptConfig(),
        getEvents: async () => subsessionLog({ header: { type: 'session', seq: 0, id: 'f-1', isSeeded: true }, label: 'fork review', prompt: 'review the diff' }),
    });
    await fork.review.handleTurnStopping(payload('turn-1', 'f-1'));
    assert.equal(fork.consultCalls.length, 1); // fork 不是 subagent，照常评审
});

test('T-023 豁免判定 fail-open：读取抛错/缝缺失/空流一律照常评审（R-01-009/AC-12）', async () => {
    const throwing = makeReview({ config: exemptConfig(), getEvents: async () => { throw new Error('seam down'); } });
    await throwing.review.handleTurnStopping(payload('turn-1'));
    assert.equal(throwing.consultCalls.length, 1);
    const noSeam = makeReview({ config: exemptConfig() }); // getEvents 未注入
    await noSeam.review.handleTurnStopping(payload('turn-1'));
    assert.equal(noSeam.consultCalls.length, 1);
    const emptyLog = makeReview({ config: exemptConfig(), getEvents: async () => [] });
    await emptyLog.review.handleTurnStopping(payload('turn-1'));
    assert.equal(emptyLog.consultCalls.length, 1);
});

test('T-023 判定缓存：同会话判定复用零重读，patterns 变更触发重判（读时求值）', async () => {
    let reads = 0;
    const events = subsessionLog({ label: 'Spec 轴审核 T-049' });
    const config = { enabled: true, mode: 'hard', turnReviewExemptPatterns: ['review'] };
    const { review } = makeReview({
        config,
        getEvents: async () => { reads += 1; return events; },
    });
    await review.handleTurnStopping(payload('turn-1', 'sub-9'));
    assert.equal(reads, 1); // 首次判定读取
    await review.handleTurnStopping(payload('turn-2', 'sub-9'));
    assert.equal(reads, 1); // 同会话缓存复用
    config.turnReviewExemptPatterns = ['cleanup']; // 清单变更 → 缓存签名失配 → 重判
    await review.handleTurnStopping(payload('turn-3', 'sub-9'));
    assert.equal(reads, 2);
    assert.equal(review.decisionStats().skipped, 2); // 两次收口均命中 '审核'（重判后仍豁免）
});

test('T-023 豁免清单为空时豁免关闭：零日志读取直接照常评审', async () => {
    let reads = 0;
    const { review, consultCalls } = makeReview({
        config: { enabled: true, mode: 'hard', turnReviewExemptPatterns: [] },
        getEvents: async () => { reads += 1; return subsessionLog({}); },
    });
    await review.handleTurnStopping(payload('turn-1'));
    assert.equal(consultCalls.length, 1);
    assert.equal(reads, 0); // 空清单短路：不读日志
});
