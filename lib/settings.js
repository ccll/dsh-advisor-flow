/**
 * `advisor-flow` settings namespace registration (R-02-001; T-005 实测第四
 * 发现的落点): the web settings card renders only when the host
 * settings.describe SERVES the namespace AND a card is registered into the
 * settings.plugin.item slot — describe serves exactly the namespaces
 * registered host-side via `settings.installSection` (dsh-client-ui-settings-
 * plugins 实证). Without this registration the slot is never dispatched and
 * the card never appears, no matter the client bundle.
 *
 * Mirrors dsh-advisor's installAdvisorSettings pattern (SettingsProvider.
 * installSection 完整范例):
 * - conditional `ctx.inject(['settings'], …)` child (no settings service →
 *   no registration, degradation marker stays);
 * - `installSection(ctx, NAMESPACE, Schema, entry, { setSource, onChange })`
 *   — the source thunk serves the LIVE composed value; `onChange` fires at
 *   attach, on committed changes, and at detach;
 * - duplicate registration (multi-fiber) falls back to the entry source
 *   instead of crashing the load.
 *
 * The schema is declared with @deepseek-ai/schemastery (peer, resolved at
 * install time) — members stay optional (schema accepts partial input),
 * mirroring dsh-advisor's Config.
 *
 * @module dsh-advisor-flow/settings
 */

import z from '@deepseek-ai/schemastery';

export const ADVISOR_FLOW_SETTINGS_NAMESPACE = 'advisor-flow';

/**
 * Settings-page schema for the `advisor-flow` namespace: keys and shapes
 * mirror SOLUTION.md#产品契约 (the runtime parser in ./config.js remains the
 * SSOT for validation semantics — the schema exists for the settings
 * surface/describe; unknown keys merge through the non-strict resolver and
 * are warned + preserved there).
 *
 * 双清单纪律（与 config.js 互指）：新增配置键 = 两处双写义务——漏写
 * config.js 字段表则运行时拒绝该键，漏写本 Schema 则设置卡不可编辑该键。
 */
export const AdvisorFlowConfigSchema = z.object({
    enabled: z.boolean().default(false),
    advisor: z.object({
        provider: z.string(),
        model: z.string(),
        reasoningEffort: z.string(),
        maxTokens: z.number().step(1).min(1),
        callTimeoutMs: z.number().step(1).min(1),
    }),
    gates: z.object({
        plan: z.object({ enabled: z.boolean() }),
        failure: z.object({ enabled: z.boolean() }),
        loop: z.object({ enabled: z.boolean(), threshold: z.number().step(1).min(1) }),
        completion: z.object({ enabled: z.boolean() }),
    }),
    failureMode: z.union(['warn-and-continue', 'block-tool', 'block-session']).default('warn-and-continue'),
    privacy: z.object({
        history: z.string(),
        repoContext: z.string(),
        toolResults: z.string(),
        toolResultMaxBytes: z.number().step(1).min(1),
        fileContent: z.boolean(),
        redactSecrets: z.boolean(),
    }),
    budget: z.object({
        maxPerSession: z.number().step(1).min(0),
    }),
});

/**
 * Install the `advisor-flow` settings section and wire the live source.
 *
 * @param {object} ctx the plugin fiber context
 * @param {object} entry the plugin-row config (composition base)
 * @param {object} [options]
 * @param {{ info?, warn?, debug? }} [options.logger]
 * @param {() => void} [options.onChange] fired at attach / committed change /
 *   detach (the wiring resolves the source and live re-applies)
 * @param {(reason: string) => void} [options.onDegradation] attach-failure
 *   marker (installSection missing / unexpected error) — the wiring surfaces
 *   it in status degradations; contained, never crashes the load
 * @returns {{ source: () => object, onChange: (cb: Function) => void,
 *   isAttached: () => boolean }}
 */
export function installAdvisorFlowSettings(ctx, entry, { logger = console, onChange, onDegradation } = {}) {
    const listeners = new Set();
    let source = () => entry;
    const notify = () => {
        for (const listener of [...listeners]) {
            listener();
        }
    };
    let attached = false;
    ctx.inject(['settings'], (settingsCtx) => {
        if (typeof settingsCtx?.settings?.installSection !== 'function') {
            // 老形态 settings 服务：无 installSection 能力——describe 不会服务
            // 本命名空间（卡片缺失），显性化而非静默。
            onDegradation?.('install-section-missing');
            logger.warn?.('advisor-flow: settings 服务无 installSection 能力——section 未注册（联调验证项 T-002）');
            return;
        }
        try {
            settingsCtx.settings.installSection(ctx, ADVISOR_FLOW_SETTINGS_NAMESPACE, AdvisorFlowConfigSchema, entry, {
                setSource: (current) => {
                    // 契约传 source thunk（dsh-advisor 形态）；防御性归一——
                    // 裸值也容（包成 thunk），避免宿主形态漂移时热路径崩。
                    source = typeof current === 'function' ? current : () => current;
                },
                onChange: notify,
            });
            attached = true;
            if (typeof onChange === 'function') {
                listeners.add(onChange);
            }
            logger.info?.('advisor-flow: settings section 已注册（describe 服务 advisor-flow）');
        } catch (error) {
            // Multi-fiber dedupe (dsh-advisor 实测): the settings registration
            // fails loud on a duplicate namespace — a later fiber falls back to
            // the entry source (the FIRST fiber owns the live namespace).
            if (error instanceof Error && error.message.includes('already registered')) {
                attached = true; // 命名空间已在（describe 照常服务）——能力视为在
                logger.debug?.('advisor-flow: settings namespace already registered — entry-source fallback (multi-fiber dedupe)');
                return;
            }
            // 其余异常包含不进装载（装载期崩溃代价过高，T-005 实测教训）——
            // 显性化降级后继续。
            onDegradation?.('install-failed');
            logger.error?.(`advisor-flow: settings section 注册失败——describe 不服务 advisor-flow: ${String(error)}`);
        }
    });
    return {
        source: () => source(),
        onChange: (callback) => {
            listeners.add(callback);
        },
        isAttached: () => attached,
    };
}
