/**
 * Plan gate judge (R-01-003): the executor declaring a plan final (exiting
 * plan mode) is reviewed BEFORE the action executes.
 *
 * 载体契约（T-008 真机实测）：工具名在 `exec.name`——dsh-tools 0.1.5-rc.2 的
 * `tools/pre-execute` 载体是 `{name, arguments, agent, callId, …}`，没有
 * `tool`/`args`/`session` 字段。
 *
 * @module dsh-advisor-flow/gates/plan
 */

import { gateToolList } from './judges.js';

/** Default guarded tools: the exit-plan-mode family. */
export const DEFAULT_PLAN_TOOLS = ['exit_plan_mode'];

/**
 * @param {object} gate resolved gate config `{ enabled, policy, tools? }`
 * @param {object} exec the pre-execute carrier `{ name, arguments, agent }`
 * @returns {boolean} hit/miss
 */
export function judgePlanGate(gate, { exec } = {}) {
    if (!gate?.enabled) {
        return false;
    }
    return gateToolList(gate, DEFAULT_PLAN_TOOLS).includes(exec?.name);
}
