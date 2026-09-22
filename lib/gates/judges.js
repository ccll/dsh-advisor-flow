/**
 * Gate judges — pure hit/miss functions, one per gate (R-01-003..R-01-006).
 *
 * Each judge receives the gate's resolved config (`{ enabled, policy,
 * threshold?, tools? }`) plus the data it needs and answers whether the gate
 * HITS at this pre-execute moment. Judges never throw and never touch I/O —
 * all orchestration lives in `lib/gates/index.js`.
 *
 * @module dsh-advisor-flow/gates/plan
 */

/**
 * Guarded tool list: the gate's own `tools` list when configured (unknown
 * keys survive config parsing as pass-through), else the built-in default.
 */
export function gateToolList(gate, defaults) {
    return Array.isArray(gate?.tools) && gate.tools.length > 0
        ? gate.tools.filter((tool) => typeof tool === 'string')
        : defaults;
}
