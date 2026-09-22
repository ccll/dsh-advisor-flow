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
 * invokes at the authoritative pre-execute moment — session/event
 * `tool/call` consumption would double-count the same dispatch. Result
 * events (`tool/result`) and reset events flow through {@link onEvent}.
 * Everything is bounded and never throws.
 *
 * @module dsh-advisor-flow/observer
 */

import { isRecord } from './util.js';

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

/** Bounds for the per-session loop-equivalence table. */
const MAX_LOOP_KEYS = 256;
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

function sessionOf(event) {
    if (typeof event?.session === 'string' && event.session.length > 0) {
        return event.session;
    }
    if (typeof event?.sessionId === 'string' && event.sessionId.length > 0) {
        return event.sessionId;
    }
    return 'default';
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

        /** Record one tool result; success breaks the failure streak. */
        recordResult(sessionId, toolName, ok) {
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
         * Consume one event from the wiring: `tool/result` updates failure
         * streaks; compaction/rewrite events reset the session state.
         * Tolerant of shape drift; never throws.
         */
        onEvent(event) {
            try {
                if (!isRecord(event)) {
                    return undefined;
                }
                const sessionId = sessionOf(event);
                if (typeof event.type === 'string' && RESET_EVENT_TYPES.has(event.type)) {
                    this.reset(sessionId);
                    logger.info?.('advisor-flow: observation state reset (compaction/rewrite)', { session: sessionId });
                    return { reset: true };
                }
                if (event.type === 'tool/result') {
                    // Explicit failure markers win; a bare result counts as success.
                    const ok = event.error !== undefined
                        ? false
                        : typeof event.ok === 'boolean'
                            ? event.ok
                            : typeof event.success === 'boolean'
                                ? event.success
                                : true;
                    const toolName = typeof event.tool === 'string' ? event.tool : 'unknown';
                    const streak = this.recordResult(sessionId, toolName, ok);
                    return { streak };
                }
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
