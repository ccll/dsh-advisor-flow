/**
 * Turn review (R-01-009; C-021) — the hard-mode pre-stop consultation at the
 * `agent/turn-stopping` seam.
 *
 * 语义（SOLUTION.md#运行时并发与失败语义）：
 * - 触发前置：`enabled === true` 且 `mode === 'hard'` 且顾问模型可用；
 *   软模式永不触发（守则是唯一的建议面）。
 * - 顾问子会话豁免（T-022）：本插件子会话呈现发出的会话不是执行者
 *   （R-01-009/AC-05 评审对象是执行者回合收口），其收口不评审。
 *   语义与动机见 SOLUTION.md#运行时、并发与失败语义「顾问子会话豁免」。
 * - 审核类子会话豁免（T-023；C-023）：会话日志自证为子会话（header
 *   `origin === 'subagent'`）且创建标签或首条提示词命中豁免清单时，其收口
 *   不评审（R-01-009/AC-11——审核者是质量闸门，元评审冗余）；判定失败
 *   fail-open 照常评审（AC-12）；成功判定按会话缓存（失败不缓存，次轮
 *   重判）、随会话清理摘除。
 * - 同步评审（Decision 协议三值）：proceed → 放行收口（意见仅日志留痕）；
 *   revise/blocked → 意见全文经 steer 送达，执行者带意见续跑（steer 即反对
 *   收口——这是收口缝唯一的强制手段，failureMode 不适用于该缝）。
 * - 同一回合同一收口事件至多一次评审：已评审 turn 的后续派发直接放行，
 *   防评审—续跑—再评审循环。
 * - fail-open：评审失败（超时/空意见/预算耗尽/呈现失败/内部异常）一律放行
 *   收口并留痕——非阻断不变量优先于功能完整。
 *
 * @module dsh-advisor-flow/turn-review
 */

import { HARD_INTERVENTION_MODE } from './config.js';
import { isRecord, sessionOf, advisorModelAllowed } from './util.js';
import { adviceForGateText } from './decision.js';
import { textFrom } from './conversation-source.js';

/** 收口评审问句（模型面文案英文，对齐 C-008/C-009 口径；聚焦本轮行为）。 */
export const TURN_REVIEW_QUESTION =
    'Advisor turn review: the Executor is about to end this turn. Review the Executor\'s actions in this turn and decide whether it may stop here. Answer in concise Markdown. Your first non-empty line must be exactly `Decision: proceed`, `Decision: revise`, or `Decision: blocked`. `proceed` = the turn may end; `revise` or `blocked` = the Executor should continue with your advice.';

/**
 * 子会话审核豁免判定（纯函数，T-023）：自证（header `origin === 'subagent'`）
 * 且豁免清单命中创建标签（`subagent/descriptor` 的 `data.label`）或首条
 * `agent/inbox/spliced` 提示词。匹配为大小写不敏感的子串包含（标签与
 * 提示词各自独立匹配，等价 OR，不跨源拼接——避免跨界拼出清单词）。
 * 空清单或缺事件流一律 false（豁免关闭与 fail-open 同向）。
 *
 * @param {object[]|undefined} events 会话有序事件流（sessionQuery 租约产物）
 * @param {string[]} patterns 豁免模式清单（非空字符串数组）
 * @returns {boolean}
 */
export function subsessionExemptFrom(events, patterns) {
    if (!Array.isArray(events) || !Array.isArray(patterns) || patterns.length === 0) {
        return false;
    }
    const header = events.find((event) => event?.type === 'session');
    if (header?.origin !== 'subagent') {
        return false; // 自证前置：主会话与 fork 会话（无 origin 字段）不是子会话
    }
    const descriptor = events.find((event) => event?.type === 'subagent/descriptor');
    const label = typeof descriptor?.data?.label === 'string' ? descriptor.data.label : '';
    let prompt = '';
    for (const event of events) {
        if (event?.type !== 'agent/inbox/spliced') {
            continue;
        }
        const inserted = Array.isArray(event?.data?.inserted) ? event.data.inserted : [];
        const text = inserted
            .map((message) => textFrom(message?.content))
            .filter((part) => part.length > 0)
            .join('\n');
        if (text.trim().length > 0) {
            prompt = text; // 首条非空提示词（实测子会话日志无 user/message 事件）
            break;
        }
    }
    const labelHay = label.toLowerCase();
    const promptHay = prompt.toLowerCase();
    return patterns.some((pattern) => {
        if (typeof pattern !== 'string' || pattern.length === 0) {
            return false;
        }
        const needle = pattern.toLowerCase();
        return labelHay.includes(needle) || promptHay.includes(needle);
    });
}

