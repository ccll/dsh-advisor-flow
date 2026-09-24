/**
 * Decision-line parser for automatic gate responses (R-01-005; ported from
 * pi-advisor-flow 0.8.1 src/tools/gate-protocol.ts — C-007).
 *
 * The advisor's gate reply must begin with exactly `Decision: proceed`,
 * `Decision: revise`, or `Decision: blocked`. The parser is adversarial:
 * - a repeated or CONTRADICTORY decision line anywhere in the reply fails
 *   the parse (a prompt-injection or model drift cannot quietly flip the
 *   verdict after the fact);
 * - `Decision:` lines inside balanced code fences are illustrative and never
 *   counted — but if the fence never closes, its decisions ARE retained so
 *   malformed Markdown cannot make the gate fail open;
 * - an empty reply, a missing decision line, or a malformed variant is a
 *   named failure category, dispositioned by the gate's failure mode.
 *
 * The parser never throws.
 *
 * @module dsh-advisor-flow/decision
 */

const DECISION_LINE = /^Decision\s*:\s*(proceed|revise|blocked)\s*$/i;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LINE_BREAK = /\r?\n/;

/** Failure categories for a gate response that yields no valid decision. */
export const DECISION_FAILURE_CATEGORIES = [
    'provider-error',
    'empty-response',
    'missing-decision',
    'malformed-decision',
    'duplicate-decision',
    'contradictory-decision',
    'budget-exhausted',
];


/**
 * Parse one advisor gate reply into a decision outcome.
 *
 * @param {string} text the advisor's full markdown reply
 * @returns {{ ok: true, decision: 'proceed'|'revise'|'blocked', markdown: string }
 *   | { ok: false, category: string, message: string, markdown?: string }} the
 *   parsed decision, or a named failure category (never throws)
 */
export function parseDecision(text) {
    const markdown = typeof text === 'string' ? text : '';
    const lines = markdown.split(LINE_BREAK);
    const nonEmpty = lines.findIndex((line) => line.trim().length > 0);
    if (nonEmpty === -1) {
        return { ok: false, category: 'empty-response', message: '顾问返回了空的门评审回复。' };
    }
    const first = lines[nonEmpty].trim();
    const match = DECISION_LINE.exec(first);
    if (!match) {
        return {
            ok: false,
            category: first.toLowerCase().startsWith('decision:')
                ? 'malformed-decision'
                : 'missing-decision',
            markdown,
            message: '顾问门评审回复必须以 Decision: proceed、Decision: revise 或 Decision: blocked 开头。',
        };
    }
    const decision = match[1].toLowerCase();
    let openingFence;
    const decisions = [];
    let pendingFencedDecisions = [];
    for (const line of lines.slice(nonEmpty + 1)) {
        const trimmed = line.trim();
        // 平衡围栏内的 Decision 行是示例，不采信；记住围栏开符号，字符或
        // 长度不匹配、带注记都不能闭合。未闭合的围栏保留其中的决策行，
        // 让畸形 Markdown 不至于让门 fail-open。
        const fence = CODE_FENCE.exec(line);
        if (fence) {
            const marker = fence[1];
            const suffix = fence[2];
            let closed = false;
            if (!openingFence) {
                if (marker[0] === '`' && suffix.includes('`')) {
                    openingFence = undefined;
                } else {
                    openingFence = { character: marker[0], length: marker.length };
                }
            } else if (
                suffix.trim().length > 0 ||
                marker[0] !== openingFence.character ||
                marker.length < openingFence.length
            ) {
                // keep the opening fence
            } else {
                closed = true;
                openingFence = undefined;
            }
            if (closed) {
                pendingFencedDecisions = [];
            }
            continue;
        }
        const subsequent = DECISION_LINE.exec(trimmed);
        if (!subsequent) {
            continue;
        }
        const repeated = subsequent[1].trim().toLowerCase();
        if (openingFence) {
            pendingFencedDecisions.push(repeated);
        } else {
            decisions.push(repeated);
        }
    }
    if (openingFence) {
        decisions.push(...pendingFencedDecisions);
    }
    for (const repeated of decisions) {
        if (repeated === decision) {
            return { ok: false, category: 'duplicate-decision', markdown, message: '顾问门评审回复包含重复的决策行。' };
        }
        return { ok: false, category: 'contradictory-decision', markdown, message: '顾问门评审回复包含相互矛盾的决策行。' };
    }
    return { ok: true, decision, markdown };
}

/**
 * The executor-facing gate result text: the bolded decision line followed by
 * the full advice markdown (pi `adviceForGateText` semantics).
 *
 * @param {{ decision: string, markdown: string }} result
 * @returns {string}
 */
export function adviceForGateText(result) {
    return `**Decision: ${result.decision}**\n\n${result.markdown}`;
}
