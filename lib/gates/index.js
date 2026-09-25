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
import { isRecord, sessionOf } from '../util.js';

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
    const args = JSON.stringify(exec?.arguments ?? {});
    return `循环门触发：工具 ${exec?.name} 以等价参数已重复 ${threshold} 次，本次调用参数 ${args}。请评审这些重复动作并给出最小的安全下一步建议。`;
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
            observer.resetLoopKey(sessionId);
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
    function dispositionFor(mode, reason, sessionId) {
        if (mode === 'warn-and-continue') {
            return { block: false, reason };
        }
        if (mode === 'block-tool') {
            return { block: true, reason };
        }
        // block-session: 会话封锁 + 尽力停止当前执行（两态显性化）。
        blockedSessions.set(sessionId, reason);
        if (typeof stopSession === 'function') {
            try {
                stopSession({ gate: 'loop', sessionId, reason });
            } catch (error) {
                logger.error?.('advisor-flow: block-session 会话停止钩子抛错——封锁已生效', { sessionId, error: String(error) });
            }
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
    async function handleHit({ exec, sessionId, loopKey, failureMode, threshold, next }) {
        let nextSettled = false;
        const allow = async () => {
            nextSettled = true;
            return next ? await next() : { kind: 'allow' };
        };
        const deny = (reason) => ({ kind: 'deny', reason });
        try {
            const outcome = await consult({
                entry: 'gate',
                session: sessionId,
                question: buildGateQuestion(exec, threshold),
            });
            if (!isRecord(outcome) || outcome.ok !== true) {
                const reason = `advisor 循环门咨询失败（${outcome?.category ?? outcome?.code ?? 'UNKNOWN'}）：${failureSummary(outcome?.message ?? outcome?.reason)}`;
                logger.error?.('advisor-flow: gate consultation unavailable — failure-mode disposition', {
                    gate: 'loop',
                    tool: exec.name,
                    session: sessionId,
                    category: DECISION_FAILURE_CATEGORIES.includes(outcome?.category) ? outcome.category : (outcome?.code ?? 'UNKNOWN'),
                });
                const d = dispositionFor(failureMode, reason, sessionId);
                if (d.block) {
                    return deny(`[advisor:loop-gate] ${d.reason}`);
                }
                // warn-and-continue：失败通告经 steer 送执行者（pi
                // sendAutomaticGateFailure 语义——零可见违背 G-3 可诊断）。
                delivery?.(sessionId, `[advisor:loop-gate] ${reason}`);
                return allow();
            }
            const gateText = adviceForGateText(outcome);
            delivery?.(sessionId, gateText);
            if (outcome.decision === 'proceed') {
                resetAfterHit(sessionId);
                return allow();
            }
            if (outcome.decision === 'revise') {
                // pi 语义：revise/blocked 不重置计数——同参数再尝试会再次
                // 触发评审（每次尝试各耗一次咨询，由 budget 兜底）。
                return deny(`[advisor:loop-gate] ${outcome.markdown}`);
            }
            // blocked → failureMode disposition。
            logger.info?.('advisor-flow: gate decision blocked — failure-mode disposition', { gate: 'loop', session: sessionId, adviceId: outcome.adviceId });
            const d = dispositionFor(failureMode, outcome.markdown, sessionId);
            if (d.block) {
                // pi 语义：blocked 不重置计数——后续等价尝试继续受审。
                return deny(`[advisor:loop-gate] ${d.reason}`);
            }
            logger.warn?.('advisor-flow: blocked decision continued by warn-and-continue', { gate: 'loop', session: sessionId, adviceId: outcome.adviceId });
            return allow();
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
                    return { kind: 'deny', reason: blockedSessions.get(sessionId) ?? 'advisor 会话已封锁。' };
                }
                const config = getConfig?.() ?? {};
                if (config?.enabled !== true) {
                    // R-02-001/AC-03：咨询功能整体禁用——门不计数不咨询。
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
            return await handleHit({ exec, sessionId, loopKey: call.key, failureMode, threshold, next });
        },

        /** Forget one session's gate state artifacts (session disposal). */
        resetSession(sessionId) {
            blockedSessions.delete(sessionId);
        },
    };
}
