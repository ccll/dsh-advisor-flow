/**
 * Gate engine — the `tools/pre-execute` waterfall handler (R-01-003..006,
 * R-02-005/AC-02; SOLUTION.md#门控服务, C-001).
 *
 * Per guarded dispatch the engine runs the gates in fixed order
 * (plan → loop → failure → completion); the FIRST hit synchronously awaits
 * one consultation (`entry: 'gate'`), then disposes by gate policy:
 * - `review` — deliver the advice, allow the action;
 * - `ask` — deliver the advice, delegate to the injected approver; refusal
 *   denies with a reason;
 * - `block` — a blocker-severity advice denies with the advice summary as
 *   reason; otherwise deliver + allow;
 * - `block-session` (failure gate only) — deny with the advice summary as
 *   reason (the guaranteed path), plus a best-effort `stopSession` hook and
 *   a loud record of whether the session stop actually executed.
 *
 * An ALLOW outcome delegates through the waterfall's `next()` so the guarded
 * action actually executes; a DENY short-circuits without dispatching.
 *
 * Non-stall invariants (R-02-005/AC-02): a consultation failure/timeout, a
 * throwing delivery, a throwing approver, or ANY gate-component error is
 * fail-open — the action is ALLOWED and the failure is logged at error
 * level. The engine never hangs: the consultation itself is deadline-bounded
 * by the consultation engine.
 *
 * Anti-stuck: after a loop/failure gate hit is handled (allow OR deny), the
 * corresponding counter is reset, so the same equivalence or tool cannot
 * wedge the session permanently.
 *
 * The advisor's own tool (`ask_advisor`) is exempt from gating — a gate
 * triggered consultation must not recurse into the gates.
 *
 * @module dsh-advisor-flow/gates
 */

import { judgePlanGate } from './plan.js';
import { judgeLoopGate } from './loop.js';
import { judgeFailureGate } from './failure.js';
import { judgeCompletionGate } from './completion.js';
import { isRecord, sessionOf } from '../util.js';

/** The advisor's own tool face — exempt from gating (anti-recursion). */
export const ADVISOR_TOOL_NAME = 'ask_advisor';

/** Fixed gate evaluation order (first hit wins). */
const GATE_ORDER = ['plan', 'loop', 'failure', 'completion'];

/** Table-driven gate judges (gateKind → judge); a hit is judged against the
 * shared per-dispatch context `{ exec, loopCount, failureStreak }`. */
const GATE_JUDGES = Object.freeze({
    plan: judgePlanGate,
    loop: judgeLoopGate,
    failure: judgeFailureGate,
    completion: judgeCompletionGate,
});

/** Bounded one-line summary of an advice, for deny reasons and logs. */
export function adviceSummary(advice, maxChars = 200) {
    const text = typeof advice?.text === 'string' ? advice.text.replace(/\s+/g, ' ').trim() : '';
    if (text.length <= maxChars) {
        return text;
    }
    return `${text.slice(0, maxChars - 1)}…`;
}

function buildGateQuestion(gateKind, exec) {
    const args = JSON.stringify(exec?.args ?? {});
    return `门触发评审（${gateKind} 门）：工具 ${exec?.tool} 即将执行，参数 ${args}。请评审该动作是否应当继续。`;
}

/**
 * Create the gate engine.
 *
 * @param {object} options
 * @param {(request: object) => Promise<object>} options.consult the
 *   consultation entry point (the engine's `consult`, which never rejects)
 * @param {object} options.observer the session observer (call/result counts)
 * @param {(sessionId: string, advice: object) => unknown} [options.deliver]
 *   the advice delivery (failure-contained by the delivery router)
 * @param {(gateKind: string) => object} [options.policyLookup] resolved gate
 *   config per kind (defaults to a disabled gate)
 * @param {(request: object) => Promise<boolean>} [options.approver] the
 *   `ask` policy's human-approval seam; when absent, `ask` fails open
 * @param {(context: object) => unknown} [options.stopSession] best-effort
 *   session-stop hook for the failure gate's `block-session` policy; when
 *   absent the deny still carries the reason and the missing stop is
 *   surfaced loudly (联调验证项: T-002 清单)
 * @param {{ info?, warn?, error? }} [options.logger]
 */
