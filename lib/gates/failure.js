/**
 * Failure gate judge (R-01-004): consecutive failures of the same tool
 * reaching the configured threshold put the NEXT call of that tool under
 * review before it executes.
 *
 * @module dsh-advisor-flow/gates/failure
 */

/**
 * @param {object} gate resolved gate config `{ enabled, policy, threshold }`
 *   — `policy` may additionally be `block-session`
 * @param {number} failureStreak the observer's consecutive-failure count for
 *   the tool (from previous results, not counting the current call)
 * @returns {boolean} hit/miss
 */
export function judgeFailureGate(gate, failureStreak) {
    if (!gate?.enabled) {
        return false;
    }
    const threshold = Number.isInteger(gate.threshold) && gate.threshold > 0 ? gate.threshold : 3;
    return failureStreak >= threshold;
}
