/**
 * Turn review (R-01-009; C-021) — the hard-mode pre-stop consultation at the
 * `agent/turn-stopping` seam.
 *
 * 语义（SOLUTION.md#运行时并发与失败语义）：
 * - 触发前置：`enabled === true` 且 `mode === 'hard'` 且顾问模型可用；
 *   软模式永不触发（守则是唯一的建议面）。
 * - 顾问子会话豁免（T-022）：本插件子会话呈现发出的会话不是执行者
 *   （R-01-009/AC-05 评审对象是执行者回合收口），其收口不评审。
 *   语义与动机见 SOLUTION.md#跨模块约束「顾问子会话豁免」。
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

/** 收口评审问句（模型面文案英文，对齐 C-008/C-009 口径；聚焦本轮行为）。 */
export const TURN_REVIEW_QUESTION =
    'Advisor turn review: the Executor is about to end this turn. Review the Executor\'s actions in this turn and decide whether it may stop here. Answer in concise Markdown. Your first non-empty line must be exactly `Decision: proceed`, `Decision: revise`, or `Decision: blocked`. `proceed` = the turn may end; `revise` or `blocked` = the Executor should continue with your advice.';

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
 * @param {{ info?, warn?, error? }} [options.logger]
 * @returns {{ handleTurnStopping: (payload: object) => Promise<undefined>,
 *   decisionStats: () => object }}
 */
export function createTurnReview({ consult, delivery, getConfig, budgetExhausted, sessionEnabled, isAdvisorSubsession, logger = console } = {}) {
    /** 收口评审计数（R-01-009/AC-10）：触发/裁决/跳过计数。 */
    const stats = { triggers: 0, proceed: 0, revise: 0, blocked: 0, failed: 0, skipped: 0 };
    /** Per-session 已评审 turn 标记（去重）。 */
    const reviewedTurns = new Map();

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
    };
}
