/**
 * Gate-result delivery — routing the loop gate's decision into the primary
 * session (R-01-005; SOLUTION.md#意见送达, C-007).
 *
 * - the gate result is steered UNCONDITIONALLY (`agent.steer`, waking): the
 *   executor must see the decision and the full advice markdown, whatever the
 *   decision is (pi 原生语义：无 severity 分流、无冷却);
 * - the message is a user-role message with the plugin identity on
 *   `source.plugin`（宿主 UserMessage 契约：content 为 ContentBlock 数组且带
 *   稳定 id）;
 * - a missing agent drops the message with a log — advisory only;
 * - the delivery router never throws: a broken channel can never fail-open a
 *   gate into a crash.
 *
 * @module dsh-advisor-flow/delivery
 */

import { randomUUID } from 'node:crypto';

import { isRecord } from './util.js';

/** Platform-convention collapsed-row summary bound (~120 chars). */
const SUMMARY_MAX_CHARS = 120;

function summaryOf(text) {
    const source = typeof text === 'string' ? text.trim() : '';
    if (source.length === 0) {
        return 'advisor 门结果';
    }
    return source.length > SUMMARY_MAX_CHARS ? `${source.slice(0, SUMMARY_MAX_CHARS - 1)}…` : source;
}

/** 软模式守则提醒文案（C-021；模型面文案英文，复述三类守则时机）。 */
export const GUIDELINE_REMINDER_TEXT =
    'Advisor guideline reminder: the conversation context was compacted and earlier advisor calls and their advice are no longer in view. The advisor invocation guidelines remain in effect: consult ask_advisor before committing to a materially consequential plan, after two consecutive materially equivalent failed attempts or when a fix recreates an earlier failure, and before declaring success.';

/**
 * Create the advice delivery router.
 *
 * @param {object} [options]
 * @param {(sessionId: string) => object} [options.lookupAgent] registry
 *   fallback for agents not in the map
 * @param {{ info?, warn?, error? }} [options.logger]
 */
export function createAdviceDelivery({ lookupAgent, logger = console } = {}) {
    const agents = new Map(); // session id → agent (agent.id === session.id)

    /** Shared steer primitive: one notice text into the executor's inbox. */
    function steerMessage(sessionId, text, label) {
        try {
            const agent = agents.get(sessionId) ?? lookupAgent?.(sessionId);
            if (!isRecord(agent) || typeof agent.steer !== 'function') {
                logger.warn?.(`advisor-flow: ${label} dropped — no agent for session`, { session: sessionId });
                return false;
            }
            agent.steer({
                role: 'user',
                id: randomUUID(),
                content: [{ type: 'text', text: typeof text === 'string' ? text : String(text ?? '') }],
                source: {
                    kind: 'plugin',
                    plugin: 'advisor-flow',
                    form: 'notice',
                    summary: summaryOf(text),
                },
            });
            return true;
        } catch (error) {
            logger.error?.(`advisor-flow: ${label} delivery failed — contained`, { session: sessionId, error: String(error) });
            return false;
        }
    }

    return {
        /** Register the session's agent (`agent/created`). */
        registerAgent(agent) {
            if (isRecord(agent) && typeof agent.id === 'string') {
                agents.set(agent.id, agent);
            }
        },

        /** Drop the agent on `agent/disposed`. */
        unregisterAgent(sessionId) {
            agents.delete(sessionId);
        },

        /**
         * Steer one gate-result message into the executor's inbox (waking —
         * the machine runs another step with the decision visible). A missing
         * agent drops the message with a log. NEVER throws.
         *
         * @param {string} sessionId the owning session id
         * @param {string} text the gate-result text（**Decision: X** + 全文）
         * @returns {boolean} whether the steer went out
         */
        steerAdvice(sessionId, text) {
            return steerMessage(sessionId, text, 'gate result');
        },

        /**
         * Steer one guideline reminder into the executor's inbox (soft mode,
         * C-021: fired after a compaction/rewrite event resets the behavioral
         * context that keeps the guidelines active). A missing agent drops
         * the message with a log. NEVER throws.
         *
         * @param {string} sessionId the owning session id
         * @returns {boolean} whether the steer went out
         */
        steerReminder(sessionId) {
            return steerMessage(sessionId, GUIDELINE_REMINDER_TEXT, 'guideline reminder');
        },

        /** Status view: registered sessions. */
        status() {
            return {
                agents: [...agents.keys()],
            };
        },
    };
}
