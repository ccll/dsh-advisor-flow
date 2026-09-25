/**
 * Gate engine — the loop gate's `tools/pre-execute` handler with the
 * `Decision` protocol and failure-mode dispositions (R-01-005, R-02-005;
 * SOLUTION.md#门控服务, C-007).
 *
 * The loop gate is the ONLY hard gate: an equivalent tool call repeating up
 * to the threshold is intercepted BEFORE execution, synchronously consulted
 * (decision-protocol system prompt), and dispositioned by the advisor's
 * three-valued decision:
 * - `proceed` — steer the gate result to the executor, reset the equivalence
 *   count, allow the action;
 * - `revise` — steer the result, deny with the full advice markdown;
 * - `blocked` — steer, then disposition by the configured failure mode:
 *   `warn-and-continue` allows (notified), `block-tool` denies, and
 *   `block-session` enters the session-blocked state (every later tool call
 *   is denied until the session is rebuilt) with a best-effort
 *   `stopSession` hook.
 *
 * A consultation FAILURE (provider error, empty response, missing/malformed/
 * duplicate/contradictory decision line, budget exhausted) is dispositioned
 * by the same failure mode — never a stall (R-02-005).
 *
 * Anti-stuck: a `proceed` decision resets the equivalence counter (the loop
 * is reviewed and allowed); revise/blocked leave the counter in place, so
 * the next equivalent attempt is reviewed again.
 *
 * The advisor's own tool (`ask_advisor`) is exempt from gating.
 *
 * @module dsh-advisor-flow/gates
 */

import { DECISION_FAILURE_CATEGORIES } from '../decision.js';
import { adviceForGateText } from '../decision.js';
import { DEFAULT_GATE_THRESHOLD } from '../config.js';
import { advisorModelAllowed, isRecord, sessionOf } from '../util.js';

/** The advisor's own tool face — exempt from gating (anti-recursion). */
export const ADVISOR_TOOL_NAME = 'ask_advisor';

/** Bounded one-line summary of a failure reason, for logs. */
export function failureSummary(message, maxChars = 200) {
    const text = typeof message === 'string' ? message.replace(/\s+/g, ' ').trim() : '';
    if (text.length <= maxChars) {
        return text;
    }
    return `${text.slice(0, maxChars - 1)}…`;
}

function buildGateQuestion(exec, threshold) {
    // pi loop-gate.ts:162-163 逐字（reason + Review 句）
    return `Advisor loop gate: normalized signature for ${exec?.name} repeated ${threshold} times without a materially different tool action. Review the repeated actions and recommend the smallest safe next step.`;
}

/** pi gate-policy failureEffect 的 reason 文案（category: message）。 */
function failureEffectReason(category, message) {
    return `Advisor gate ${category}: ${message}`;
}

/**
 * Create the loop-gate engine.
 *
 * @param {object} options
 * @param {(request: object) => Promise<object>} options.consult the gate
 *   consultation entry（`entry:'gate'`，Decision 协议；never rejects）
 * @param {object} options.observer the session observer (call counts)
 * @param {(sessionId: string, text: string) => unknown} [options.delivery]
 *   the gate-result steer seam（文本 = **Decision: X** + 全文）；失败 contained
 * @param {() => object} [options.getConfig] live runtime config
 *   (`gates.loop` + `failureMode`)
 * @param {(context: object) => unknown} [options.stopSession] best-effort
 *   `agents.cancel` seam for the block-session disposition
 * @param {{ info?, warn?, error? }} [options.logger]
 */
