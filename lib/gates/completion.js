/**
 * Completion gate judge (R-01-006): the executor declaring the task done
 * (concludes-turn tools) is reviewed BEFORE the declaration takes effect.
 *
 * @module dsh-advisor-flow/gates/completion
 */

import { gateToolList } from './judges.js';

/** Default guarded tools: the turn-concluding family. */
export const DEFAULT_COMPLETION_TOOLS = ['concludesTurn'];

/**
 * @param {object} gate resolved gate config `{ enabled, policy, tools? }`
 * @param {object} exec the pre-execute carrier `{ tool, args, session }`
 * @returns {boolean} hit/miss
 */
export function judgeCompletionGate(gate, exec) {
    if (!gate?.enabled) {
        return false;
    }
    return gateToolList(gate, DEFAULT_COMPLETION_TOOLS).includes(exec?.tool);
}
