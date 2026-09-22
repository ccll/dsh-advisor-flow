/**
 * Small shared predicates used across the advisor-flow modules.
 *
 * @module dsh-advisor-flow/util
 */

/** True for plain object values (null and arrays excluded). */
export const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
