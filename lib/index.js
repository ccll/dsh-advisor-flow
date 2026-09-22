/**
 * dsh-advisor-flow — dsh bundle entry skeleton (T-001).
 *
 * Ports pi-advisor-flow's executor/advisor workflow to DeepSeek Harness:
 * the executor's daily model does the work; a stronger advisor model
 * provides second opinions at key moments. This file wires the T-001 core
 * (consultation service + tool face) onto the dsh seams and leaves the
 * remaining subsystems as explicit TODOs for their owning tasks:
 *
 * - T-002: settings bridge (`installSection` + `onChange` live re-apply,
 *   signature 变更才重建运行时)、门控服务（`tools/pre-execute` waterfall）、
 *   budget.maxPerSession enforcement;
 * - T-003: 命令面（/advisor-manual、/advisor status|gates|on|off）、
 *   web 设置卡 gateway RPC、意见送达（agent.inject/steer）。
 *
 * @module dsh-advisor-flow
 */

import { resolveAdvisorFlowConfig, ADVISOR_FLOW_NAMESPACE } from './config.js';
import { createConsultationEngine } from './consultation.js';
import { createAskAdvisorTool } from './tools/ask-advisor.js';
import { createUsageLedger } from './usage.js';
import { createStatusProvider } from './status.js';

export const name = 'dsh-advisor-flow';
/** Services the bundle consumes; the row loads once all are available. */
export const inject = ['llm'];
export { ADVISOR_FLOW_NAMESPACE, resolveAdvisorFlowConfig };

/**
 * Cordis plugin entry. `entryConfig` is the plugin-row config (the
 * `advisor-flow` composition base until the T-002 settings bridge layers
 * the live namespace on top).
 */
export function apply(ctx, entryConfig) {
    const logger = typeof ctx?.logger === 'function' ? ctx.logger('advisor-flow') : console;

    // handoff: a plugin ctx may sit in an isolated scope whose local llm has
    // NO provider adapter — always resolve the LLM service from the app root
    // (`ctx.root?.get?.('llm') ?? ctx.llm`), the NO_ADAPTER fix.
    const llm = ctx?.root?.get?.('llm') ?? ctx?.llm;

    const resolved = resolveAdvisorFlowConfig(entryConfig);
    if (resolved.ok) {
        for (const key of resolved.warnings) {
            logger.warn?.(`advisor-flow: 未知配置键（已保留透传）: ${key}`);
        }
    } else {
        for (const key of resolved.warnings) {
            logger.warn?.(`advisor-flow: 未知配置键（已保留透传）: ${key}`);
        }
        logger.warn?.(`advisor-flow: 配置解析被拒绝 — ${resolved.error}`);
    }
    const config = resolved.ok ? resolved.config : { enabled: false, reason: 'invalid-config' };

    // TODO(T-002): usage ledger persistence path comes from the settings
    // namespace (`advisor-flow.usage.path`) — memory-only until wired.
    const usageLedger = createUsageLedger({ logger });
    const engine = createConsultationEngine({ llm, config, logger, usageLedger });
    const askAdvisor = createAskAdvisorTool({ engine });
    const status = createStatusProvider({ config, engine, usageLedger });

    // TODO(T-002): settings bridge — register the `advisor-flow` section via
    // `ctx.inject(['settings'], …)` + `installSection`/`onChange`; re-resolve
    // and `engine.applyConfig()` (plus runtime rebuild) on signature change.
    // TODO(T-002): gate service — subscribe `ctx.on('tools/pre-execute', …)`
    // for plan/failure/loop/completion gates (consult() entry: 'gate').
    // TODO(T-002): enforce budget.maxPerSession per entry type.
    // TODO(T-003): commands — /advisor-manual、/advisor status|gates|on|off
    //   (resume() backs `/advisor on`; rebuild-on-halt is the command layer's
    //   dispose-and-recreate).
    // TODO(T-003): web settings card gateway RPC (`/api/advisor-flow/get|set`).
    // TODO(T-003): delivery — severity → agent.inject (nit) / agent.steer
    //   (concern|blocker), per-session agent map + immuneTurns cooldown.

    // Tool-face registration seam: fail LOUD. A missing seam means the
    // plugin's only user-facing surface (ask_advisor) silently vanishes —
    // that must surface at startup as an error, not as a quiet no-op. Only
    // the dispose path stays fault-tolerant (the non-stall invariant).
    const register = ctx?.tools?.register;
    if (typeof register !== 'function') {
        const detail = '工具注册缝缺失（ctx.tools.register 不存在）——ask_advisor 无法暴露，插件拒绝启动';
        logger.error?.(`advisor-flow: ${detail}`);
        throw new Error(`advisor-flow: ${detail}`);
    }
    try {
        register.call(ctx.tools, askAdvisor);
    } catch (error) {
        logger.error?.(`advisor-flow: ask_advisor 注册失败，插件拒绝启动: ${String(error)}`);
        throw error;
    }

    return {
        engine,
        askAdvisor,
        usage: usageLedger,
        status,
        config,
        /** Wired disposal seam (session/disposed / agent/disposed, T-002). */
        dispose: () => engine.dispose(),
    };
}

export default { name, inject, apply };
