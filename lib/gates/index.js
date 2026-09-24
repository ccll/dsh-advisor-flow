/**
 * Gate engine — the `tools/pre-execute` waterfall handler (R-01-003..005,
 * R-02-005/AC-02; SOLUTION.md#门控服务, C-001) plus the completion gate's
 * turn-close entry (`agent/turn-stopping`, R-01-006).
 *
 * Per guarded tool dispatch the engine runs the pre-execute gates in fixed
 * order (plan → loop → failure); the FIRST hit synchronously awaits
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
import { buildAdviceMessage } from '../delivery.js';
import { isRecord, sessionOf } from '../util.js';

/** The advisor's own tool face — exempt from gating (anti-recursion). */
export const ADVISOR_TOOL_NAME = 'ask_advisor';

/** Fixed gate evaluation order (first hit wins). The completion gate is NOT
 * here: dsh has no turn-concluding TOOL — the turn close is signaled by the
 * `agent/turn-stopping` serial dispatch (payload `{turn, signal, agent}`),
 * which the wiring routes to {@link handleTurnStopping}. */
const GATE_ORDER = ['plan', 'loop', 'failure'];

/** Table-driven gate judges (gateKind → judge); a hit is judged against the
 * shared per-dispatch context `{ exec, loopCount, failureStreak }`. */
