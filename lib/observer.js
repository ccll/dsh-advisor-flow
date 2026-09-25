/**
 * Session observer — the gate decisions' data source (R-01-004, R-01-005;
 * SOLUTION.md#会话观察, C-002).
 *
 * Consumes tool lifecycle events and maintains per-session {@link GateState}:
 * - failure streaks (tool name → consecutive failures, R-01-004);
 * - a single-slot consecutive-signature repetition state（pi recordToolCall
 *   连续语义，R-01-005/AC-06：同签名连续累加、异签名介入归 1；波动归一按
 *   pi normalizeToolInput——时间戳/请求 id 键值占位、临时路径占位、bash
 *   command 引号感知空白折叠）;
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

/** Bounds for the cross-seam result-identity dedup set. */
const MAX_SEEN_RESULTS = 512;

/** Long string truncation for argument canonicalization. */
const MAX_STRING_CHARS = 200;
/** Cap for the canonical argument serialization（移植侧内存界，pi 无此上限）. */
const MAX_KEY_CHARS = 512;

/** pi session-state.ts:34-44 波动键集（键名经 [-_] 剥离与小写归一后比对）. */
const TIMESTAMP_KEYS = new Set(['createdat', 'date', 'datetime', 'time', 'timestamp', 'updatedat']);
const REQUEST_ID_KEYS = new Set(['correlationid', 'requestid', 'traceid']);
const normalizedKey = (key) => key.replaceAll(/[-_]/gu, '').toLowerCase();
const isVolatileKey = (key, keys) => keys.has(normalizedKey(key));

const WHITESPACE = /\s/;

/** pi normalizeShellWhitespace（session-state.ts:47-77 逐条移植）：引号感知
 * 的空白折叠——引号内空白保留，引号外连续空白折叠为单空格。 */
function normalizeShellWhitespace(command) {
    let result = '';
    let quote;
    let pendingSpace = false;
    for (const char of command.trim()) {
        if (quote) {
            result += char;
            if (char === quote) {
                quote = undefined;
            }
            continue;
        }
        if (char === "'" || char === '"' || char === '`') {
            if (pendingSpace && result) {
                result += ' ';
            }
            pendingSpace = false;
            quote = char;
            result += char;
        } else if (WHITESPACE.test(char)) {
            pendingSpace = true;
        } else {
            if (pendingSpace && result) {
                result += ' ';
            }
            pendingSpace = false;
            result += char;
        }
    }
    return result;
}

/** pi normalizeString（session-state.ts:79-82）：临时路径占位。 */
const normalizeString = (value) =>
    value
        .replaceAll(/\/(?:private\/)?tmp\/[^\s/]+/gu, '/tmp/<temporary>')
        .replaceAll(/\/var\/folders\/[^\s/]+/gu, '/var/folders/<temporary>');

/**
 * Canonicalize a tool-args value for equivalence comparison（pi
 * normalizeToolInput 语义移植，R-01-005/AC-06 波动归一）：波动键（时间戳/
 * 请求 id）以占位符替代、临时路径占位、bash command 空白归一、对象键排序、
 * 长字符串截断带长度标记（移植侧内存界，pi 无此上限）。
 */
function canonicalize(value, toolName, key) {
    if (typeof value === 'string') {
        if (key && isVolatileKey(key, TIMESTAMP_KEYS)) {
            return '<timestamp>';
        }
        if (key && isVolatileKey(key, REQUEST_ID_KEYS)) {
            return '<request-id>';
        }
        const normalized = normalizeString(value);
        const shaped = toolName === 'bash' && key === 'command'
            ? normalizeShellWhitespace(normalized)
            : normalized;
        return shaped.length > MAX_STRING_CHARS
            ? `${shaped.slice(0, MAX_STRING_CHARS)}…(len=${shaped.length})`
            : shaped;
    }
    if (Array.isArray(value)) {
        return value.map((item) => canonicalize(item, toolName));
    }
    if (isRecord(value)) {
        return Object.fromEntries(Object.keys(value).sort().map((childKey) => [childKey, canonicalize(value[childKey], toolName, childKey)]));
    }
    return value;
}

/** Normalize tool args into a stable equivalence key（pi normalizedToolSignature
 * 语义：值级归一 + 键排序；工具名参与 bash command 特判）. */
export function normalizeToolArgs(args, toolName) {
    const serialized = JSON.stringify(canonicalize(args ?? {}, toolName)) ?? '{}';
    return serialized.length > MAX_KEY_CHARS
        ? `${serialized.slice(0, MAX_KEY_CHARS)}…(len=${serialized.length})`
        : serialized;
}

function emptyGateState() {
    return {
        failures: new Map(), // tool name → consecutive failure streak
        repetition: { count: 0, previousSignature: undefined }, // pi RepetitionState
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
         * Record one tool call at its pre-execute moment（pi recordToolCall
         * 连续语义，R-01-005/AC-06：计数随「上次签名是否相同」归位，而非
         * 按键跨调用累计——单槽 previousSignature 天然有界，无需逐键驱逐）。
         * Returns `{ key, count }` for the loop gate.
         */
        recordCall(sessionId, toolName, args) {
            const state = stateOf(sessionId);
            const key = `${toolName}::${normalizeToolArgs(args, toolName)}`;
            const repetition = state.repetition;
            repetition.count = key === repetition.previousSignature
                ? repetition.count + 1
                : 1;
            repetition.previousSignature = key;
            return { key, count: repetition.count };
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

        /** Current loop-equivalence count for one call（连续语义：仅当该调用
         * 形状正是当前连续签名时返回计数值，否则 0）. */
        loopCount(sessionId, toolName, args) {
            const key = `${toolName}::${normalizeToolArgs(args, toolName)}`;
            const repetition = stateOf(sessionId).repetition;
            return repetition.previousSignature === key ? repetition.count : 0;
        },

        /** pi resetRepetition（proceed 放行后的计数重置缝；累计干预数如后续
         * 状态面需要再补——T-013 范围）. */
        resetRepetition(sessionId) {
            const repetition = stateOf(sessionId).repetition;
            repetition.count = 0;
            repetition.previousSignature = undefined;
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
                return { failures: {}, repetitionCount: 0 };
            }
            return {
                failures: Object.fromEntries(state.failures),
                repetitionCount: state.repetition.count,
            };
        },
    };
}
