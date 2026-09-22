/**
 * Plan gate judge (R-01-003): the executor declaring a plan final (exiting
 * plan mode) is reviewed BEFORE the action executes.
 *
 * @module dsh-advisor-flow/gates/plan
 */

import { gateToolList } from './judges.js';

/** Default guarded tools: the exit-plan-mode family. */
export const DEFAULT_PLAN_TOOLS = ['exit_plan_mode'];

/**
 * @param {object} gate resolved gate config `{ enabled, policy, tools? }`
 * @param {object} exec the pre-execute carrier `{ tool, args, session }`
 * @returns {boolean} hit/miss
 */
export function judgePlanGate(gate, { exec } = {}) {
    if (!gate?.enabled) {
        return false;
    }
    return gateToolList(gate, DEFAULT_PLAN_TOOLS).includes(exec?.tool);
}