/**
 * Create the turn-review handler.
 *
 * @param {object} options
 * @param {(request: object) => Promise<object>} options.consult the
 *   consultation entry（`entry: 'turn-review'`，Decision 协议；never rejects）
 * @param {(sessionId: string, text: string) => unknown} [options.delivery]
 *   the steer seam（意见全文送达；失败 contained）
 * @param {() => object} [options.getConfig] live runtime config
 * @param {(sessionId: string) => boolean} [options.budgetExhausted]
 *   per-session budget exhaustion accessor（耗尽即 fail-open 放行收口）
 * @param {(sessionId: string) => boolean} [options.sessionEnabled]
 *   per-session override accessor（`/advisor off` 时短路不评审，与守则
 *   送达同口径）
 * @param {(sessionId: string) => boolean} [options.isAdvisorSubsession]
 *   advisor-subsession registry accessor（T-022 递归守卫：命中即豁免——
 *   顾问子会话不是执行者，其收口不得再触发收口评审）
 * @param {(sessionId: string) => Promise<object[]|undefined>} [options.getEvents]
 *   会话事件流读取缝（T-023 审核类子会话豁免判定源；未注入时判定恒 false
 *   ——豁免面收敛，fail-open 同型）
 * @param {{ info?, warn?, error? }} [options.logger]
 * @returns {{ handleTurnStopping: (payload: object) => Promise<undefined>,
 *   decisionStats: () => object, forgetSession: (sessionId: string) => void }}
 */
