/**
 * dsh-advisor-flow — dsh bundle entry (T-001 core + T-003 gates/observer/
 * delivery + T-004 commands/card + T-005 persistence).
 *
 * Ports pi-advisor-flow's executor/advisor workflow to DeepSeek Harness:
 * the executor's daily model does the work; a stronger advisor model
 * provides second opinions at key moments, with review gates in front of
 * critical tool actions.
 *
 * 服务装配划分（T-005 实测结论，journal 实证 cordis ctx 代理对未注入属性
 * 的 get 会抛「cannot get property … without inject」——任何顶层属性探测
 * 都可能击穿 apply 使整个插件树装载失败）：
 * - 必选服务走声明式 `inject`（llm、agents）——直接访问合法；
 * - 可选服务全部经 `ctx.inject([name], (child) => …)` 条件子上下文——
 *   服务不在场时子上下文不激活、apply 照常完成（dsh-advisor 成熟原语）；
 *   降级标注在激活前立好、激活时清除（与持久写轮「恢复清除」语义一致）。
 * - 缺失形态的降级标注保留（askPolicy/commands/settingsCard/persistence），
 *   激活时清除；activation 时点与真实服务名归 T-002 联调清单。
 *
 * @module dsh-advisor-flow
 */

import { resolveAdvisorFlowConfig, ADVISOR_FLOW_NAMESPACE } from './config.js';
import { createConsultationEngine } from './consultation.js';
import { createAskAdvisorTool } from './tools/ask-advisor.js';
import { createUsageLedger } from './usage.js';
import { createStatusProvider } from './status.js';
import { createSessionObserver, classifySessionEvent } from './observer.js';
import { isRecord, sessionOf } from './util.js';
import { createGateEngine } from './gates/index.js';
import { createAdviceDelivery } from './delivery.js';
import { createCommandController, registerAdvisorFlowCommands } from './commands.js';
import { createConfigGateway, registerConfigGateway } from './gateway.js';

export const name = 'dsh-advisor-flow';
/**
 * 必选服务（声明式注入；真实宿主上缺任一即整行不装载——与 dsh-advisor 一致）：
 * - llm：顾问模型调用；
 * - agents：delivery 的 agent 注册表回退（agent.id === session.id）。
 */
export const inject = ['agents', 'llm'];
export { ADVISOR_FLOW_NAMESPACE, resolveAdvisorFlowConfig };

/**
 * Cordis plugin entry. `entryConfig` is the plugin-row config (the
 * `advisor-flow` composition base until the T-002 settings bridge layers
 * the live namespace on top).
 */
