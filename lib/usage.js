/**
 * Advisor usage ledger (R-02-002, C-003).
 *
 * Plugin-owned bookkeeping: per-consultation token/cost detail plus session
 * accumulation, classified by entry type (`tool` / `manual` / `gate`).
 * Provider usage fields that never arrived are recorded as the literal
 * string `'unavailable'` — never zero, so an unavailable measurement is
 * never presented as a free call (R-02-002/AC-02).
 *
 * Records can additionally be appended to a JSONL file (path configured via
 * `advisor-flow` settings, T-002 wiring); without a path the ledger stays
 * in-memory. Persistence failures are contained: they degrade to a logged
 * warning and never break the consultation path (non-stall invariant).
 *
 * @module dsh-advisor-flow/usage
 */

import { appendFileSync } from 'node:fs';

export const UNAVAILABLE = 'unavailable';
export const ENTRY_TYPES = ['tool', 'manual', 'gate'];

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheTokens'];
const MONEY_FIELDS = ['cost'];

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
 */
export function createUsageLedger({ path, fs, logger, maxRecords = DEFAULT_MAX_RECORDS } = {}) {
    const append = (fs && typeof fs.appendFileSync === 'function' ? fs : { appendFileSync }).appendFileSync;
    const records = [];
    // Per-entry-type totals; every subtotal starts `unavailable` and becomes a
    // number only once an available value has been seen for it.
    const totalsByEntry = new Map(ENTRY_TYPES.map((entry) => [entry, emptyTotals(entry)]));
    const grandTotals = emptyTotals('total');

    function emptyTotals(entry) {
        return { entry, calls: 0, inputTokens: UNAVAILABLE, outputTokens: UNAVAILABLE, cacheTokens: UNAVAILABLE, cost: UNAVAILABLE };
    }

    function accumulate(totals, record) {
        totals.calls += 1;
        for (const field of [...TOKEN_FIELDS, ...MONEY_FIELDS]) {
            if (isAvailable(record[field])) {
                totals[field] = isAvailable(totals[field]) ? totals[field] + record[field] : record[field];
            }
        }
    }

    return {
        /**
         * Record one consultation's usage. Missing provider fields become
         * `'unavailable'`; the record counts toward the entry-type counters
         * regardless.
         */
        record(entry) {
            const request = isRecordSafe(entry) ? entry : {};
            const record = {
                at: Date.now(),
                adviceId: typeof request.adviceId === 'string' ? request.adviceId : UNAVAILABLE,
                session: typeof request.session === 'string' ? request.session : UNAVAILABLE,
                entry: ENTRY_TYPES.includes(request.entry) ? request.entry : 'tool',
                inputTokens: normalizeField(request.inputTokens),
                outputTokens: normalizeField(request.outputTokens),
                cacheTokens: normalizeField(request.cacheTokens),
                cost: normalizeField(request.cost),
            };
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

        /** Immutable totals snapshot, classified by entry type. */
        totals() {
            return {
                byEntry: Object.fromEntries(totalsByEntry),
                total: { ...grandTotals },
            };
        },

        /** The bounded in-memory record list (newest last). */
        records() {
            return [...records];
        },
    };
}

function isRecordSafe(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
