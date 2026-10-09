/**
 * Small shared helpers used across the advisor-flow modules.
 *
 * @module dsh-advisor-flow/util
 */

/** True for plain object values (null and arrays excluded). */
export const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The `'default'` bucket is a LAST-RESORT fallback shared by every seam — a
 * mis-wired event feeding `'default'` would mix gate/delivery state across
 * real sessions. 联调验证项（T-002 清单）：确认两条缝上真实会话标识的形状后
 * 收紧本兜底。
 */
const DEFAULT_SESSION = 'default';

/**
 * Resolve a session id from a carrier or event record (WIDE form). Carries:
 * `session` (string, `{ id }`, or a session/agent object passed directly),
 * `sessionId`, or the carrier's own `id` (session/disposed and
 * agent/created payloads identify themselves on `id`). A plain string id is
 * passed through as-is (session/disposed may deliver the bare id).
 */
/**
 * 咨询入口四态：工具、手动、循环门、收口评审。
 * consultation 入口归一与 subsession 标签共用此单点（T-022 双点收敛）；
 * usage 台账的入口枚举另含 scout，属计量口径差异，不并入。
 */
export const CONSULTATION_ENTRIES = Object.freeze(['tool', 'manual', 'gate', 'turn-review']);

export function sessionOf(record) {
    if (typeof record === 'string' && record.length > 0) {
        return record; // bare string id passed directly (session/disposed)
    }
    const direct = record?.session;
    if (typeof direct === 'string' && direct.length > 0) {
        return direct;
    }
    if (isRecord(direct) && typeof direct.id === 'string' && direct.id.length > 0) {
        return direct.id;
    }
    if (typeof record?.sessionId === 'string' && record.sessionId.length > 0) {
        return record.sessionId;
    }
    // Tool execution carriers (dsh-tools `tools/pre-execute`|`tools/result`):
    // the session identity rides `exec.agent` (agent.id === session.id —
    // dsh-agents resolves agents BY session id), not on a `session` field.
    if (isRecord(record?.agent) && typeof record.agent.id === 'string' && record.agent.id.length > 0) {
        return record.agent.id;
    }
    // Carrier objects (a session/agent passed directly, e.g. the
    // session/disposed and agent/created payloads) identify themselves on `id`.
    if (typeof record?.id === 'string' && record.id.length > 0) {
        return record.id;
    }
    return DEFAULT_SESSION;
}

/**
 * Resolve a session id from an event record (NARROW form — for result-shaped
 * events whose `id` field is EXECUTION identity, not a session). Only the
 * explicit session fields count; anything else falls to the shared
 * `'default'` bucket. This keeps a result event that only carries an
 * unrelated `id` from opening a per-execution orphan bucket where the
 * failure streak would silently never accumulate (the failure gate would go
 * blind). Direction matches the no-identity conservative counting bias.
 * 联调验证项（T-002 清单）：result 事件的真实会话字段形状。
 */
export function sessionOfEvent(record) {
    if (typeof record === 'string' && record.length > 0) {
        return record; // bare string id passed directly
    }
    const direct = record?.session;
    if (typeof direct === 'string' && direct.length > 0) {
        return direct;
    }
    if (isRecord(direct) && typeof direct.id === 'string' && direct.id.length > 0) {
        return direct.id;
    }
    if (typeof record?.sessionId === 'string' && record.sessionId.length > 0) {
        return record.sessionId;
    }
    return DEFAULT_SESSION;
}

/** pi advisorModelIsAllowed 语义共享谓词：白名单非空且顾问模型不在其中时
 * 为不可用（gates 与 guidelines 两处共用，Standards 轴发现③去重）。 */
export function advisorModelAllowed(config) {
    const whitelist = Array.isArray(config?.modelWhitelist) ? config.modelWhitelist : [];
    if (whitelist.length === 0) {
        return true;
    }
    return whitelist.includes(config?.advisor?.model);
}