export function apply(ctx, entryConfig) {
    const logger = typeof ctx?.logger === 'function' ? ctx.logger('advisor-flow') : console;

    // handoff: a plugin ctx may sit in an isolated scope whose local llm has
    // NO provider adapter — prefer the app-root LLM (`ctx.root.get('llm')`),
    // falling back to the (now inject-declared) scope llm.
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
    /**
     * The RAW namespace is the card's editable truth (the gateway round-trips
     * it); the resolved config is the runtime truth. Both update together on
     * a valid save. When the entry config FAILED validation the raw is kept
     * AS-IS (junk included): the card must be able to show and repair the
     * real content — dropping it to `{}` would silently wipe keys that
     * genuinely exist in settings.yaml on the next card save.
     */
    let rawConfig = isRecord(entryConfig) ? entryConfig : {};

    // TODO(T-002): usage ledger persistence path comes from the settings
    // namespace (`advisor-flow.usage.path`) — memory-only until wired.
    const usageLedger = createUsageLedger({ logger });
    const engine = createConsultationEngine({ llm, config, logger, usageLedger });
    const askAdvisor = createAskAdvisorTool({ engine });
    const observer = createSessionObserver({ logger });
    // agents 已声明注入：直访合法（不再经 try/catch 探测——cordis 代理对未
    // 注入属性的 get 会抛，顶层探测曾使整个插件树装载失败，见 T-005 实测）。
    const delivery = createAdviceDelivery({ logger, lookupAgent: (sessionId) => ctx?.agents?.get?.(sessionId) });

    // ---- 可选服务：全部经条件 inject 子上下文（dsh-advisor 原语） ----------
    // 子上下文仅在该服务存在时激活；未激活 = 缝缺失路径，降级标注保持。
    // 激活时接上服务并清除对应降级标注（与持久写轮「恢复清除」语义一致）。
    // 关键纪律：子上下文回调内才允许触达服务属性——顶层触及未注入属性会在
    // cordis get-trap 下抛出（T-005 实测：cannot get property "approvals"
    // without inject 曾使 apply 崩溃、整个插件树未装载）。
    const degradations = {};
    // tools 缝显性化自装载即生效（子上下文激活/注册成功时清除）。
    degradations.askAdvisorTool = 'tools-seam-not-activated';

    /**
     * 条件子上下文共享原语（五缝接入的单一模板，降低模板漂移面）：
     * `whenServiceAvailable(name, onActive)` 订阅一个可选服务——服务在场时
     * 子上下文激活并以 (service, serviceCtx) 调用 onActive（接缝 + 清除对应
     * 降级标注的回调职责在 onActive 内）；未激活时不动作（降级标注保持）。
     * approval 的 attached 守卫等特殊逻辑保留在各回调内。
     */
    function whenServiceAvailable(name, onActive) {
        if (typeof ctx?.inject !== 'function') {
            return; // 无法条件订阅（宿主异常形态）——保持降级标注
        }
        ctx.inject([name], (serviceCtx) => {
            onActive(serviceCtx?.[name], serviceCtx);
        });
    }

    // ask 策略的人工审批缝：候选服务名 approval / approvals（真实名联调
    // 验证项 T-002 清单；先激活者优先，attached 守卫防重复接入）。激活前
    // ask 门 fail-open + 降级标注；激活时接上。
    let approverImpl;
    const approver = (request) => {
        if (typeof approverImpl !== 'function') {
            // 引擎会捕获该异常并 fail-open（放行 + error 留痕）。
            throw new Error('审批缝未激活（approval 服务未接入）');
        }
        return approverImpl(request);
    };
    let approvalAttached = false;
    function attachApproval(seam) {
        if (approvalAttached || !isRecord(seam)) {
            return;
        }
        const request = seam.request ?? seam.ask;
        if (typeof request === 'function') {
            approvalAttached = true;
            approverImpl = (req) => request.call(seam, req);
            delete degradations.askPolicy;
            logger.info?.('advisor-flow: 审批缝已接入——ask 策略恢复人工确认');
        }
    }
    whenServiceAvailable('approval', attachApproval);
    whenServiceAvailable('approvals', attachApproval);
    if (!approvalAttached) {
        degradations.askPolicy = 'approver-seam-missing';
        logger.error?.('advisor-flow: 人工审批缝未接入（条件注入未激活）——ask 策略门将 fail-open 放行（degraded），接入前请在状态页关注');
    }

    // block-session 的会话停止缝：agents 已注入，其 cancel 类方法为停止缝；
    // 两态显性化由闭包承载——未激活（缝缺失）抛带 stopSessionReason 标记的
    // 错误，激活但调用抛错则原样上抛，门引擎据此区分文案。
    // 联调验证项（T-002 清单）：宿主会话停止（agent cancel 类）缝的真实形态。
    let sessionStopImpl;
    const stopSession = (context) => {
        if (typeof sessionStopImpl !== 'function') {
            const error = new Error('会话停止缝未激活');
            error.stopSessionReason = 'seam-not-activated';
            throw error;
        }
        return sessionStopImpl(context);
    };
    const agentsCancel = ctx?.agents?.cancel;
    if (typeof agentsCancel === 'function') {
        sessionStopImpl = (context) => agentsCancel.call(ctx.agents, context);
    }

    // 持久写缝（R-02-001/AC-01 持久化维度）：settings 条件子上下文激活时接
    // settings.update 类缝（merge 语义——只写本命名空间键——由缝承载）；
    // 未激活/写入失败 → 一次性 error + degradations.persistence，保存保持
    // 运行时态、绝不静默。联调验证项（T-002 清单）：settings.update 签名。
    let settingsWriter;
    const persist = async (raw) => {
        if (typeof settingsWriter !== 'function') {
            throw new Error('settings 写缝未激活（settings 服务未接入）');
        }
        await settingsWriter(raw);
    };
    const persistenceLogged = new Set();
    function degradePersistence(reason) {
        degradations.persistence = reason;
        if (!persistenceLogged.has(reason)) {
            persistenceLogged.add(reason); // 每类原因一次性 error，不刷屏
            logger.error?.(`advisor-flow: 持久化不可用（${reason === 'persist-write-failed' ? '写入失败' : 'settings 写缝未接入'}）——保存仅为运行时态，重启即失`);
        }
    }
    // 恢复：清除降级标注并清空一次性日志记录——恢复后再次失败必须再次显性。
    const onPersistenceRecovered = () => {
        delete degradations.persistence;
        persistenceLogged.clear();
    };
    const onPersistenceFailure = (reason) => degradePersistence(reason);
    whenServiceAvailable('settings', (settingsSeam) => {
        const update = settingsSeam?.update ?? settingsSeam?.write;
        if (typeof update === 'function') {
            settingsWriter = (raw) => update.call(settingsSeam, ADVISOR_FLOW_NAMESPACE, raw);
            onPersistenceRecovered(); // 接上即清除缺失降级（恢复语义）
            logger.info?.('advisor-flow: settings 写缝已接入——保存将持久化到 settings.yaml');
        }
    });
    if (!settingsWriter) {
        degradePersistence('settings-writer-seam-missing');
    }

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
    const commandController = createCommandController({
        engine,
        statusProvider: status,
        delivery,
        getConfig: () => config,
        logger,
    });

    // TODO(T-002): settings bridge — register the `advisor-flow` section via
    // the settings child above（installSection/onChange 的 live re-apply，
    // signature 变更才重建运行时——applyConfig 已就绪）。
    // TODO(T-002): enforce budget.maxPerSession per entry type.

    // Live config re-apply: consultations pick the new config up per call;
    // a GATE-CONFIG signature change rebuilds gate state (atomic — pending
    // counters belong to the old rules).
    let gateSignature = JSON.stringify(config.gates ?? {});
    function applyConfig(nextResolved, nextRaw) {
        if (!nextResolved || typeof nextResolved !== 'object') {
            return;
        }
        config = nextResolved;
        if (isRecord(nextRaw)) {
            rawConfig = nextRaw;
        }
        engine.applyConfig(nextResolved);
        const signature = JSON.stringify(config.gates ?? {});
        if (signature !== gateSignature) {
            gateSignature = signature;
            observer.resetAll();
            logger.info?.('advisor-flow: gate config changed — gate state rebuilt', {});
        }
    }

    let commandsDisposer;
    let gatewayDisposer;

    // dsh event wiring (handoff-verified seams; `on` is a context method —
    // no inject needed). A missing event seam means the gates cannot work at
    // all — fail loud; only runtime paths stay fault-tolerant.
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
        const sessionId = sessionOf(session);
        // 覆盖与进行中手动咨询必须随会话清理：`/advisor off` 的覆盖若残留，
        // 'default' 兜底桶之外的会话键会泄漏语义到复用的会话 id。
        engine.setSessionEnabled?.(sessionId, undefined);
        commandController.cancelManual?.(sessionId);
        observer.reset(sessionId);
        delivery.unregisterAgent(sessionId);
    }, { global: true });

    // Command registration: conditional inject child (dsh-advisor 原语) —
    // the command face is a UX surface; a composition without the commands
    // service keeps the core working with a visible degradation marker.
    // 联调验证项 (T-002 清单): the dsh CommandService registration shape.
    whenServiceAvailable('commands', (registry) => {
        if (typeof registry?.register !== 'function') {
            degradations.commands = 'registry-seam-missing';
            logger.warn?.('advisor-flow: 命令注册缝形态不符——命令面未挂载（联调验证项 T-002）');
            return;
        }
        commandsDisposer = registerAdvisorFlowCommands(registry, commandController);
        delete degradations.commands;
        logger.info?.('advisor-flow: 命令面已挂载（/advisor-manual、/advisor）');
    });
    if (!commandsDisposer) {
        degradations.commands = 'registry-seam-missing';
    }

    // Web settings card gateway (plugin's OWN channel — advisor-flow/get|set;
    // NOT the settings.describe exposure path, which the host allowlist
    // filters). Conditional inject child; registration failures degrade
    // visibly instead of crashing the load (卡片是 UX 面).
    // 联调验证项 (T-002 清单): the typertGateway claim shape.
    let gatewayAttached = false;
    function attachGateway(seam) {
        if (gatewayAttached || !isRecord(seam) || typeof seam.register !== 'function') {
            return;
        }
        try {
            gatewayDisposer = registerConfigGateway(seam, createConfigGateway({
                getRawConfig: () => rawConfig,
                applyResolved: (resolvedConfig, raw) => applyConfig(resolvedConfig, raw),
                persist,
                onPersistenceFailure,
                onPersistenceRecovered,
                logger,
            }));
            gatewayAttached = true;
            delete degradations.settingsCard;
            logger.info?.('advisor-flow: gateway RPC 已注册（advisor-flow/get|set）');
        } catch (error) {
            degradations.settingsCard = 'gateway-register-failed';
            logger.error?.(`advisor-flow: gateway RPC 注册失败——web 设置卡不可用: ${String(error)}`);
        }
    }
    // 双候选（先激活者优先，attached 守卫防重复接入；真实服务名联调项 T-002）
    whenServiceAvailable('typert', attachGateway);
    whenServiceAvailable('gateway', attachGateway);
    if (!gatewayDisposer) {
        degradations.settingsCard = 'gateway-seam-missing';
    }

    // Tool-face registration: `tools` 条件子上下文（tools 服务挂载时点可能晚
    // 于插件 apply）。ask_advisor 是插件唯一用户面：五缝显性化对齐——未激活
    // 标注 degradations.askAdvisorTool；激活即注册并清除；注册失败仍 fail
    // loud（向上传播）且标注 tools-register-failed。
    whenServiceAvailable('tools', (toolsSeam) => {
        try {
            toolsSeam.register(askAdvisor);
            delete degradations.askAdvisorTool;
            logger.info?.('advisor-flow: ask_advisor 已注册');
        } catch (error) {
            degradations.askAdvisorTool = 'tools-register-failed';
            logger.error?.(`advisor-flow: ask_advisor 注册失败，插件拒绝启动: ${String(error)}`);
            throw error;
        }
    });

    return {
        engine,
        gateEngine,
        commandController,
        observer,
        delivery,
        askAdvisor,
        usage: usageLedger,
        status,
        config: () => config,
        applyConfig,
        /** Wired disposal seam（子上下文注册的命令/gateway 随 fiber 撤除）。 */
        dispose: () => {
            commandsDisposer?.();
            gatewayDisposer?.();
            engine.dispose();
        },
    };
}

export default { name, inject, apply };
