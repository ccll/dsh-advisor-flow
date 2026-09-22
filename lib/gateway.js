/**
 * Host-side `advisor-flow` config gateway: the `advisor-flow/get` +
 * `advisor-flow/set` RPC endpoints backing the web settings card
 * (SOLUTION.md#web 设置卡: the plugin's OWN gateway channel — the
 * `settings.describe` exposure path is NOT used; the host filters that wire
 * with a hardcoded namespace allowlist).
 *
 * Payload contract (dsh gateway convention, cf. dsh-advisor): one plain
 * `args` object; `get()` → `{ args: {} }`, `set(patch)` → `{ args: { patch } }`.
 *
 * `set` reuses `resolveAdvisorFlowConfig` as the single validation truth:
 * invalid values reject the whole save with the parser's message, unknown
 * keys warn and pass through (same semantics as settings.yaml), and the
 * enabled-without-provider/model shape is rejected HERE so the card cannot
 * save a config that would disable the feature wholesale (R-02-001/AC-03,
 * web-side experience). A valid save applies the resolved config live
 * (R-02-001/AC-01) and returns it.
 *
 * @module dsh-advisor-flow/gateway
 */

import { resolveAdvisorFlowConfig, advisorModelMissingMessage, SAVE_NOTICE_PERSISTED, SAVE_NOTICE_EPHEMERAL } from './config.js';
import { isRecord } from './util.js';

/**
 * Merge a patch onto the raw namespace: section objects merge per key so a
 * card saving `advisor.model` does not wipe `advisor.maxTokens`, and gate
 * sections merge per kind. Unknown keys inside the patch survive the merge
 * and flow through the parser's warn-and-preserve path.
 */
export function mergeAdvisorFlowConfig(base, patch) {
    const merged = { ...(isRecord(base) ? base : {}) };
    for (const key of Object.keys(patch)) {
        const incoming = patch[key];
        const current = merged[key];
        if (isRecord(incoming) && isRecord(current)) {
            const section = { ...current };
            for (const sub of Object.keys(incoming)) {
                if (key === 'gates' && isRecord(incoming[sub]) && isRecord(current[sub])) {
                    section[sub] = { ...current[sub], ...incoming[sub] };
                } else {
                    section[sub] = incoming[sub];
                }
            }
            merged[key] = section;
        } else {
            merged[key] = incoming;
        }
    }
    return merged;
}

/**
 * Create the two RPC handlers.
 *
 * @param {object} options
 * @param {() => object} options.getRawConfig the RAW namespace (the editable
 *   truth the card round-trips against)
 * @param {(resolved: object, raw: object) => void} options.applyResolved
 *   live re-apply of a valid save (bundle `applyConfig`)
 * @param {(raw: object) => Promise<void>} [options.persist] the settings
 *   write seam — persists the merged RAW namespace to settings.yaml under the
 *   `advisor-flow` key (merge semantics live in the seam: only this
 *   namespace's key is touched). Absent or throwing → the save stays
 *   runtime-only and the failure is surfaced loudly (never silent):
 *   `onPersistenceFailure` marks the status degradations.
 * @param {(reason: string) => void} [options.onPersistenceFailure] called
 *   once per failed persistence attempt (wiring marks status degradations)
 * @param {{ info?, warn?, error? }} [options.logger]
 * @returns {{ 'advisor-flow/get': Function, 'advisor-flow/set': Function }}
 */
export function createConfigGateway({ getRawConfig, applyResolved, persist, onPersistenceFailure, logger = console } = {}) {
    return {
        /** Readback: the raw namespace for the card form. */
        'advisor-flow/get': async () => {
            const config = getRawConfig() ?? {};
            const resolved = resolveAdvisorFlowConfig(config);
            return {
                config,
                resolved: resolved.ok ? resolved.config : undefined,
                warnings: resolved.ok ? resolved.warnings : [],
                error: resolved.ok ? undefined : resolved.error,
            };
        },

        /**
         * Validate + apply a patch. Returns `{ ok: true, config }` on a
         * valid save, `{ ok: false, error }` otherwise (invalid values,
         * unknown-shape junk, or the enabled-without-model block). Never
         * throws.
         */
        'advisor-flow/set': async (payload) => {
            try {
                const patch = payload?.args?.patch ?? payload?.patch;
                if (!isRecord(patch)) {
                    return { ok: false, error: '缺少 patch 对象（{ args: { patch } }）' };
                }
                const merged = mergeAdvisorFlowConfig(getRawConfig() ?? {}, patch);
                // The enabled-without-model block reads the RAW merged shape:
                // resolveAdvisorFlowConfig would have already flipped
                // `enabled` to false (disabled-with-reason), silently hiding
                // the misconfiguration instead of blocking the save
                // (R-02-001/AC-03 web side).
                const rawAdvisor = isRecord(merged.advisor) ? merged.advisor : {};
                if (merged.enabled === true && (!rawAdvisor.provider || !rawAdvisor.model)) {
                    const missing = rawAdvisor.provider ? 'advisor.model' : 'advisor.provider';
                    return { ok: false, error: advisorModelMissingMessage(missing) };
                }
                const resolved = resolveAdvisorFlowConfig(merged);
                if (!resolved.ok) {
                    logger.warn?.('advisor-flow: 配置保存被拒绝（非法值）', { error: resolved.error });
                    return { ok: false, error: `配置无效，已拒绝保存：${resolved.error}` };
                }
                for (const warning of resolved.warnings) {
                    logger.warn?.(`advisor-flow: 未知配置键（已保留透传）: ${warning}`);
                }
                applyResolved(resolved.config, merged);
                // Persistence (R-02-001/AC-01 持久化维度): write the merged
                // RAW namespace back through the settings bridge — merge
                // semantics live in the seam (only the advisor-flow key is
                // touched). A missing seam or a throwing write NEVER rolls
                // back the runtime apply; it degrades loudly instead.
                let persisted = false;
                let persistError;
                if (typeof persist === 'function') {
                    try {
                        await persist(merged);
                        persisted = true;
                    } catch (error) {
                        persisted = false;
                        persistError = String(error);
                        logger.error?.('advisor-flow: 配置持久化失败——保存仅为运行时态', { error: String(error) });
                        onPersistenceFailure?.('persist-write-failed');
                    }
                } else {
                    persisted = false;
                    onPersistenceFailure?.('settings-writer-seam-missing');
                }
                return {
                    ok: true,
                    config: resolved.config,
                    warnings: resolved.warnings,
                    persisted,
                    notice: persisted ? SAVE_NOTICE_PERSISTED : SAVE_NOTICE_EPHEMERAL,
                    ...(persistError ? { persistError } : {}),
                };
            } catch (error) {
                logger.error?.('advisor-flow: gateway set failed — contained', { error: String(error) });
                return { ok: false, error: `保存失败：${String(error)}` };
            }
        },
    };
}

/**
 * Register the handlers on the host gateway seam (probed by the wiring:
 * `ctx.gateway.register` / `ctx.typert.register` — 联调验证项, T-002 清单).
 *
 * @param {object} seam an object with `register(name, handler)`
 * @param {object} handlers the `{ 'advisor-flow/get', 'advisor-flow/set' }` map
 * @returns {Function} disposer
 */
export function registerConfigGateway(seam, handlers) {
    seam.register('advisor-flow/get', handlers['advisor-flow/get']);
    seam.register('advisor-flow/set', handlers['advisor-flow/set']);
    return () => {
        seam.unregister?.('advisor-flow/get');
        seam.unregister?.('advisor-flow/set');
    };
}
