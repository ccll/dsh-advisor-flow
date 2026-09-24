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
import { createConfigGateway } from './gateway.js';

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
    // 工具体经包装引擎：consult 前惰性应用最新文件配置（读时求值）。
    const askAdvisor = createAskAdvisorTool({
        engine: {
            consult: (request) => {
                applyFromSource();
                return engine.consult(request);
            },
        },
    });
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
    // tools / settingsSection 缝显性化自装载即生效（激活/注册成功时清除）。
    degradations.askAdvisorTool = 'tools-seam-not-activated';
    degradations.settingsSection = 'install-section-missing';

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

    const gateEngine = createGateEngine({
        consult: (request) => {
            applyFromSource(); // 读时求值：门评审用最新文件配置
            return engine.consult(request);
        },
        observer,
        delivery: (sessionId, advice) => delivery.deliver(sessionId, advice),
        policyLookup: (gateKind) => config.gates?.[gateKind],
        approver,
        stopSession,
        logger,
    });
    const status = createStatusProvider({ config: () => {
        applyFromSource(); // 读时求值：状态快照前应用最新文件配置
        return config;
    }, engine, usageLedger, degradations: () => degradations });
    // 手动命令经包装引擎：consult 前惰性应用最新文件配置（读时求值）——
    // 与工具/门路径一致（T-005 读时求值轮收尾）。
    const commandEngine = {
        consult: (request) => {
            applyFromSource();
            return engine.consult(request);
        },
        resume: (...args) => engine.resume(...args),
        setSessionEnabled: (...args) => engine.setSessionEnabled(...args),
        sessionEnabled: (...args) => engine.sessionEnabled(...args),
    };
    const commandController = createCommandController({
        engine: commandEngine,
        statusProvider: status,
        // commands.js 的 startManual 以回调形态送达意见——传函数而非 delivery 对象
        delivery: (sessionId, advice) => delivery.deliver(sessionId, advice),
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

    // settings 桥（R-02-001：section 注册驱动 describe/卡片 + AC-01 持久化
    // 维度）：settings 条件子上下文激活时——①经 installAdvisorFlowSettings
    // 注册 advisor-flow section（source-thunk + onChange → applyConfig live
    // re-apply）；②接 settings.update 类持久写缝（merge 语义由缝承载）。
    // 未激活/装配失败 → 一次性 error + degradations.persistence，保存保持
    // 运行时态、绝不静默。联调验证项（T-002 清单）：settings.update 签名与
    // installSection 选项形态。
    let settingsWriter;
    /**
     * settings 桥（子上下文激活时赋值）。applyFromSource 为「读时求值」原语
     * （T-005 实测第八发现：attach 时 settings 文档可能尚未加载完成——任何
     * 依赖 attach/事件时序的种子都不可靠；关键读数点前惰性应用，幂等廉价）。
     */
    let settingsBridge;
    function applyFromSource() {
        if (!settingsBridge) {
            return; // 桥未接入：保持当前运行时配置（读时求值在桥接入后生效）
        }
        let raw;
        try {
            raw = settingsBridge.source();
        } catch {
            return; // source 未就绪（文档未加载完成）——空值不覆盖
        }
        if (!isRecord(raw) || Object.keys(raw).length === 0) {
            return; // 空段不覆盖（文件未加载完成/无 advisor-flow 段）——raw 不被清空
        }
        const resolvedLive = resolveAdvisorFlowConfig(raw);
        if (resolvedLive.ok) {
            applyConfig(resolvedLive.config, raw);
        } else {
            // 非法用户层不楔住热路径——disabled-with-reason 兜底（状态可查询、
            // 卡片可修复），raw 保留真实键。
            applyConfig({ enabled: false, reason: `配置无效：${resolvedLive.error}` }, raw);
        }
    }
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
    // 启动期仅标注不记日志：settings 子上下文异步激活（动态 import 桥），
    // 成功即清除本标注；确认缺失/装配失败时才经 degradePersistence 记一次
    // 性日志——不虚报（未确认前不写「持久化不可用」）。
    degradations.persistence = 'settings-writer-seam-missing';
    whenServiceAvailable('settings', (settingsSeam) => {
        // settings.js 引 schemastery peer——动态 import 保持单测环境无 peer
        // 时其余用例照常（缺失 → 降级标注，不崩装载）。
        import('./settings.js')
            .then(({ installAdvisorFlowSettings }) => {
                // live re-apply（R-02-001/AC-01）：onChange → 顶层
                // applyFromSource（读时求值原语，与 gateway/consult/status
                // 读数点同源）；非法用户层 disabled-with-reason 兜底、raw 保留
                // 真实键——逻辑在 applyFromSource 内，此处不复制。
                settingsBridge = installAdvisorFlowSettings(ctx, rawConfig, {
                    logger,
                    onDegradation: (reason) => {
                        degradations.settingsSection = reason;
                        logger.error?.(`advisor-flow: settings section 未注册（${reason}）——设置卡将缺失（联调验证项 T-002）`);
                    },
                    onChange: () => applyFromSource(),
                });
                // attach 即种子（尽力早刷）：文档未加载完成时 source 为空 →
                // applyFromSource 空值跳过（不覆盖 raw）——读时求值兜底，失败无妨。
                try {
                    applyFromSource();
                } catch (error) {
                    logger.debug?.(`advisor-flow: attach 种子未生效——读时求值兜底: ${String(error)}`);
                }
                if (settingsBridge.isAttached()) {
                    delete degradations.settingsSection; // section 注册成功/dup 在——describe 服务本命名空间
                }
                const update = settingsSeam?.update ?? settingsSeam?.write;
                if (typeof update === 'function') {
                    settingsWriter = (raw) => update.call(settingsSeam, ADVISOR_FLOW_NAMESPACE, raw);
                    onPersistenceRecovered(); // 接上即清除缺失降级（恢复语义）
                    logger.info?.('advisor-flow: settings 写缝已接入——保存将持久化到 settings.yaml');
                } else {
                    degradePersistence('settings-writer-seam-missing');
                }
            })
            .catch((error) => {
                degradePersistence('settings-bridge-failed');
                logger.error?.(`advisor-flow: settings 桥装配失败——持久化不可用: ${String(error)}`);
            });
    });
    // 注意：settings 子上下文异步激活——启动期仅标注（见上），确认缺失/
    // 装配失败时才在异步路径记一次性日志；服务整个缺失（子上下文永不激活）
    // 时保持标注不虚报日志（真实宿主 settings 恒在，此为桩/无头形态）。


    // dsh event wiring (handoff-verified seams; `on` is a context method —
    // no inject needed). A missing event seam means the gates cannot work at
    // all — fail loud; only runtime paths stay fault-tolerant.
    const on = ctx?.on;
    if (typeof on !== 'function') {
        const detail = '事件订阅缝缺失（ctx.on 不存在）——门控无法工作，插件拒绝启动';
        logger.error?.(`advisor-flow: ${detail}`);
        throw new Error(`advisor-flow: ${detail}`);
    }
    // 工具生命周期事件以 agent scope 为 carrier 派发（dsh-tools 的
    // scopeTarget(this, exec.agent)）——根 fiber 上的裸监听收不到子代理/
    // 会话 scope 的调用（T-005 实测第六发现：门在真实会话零触发的根因，
    // 与 session/event 当年的 {global:true} 修复同型；dsh-tools 自带
    // invariant 监听 tools/* 事件亦用 {global:true}——实证先例）。必须
    // { global: true }。
    //
    // 载体契约（T-008 真机实测，dsh-tools 0.1.5-rc.2）：
    // `exec = { token, callId, rootCallId, name, arguments, agent?, parent?,
    // signal, … }`——工具名在 `name`、参数在 `arguments`、会话标识在
    // `exec.agent`（agent.id === session.id）。判定与计数全部读这组字段。
    on.call(ctx, 'tools/pre-execute', (exec, next) => gateEngine.handlePreExecute(exec, next), { global: true });
    // 结果缝（权威成败缝）：宿主以 (exec, result) 两参投递——失败真值是
    // `result.isError === true`，执行标识是 `exec.callId`。session/event 的
    // `tool/result` 存储记录不带工具名（只有 callId/content），无法归属
    // 失败计数——不作为计数缝（T-008 实测裁决，双缝去重议题就此关闭）。
    on.call(ctx, 'tools/result', (exec, result) => {
        try {
            if (!isRecord(exec) || typeof exec.name !== 'string') {
                return; // 无工具名的结果无法归属计数——放弃而非猜
            }
            const ok = isRecord(result) ? result.isError !== true : true;
            observer.recordResult(sessionOf(exec), exec.name, ok, typeof exec.callId === 'string' ? exec.callId : undefined);
        } catch (error) {
            logger.error?.('advisor-flow: tools/result observation failed — contained', { error: String(error) });
        }
    }, { global: true });
    // 回合收口缝（完成门的真实时点 + 送达冷却的 turn 计数源）：宿主在回合
    // 边界提交前串行等待本事件；收口反对靠 steer 数据（inbox 续步），不是
    // 返回值。监听器全 contained——任何异常不得打断宿主的收口流程。
    // 冷却倒数口径（评审轮修正）：完成门的送达/反对都把消息落 next-step
    // inbox、宿主会续步——那不是一次真实收口，不倒数；仅当本次处理未投递
    // 未反对（自由收口）时倒数，冷却语义对齐「送达后 N 个 stepped turn」。
    on.call(ctx, 'agent/turn-stopping', async (payload) => {
        const sessionId = sessionOf(payload);
        try {
            const acted = await gateEngine.handleTurnStopping(payload);
            if (acted !== undefined) {
                return undefined; // 送达/反对已续步——非真实收口，不倒数
            }
            delivery.onSteppedTurnEnd(sessionId);
        } catch (error) {
            logger.error?.('advisor-flow: turn-stopping handling failed — contained', { error: String(error), session: sessionId });
        }
    }, { global: true });
    // Cross-scope session events require `{ global: true }` (handoff).
    // 本缝只承载 reset 类事件（压缩/重写——观察与冷却的按轮基准失效）与
    // carrier 传递；结果计数归 `tools/result` 权威缝（见上）。
    on.call(ctx, 'session/event', (session, event) => {
        const enriched = { ...(event ?? {}) };
        if (enriched.session === undefined) {
            enriched.session = session;
        }
        const kind = classifySessionEvent(enriched);
        if (kind === 'reset') {
            const sessionId = sessionOf(enriched);
            // 压缩/重写：冷却的按轮计数基准失效 → 交付冷却重置（观察状态
            // 的重置在 onEvent 内统一处理）。
            delivery.reset(sessionId);
            observer.onEvent(enriched);
        }
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
        gateEngine.resetSession?.(sessionId);
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
    // gateway 处理器（纯逻辑，宿主侧）——服务/端点声明在 typert 条件子上下文
    // 内经动态 import 装配（typert-protocol 为 peer 依赖：真实宿主安装时解析；
    // 单测环境缺失时降级为 settingsCard 标注，绝不崩装载）。
    // 联调验证项 (T-002 清单): TypertRemoteService 注册与贡献声明时序。
    const gatewayHandlers = createConfigGateway({
        getRawConfig: () => {
            applyFromSource(); // 读时求值：卡片每次打开/保存都见真实文件值
            return rawConfig;
        },
        applyResolved: (resolvedConfig, raw) => applyConfig(resolvedConfig, raw),
        persist,
        onPersistenceFailure,
        onPersistenceRecovered,
        logger,
    });
    whenServiceAvailable('typert', () => {
        import('./typert-gateway.js')
            .then(({ registerAdvisorFlowGateway }) => {
                const { disposer, gateway } = registerAdvisorFlowGateway(ctx, gatewayHandlers, logger);
                gatewayDisposer = disposer;
                if (gateway) {
                    delete degradations.settingsCard;
                    logger.info?.('advisor-flow: gateway 服务与端点已注册（/api/advisor-flow/get|set）');
                }
            })
            .catch((error) => {
                degradations.settingsCard = 'typert-protocol-unavailable';
                logger.error?.(`advisor-flow: gateway 服务装配失败——web 设置卡不可用: ${String(error)}`);
            });
    });
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