export function createGateEngine({ consult, observer, delivery, getConfig, stopSession, logger = console } = {}) {
    /** 会话封锁态：sessionId → 封锁原因（block-session 处置落位）。 */
    const blockedSessions = new Map();

    function resetAfterHit(sessionId) {
        try {
            observer.resetRepetition(sessionId);
        } catch (error) {
            logger.error?.('advisor-flow: gate counter reset failed — contained', { error: String(error) });
        }
    }

    /**
     * The failureMode disposition for one gate failure or `blocked` decision.
     * @param {string} mode the resolved failure mode
     * @param {string} reason the notify/deny reason
     * @param {string} sessionId the owning session
     * @returns {{ block: boolean, reason: string }} whether the guarded action
     *   must be denied, and the denial/notify reason；block-session 另行落封锁
     */
    /**
     * The failureMode disposition for one gate failure or `blocked` decision
     * （pi gate-policy failureEffect / blockedDecisionEffect：封锁无条件落位，
     * `ctx.abort()` 即 stopSession 由 advisorBlockOnBlockedRef 门控——移植侧
     * 以 blockOnBlocked 配置承接）。
     * @param {string} mode the resolved failure mode
     * @param {string} reason the notify/deny reason
     * @param {string} sessionId the owning session
     * @param {boolean} stopOnBlocked blockOnBlocked 配置（true 才停止当前执行）
     * @returns {{ block: boolean, reason: string }} whether the guarded action
     *   must be denied, and the denial/notify reason；block-session 另行落封锁
     */
    function dispositionFor(mode, reason, sessionId, stopOnBlocked) {
        if (mode === 'warn-and-continue') {
            return { block: false, reason };
        }
        if (mode === 'block-tool') {
            return { block: true, reason };
        }
        // block-session: 会话封锁（无条件，pi session.block）+ 尽力停止当前
        // 执行（仅 blockOnBlocked=true 时调 stopSession，对齐 pi ctx.abort）。
        blockedSessions.set(sessionId, reason);
        if (stopOnBlocked !== false && typeof stopSession === 'function') {
            try {
                stopSession({ gate: 'loop', sessionId, reason });
            } catch (error) {
                logger.error?.('advisor-flow: block-session 会话停止钩子抛错——封锁已生效', { sessionId, error: String(error) });
            }
        } else if (stopOnBlocked === false) {
            logger.info?.('advisor-flow: blockOnBlocked=false——封锁生效但不触发会话停止', { sessionId });
        } else {
            logger.error?.('advisor-flow: block-session 会话停止缝未接入——封锁已生效，当前执行尽力停止不可用');
        }
        return { block: true, reason };
    }

    /**
     * One gate hit: synchronous consultation（Decision 协议）, then the
     * decision/failure disposition. Any internal failure is contained and
     * dispositioned by the failure mode — the guarded action is never held
     * hostage to advisor availability.
     */
    async function handleHit({ exec, sessionId, failureMode, threshold, blockOnBlocked, next }) {
        let nextSettled = false;
        const allow = async () => {
            nextSettled = true;
            return next ? await next() : { kind: 'allow' };
        };
        const deny = (reason) => ({ kind: 'deny', reason });
        const gateQuestion = buildGateQuestion(exec, threshold);
        try {
            // pi sendAutomaticGateCall：评审请求先行通告（deliverAs steer）。
            delivery?.(sessionId, 'Automatic Advisor loop review');
            const outcome = await consult({
                entry: 'gate',
                session: sessionId,
                question: gateQuestion,
            });
            if (!isRecord(outcome) || outcome.ok !== true) {
                const category = outcome?.category ?? outcome?.code ?? 'UNKNOWN';
                const message = outcome?.message ?? outcome?.reason ?? 'unknown';
                logger.error?.('advisor-flow: gate consultation unavailable — failure-mode disposition', {
                    gate: 'loop',
                    tool: exec.name,
                    session: sessionId,
                    category: DECISION_FAILURE_CATEGORIES.includes(outcome?.category) ? outcome.category : (outcome?.code ?? 'UNKNOWN'),
                });
                // pi failureEffect：reason = `Advisor gate ${category}: ${message}`；
                // 块处置拒绝原因 = 门问句 + '\n' + failureEffect.reason。
                const effectReason = failureEffectReason(category, message);
                const d = dispositionFor(failureMode, effectReason, sessionId, blockOnBlocked);
                if (d.block) {
                    return deny(`${gateQuestion}\n${d.reason}`);
                }
                // pi sendAutomaticGateFailure：失败通告经 steer 送执行者。
                delivery?.(sessionId, `**Advisor gate failure (${category}):** ${message}`);
                return allow();
            }
            const gateText = adviceForGateText(outcome);
            delivery?.(sessionId, gateText);
            if (outcome.decision === 'proceed') {
                resetAfterHit(sessionId);
                return allow();
            }
            // pi gateReason（loop-gate.ts:158）：revise/blocked 共用该拒绝原因
            const gateReason = `Advisor loop review: ${outcome.markdown}`;
            if (outcome.decision === 'revise') {
                // pi 语义：revise/blocked 不重置计数——同参数再尝试会再次
                // 触发评审（每次尝试各耗一次咨询，由 budget 兜底）。
                return deny(gateReason);
            }
            // blocked → blockedDecisionEffect（pi 语义：封锁态不重置计数；
            // 封锁 reason = gateReason）。
            logger.info?.('advisor-flow: gate decision blocked — failure-mode disposition', { gate: 'loop', session: sessionId, adviceId: outcome.adviceId });
            const d = dispositionFor(failureMode, gateReason, sessionId, blockOnBlocked);
            if (failureMode === 'warn-and-continue') {
                // pi blockedDecisionEffect warn 分支：notify 后按配置放行
                logger.warn?.('Advisor gate returned blocked; continuing by configuration.', { gate: 'loop', session: sessionId, adviceId: outcome.adviceId });
                return allow();
            }
            // pi 语义：blocked 不重置计数——后续等价尝试继续受审；warn 分支
            // 已在上方放行，block-tool/block-session 恒 block（dispositionFor）。
            return deny(d.reason);
        } catch (error) {
            if (nextSettled) {
                // The guarded action already dispatched through next(): this
                // error belongs to the waterfall/downstream — propagate.
                throw error;
            }
            logger.error?.('advisor-flow: gate disposition failed — fail-open allow', { gate: 'loop', tool: exec?.name, error: String(error) });
            return allow();
        }
    }

    return {
        /**
         * The pre-execute waterfall handler. Returns `{ kind: 'allow' }`
         * (delegating through `next()` when present) or `{ kind: 'deny',
         * reason }`. Gate MECHANICS never throw — they fail open.
         */
        async handlePreExecute(exec, next) {
            let sessionId;
            let call;
            let gate;
            try {
                if (!isRecord(exec) || typeof exec.name !== 'string' || exec.name === ADVISOR_TOOL_NAME) {
                    // Malformed carriers and the advisor's own tool pass through.
                    return next ? await next() : { kind: 'allow' };
                }
                sessionId = sessionOf(exec);
                if (blockedSessions.has(sessionId)) {
                    // 会话封锁态：一切工具调用拦截（R-01-005/AC-03）。
                    return { kind: 'deny', reason: blockedSessions.get(sessionId) ?? 'Advisor session is blocked.' };
                }
                const config = getConfig?.() ?? {};
                if (config?.enabled !== true) {
                    // R-02-001/AC-03：咨询功能整体禁用——门不计数不咨询。
                    return next ? await next() : { kind: 'allow' };
                }
                // pi advisorModelIsAllowed 前置：白名单非空且顾问模型不在其中
                // → 门不介入（R-02-001 模型白名单；共享谓词见 util.js）。
                if (!advisorModelAllowed(config)) {
                    return next ? await next() : { kind: 'allow' };
                }
                gate = config?.gates?.loop ?? { enabled: false };
                if (!gate?.enabled) {
                    return next ? await next() : { kind: 'allow' };
                }
                // Count this call BEFORE judging (the count includes the
                // current call: "repeated up to the threshold").
                call = observer.recordCall(sessionId, exec.name, exec.arguments);
            } catch (error) {
                logger.error?.('advisor-flow: gate component failed — fail-open allow', { error: String(error), tool: exec?.name });
                return next ? await next() : { kind: 'allow' };
            }
            const failureMode = getConfig?.()?.failureMode ?? 'warn-and-continue';
            const threshold = Number.isInteger(gate?.threshold) && gate?.threshold > 0 ? gate.threshold : DEFAULT_GATE_THRESHOLD;
            if (call.count < threshold) {
                return next ? await next() : { kind: 'allow' };
            }
            return await handleHit({ exec, sessionId, failureMode, threshold, blockOnBlocked: getConfig?.()?.blockOnBlocked !== false, next });
        },

        /** Forget one session's gate state artifacts (session disposal). */
        resetSession(sessionId) {
            blockedSessions.delete(sessionId);
        },
    };
}
