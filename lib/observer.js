/**
 * Session observer — the gate decisions' data source (R-01-004, R-01-005;
 * SOLUTION.md#会话观察, C-002).
 *
 * Consumes tool lifecycle events and maintains per-session {@link GateState}:
 * - failure streaks (tool name → consecutive failures, R-01-004);
 * - a loop-equivalence table (tool name + normalized-args hash → count with
 *   first-seen order, R-01-005) — equivalence is decided by tool name and
 *   canonicalized parameters, so a material argument change lands on a fresh
 *   key (R-01-005/AC-03);
 * - compaction/rewrite events reset the session's observation state (C-002:
 *   the transcript basis is being rewritten, old counts no longer apply).
 *
 * Call counting happens through {@link recordCall}, which the gate engine
 * invokes at the authoritative pre-execute moment, and through
 * {@link recordResult}, which the wiring feeds from the authoritative
 * `tools/result` lifecycle seam (`(exec, result)` — `exec.name` +
 * `result.isError` + `exec.callId`). Session/event records carry no tool
 * name, so they never feed counting (T-008 实测裁决); only reset events
 * flow through {@link onEvent}. Everything is bounded and never throws.
 *
 * @module dsh-advisor-flow/observer
 */

import { isRecord, sessionOf, sessionOfEvent } from './util.js';

/** Event types that reset a session's observation state (compress/rewrite). */
const RESET_EVENT_TYPES = new Set([
    'compact',
    'compaction',
    'compacted',
    'session/compact',
    'session/compacted',
    'rewrite',
    'session/rewrite',
]);

/**
 * Classify one `session/event` payload into the taxonomy the bundle wiring
 * consumes: `'turn-end'` = one completed stepped primary turn (drives the
 * delivery cooldown countdown); `'reset'` = compaction/rewrite (resets
 * observation state AND the cooldown); anything else is `'unknown'` and must
 * be ignored (with a debug log at the wiring). Shapes follow the handoff
 * facts (dsh-advisor's transcript-observer pattern); every unrecognized
 * variant must degrade to 'unknown' rather than guess.
 * 联调验证项（T-002 清单）：turn/end 与压缩事件的真实字段形状。
 *
 * @returns {'turn-end'|'reset'|'unknown'}
 */
export function classifySessionEvent(event) {
    const type = typeof event?.type === 'string' ? event.type : '';
    if (type === 'turn/end' || type === 'turn-end' || type === 'turn_end') {
        return 'turn-end';
    }
    if (RESET_EVENT_TYPES.has(type)) {
        return 'reset';
    }
    return 'unknown';
}

/** Bounds for the per-session loop-equivalence table. */
const MAX_LOOP_KEYS = 256;
/** Bounds for the cross-seam result-identity dedup set. */
const MAX_SEEN_RESULTS = 512;

/** Long string truncation for argument canonicalization. */
const MAX_STRING_CHARS = 200;
/** Cap for the canonical argument serialization. */
const MAX_KEY_CHARS = 512;

/**
 * Canonicalize a tool-args value for equivalence comparison: object keys are
 * sorted, arrays keep order, long strings are truncated with a length
 * marker so content changes stay visible while pathological payloads stay
 * bounded.
 */
function canonicalize(value) {
    if (typeof value === 'string') {
        return value.length > MAX_STRING_CHARS
            ? `${value.slice(0, MAX_STRING_CHARS)}…(len=${value.length})`
            : value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => canonicalize(item));
    }
    if (isRecord(value)) {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
}

/** Normalize tool args into a stable equivalence key. */
export function normalizeToolArgs(args) {
    const serialized = JSON.stringify(canonicalize(args ?? {})) ?? '{}';
    return serialized.length > MAX_KEY_CHARS
        ? `${serialized.slice(0, MAX_KEY_CHARS)}…(len=${serialized.length})`
        : serialized;
}

function emptyGateState() {
    return {
        failures: new Map(), // tool name → consecutive failure streak
        loopCounts: new Map(), // equivalence key → { count, firstSeen }
    };
}

/**
 * Create the session observer.
 *
 * @param {object} [options]
 * @param {{ info?, warn?, error? }} [options.logger]
 */
