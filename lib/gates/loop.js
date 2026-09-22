/**
 * Loop gate judge (R-01-005): equivalent tool calls repeating up to the
 * configured threshold are intercepted BEFORE the repeated call executes.
 * Equivalence is keyed by tool name + normalized arguments.
 *
 * @module dsh-advisor-flow/gates/loop
 */

import { DEFAULT_GATE_THRESHOLD } from '../config.js';

/**
 * @param {object} gate resolved gate config `{ enabled, policy, threshold }`
 * @param {{ loopCount: number }} ctx the observer's equivalence count for
 *   THIS call (already incremented by `observer.recordCall`)
 * @returns {boolean} hit/miss
 */
export function judgeLoopGate(gate, { loopCount } = {}) {
    if (!gate?.enabled) {
        return false;
    }
    const threshold = Number.isInteger(gate.threshold) && gate.threshold > 0 ? gate.threshold : DEFAULT_GATE_THRESHOLD;
    return loopCount >= threshold;
}
