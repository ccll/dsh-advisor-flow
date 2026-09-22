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

import { resolveAdvisorFlowConfig } from './config.js';
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
 * @param {{ info?, warn?, error? }} [options.logger]
 * @returns {{ 'advisor-flow/get': Function, 'advisor-flow/set': Function }}
 */
export function createConfigGateway({ getRawConfig, applyResolved, logger = console } = {}) {
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
                    return {
                        ok: false,
                        error: `已启用但缺少 ${missing}——请补齐后再保存，否则咨询功能将整体禁用`,
                    };
                }
                const resolved = resolveAdvisorFlowConfig(merged);
                if (!resolved.ok) {
                    logger.warn?.('advisor-flow: 配置保存被拒绝（非法值）', { error: resolved.error });
                    return { ok: false, error: `配置无效，已拒绝保存：${resolved.error}` };
                }
                if (resolved.config.enabled && (!resolved.config.advisor.provider || !resolved.config.advisor.model)) {
                    const missing = !resolved.config.advisor.provider ? 'advisor.provider' : 'advisor.model';
                    return {
                        ok: false,
                        error: `已启用但缺少 ${missing}——请补齐后再保存，否则咨询功能将整体禁用`,
                    };
                }
                for (const warning of resolved.warnings) {
                    logger.warn?.(`advisor-flow: 未知配置键（已保留透传）: ${warning}`);
                }
                applyResolved(resolved.config, merged);
                return { ok: true, config: resolved.config, warnings: resolved.warnings };
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
