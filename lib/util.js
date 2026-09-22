/**
 * Small shared helpers used across the advisor-flow modules.
 *
 * @module dsh-advisor-flow/util
 */

/** True for plain object values (null and arrays excluded). */
export const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Resolve a session id from a carrier or event record. Both seams carry the
 * session on `session` (string or `{ id }`) or `sessionId`; the `'default'`
 * bucket is a LAST-RESORT fallback shared by every seam — a mis-wired event
 * feeding `'default'` would mix gate/delivery state across real sessions.
 * 联调验证项（T-002 清单）：确认两条缝上真实会话标识的形状后收紧本兜底。
 */
export function sessionOf(record) {
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
    return 'default';
}
