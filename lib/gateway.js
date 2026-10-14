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
 * invalid values reject the whole save with the parser's message, and unknown
 * keys warn and pass through (same semantics as settings.yaml). A valid save
 * applies the resolved config live (R-02-001/AC-01) and returns it.
 * Enablement is derived (advisor.provider + advisor.model, C-030) — the
 * legacy `enabled` key warns (deprecation) and is ignored.
 *
 * @module dsh-advisor-flow/gateway
 */

import { resolveAdvisorFlowConfig, SAVE_NOTICE_PERSISTED, SAVE_NOTICE_EPHEMERAL, SAVE_NOTICE_WRITE_FAILED } from './config.js';
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
 *   write seam — persists the merged RAW namespace to the profile patch row
 *   config (0.2.0 SettingsForms `settings.update`; merge semantics live in
 *   the seam: only this namespace's key is touched). Absent or throwing →
 *   the save stays runtime-only and the failure is surfaced loudly (never
 *   silent): `onPersistenceFailure` marks the status degradations.
 * @param {(reason: string) => void} [options.onPersistenceFailure] called
 *   once per failed persistence attempt (wiring marks status degradations)
 * @param {() => void} [options.onPersistenceRecovered] called when a save
 *   persists AFTER a degraded episode — the wiring clears the degradations
 *   marker and re-arms the one-time failure log, so a NEW failure after
 *   recovery must become visible again (恢复后再次失败不得静默)
 * @param {(provider: string, model: string) => Promise<{ defaultMaxTokens?: number }>}
 *   [options.resolveModelLimits] host llm resolver adapter（lib/index.js 直接委派
 *   ctx.llm.resolveModelInfo，不吞错）——modelInfo 端点的数据源；抛错由本
 *   处理器统一降级并记 warn（resolve-failed）
 * @param {{ info?, warn?, error? }} [options.logger]
 * @returns {{ 'advisor-flow/get': Function, 'advisor-flow/set': Function, 'advisor-flow/modelInfo': Function }}
 */
export function createConfigGateway({ getRawConfig, applyResolved, persist, onPersistenceFailure, onPersistenceRecovered, resolveModelLimits, logger = console } = {}) {
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
         * `/api/advisor-flow/modelInfo`（T-034）：把宿主 llm 运行时的模型
         * 声明值透给设置卡——目录快照不携带 limits（宿主 session/
         * modelCatalog 只透出 provider/id/name/inputModalities），maxTokens
         * 占位数值只能经自有 RPC 问运行时（pi-ai 适配器对声明过 maxTokens
         * 的模型返回 defaultMaxTokens）。注入缺失/解析抛错/入参非法一律
         * `{ ok: false }` 降级——占位回退原文，绝不崩卡片。
         */
        'advisor-flow/modelInfo': async (payload) => {
            const args = payload?.args ?? payload ?? {};
            const provider = args.provider;
            const model = args.model;
            if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) {
                return { ok: false, reason: 'invalid-args' };
            }
            if (typeof resolveModelLimits !== 'function') {
                return { ok: false, reason: 'model-info-unavailable' };
            }
            try {
                const info = await resolveModelLimits(provider, model);
                const defaultMaxTokens = info?.defaultMaxTokens;
                return {
                    ok: true,
                    ...(Number.isInteger(defaultMaxTokens) && defaultMaxTokens > 0
                        ? { defaultMaxTokens }
                        : {}),
                };
            } catch (error) {
                logger.warn?.(`advisor-flow: modelInfo 解析失败（provider=${provider}, model=${model}）: ${String(error)}`);
                return { ok: false, reason: 'resolve-failed' };
            }
        },

        /**
         * Validate + apply a patch. Returns `{ ok: true, config }` on a
         * valid save, `{ ok: false, error }` otherwise (invalid values or
         * unknown-shape junk). Never throws.
         */
        'advisor-flow/set': async (payload) => {
            try {
                const patch = payload?.args?.patch ?? payload?.patch;
                if (!isRecord(patch)) {
                    return { ok: false, error: '缺少 patch 对象（{ args: { patch } }）' };
                }
                const merged = mergeAdvisorFlowConfig(getRawConfig() ?? {}, patch);
                const resolved = resolveAdvisorFlowConfig(merged);
                if (!resolved.ok) {
                    logger.warn?.('advisor-flow: 配置保存被拒绝（非法值）', { error: resolved.error });
                    return { ok: false, error: `配置无效，已拒绝保存：${resolved.error}` };
                }
                for (const warning of resolved.warnings) {
                    // 弃用告警（config.js）自带完整文案；未知键只是裸键名，
                    // 补「已保留透传」语境——不得给前者再套「未知键」前缀。
                    logger.warn?.(/[:：]/.test(warning)
                        ? `advisor-flow: ${warning}`
                        : `advisor-flow: 未知配置键（已保留透传）: ${warning}`);
                }
                applyResolved(resolved.config, merged);
                // Persistence (R-02-001/AC-01 持久化维度): write the merged
                // RAW namespace back through the settings bridge — merge
                // semantics live in the seam (only the advisor-flow key is
                // touched). A missing seam or a throwing write NEVER rolls
                // back the runtime apply; it degrades loudly instead.
                let persisted = false;
                let persistError;
                let notice = SAVE_NOTICE_EPHEMERAL;
                if (typeof persist === 'function') {
                    try {
                        await persist(merged);
                        persisted = true;
                        notice = SAVE_NOTICE_PERSISTED;
                        onPersistenceRecovered?.(); // 恢复：清除降级标注、重新武装一次性日志
                    } catch (error) {
                        persisted = false;
                        persistError = String(error);
                        notice = SAVE_NOTICE_WRITE_FAILED; // 失败专属文案：不误读为功能缺失
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
                    notice,
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
 * The explicit typert invocation contribution for the `advisor-flow` gateway
 * endpoints — registered via `ctx.typert.register(...)` inside the typert
 * conditional child (lib/typert-gateway.js). Mirrors dsh-advisor's
 * `advisorTypertContribution` descriptor shape: namespace = service key
 * `advisor-flow` → the host typertGateway derives `/api/advisor-flow/get|set`
 * (prefix rule: `/api/<namespace>/<method>`, namespace defaults to the cordis
 * service key). Explicit registration instead of @Remote SRC markers — the
 * marker table is module-private and a locally-linked plugin can never share
 * it with the host installation (dsh-advisor 实测结论).
 *
 * Pure data — testable without the typert peer dependency.
 */
export function advisorFlowTypertContribution() {
    return {
        package: 'dsh-advisor-flow',
        face: 'host',
        schemas: [],
        model: { services: [], events: [], objects: [] },
        invocations: [
            {
                id: 'dsh-advisor-flow#advisor-flow/get',
                service: 'advisor-flow',
                namespace: 'advisor-flow',
                method: 'get',
                invocation: { kind: 'direct' },
                parameters: [],
                result: { mode: 'src-json' },
            },
            {
                id: 'dsh-advisor-flow#advisor-flow/set',
                service: 'advisor-flow',
                namespace: 'advisor-flow',
                method: 'set',
                invocation: { kind: 'direct' },
                parameters: [
                    { name: 'patch', wire: 'patch', source: 'json', codec: { mode: 'src-json' } },
                ],
                result: { mode: 'src-json' },
            },
            {
                id: 'dsh-advisor-flow#advisor-flow/modelInfo',
                service: 'advisor-flow',
                namespace: 'advisor-flow',
                method: 'modelInfo',
                invocation: { kind: 'direct' },
                parameters: [
                    { name: 'provider', wire: 'provider', source: 'json', codec: { mode: 'src-json' } },
                    { name: 'model', wire: 'model', source: 'json', codec: { mode: 'src-json' } },
                ],
                result: { mode: 'src-json' },
            },
        ],
    };
}

/**
 * typertGateway wire-boundary normalization: JSON cannot carry undefined, and
 * the gateway result validator REJECTS undefined values — strip every
 * undefined-valued key (recursively; null survives, arrays keep elements but
 * their contents are normalized too). Pure — testable without peer deps.
 */
export function toWireJson(value) {
    if (Array.isArray(value)) {
        return value.map((item) => toWireJson(item));
    }
    if (isRecord(value)) {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (item === undefined) {
                continue; // absent, never present-as-undefined
            }
            out[key] = toWireJson(item);
        }
        return out;
    }
    return value;
}
