/**
 * Advisor status snapshot (R-02-003).
 *
 * A queryable snapshot of the advisor runtime: enabled state (with the
 * disabled-with-reason when applicable), the model route, per-session
 * runtime/pending/last-activity rows, and the usage summary. Gate state is
 * echoed from the parsed gate configuration until the gate service lands
 * (T-002 owns live gate state).
 *
 * @module dsh-advisor-flow/status
 */

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Create the status provider.
 *
 * @param {object} options
 * @param {object} options.config the RESOLVED `advisor-flow` config
 * @param {object} [options.engine] the consultation engine (per-session rows)
 * @param {object} [options.usageLedger] the usage ledger (usage summary)
 */
export function createStatusProvider({ config, engine, usageLedger } = {}) {
    return {
        /** Build one immutable status snapshot. Never throws. */
        snapshot() {
            const cfg = isRecord(config) ? config : {};
            const advisor = isRecord(cfg.advisor) ? cfg.advisor : {};
            const sessions = typeof engine?.status === 'function' ? engine.status() : [];
            const usage = typeof usageLedger?.totals === 'function' ? usageLedger.totals() : undefined;
            const pending = sessions.reduce((sum, row) => sum + (row.pending ?? 0), 0);
            const lastActivity = sessions.reduce((latest, row) => {
                return typeof row.lastActivity === 'number' && (latest === undefined || row.lastActivity > latest)
                    ? row.lastActivity
                    : latest;
            }, undefined);
            return {
                enabled: cfg.enabled === true,
                reason: cfg.reason,
                advisor: {
                    provider: advisor.provider,
                    model: advisor.model,
                    reasoningEffort: advisor.reasoningEffort,
                    maxTokens: advisor.maxTokens,
                    callTimeoutMs: advisor.callTimeoutMs,
                },
                // Gate configuration echo; live gate state arrives with T-002.
                gates: isRecord(cfg.gates) ? cfg.gates : {},
                sessions,
                pending,
                lastActivity,
                usage,
            };
        },
    };
}
