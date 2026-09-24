/**
 * Advice delivery — routing an accepted advice into the primary session
 * (SOLUTION.md#意见送达).
 *
 * - severity → channel: `nit` → `agent.inject` (non-waking); `concern` /
 *   `blocker` → `agent.steer` (waking);
 * - the immuneTurns cooldown: after a REAL steer delivery, the next
 *   `immuneTurns` stepped primary turns must complete before another
 *   interrupting advice may steer; interrupting advices inside the window
 *   downgrade to inject (anti advice-storm, the proven dsh-advisor shape);
 * - the KD-style per-session agent map, maintained by the wiring on
 *   `agent/created` / `agent/disposed`, with a registry fallback
 *   (`lookupAgent`) for agents published before this plugin loaded; a
 *   missing agent drops the advice with a log — advisory only;
 * - {@link deliver} is the contained seam the gate engine calls: it never
 *   throws, so a broken channel can never fail-open a gate into a crash.
 *
 * Message shape (SOLUTION.md#产品契约): `[advisor:{severity}] <意见正文>`
 * with the adviceId appended for outcome reference.
 *
 * @module dsh-advisor-flow/delivery
 */

import { randomUUID } from 'node:crypto';

import { isRecord } from './util.js';

/** Collapsed-row summary bound (platform convention ~120 chars). */
const SUMMARY_MAX_CHARS = 120;

/** True when an advice interrupts the primary (concern/blocker). */
function isInterrupting(severity) {
    return severity === 'concern' || severity === 'blocker';
}

/**
 * Build the advice message: a user-role message with the plugin identity on
 * the `source.plugin` arm and a self-describing severity tag.
 *
 * 载体契约（T-008 真机实测）：宿主 UserMessage 的 `content` 是 ContentBlock
 * 数组（`[{type:'text',text}]`），且消息带稳定 `id`——字符串 content 不符合
 * 会话存储的消息契约。
 */
export function buildAdviceMessage(advice) {
    const severity = isInterrupting(advice?.severity) ? advice.severity : 'nit';
    const text = typeof advice?.text === 'string' ? advice.text.trim() : '';
    const adviceId = typeof advice?.adviceId === 'string' ? advice.adviceId : '';
    const body = adviceId
        ? `[advisor:${severity}] ${text}\n（adviceId: ${adviceId}）`
        : `[advisor:${severity}] ${text}`;
    const summarySource = text.length > 0 ? text : severity;
    const summary = summarySource.length > SUMMARY_MAX_CHARS
        ? `${summarySource.slice(0, SUMMARY_MAX_CHARS - 1)}…`
        : summarySource;
    return {
        role: 'user',
        id: randomUUID(),
        content: [{ type: 'text', text: body }],
        source: {
            kind: 'plugin',
            plugin: 'advisor-flow',
            form: 'notice',
            summary,
        },
    };
}

/**
 * Create the advice delivery router.
 *
 * @param {object} [options]
 * @param {number} [options.immuneTurns] stepped turns an interrupting steer
 *   suppresses further steers for (default 2)
 * @param {(sessionId: string) => object} [options.lookupAgent] registry
 *   fallback for agents not in the map
 * @param {{ info?, warn?, error? }} [options.logger]
 */
export function createAdviceDelivery({ immuneTurns = 2, lookupAgent, logger = console } = {}) {
    const agents = new Map(); // session id → agent (agent.id === session.id)
    /** Per-session steer cooldown: remaining stepped turns (armed entries > 0). */
    const cooldown = new Map();
    /**
     * Per-session severity of the last steered interrupt: the cooldown fence
     * suppresses only the SAME severity inside the window ("送达后 N 个
     * stepped turn 内不再送同级") — a DIFFERENT interrupting severity still
     * steers (and re-arms the fence with its own level).
     */
    const lastSteered = new Map();

    let fence = Number.isInteger(immuneTurns) && immuneTurns >= 0 ? immuneTurns : 2;

    return {
        /** Register the session's agent (`agent/created`). */
        registerAgent(agent) {
            if (isRecord(agent) && typeof agent.id === 'string') {
                agents.set(agent.id, agent);
            }
        },

        /** Drop the agent — and its cooldown — on `agent/disposed`. */
        unregisterAgent(sessionId) {
            agents.delete(sessionId);
            cooldown.delete(sessionId);
            lastSteered.delete(sessionId);
        },

        /** Live-config updates re-arm the fence length on the next steer. */
        setImmuneTurns(value) {
            if (Number.isInteger(value) && value >= 0) {
                fence = value;
            }
        },

        /** One completed stepped primary turn: decrement the countdown. */
        onSteppedTurnEnd(sessionId) {
            const remaining = cooldown.get(sessionId);
            if (remaining === undefined || remaining <= 0) {
                return;
            }
            if (remaining <= 1) {
                cooldown.delete(sessionId);
            } else {
                cooldown.set(sessionId, remaining - 1);
            }
        },

        /** Compaction/rewrite clears the cooldown (turn-count basis is gone). */
        reset(sessionId) {
            cooldown.delete(sessionId);
            lastSteered.delete(sessionId);
        },

        /**
         * Route one advice. nit → inject; concern/blocker → steer unless the
         * fence is armed (downgrade to inject). A missing agent drops the
         * advice with a log. NEVER throws (agent-method throws are contained
         * here — the gate engine treats delivery as best-effort).
         *
         * @returns {'inject'|'steer'|undefined} the channel, or `undefined`
         *   when dropped
         */
        deliver(sessionId, advice) {
            try {
                const agent = agents.get(sessionId) ?? lookupAgent?.(sessionId);
                if (!isRecord(agent) || typeof agent.inject !== 'function') {
                    logger.warn?.('advisor-flow: advice dropped — no agent for session', { session: sessionId, severity: advice?.severity });
                    return undefined;
                }
                const message = buildAdviceMessage(advice);
                const severity = isInterrupting(advice?.severity) ? advice.severity : 'nit';
                const armed = cooldown.get(sessionId) ?? 0;
                if (isInterrupting(severity) && (armed <= 0 || lastSteered.get(sessionId) !== severity)) {
                    // May interrupt: the window is exhausted, OR this severity
                    // differs from the last steered level (the fence only
                    // suppresses the SAME level). Arm the fence BEFORE the
                    // call: a failed steer still counts as an attempted
                    // interrupt, keeping a throwing agent out of a noise loop.
                    if (fence > 0) {
                        cooldown.set(sessionId, fence);
                    }
                    lastSteered.set(sessionId, severity);
                    if (typeof agent.steer === 'function') {
                        agent.steer(message);
                        return 'steer';
                    }
                    // Agent without a steer seam: degrade to inject.
                }
                agent.inject(message);
                return 'inject';
            } catch (error) {
                logger.error?.('advisor-flow: advice delivery failed — contained', { session: sessionId, error: String(error) });
                return undefined;
            }
        },

        /** Status view: registered sessions, cooldowns, last steered levels. */
        status() {
            return {
                agents: [...agents.keys()],
                cooldowns: Object.fromEntries(cooldown),
                lastSteered: Object.fromEntries(lastSteered),
            };
        },
    };
}