export function createGateEngine({ consult, observer, delivery, policyLookup, approver, stopSession, logger = console } = {}) {
    /**
     * Post-hit counter reset (anti-stuck): a handled loop hit clears its
     * equivalence count and a handled failure hit clears the streak —
     * whether the action was allowed or denied.
     */
    function resetAfterHit(gateKind, sessionId, loopKey, toolName) {
        try {
            if (gateKind === 'loop' && loopKey) {
                observer.resetLoopKey(sessionId, loopKey);
            }
            if (gateKind === 'failure' && toolName) {
                observer.resetFailures(sessionId, toolName);
            }
        } catch (error) {
            logger.error?.('advisor-flow: gate counter reset failed — contained', { error: String(error) });
        }
    }

    /**
     * One gate hit: synchronous consultation (C-001), then policy
     * disposition. Any failure inside is fail-open (allow + error log).
     * An ALLOW outcome delegates through `next()` so the guarded action
     * actually executes in the waterfall; if the error happens AFTER next()
     * already ran, the bare allow is returned instead of re-dispatching.
     */
    async function handleHit({ gateKind, gate, exec, sessionId, loopKey, next }) {
        let nextSettled = false;
        const allow = async () => {
            nextSettled = true;
            return next ? await next() : { kind: 'allow' };
        };
        try {
            const advice = await consult({
                entry: 'gate',
                session: sessionId,
                question: buildGateQuestion(gateKind, exec),
            });
            if (!isRecord(advice) || advice.ok !== true) {
                // Consultation unavailable (not configured / failed / timed
                // out / paused / halted): fail-open per R-02-005/AC-02 — the
                // action is never held hostage to advisor availability.
                logger.error?.('advisor-flow: gate consultation unavailable — fail-open allow', {
                    gate: gateKind,
                    tool: exec.tool,
                    session: sessionId,
                    code: advice?.code ?? 'UNKNOWN',
                    reason: advice?.reason ?? 'unknown',
                });
                resetAfterHit(gateKind, sessionId, loopKey, exec.tool);
                return allow();
            }
            const severity = advice.severity === 'blocker' || advice.severity === 'concern'
                ? advice.severity
                : 'nit';
            const record = { adviceId: advice.adviceId, severity, text: advice.text, gate: gateKind };
            const summary = adviceSummary(advice);

            if (gate.policy === 'block') {
                if (severity === 'blocker') {
                    logger.info?.('advisor-flow: gate denied the action — blocker advice', { gate: gateKind, tool: exec.tool, session: sessionId, adviceId: advice.adviceId });
                    resetAfterHit(gateKind, sessionId, loopKey, exec.tool);
                    return { kind: 'deny', reason: `[advisor:blocker] ${summary}` };
                }
                delivery?.(sessionId, record);
                resetAfterHit(gateKind, sessionId, loopKey, exec.tool);
                return allow();
            }
            if (gate.policy === 'block-session') {
                // failure gate only. The GUARANTEED path is deny(reason) — the
                // tool call terminates with the advice summary. Stopping the
                // session itself is an extra best-effort hook: the wiring may
                // inject a session-stop seam; without one this is surfaced
                // loudly instead of silently pretending the session stopped.
                // 联调验证项（T-002 清单）：宿主会话停止缝的真实形态。
                logger.error?.('advisor-flow: gate block-session — stopping session execution', {
                    gate: gateKind,
                    tool: exec.tool,
                    session: sessionId,
                    adviceId: advice.adviceId,
                    summary,
                    sessionStopped: typeof stopSession === 'function',
                });
                if (typeof stopSession === 'function') {
                    try {
                        stopSession({ gate: gateKind, exec, sessionId, adviceId: advice.adviceId, summary });
                    } catch (error) {
                        logger.error?.('advisor-flow: block-session stop hook failed — deny still delivered', { gate: gateKind, tool: exec.tool, error: String(error) });
                    }
                } else {
                    logger.error?.('advisor-flow: block-session 请求会话停止，但未接入会话停止缝——会话停止未执行', { gate: gateKind, tool: exec.tool, session: sessionId });
                }
                resetAfterHit(gateKind, sessionId, loopKey, exec.tool);
                return { kind: 'deny', reason: `[advisor:blocker] ${summary}` };
            }
            if (gate.policy === 'ask') {
                delivery?.(sessionId, record);
                if (typeof approver !== 'function') {
                    // No approval seam wired: fail-open rather than stall.
                    logger.error?.('advisor-flow: gate ask policy has no approver — fail-open allow', { gate: gateKind, tool: exec.tool, session: sessionId });
                    resetAfterHit(gateKind, sessionId, loopKey, exec.tool);
                    return allow();
                }
                let approved;
                try {
                    approved = await approver({ gate: gateKind, exec, advice: record });
                } catch (error) {
                    logger.error?.('advisor-flow: approver failed — fail-open allow', { gate: gateKind, tool: exec.tool, error: String(error) });
                    resetAfterHit(gateKind, sessionId, loopKey, exec.tool);
                    return allow();
                }
                resetAfterHit(gateKind, sessionId, loopKey, exec.tool);
                if (approved) {
                    return allow();
                }
                logger.info?.('advisor-flow: gate ask policy rejected by approver', { gate: gateKind, tool: exec.tool, session: sessionId, adviceId: advice.adviceId });
                return { kind: 'deny', reason: `人工拒绝：${summary}` };
            }
            // 'review' (default): deliver the advice BEFORE the action's
            // result becomes visible, then allow (R-01-003/AC-03).
            delivery?.(sessionId, record);
            resetAfterHit(gateKind, sessionId, loopKey, exec.tool);
            return allow();
        } catch (error) {
            if (nextSettled) {
                // The guarded action already dispatched through next(): this
                // error belongs to the waterfall/downstream, NOT to the gate —
                // rethrow it untouched so later listeners and the dispatcher
                // see the real failure. fail-open only covers gate logic.
                throw error;
            }
            // Anything unexpected in the hit path: fail-open.
            logger.error?.('advisor-flow: gate disposition failed — fail-open allow', { gate: gateKind, tool: exec?.tool, error: String(error) });
            resetAfterHit(gateKind, sessionId, loopKey, exec?.tool);
            return allow();
        }
    }

    return {
        /**
         * The pre-execute waterfall handler. Returns the waterfall decision:
         * `{ kind: 'allow' }` (delegating through `next()` when present) or
         * `{ kind: 'deny', reason }`. The gate's own `ask`
         * policy resolves through the injected approver, so `{ kind: 'ask' }`
         * is never emitted. Never throws; never hangs.
         */
        async handlePreExecute(exec, next) {
            // Gate mechanics (counting, judging) are contained: a component
            // failure here is fail-open. A hit's disposition (handleHit) is
            // self-contained EXCEPT for errors raised by next() itself after
            // dispatch — those must propagate untouched (waterfall contract).
            let sessionId;
            let call;
            let streak;
            try {
                if (!isRecord(exec) || typeof exec.tool !== 'string' || exec.tool === ADVISOR_TOOL_NAME) {
                    // Malformed carriers and the advisor's own tool pass through.
                    return next ? await next() : { kind: 'allow' };
                }
                sessionId = sessionOf(exec);
                // Count this call for the loop gate BEFORE judging (the count
                // includes the current call: "repeated up to the threshold").
                call = observer.recordCall(sessionId, exec.tool, exec.args);
                streak = observer.failureStreak(sessionId, exec.tool);
            } catch (error) {
                // Gate-component failure: fail-open, never stall the tool call.
                logger.error?.('advisor-flow: gate component failed — fail-open allow', { error: String(error), tool: exec?.tool });
                return { kind: 'allow' };
            }

            for (const gateKind of GATE_ORDER) {
                const gate = policyLookup?.(gateKind) ?? { enabled: false };
                const judge = GATE_JUDGES[gateKind];
                const hit = judge ? judge(gate, { exec, loopCount: call.count, failureStreak: streak }) : false;
                if (!hit) {
                    continue;
                }
                return await handleHit({ gateKind, gate, exec, sessionId, loopKey: call.key, next });
            }
            // No gate hit — proceed with the waterfall. A throw from next()
            // belongs to the waterfall and propagates untouched.
            return next ? await next() : { kind: 'allow' };
        },
    };
}
