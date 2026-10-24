/**
 * Advisor usage ledger (R-02-002, C-003).
 *
 * Plugin-owned bookkeeping: per-consultation token/cost detail plus session
 * accumulation, classified by entry type (`tool` / `manual` / `gate`).
 * Provider usage fields that never arrived are recorded as the literal
 * string `'unavailable'` — never zero, so an unavailable measurement is
 * never presented as a free call (R-02-002/AC-02).
 * R-01-010：记录另按顾问携带 `model`/`batchId`/`durationMs`（缺省 =
 * unavailable），`batches()` 以 batchId 聚合批次合计（token/cost/durationMs）。
 *
 * Records can additionally be appended to a JSONL file (path configured via
 * `advisor-flow` settings, T-002 wiring); without a path the ledger stays
 * in-memory. Persistence failures are contained: they degrade to a logged
 * warning and never break the consultation path (non-stall invariant).
 *
 * @module dsh-advisor-flow/usage
 */

import { appendFileSync } from 'node:fs';
import { isRecord } from './util.js';

export const UNAVAILABLE = 'unavailable';
export const ENTRY_TYPES = ['tool', 'manual', 'gate', 'scout'];

/** 载体契约（T-008 staging 实弹核对，dsh-llm TokenUsage）：计数按
 * `inputTokens`（未缓存输入）/`outputTokens`/`cacheReadTokens`/
 * `cacheWriteTokens`/`totalTokens`/`reasoningTokens` 离散承载——无
 * `cacheTokens` 字段。导出供 status/commands 展示层复用（单点维护）。 */
export const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'reasoningTokens'];

/** Keep a bounded in-memory history so status stays cheap on long sessions. */
const DEFAULT_MAX_RECORDS = 256;

function normalizeField(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : UNAVAILABLE;
}

function isAvailable(value) {
    return typeof value === 'number';
}

/**
 * Create the usage ledger.
 *
 * @param {object} [options]
 * @param {string} [options.path] JSONL file to append records to; omit for
 *   memory-only operation
 * @param {{ appendFileSync?: Function }} [options.fs] injectable fs surface
 *   (tests); defaults to `node:fs`
 * @param {{ info?: Function, warn?: Function }} [options.logger] logger for
 *   contained persistence failures
 * @param {number} [options.maxRecords] in-memory history bound
 * @param {() => number} [options.clock] injectable epoch-ms clock (tests)
 */
export function createUsageLedger({ path, fs, logger, maxRecords = DEFAULT_MAX_RECORDS, clock = () => Date.now() } = {}) {
    const append = (fs && typeof fs.appendFileSync === 'function' ? fs : { appendFileSync }).appendFileSync;
    const records = [];
    // Per-entry-type totals; every subtotal starts `unavailable` and becomes a
    // number only once an available value has been seen for it.
    const totalsByEntry = new Map(ENTRY_TYPES.map((entry) => [entry, emptyTotals(entry)]));
    const grandTotals = emptyTotals('total');

    function emptyTotals(entry) {
        const totals = { entry, calls: 0, cost: UNAVAILABLE, durationMs: UNAVAILABLE };
        for (const field of TOKEN_FIELDS) {
            totals[field] = UNAVAILABLE;
        }
        return totals;
    }

    function accumulate(totals, record) {
        totals.calls += 1;
        for (const field of TOKEN_FIELDS) {
            if (isAvailable(record[field])) {
                totals[field] = isAvailable(totals[field]) ? totals[field] + record[field] : record[field];
            }
        }
        if (isAvailable(record.durationMs)) {
            totals.durationMs = isAvailable(totals.durationMs) ? totals.durationMs + record.durationMs : record.durationMs;
        }
        if (isAvailable(record.cost)) {
            totals.cost = isAvailable(totals.cost) ? totals.cost + record.cost : record.cost;
        }
    }

    return {
        /**
         * Record one consultation's usage. Missing provider fields become
         * `'unavailable'`; the record counts toward the entry-type counters
         * regardless. R-01-010：按顾问记录 model/batchId/durationMs（批次
         * 关联与合计的数据源；缺省 = unavailable 而非零）。
         */
        record(entry) {
            const request = isRecord(entry) ? entry : {};
            const record = {
                at: clock(),
                adviceId: typeof request.adviceId === 'string' ? request.adviceId : UNAVAILABLE,
                session: typeof request.session === 'string' ? request.session : UNAVAILABLE,
                entry: ENTRY_TYPES.includes(request.entry) ? request.entry : 'tool',
                model: typeof request.model === 'string' ? request.model : UNAVAILABLE,
                batchId: typeof request.batchId === 'string' ? request.batchId : UNAVAILABLE,
                durationMs: normalizeField(request.durationMs),
                cost: normalizeField(request.cost),
            };
            for (const field of TOKEN_FIELDS) {
                record[field] = normalizeField(request[field]);
            }
            records.push(record);
            if (records.length > maxRecords) {
                records.shift();
            }
            accumulate(totalsByEntry.get(record.entry), record);
            accumulate(grandTotals, record);
            if (path) {
                try {
                    append(path, `${JSON.stringify(record)}\n`);
                } catch (error) {
                    // Contained: persistence is an observability side channel.
                    logger?.warn?.('advisor-flow: usage record persistence failed — kept in memory', { error: String(error) });
                }
            }
            return record;
        },

        /**
         * Per-batch totals keyed by batchId (R-01-010 双顾问批次合计：
         * token/cost/durationMs 按批次聚合，缺项仍为 unavailable)。旧单顾问
         * 记录（batchId 不可得）不参与批次合计。
         */
        batches() {
            const byBatch = new Map();
            for (const record of records) {
                if (record.batchId === UNAVAILABLE) {
                    continue; // 旧单顾问记录（批次不可得）不参与批次合计
                }
                let totals = byBatch.get(record.batchId);
                if (!totals) {
                    totals = { batchId: record.batchId, calls: 0, cost: UNAVAILABLE, durationMs: UNAVAILABLE };
                    for (const field of TOKEN_FIELDS) {
                        totals[field] = UNAVAILABLE;
                    }
                    byBatch.set(record.batchId, totals);
                }
                accumulate(totals, record);
            }
            return [...byBatch.values()].map((totals) => ({ ...totals }));
        },

        /**
         * Totals snapshot, classified by entry type. A deep copy: callers
         * can never mutate the ledger's internal accumulators through the
         * snapshot (P5).
         */
        totals() {
            return {
                byEntry: Object.fromEntries([...totalsByEntry].map(([entry, totals]) => [entry, { ...totals }])),
                total: { ...grandTotals },
            };
        },

        /** The bounded in-memory record list (newest last). */
        records() {
            return [...records];
        },
    };
}
