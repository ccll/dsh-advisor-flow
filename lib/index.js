/**
 * dsh-advisor-flow — dsh bundle entry (T-001 core + T-003 gates/observer/
 * delivery).
 *
 * Ports pi-advisor-flow's executor/advisor workflow to DeepSeek Harness:
 * the executor's daily model does the work; a stronger advisor model
 * provides second opinions at key moments, with review gates in front of
 * critical tool actions. Remaining subsystems stay as explicit TODOs:
 *
 * - T-002: settings bridge (`installSection` + `onChange` live re-apply,
 *   signature 变更才重建运行时)、budget.maxPerSession enforcement;
 * - T-004: 命令面（/advisor-manual、/advisor status|gates|on|off）、
 *   web 设置卡 gateway RPC。
 *
 * @module dsh-advisor-flow
 */

import { resolveAdvisorFlowConfig, ADVISOR_FLOW_NAMESPACE } from './config.js';
import { createConsultationEngine } from './consultation.js';
import { createAskAdvisorTool } from './tools/ask-advisor.js';
import { createUsageLedger } from './usage.js';
import { createStatusProvider } from './status.js';
import { createSessionObserver, classifySessionEvent } from './observer.js';
import { sessionOf } from './util.js';
import { createGateEngine } from './gates/index.js';
import { createAdviceDelivery } from './delivery.js';

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
    let config = resolved.ok ? resolved.config : { enabled: false, reason: 'invalid-config' };

    // TODO(T-002): usage ledger persistence path comes from the settings
    // namespace (`advisor-flow.usage.path`) — memory-only until wired.
    const usageLedger = createUsageLedger({ logger });
    const engine = createConsultationEngine({ llm, config, logger, usageLedger });
    const askAdvisor = createAskAdvisorTool({ engine });
    const observer = createSessionObserver({ logger });
    const delivery = createAdviceDelivery({ logger, lookupAgent: (sessionId) => ctx?.agents?.get?.(sessionId) });
    // ask 策略的人工审批缝：尽力探测宿主 approval 缝。拿不到时必须显性化
    // （一次性 error + 状态快照 degraded 标注），不得静默 fail-open——
    // ask 门在无审批缝时的放行是 degraded 行为，会话主必须可见。
    // 联调验证项（T-002 清单）：宿主 approval 通道的真实形态。
    const approvalSeam = ctx?.approvals ?? ctx?.approval;
    const approvalRequest = approvalSeam?.request ?? approvalSeam?.ask;
    const approver = typeof approvalRequest === 'function'
        ? (request) => approvalRequest.call(approvalSeam, request)
        : undefined;
    const degradations = {};
    if (!approver) {
        degradations.askPolicy = 'approver-seam-missing';
        logger.error?.('advisor-flow: 人工审批缝不可得（ctx.approvals/approval）——ask 策略门将 fail-open 放行（degraded），接入审批缝前请在状态页关注');
    }
    // block-session 的会话停止缝：尽力探测宿主会话停止能力；拿不到时门引擎
    // 会在命中时显性化「会话停止未执行」（deny 兜底路径不受影响）。
    // 联调验证项（T-002 清单）：宿主会话停止（agent cancel 类）缝的真实形态。
    const sessionStopSeam = ctx?.agent?.cancel ?? ctx?.agents?.cancel ?? ctx?.cancelSession;
    const stopSession = typeof sessionStopSeam === 'function'
        ? (context) => sessionStopSeam.call(ctx?.agent ?? ctx?.agents ?? ctx, context)
        : undefined;
    const gateEngine = createGateEngine({
        consult: (request) => engine.consult(request),
        observer,
        delivery: (sessionId, advice) => delivery.deliver(sessionId, advice),
        policyLookup: (gateKind) => config.gates?.[gateKind],
        approver,
        stopSession,
        logger,
    });
    const status = createStatusProvider({ config: () => config, engine, usageLedger, degradations: () => degradations });

    // TODO(T-002): settings bridge — register the `advisor-flow` section via
    // `ctx.inject(['settings'], …)` + `installSection`/`onChange`; re-resolve
    // and re-apply on signature change (see applyConfig below).
    // TODO(T-002): enforce budget.maxPerSession per entry type.
    // TODO(T-004): commands — /advisor-manual、/advisor status|gates|on|off
    //   (resume() backs `/advisor on`; rebuild-on-halt is the command layer's
    //   dispose-and-recreate).
    // TODO(T-004): web settings card gateway RPC (`/api/advisor-flow/get|set`).

    // Live config re-apply: consultations pick the new config up per call;
    // a GATE-CONFIG signature change rebuilds gate state (atomic — pending
    // counters belong to the old rules).
    let gateSignature = JSON.stringify(config.gates ?? {});
    function applyConfig(nextResolved) {
        if (!nextResolved || typeof nextResolved !== 'object') {
            return;
        }
        config = nextResolved;
        engine.applyConfig(nextResolved);
        const signature = JSON.stringify(config.gates ?? {});
        if (signature !== gateSignature) {
            gateSignature = signature;
            observer.resetAll();
            logger.info?.('advisor-flow: gate config changed — gate state rebuilt', {});
        }
    }

    // dsh event wiring (handoff-verified seams). A missing event seam means
    // the gates cannot work at all — fail loud, consistent with the tool
    // registration seam; only runtime paths stay fault-tolerant.
    const on = ctx?.on;
    if (typeof on !== 'function') {
        const detail = '事件订阅缝缺失（ctx.on 不存在）——门控无法工作，插件拒绝启动';
        logger.error?.(`advisor-flow: ${detail}`);
        throw new Error(`advisor-flow: ${detail}`);
    }
    on.call(ctx, 'tools/pre-execute', (exec, next) => gateEngine.handlePreExecute(exec, next));
    // 双缝观测（保留 + 去重）：工具结果可能经「生命周期 tools/result」与
    // 「session/event 的结果事件」两条缝到达。observer 按执行标识去重
    // （execId/callId/seq…，见 observer.js），两缝的投递顺序与覆盖关系均不
    // 影响失败计数；无标识的事件保守计数。缝的最终取舍仍归 T-002 联调
    // 实测决定——当前实现对两种实测结论（双缝均达 / 仅单缝）都稳健。
    on.call(ctx, 'tools/result', (event) => observer.onEvent(event));
    // Cross-scope session events require `{ global: true }` (handoff).
    on.call(ctx, 'session/event', (session, event) => {
        const enriched = { ...(event ?? {}) };
        if (enriched.session === undefined) {
            enriched.session = session;
        }
        const kind = classifySessionEvent(enriched);
        const sessionId = sessionOf(enriched);
        if (kind === 'turn-end') {
            // 一个 stepped primary turn 完成 → immuneTurns 冷却倒数。
            delivery.onSteppedTurnEnd(sessionId);
        } else if (kind === 'reset') {
            // 压缩/重写：冷却的按轮计数基准失效 → 交付冷却重置（观察状态
            // 的重置在 onEvent 内统一处理）。
            delivery.reset(sessionId);
        } else {
            logger.debug?.('advisor-flow: session/event ignored (unclassified type)', { type: enriched.type });
        }
        observer.onEvent(enriched);
    }, { global: true });
    on.call(ctx, 'agent/created', ({ agent } = {}) => delivery.registerAgent(agent), { global: true });
    on.call(ctx, 'agent/disposed', ({ agent } = {}) => delivery.unregisterAgent(agent?.id), { global: true });
    on.call(ctx, 'session/disposed', (session) => {
        observer.reset(session?.id ?? session);
        delivery.unregisterAgent(session?.id ?? session);
    }, { global: true });

    // Tool-face registration seam: fail LOUD. A missing seam means the
    // plugin's only user-facing surface (ask_advisor) silently vanishes —
    // that must surface at startup as an error, not as a quiet no-op. Only
    // runtime paths stay fault-tolerant (the non-stall invariant).
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
        gateEngine,
        observer,
        delivery,
        askAdvisor,
        usage: usageLedger,
        status,
        config: () => config,
        applyConfig,
        /** Wired disposal seam (session/disposed / agent/disposed, T-002). */
        dispose: () => engine.dispose(),
    };
}

export default { name, inject, apply };
