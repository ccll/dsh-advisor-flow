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

import { DEFAULT_INTERVENTION_MODE } from './config.js';
import { isRecord } from './util.js';

/**
 * Create the status provider.
 *
 * @param {object} options
 * @param {object} options.config the RESOLVED `advisor-flow` config
 * @param {object} [options.engine] the consultation engine (per-session rows)
 * @param {object} [options.usageLedger] the usage ledger (usage summary)
 * @param {object|(() => object)} [options.degradations] live degraded-mode
 *   markers (e.g. `askPolicy: 'approver-seam-missing'`); may be a thunk so
 *   the snapshot never goes stale
 */
export function createStatusProvider({ config, engine, usageLedger, degradations } = {}) {
    return {
        /** Build one immutable status snapshot. Never throws. */
        snapshot() {
            // `config` may be an object or a live thunk (the bundle wiring
            // passes `() => config` so snapshots never go stale after
            // applyConfig).
            const raw = typeof config === 'function' ? config() : config;
            const cfg = isRecord(raw) ? raw : {};
            const advisor = isRecord(cfg.advisor) ? cfg.advisor : {};
            const sessions = typeof engine?.status === 'function' ? engine.status() : [];
            const usage = typeof usageLedger?.totals === 'function' ? usageLedger.totals() : undefined;
            // The engine's own counter is authoritative when present (it also
            // counts the in-flight consultation, which the per-session rows
            // already include); the row sum is the fallback.
            const pending = typeof engine?.pendingCount === 'number'
                ? engine.pendingCount
                : sessions.reduce((sum, row) => sum + (row.pending ?? 0), 0);
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
                failureMode: typeof cfg.failureMode === 'string' ? cfg.failureMode : 'warn-and-continue',
                // R-01-009/AC-10：介入强度快照（缺省随 DEFAULT_INTERVENTION_MODE，C-022）。
                mode: typeof cfg.mode === 'string' ? cfg.mode : DEFAULT_INTERVENTION_MODE,
                // Degraded-mode markers (e.g. guidelines seam without systemPrompt
                // seam) — visible by design, never silently absorbed.
                degradations: typeof degradations === 'function'
                    ? (degradations() ?? {})
                    : (isRecord(degradations) ? degradations : {}),
                sessions,
                pending,
                lastActivity,
                usage,
                // R-02-002/AC-04：逐次明细（记录列表，新者居末）。
                usageRecords: typeof usageLedger?.records === 'function' ? usageLedger.records() : [],
                // R-02-002/AC-05：配置预算时的剩余可用次数（逐会话）。
                budgetRemaining: sessions.reduce((acc, row) => {
                    if (typeof row?.session === 'string' && typeof engine?.remainingCalls === 'function') {
                        const remaining = engine.remainingCalls(row.session);
                        if (Number.isInteger(remaining)) {
                            acc[row.session] = remaining;
                        }
                    }
                    return acc;
                }, {}),
                // R-02-003/AC-03：门决策统计（放行/修订/阻断计数与干预累计）。
                gateDecisions: typeof engine?.decisionStats === 'function' ? engine.decisionStats() : undefined,
                // R-01-009/AC-10：收口评审计数（硬模式）。
                turnReviewStats: typeof engine?.turnReviewStats === 'function' ? engine.turnReviewStats() : undefined,
            };
        },
    };
}