const GATE_JUDGES = Object.freeze({
    plan: judgePlanGate,
    loop: judgeLoopGate,
    failure: judgeFailureGate,
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
    const args = JSON.stringify(exec?.arguments ?? {});
    return `门触发评审（${gateKind} 门）：工具 ${exec?.name} 即将执行，参数 ${args}。请评审该动作是否应当继续。`;
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
     * Completion-gate dedup: one review per (session, turn). The turn-stopping
     * dispatch re-fires for the SAME turn whenever the close is deferred —
     * and the gate's own delivery (inject/steer land in the next-step inbox,
     * which the host re-reads before closing) is itself such a deferral.
     * Without the marker the gate would consult → deliver → force another
     * step → consult again on the same turn's next close attempt: an
     * unbounded consultation loop. Marker semantics: the FIRST close attempt
     * of a turn reviews; every later attempt of the SAME turn closes freely.
     */
    const reviewedTurns = new Map(); // session id → reviewed turn number

    /** Forget one session's completion-review marker (session disposal). */
    function resetSession(sessionId) {
        reviewedTurns.delete(sessionId);
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
                    tool: exec.name,
                    session: sessionId,
                    code: advice?.code ?? 'UNKNOWN',
                    reason: advice?.reason ?? 'unknown',
                });
                resetAfterHit(gateKind, sessionId, loopKey, exec.name);
                return allow();
            }
            const severity = advice.severity === 'blocker' || advice.severity === 'concern'
                ? advice.severity
                : 'nit';
            const record = { adviceId: advice.adviceId, severity, text: advice.text, gate: gateKind };
            const summary = adviceSummary(advice);

            if (gate.policy === 'block') {
                if (severity === 'blocker') {
                    logger.info?.('advisor-flow: gate denied the action — blocker advice', { gate: gateKind, tool: exec.name, session: sessionId, adviceId: advice.adviceId });
                    resetAfterHit(gateKind, sessionId, loopKey, exec.name);
                    return { kind: 'deny', reason: `[advisor:blocker] ${summary}` };
                }
                delivery?.(sessionId, record);
                resetAfterHit(gateKind, sessionId, loopKey, exec.name);
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
                    tool: exec.name,
                    session: sessionId,
                    adviceId: advice.adviceId,
                    summary,
                    sessionStopped: typeof stopSession === 'function',
                });
                if (typeof stopSession === 'function') {
                    try {
                        stopSession({ gate: gateKind, exec, sessionId, adviceId: advice.adviceId, summary });
                    } catch (error) {
                        // 两态显性化：缝未激活（闭包标记）与激活但钩子抛错分开
                        // 呈现，deny 兜底交付不受影响。
                        const state = error?.stopSessionReason === 'seam-not-activated'
                            ? '会话停止缝未激活'
                            : '会话停止钩子抛错';
                        logger.error?.(`advisor-flow: block-session 会话停止未执行（${state}）——deny 仍交付`, { gate: gateKind, tool: exec.name, session: sessionId, error: String(error) });
                    }
                } else {
                    logger.error?.('advisor-flow: block-session 会话停止未执行（会话停止缝未接入）——deny 仍交付', { gate: gateKind, tool: exec.name, session: sessionId });
                }
                resetAfterHit(gateKind, sessionId, loopKey, exec.name);
                return { kind: 'deny', reason: `[advisor:blocker] ${summary}` };
            }
            if (gate.policy === 'ask') {
                delivery?.(sessionId, record);
                if (typeof approver !== 'function') {
                    // No approval seam wired: fail-open rather than stall.
                    logger.error?.('advisor-flow: gate ask policy has no approver — fail-open allow', { gate: gateKind, tool: exec.name, session: sessionId });
                    resetAfterHit(gateKind, sessionId, loopKey, exec.name);
                    return allow();
                }
                let approved;
                try {
                    approved = await approver({ gate: gateKind, exec, advice: record });
                } catch (error) {
                    logger.error?.('advisor-flow: approver failed — fail-open allow', { gate: gateKind, tool: exec.name, error: String(error) });
                    resetAfterHit(gateKind, sessionId, loopKey, exec.name);
                    return allow();
                }
                resetAfterHit(gateKind, sessionId, loopKey, exec.name);
                if (approved) {
                    return allow();
                }
                logger.info?.('advisor-flow: gate ask policy rejected by approver', { gate: gateKind, tool: exec.name, session: sessionId, adviceId: advice.adviceId });
                return { kind: 'deny', reason: `人工拒绝：${summary}` };
            }
            // 'review' (default): deliver the advice BEFORE the action's
            // result becomes visible, then allow (R-01-003/AC-03).
            delivery?.(sessionId, record);
            resetAfterHit(gateKind, sessionId, loopKey, exec.name);
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
            logger.error?.('advisor-flow: gate disposition failed — fail-open allow', { gate: gateKind, tool: exec?.name, error: String(error) });
            resetAfterHit(gateKind, sessionId, loopKey, exec?.name);
            return allow();
        }
    }

    return {
        /** Forget one session's gate state artifacts (session disposal). */
        resetSession,

        /**
         * The pre-execute waterfall handler. Returns the waterfall decision:
         * `{ kind: 'allow' }` (delegating through `next()` when present) or
         * `{ kind: 'deny', reason }`. The gate's own `ask` policy resolves
         * through the injected approver, so `{ kind: 'ask' }` is never
         * emitted.
         *
         * Throw behavior: gate MECHANICS (argument guard, counting, judging)
         * never throw — they fail open with a delegated allow. An error
         * raised INSIDE a hit disposition is contained the same way, EXCEPT
         * after `next()` has already dispatched: those errors belong to the
         * waterfall and propagate untouched (see handleHit).
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
                if (!isRecord(exec) || typeof exec.name !== 'string' || exec.name === ADVISOR_TOOL_NAME) {
                    // Malformed carriers and the advisor's own tool pass through.
                    return next ? await next() : { kind: 'allow' };
                }
                sessionId = sessionOf(exec);
                // Count this call for the loop gate BEFORE judging (the count
                // includes the current call: "repeated up to the threshold").
                call = observer.recordCall(sessionId, exec.name, exec.arguments);
                streak = observer.failureStreak(sessionId, exec.name);
            } catch (error) {
                // Gate-component failure: fail-open, never stall the tool
                // call. next() has NOT been dispatched in this phase, so the
                // delegated allow below still executes the guarded action —
                // fail-open means the action proceeds, not that it vanishes.
                logger.error?.('advisor-flow: gate component failed — fail-open allow', { error: String(error), tool: exec?.name });
                return next ? await next() : { kind: 'allow' };
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

        /**
         * The completion gate's turn-close entry (the `agent/turn-stopping`
         * serial dispatch, payload `{turn, signal, agent}` — the agent is
         * fused into the payload by the host's agentEvents). Runs BEFORE the
         * turn boundary commits; an objection is expressed by steering the
         * agent (the machine re-reads its inbox and runs another step), NOT
         * by a return value — the serial dispatch has no veto channel.
         *
         * Dispositions map onto the steering seam:
         * - `review` — deliver the advice, allow the close;
         * - `ask` — deliver, delegate to the approver; refusal objects by
         *   steering the reason (the turn continues);
         * - `block` — a blocker-severity advice objects by steering the
         *   advice; otherwise deliver + allow.
         *
         * 去重与 AC-02 的边界（评审轮修正）：同回合内完成门的任何输出——
         * 送达（inject）与反对（steer）都落 next-step inbox——都会让宿主
         * 重读 inbox 续步、再次派发收口事件。去重标记只在「放行收口」的
         * 处置后落（review/block 非 blocker/ask 同意），使送达后续步的下
         * 一次收口尝试直接放行、循环有界；「反对收口」的处置不落标记——
         * 同回合的再收口会重新评审，blocker 反对不能被立即再收口绕过
         * （R-01-006/AC-02）。代价：blocker 拉锯期每次收口尝试各耗一次
         * 咨询，由 budget.maxPerSession 与门开关兜底。
         *
         * Non-stall invariants (R-02-005): a consultation failure/timeout or
         * ANY gate-component error is fail-open — the close proceeds and the
         * failure is logged at error level. Without an agent (or a steer
         * seam) a blocking objection cannot be expressed — logged loudly, the
         * close still proceeds (never hangs the boundary).
         *
         * @returns `'delivered'`（意见已送达且放行收口——本次注入已让宿主
         *   续步）| `'objected'`（已反对收口——同回合再收口将重新评审）|
         *   `undefined`（未评审或未投递：门禁用、去重跳过、fail-open 放行）。
         *   事件监听层只在 `undefined`（自由收口）时递减送达冷却。
         */
        async handleTurnStopping(payload) {
            let sessionId;
            try {
                if (!isRecord(payload)) {
                    return undefined;
                }
                sessionId = sessionOf(payload); // payload.agent.id (fused)
                const gate = policyLookup?.('completion') ?? { enabled: false };
                if (!gate?.enabled) {
                    return undefined;
                }
                // One ALLOWED close per (session, turn): a later close attempt
                // of the same turn skips after an allow disposition (see
                // reviewedTurns above — the gate's own delivery defers the
                // close, so without the marker the same turn would re-review
                // once per delivery: an unbounded loop). An objected close
                // never marks — the objection must survive immediate
                // re-close attempts (R-01-006/AC-02).
                const turn = typeof payload.turn === 'number' && Number.isFinite(payload.turn)
                    ? payload.turn
                    : undefined;
                if (turn !== undefined && reviewedTurns.get(sessionId) === turn) {
                    return undefined; // already reviewed + allowed this turn — close freely
                }
                const advice = await consult({
                    entry: 'gate',
                    session: sessionId,
                    question: '门触发评审（completion 门）：执行者回合即将收口。请评审本轮工作是否达到可收口状态，遗漏请指出。',
                });
                if (!isRecord(advice) || advice.ok !== true) {
                    logger.error?.('advisor-flow: gate consultation unavailable — fail-open allow', {
                        gate: 'completion',
                        tool: '(turn close)',
                        session: sessionId,
                        code: advice?.code ?? 'UNKNOWN',
                        reason: advice?.reason ?? 'unknown',
                    });
                    return undefined;
                }
                const severity = advice.severity === 'blocker' || advice.severity === 'concern'
                    ? advice.severity
                    : 'nit';
                const record = { adviceId: advice.adviceId, severity, text: advice.text, gate: 'completion' };
                const agent = isRecord(payload.agent) ? payload.agent : undefined;
                const markReviewed = () => {
                    if (turn !== undefined) {
                        reviewedTurns.set(sessionId, turn);
                    }
                };
                /** Object to the close: steer the agent so the machine runs
                 * another step with the advice visible. Contained: a missing
                 * or throwing steer seam degrades to a loud allow-close. */
                const objectToClose = () => {
                    if (!isRecord(agent) || typeof agent.steer !== 'function') {
                        logger.error?.('advisor-flow: completion gate objection could not steer — turn closes anyway', { gate: 'completion', session: sessionId, adviceId: advice.adviceId });
                        return;
                    }
                    try {
                        agent.steer(buildAdviceMessage(record));
                    } catch (error) {
                        logger.error?.('advisor-flow: completion gate objection steer failed — turn closes anyway', { gate: 'completion', session: sessionId, error: String(error) });
                    }
                };
                if (gate.policy === 'block') {
                    if (severity === 'blocker') {
                        logger.info?.('advisor-flow: gate objected to the turn close — blocker advice', { gate: 'completion', session: sessionId, adviceId: advice.adviceId });
                        objectToClose();
                        return 'objected'; // 不落去重标记：同回合再收口重新评审
                    }
                    delivery?.(sessionId, record);
                    markReviewed();
                    return 'delivered';
                }
                if (gate.policy === 'ask') {
                    delivery?.(sessionId, record);
                    if (typeof approver !== 'function') {
                        logger.error?.('advisor-flow: gate ask policy has no approver — fail-open allow close', { gate: 'completion', session: sessionId });
                        return undefined;
                    }
                    let approved;
                    try {
                        approved = await approver({ gate: 'completion', exec: undefined, advice: record });
                    } catch (error) {
                        logger.error?.('advisor-flow: approver failed — fail-open allow close', { gate: 'completion', error: String(error) });
                        return undefined;
                    }
                    if (!approved) {
                        logger.info?.('advisor-flow: gate ask policy rejected by approver — objecting to the close', { gate: 'completion', session: sessionId, adviceId: advice.adviceId });
                        objectToClose();
                        return 'objected'; // 不落去重标记：同回合再收口重新评审
                    }
                    markReviewed();
                    return 'delivered';
                }
                // 'review' (default): deliver the advice BEFORE the boundary
                // commits, then allow the close.
                delivery?.(sessionId, record);
                markReviewed();
                return 'delivered';
            } catch (error) {
                logger.error?.('advisor-flow: completion gate failed — fail-open allow close', { error: String(error), session: sessionId });
                return undefined;
            }
        },
    };
}