export function createTurnReview({ consult, delivery, getConfig, budgetExhausted, sessionEnabled, isAdvisorSubsession, getEvents, logger = console } = {}) {
    /** 收口评审计数（R-01-009/AC-10）：触发/裁决/跳过计数。 */
    const stats = { triggers: 0, proceed: 0, revise: 0, blocked: 0, failed: 0, skipped: 0 };
    /** Per-session 已评审 turn 标记（去重）。 */
    const reviewedTurns = new Map();
    /** T-023 豁免判定缓存：sessionId → { patternsKey, verdict }；清单变更失配重判。 */
    const exemptVerdicts = new Map();

    /** 会话清理摘除豁免判定缓存（session/disposed 接线调用）。 */
    function forgetSession(sessionId) {
        exemptVerdicts.delete(sessionId);
    }

    /**
     * 审核类子会话豁免判定（T-023）：清单空直接关闭（零日志读取）；仅
     * 成功读取（events 为数组）所得判定（含 false）按会话缓存——执行者
     * 根会话每回合收口零重读；清单变更失配重判（读时求值）。缝缺失/
     * 读取失败/解析失败（生产缝以 undefined 表达失败，不抛错）与抛错
     * 同型 fail-open 返回 false 且一律不缓存（暂态故障次轮收口重判）。
     */
    async function exemptSubsession(sessionId) {
        const patterns = getConfig?.()?.turnReviewExemptPatterns;
        const list = Array.isArray(patterns) ? patterns : [];
        if (list.length === 0) {
            return false; // 豁免关闭：不读日志（R-01-009/AC-11 清单空语义）
        }
        const patternsKey = list.join('\u0000');
        const cached = exemptVerdicts.get(sessionId);
        if (cached && cached.patternsKey === patternsKey) {
            return cached.verdict;
        }
        try {
            const events = await getEvents?.(sessionId);
            if (!Array.isArray(events)) {
                // 生产缝以 undefined 表达缝缺失/读取失败（不抛错）：与抛错
                // 同型 fail-open 照常评审（R-01-009/AC-12），且不落缓存。
                logger.info?.('advisor-flow: turn review exempt check failed — no events read, fail-open review proceeds', { session: sessionId });
                return false;
            }
            const verdict = subsessionExemptFrom(events, list);
            exemptVerdicts.set(sessionId, { patternsKey, verdict });
            return verdict;
        } catch (error) {
            // 解析/读取抛错：fail-open 照常评审（R-01-009/AC-12），不缓存。
            logger.info?.('advisor-flow: turn review exempt check failed — fail-open review proceeds', { session: sessionId, error: String(error) });
            return false;
        }
    }

    /** 判定该 turn 是否已评审；未评审则落标记。 */
    function markReviewed(sessionId, turn) {
        let set = reviewedTurns.get(sessionId);
        if (!set) {
            set = new Set();
            reviewedTurns.set(sessionId, set);
        }
        const key = typeof turn === 'string' || typeof turn === 'number' ? String(turn) : 'anonymous';
        if (set.has(key)) {
            return true; // 已评审：后续派发放行
        }
        set.add(key);
        return false;
    }

    /**
     * One turn-stopping event: synchronous consultation（Decision 协议）,
     * then the verdict disposition. Never throws — fail-open releases the
     * stop on every internal failure.
     */
    async function handleTurnStopping(payload) {
        try {
            if (!isRecord(payload)) {
                return undefined; // 载体形态漂移：fail-open 放行收口
            }
            const config = getConfig?.() ?? {};
            if (config?.enabled !== true || config?.mode !== HARD_INTERVENTION_MODE) {
                return undefined; // 软模式或整体禁用：不评审
            }
            if (!advisorModelAllowed(config)) {
                stats.skipped += 1;
                logger.info?.('advisor-flow: turn review skipped — advisor model not allowed', { session: sessionOf(payload) });
                return undefined; // 模型白名单前置不满足：不评审（留痕）
            }
            const sessionId = sessionOf(payload);
            if (isAdvisorSubsession?.(sessionId) === true) {
                stats.skipped += 1;
                logger.info?.('advisor-flow: turn review skipped — session is an advisor subsession', { session: sessionId });
                return undefined; // 顾问子会话不是执行者（R-01-009/AC-05；T-022）
            }
            if (await exemptSubsession(sessionId) === true) {
                stats.skipped += 1;
                logger.info?.('advisor-flow: turn review skipped — subsession matches exempt patterns', { session: sessionId });
                return undefined; // 审核类子会话收口不评审（R-01-009/AC-11；T-023）
            }
            if (budgetExhausted?.(sessionId) === true) {
                stats.skipped += 1;
                logger.info?.('advisor-flow: turn review skipped — per-session budget exhausted', { session: sessionId });
                return undefined; // 预算耗尽：fail-open 放行收口
            }
            if (sessionEnabled?.(sessionId) === false) {
                stats.skipped += 1;
                logger.info?.('advisor-flow: turn review skipped — session advisor off', { session: sessionId });
                return undefined; // 会话级停用：短路不评审（/advisor off 同口径）
            }
            if (markReviewed(sessionId, payload.turn)) {
                return undefined; // 同回合同一收口事件已评审：放行
            }
            stats.triggers += 1;
            const outcome = await consult({
                entry: 'turn-review',
                session: sessionId,
                question: TURN_REVIEW_QUESTION,
                parent: payload.agent,
            });
            if (!isRecord(outcome) || outcome.ok !== true) {
                stats.failed += 1;
                logger.info?.('advisor-flow: turn review failed — fail-open allow stop', {
                    session: sessionId,
                    code: outcome?.code ?? 'UNKNOWN',
                    reason: outcome?.reason ?? 'unknown',
                });
                return undefined; // 评审失败：放行收口（留痕，不送达）
            }
            if (outcome.decision === 'proceed') {
                stats.proceed += 1;
                logger.info?.('advisor-flow: turn review proceed — stop allowed', { session: sessionId, adviceId: outcome.adviceId });
                return undefined; // 放行收口；意见全文仅日志留痕
            }
            if (outcome.decision === 'revise' || outcome.decision === 'blocked') {
                if (outcome.decision === 'revise') {
                    stats.revise += 1;
                } else {
                    stats.blocked += 1;
                    logger.info?.('advisor-flow: turn review blocked — advice delivered, stop opposed', { session: sessionId, adviceId: outcome.adviceId });
                }
                // revise/blocked：意见全文 steer 送达 = 反对收口，执行者带意见续跑。
                const adviceText = adviceForGateText(outcome);
                try {
                    delivery?.(sessionId, adviceText);
                } catch (error) {
                    logger.error?.('advisor-flow: turn review delivery failed — contained', { session: sessionId, error: String(error) });
                }
                return undefined;
            }
            // 非三值裁决（engine 已拦截 Decision 行，此处兜底防御）：按失败处置。
            stats.failed += 1;
            logger.info?.('advisor-flow: turn review has no valid decision — fail-open allow stop', {
                session: sessionId,
                decision: outcome.decision ?? 'none',
            });
            return undefined;
        } catch (error) {
            stats.failed += 1;
            logger.error?.('advisor-flow: turn review component failed — fail-open allow stop', { error: String(error) });
            return undefined;
        }
    }

    return {
        handleTurnStopping,
        decisionStats: () => ({ ...stats }),
        forgetSession,
    };
}