export function createSessionObserver({ logger = console } = {}) {
    const sessions = new Map(); // session id → GateState
    /** Cross-seam execution-identity dedup set (bounded, insertion-order evict). */
    const seenResults = new Map();

    function stateOf(sessionId) {
        let state = sessions.get(sessionId);
        if (!state) {
            state = emptyGateState();
            sessions.set(sessionId, state);
        }
        return state;
    }

    return {
        /**
         * Record one tool call at its pre-execute moment. Increments the
         * loop-equivalence counter for `tool` + normalized `args` and returns
         * `{ key, count }` for the loop gate. Bounded: the oldest keys are
         * evoked once the table overflows.
         */
        recordCall(sessionId, toolName, args) {
            const state = stateOf(sessionId);
            const key = `${toolName}::${normalizeToolArgs(args)}`;
            const entry = state.loopCounts.get(key);
            if (entry) {
                entry.count += 1;
            } else {
                state.loopCounts.set(key, { count: 1, firstSeen: state.loopCounts.size });
                if (state.loopCounts.size > MAX_LOOP_KEYS) {
                    // Evict the oldest entries to keep the table bounded.
                    const oldest = [...state.loopCounts.entries()]
                        .sort((a, b) => a[1].firstSeen - b[1].firstSeen)
                        .slice(0, state.loopCounts.size - MAX_LOOP_KEYS);
                    for (const [stale] of oldest) {
                        state.loopCounts.delete(stale);
                    }
                }
            }
            return { key, count: state.loopCounts.get(key).count };
        },

        /**
         * Record one tool result; success breaks the failure streak.
         *
         * `identity`（执行标识，可选）支撑双缝去重：同一工具执行的结果经
         * 「生命周期 tools/result」与「session/event」两条缝都可能到达，带
         * 标识的重复投递只计一次；无标识的事件保守逐次计数（宁可阈值偏差
         * 一格，不可让失败门失去输入）。缝的最终取舍归 T-002 联调实测决定，
         * 当前实现对「双缝均达」与「仅单缝」两种结论都稳健。
         */
        recordResult(sessionId, toolName, ok, identity) {
            if (identity !== undefined) {
                const seenKey = `${sessionId}\u0000${toolName}\u0000${identity}`;
                if (seenResults.has(seenKey)) {
                    return this.failureStreak(sessionId, toolName); // 重复投递：不计数
                }
                seenResults.set(seenKey, true);
                if (seenResults.size > MAX_SEEN_RESULTS) {
                    // Bounded memory: evict the oldest identities (insertion order).
                    const oldest = seenResults.keys().next().value;
                    seenResults.delete(oldest);
                }
            }
            const state = stateOf(sessionId);
            if (ok) {
                state.failures.delete(toolName);
                return 0;
            }
            const streak = (state.failures.get(toolName) ?? 0) + 1;
            state.failures.set(toolName, streak);
            return streak;
        },

        /** Current consecutive-failure streak for one tool (0 when none). */
        failureStreak(sessionId, toolName) {
            return stateOf(sessionId).failures.get(toolName) ?? 0;
        },

        /** Current loop-equivalence count for one call (0 before first call). */
        loopCount(sessionId, toolName, args) {
            const key = `${toolName}::${normalizeToolArgs(args)}`;
            return stateOf(sessionId).loopCounts.get(key)?.count ?? 0;
        },

        /** Clear one equivalence key's count (post-deny reset, anti-stuck). */
        resetLoopKey(sessionId, key) {
            stateOf(sessionId).loopCounts.delete(key);
        },

        /** Clear one tool's failure streak (post-deny reset, anti-stuck). */
        resetFailures(sessionId, toolName) {
            stateOf(sessionId).failures.delete(toolName);
        },

        /** Reset a session's whole observation state (compaction/rewrite). */
        reset(sessionId) {
            sessions.set(sessionId, emptyGateState());
        },

        /** Reset every session (runtime rebuild on config signature change). */
        resetAll() {
            sessions.clear();
        },

        /**
         * Consume one event from the wiring: reset events (compaction/
         * rewrite) clear the session state; result-shaped events update the
         * failure streak. Tolerant of shape drift; never throws. The event
         * TYPE taxonomy is shared with the bundle wiring via
         * {@link classifySessionEvent} — 单一来源，避免双缝分类漂移.
         */
        /**
         * Consume one event from the wiring: reset events (compaction/
         * rewrite) clear the session state. Result-shaped session records are
         * deliberately NOT counted here — the dsh session store's
         * `tool/result` record carries no tool name (only callId/content), so
         * a failure cannot be attributed to a tool; the authoritative
         * failure-counting seam is the two-arg `tools/result` lifecycle event
         * (exec, result — exec.name + result.isError), consumed by the wiring
         * directly via {@link recordResult}. Tolerant of shape drift; never
         * throws. The event TYPE taxonomy is shared with the bundle wiring
         * via {@link classifySessionEvent} — 单一来源，避免双缝分类漂移.
         */
        onEvent(event) {
            try {
                if (!isRecord(event)) {
                    return undefined;
                }
                // NARROW session resolution: a result event's bare `id` field
                // is EXECUTION identity, not a session — the wide form would
                // open a per-execution orphan bucket where the failure streak
                // never accumulates (the failure gate silently goes blind).
                const sessionId = sessionOfEvent(event);
                const kind = classifySessionEvent(event);
                if (kind === 'reset') {
                    this.reset(sessionId);
                    logger.info?.('advisor-flow: observation state reset (compaction/rewrite)', { session: sessionId });
                    return { reset: true };
                }
                // Everything else (result-shaped records included) is ignored:
                // counting happens at the authoritative pre-execute/result
                // lifecycle seams only.
                return undefined;
            } catch (error) {
                // Observation must never break the session event pipeline.
                logger.error?.('advisor-flow: observer event handling failed — contained', { error: String(error) });
                return undefined;
            }
        },

        /** Debug/status view of one session's counters. */
        snapshot(sessionId) {
            const state = sessions.get(sessionId);
            if (!state) {
                return { failures: {}, loopKeys: 0 };
            }
            return {
                failures: Object.fromEntries(state.failures),
                loopKeys: state.loopCounts.size,
            };
        },
    };
}
