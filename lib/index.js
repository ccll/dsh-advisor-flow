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
 * - 缺失形态的降级标注保留（guidelines/commands/settingsCard/persistence），
 *   激活时清除；activation 时点与真实服务名归 T-002 联调清单。
 *
 * @module dsh-advisor-flow
 */

import { resolveAdvisorFlowConfig, ADVISOR_FLOW_NAMESPACE } from './config.js';
import { createConsultationEngine } from './consultation.js';
import { createSubsessionPresenter } from './subsession.js';
import { buildAdvisorMessageText } from './materials.js';
import { redactText } from './redact.js';

/** Scout 策展指令（T-014：二次调用产出 JSON 组清单；不可信推断由注记承载）。 */
const SCOUT_SYSTEM_PROMPT = 'You curate conversation context for an advisor review. Return ONLY a JSON object: {"groups":[{"id":"...","required":true|false,"text":"..."}],"synthesis":"..."}. Groups carry the distilled evidence from the supplied conversation; required groups are the ones the review cannot proceed without. Never invent content that is not in the conversation.';
const SCOUT_QUESTION = 'Curate the conversation context for the upcoming advisor review.';
import { createAskAdvisorTool } from './tools/ask-advisor.js';
import { createUsageLedger } from './usage.js';
import { createStatusProvider } from './status.js';
import { createSessionObserver, classifySessionEvent } from './observer.js';
import { isRecord, sessionOf } from './util.js';
import { createGateEngine } from './gates/index.js';
import { createAdviceDelivery } from './delivery.js';
import { createTurnReview } from './turn-review.js';
import { createReviewerClassifier, subsessionExemptFrom, REVIEWER_LEASE_CANARY } from './reviewer-classifier.js';
import { createToolFaceGuard } from './tool-guard.js';
import { createSubsessionExecutionGuard } from './subsession-guard.js';
import { installAdvisorGuidelines } from './guidelines.js';
import { createCommandController, registerAdvisorFlowCommands } from './commands.js';
import { createConfigGateway } from './gateway.js';
import {
    installAdvisorFlowSettings,
    unwrapVolatileConfig,
    projectSchemaKeys,
    AdvisorFlowConfigSchema,
} from './settings.js';

export const name = 'dsh-advisor-flow';
/**
 * 必选服务（声明式注入；真实宿主上缺任一即整行不装载——与 dsh-advisor 一致）：
 * - llm：顾问模型调用；
 * - agents：delivery 的 agent 注册表回退（agent.id === session.id）。
 */
export const inject = ['agents', 'llm'];
export { ADVISOR_FLOW_NAMESPACE, resolveAdvisorFlowConfig };
/**
 * 0.2.0 SettingsForms 入口（T-028）：宿主 settings 服务经
 * `entry.fiber.runtime.Config` 发现本 schema，describe/update 由此驱动
 * （成员形态与校验单点说明见 lib/settings.js）。
 */
export const Config = AdvisorFlowConfigSchema;

/**
 * Cordis plugin entry. `entryConfig` is the plugin-row config (0.2.0：cordis
 * 已按模块 `Config` resolve 过——volatile 节点为 cell，读值统一经
 * unwrapVolatileConfig；settings 桥在其上承接宿主热更新，见 settingsBridge)。
 */
export function apply(ctx, entryConfig) {
    const logger = typeof ctx?.logger === 'function' ? ctx.logger('advisor-flow') : console;

    // sessionQuery 缝（T-012 spike 判据①）：observeSession 异步租约归一为
    // 事件数组供脉络重建；缝缺失时显性化降级而非静默空脉络。
    let sessionQueryRef;
    let sessionQuerySeen = false;
    try {
        ctx.inject(['sessionQuery'], (sqCtx) => {
            sessionQueryRef = sqCtx?.sessionQuery ?? sqCtx;
            sessionQuerySeen = true;
        });
    } catch {
        logger.warn?.('advisor-flow: sessionQuery 缝缺失——会话脉络区将留空（staging 联调项）');
        sessionQuerySeen = false; // 缝缺失：getSessionEvents 内显性化降级标注
    }
    /**
     * sessionQuery 租约读取缝（T-036）：租约归一为 `{events, header}`——
     * header 是租约独立属性（子会话自证 origin 在此），事件流为裸 log 切片。
     * header 于 dispose 前取出；缝缺失/读取失败返回 undefined（显性化降级
     * 而非静默空脉络）。
     */
    const observeSessionLease = async (sessionId) => {
        logger.info?.(`advisor-flow: sessionQuery seam probe — seen=${sessionQuerySeen} ref=${typeof sessionQueryRef} sessionId=${sessionId}`);
        if (!sessionQuerySeen || !sessionQueryRef) {
            degradations.sessionQueryMissing = degradations.sessionQueryMissing ?? true;
            return undefined;
        }
        try {
            const observation = await sessionQueryRef.observeSession?.(sessionId);
            try {
                const events = observation?.events ? [...observation.events] : undefined;
                logger.info?.(`advisor-flow: conversation events fetched: ${Array.isArray(events) ? events.length : 'none'} for ${sessionId}`);
                return { events, header: observation?.header };
            } finally {
                observation?.[Symbol.dispose]?.();
            }
        } catch (error) {
            logger.warn?.('advisor-flow: observeSession 读取失败——脉络区留空', { sessionId, error: String(error) });
            return undefined;
        }
    };
    /** 会话脉络事件源（R-02-006/AC-03）：sessionQuery 租约 → 事件数组。 */
    const getSessionEvents = async (sessionId) => (await observeSessionLease(sessionId))?.events;
    /**
     * 会话工作区 cwd（T-035；R-02-006）：仓库上下文与附件归属校验必须落在
     * 发起咨询的会话工作区——宿主服务进程 cwd（如 systemd WorkingDirectory）
     * 非会话现场，曾致 repository_changes 恒 not-a-repository。经 sessionQuery
     * 缝读 header.cwd（宿主先例 dsh-session-reference 同款取法）；缝缺失或
     * 读取失败返回 undefined，由调用方回落宿主进程 cwd。
     */
    const getWorkspaceCwd = async (sessionId) => {
        if (!sessionQuerySeen || !sessionQueryRef) {
            degradations.sessionQueryMissing = degradations.sessionQueryMissing ?? true;
            return undefined;
        }
        try {
            const observation = await sessionQueryRef.observeSession?.(sessionId);
            try {
                const cwd = observation?.header?.cwd;
                return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
            } finally {
                observation?.[Symbol.dispose]?.();
            }
        } catch (error) {
            logger.warn?.('advisor-flow: 会话工作区 cwd 读取失败——仓库上下文回落宿主进程 cwd', { sessionId, error: String(error) });
            return undefined;
        }
    };

    // 子会话呈现缝（R-02-007；C-020）：subagents 条件子上下文（可选服务
    // 原语）；缝未接入时 presentSubsession 返回 fallback——咨询引擎降级
    // llm.stream 直调并显性化（AC-03）。
    let subsessionPresenter;
    /**
     * 顾问子会话登记表（T-022）：呈现缝发布的子会话 id 登记于此，收口评审
     * 处置器据此豁免——顾问子会话不是执行者（R-01-009/AC-05）。
     * 语义与动机见 SOLUTION.md#运行时、并发与失败语义「顾问子会话豁免」。
     */
    const advisorSubsessions = new Set();
    /** 呈现缝读时求值：闭包引用 subsessionPresenter，缝接入前后无需重建引擎。 */
    const presentSubsession = (request) => {
        if (!subsessionPresenter) {
            return Promise.resolve({ kind: 'fallback', reason: 'subagents 缝未接入（呈现降级直调）' });
        }
        return subsessionPresenter.present(request);
    };

    // handoff: a plugin ctx may sit in an isolated scope whose local llm has
    // NO provider adapter — prefer the app-root LLM (`ctx.root.get('llm')`),
    // falling back to the (now inject-declared) scope llm.
    const llm = ctx?.root?.get?.('llm') ?? ctx?.llm;

    // 0.2.0（T-028）：声明 Config 后 cordis 对 entry config 做 Schema.resolve，
    // volatile 节点变 cosmokit cell——读值必须解包（.get()），统一经
    // unwrapVolatileConfig；非 record（异常宿主形态）照旧落 {}。
    // 解包一次共用：resolve 与 raw 初始化同一份普通值，避免 cell 形态
    // 触发虚假「配置解析被拒绝」。
    const entryPlain = isRecord(entryConfig) ? unwrapVolatileConfig(entryConfig) : {};
    const resolved = resolveAdvisorFlowConfig(entryPlain);
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
     * genuinely exist in the entry config on the next card save.
     */
    let rawConfig = entryPlain;

    // TODO(T-002): usage ledger persistence path comes from the settings
    // namespace (`advisor-flow.usage.path`) — memory-only until wired.
    const usageLedger = createUsageLedger({ logger });
    // Scout 策展执行缝（T-014）：经 llm 缝的二次顾问调用，产出 {groups, synthesis}；
    // 用量以 scout 口径入台账（R-02-002 分类计量）。策展失败由引擎红线兜底（回退 legacy）。
    const runScout = async ({ legacy, budget, resolveMaxTokens }) => {
applyFromSource(); // 读时求值：策展用最新文件配置
        const timeoutMs = Number.isInteger(config.scout?.timeoutMs) ? config.scout.timeoutMs : 30000;
        const signal = AbortSignal.timeout(timeoutMs);
        // 输出上限与主咨询同语义（C-015）：显式配置覆盖 > 宿主模型声明值 > 省略参数。
        const maxTokens = config.advisor.maxTokens
            ?? (typeof resolveMaxTokens === 'function' ? await resolveMaxTokens(signal) : undefined);
        let text = '';
        let usage;
        for await (const event of llm.stream({
            provider: config.advisor.provider,
            model: config.advisor.model,
            system: SCOUT_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: [{ type: 'text', text: redactText(buildAdvisorMessageText({ conversation: legacy, question: SCOUT_QUESTION }), { enabled: config.privacy?.redactSecrets !== false }) }] }],
            ...(maxTokens === undefined ? {} : { maxTokens }),
            signal,
        })) {
            if (event.type === 'text-delta') {
                text += event.textDelta ?? '';
            } else if (event.type === 'usage' && isRecord(event.usage)) {
                usage = event.usage;
            }
        }
        if (isRecord(usage)) {
            usageLedger.record({
                adviceId: `scout-${Date.now()}`,
                entry: 'scout',
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens,
                costTotal: usage.costTotal,
            });
        }
const parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
        if (!isRecord(parsed)) {
            throw new Error('scout reply is not an object');
        }
        return parsed;
    };
    const engine = createConsultationEngine({ llm, config, logger, usageLedger, getSessionEvents, getWorkspaceCwd, runScout, presentSubsession });
    // 共享审核类子会话分类器（T-026；C-025）：收口评审豁免（T-023）与咨询
    // 工具面守卫共用同一实例与缓存——同会话两类判定零重读；清单读时求值。
    const reviewerClassifier = createReviewerClassifier({ getConfig: () => config, getLease: observeSessionLease, logger });
    // 工具面守卫（R-01-001/AC-09、AC-10；C-025）：applyFromSource 与包装
    // 引擎同一读时求值原语（时序缝修正——判定前刷新文件配置）。
    const toolFaceGuard = createToolFaceGuard({
        getConfig: () => config,
        applyConfig: applyFromSource,
        classifier: reviewerClassifier,
        isAdvisorSubsession: (sessionId) => advisorSubsessions.has(sessionId),
        logger,
    });
    // 子会话执行面守卫（T-035；NG-1、R-02-007/AC-05；C-034）：宿主把委派
    // 工具注册进被 spawn 子会话的 own 层，toolFilter 拦不住——执行边界对
    // 已登记顾问子会话内的一切工具调用做否决（deny-all），是工具面守卫
    // （自我再入防线）之后的第二道防线纵深。
    const subsessionGuard = createSubsessionExecutionGuard({
        isAdvisorSubsession: (sessionId) => advisorSubsessions.has(sessionId),
        logger,
    });
    // 工具体经包装引擎：consult 前惰性应用最新文件配置（读时求值）。
    const askAdvisor = createAskAdvisorTool({
        guard: toolFaceGuard,
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
    // cordis get-trap 下抛出（T-005 实测：顶层属性探测
    // without inject 曾使 apply 崩溃、整个插件树未装载）。
    const degradations = {};
    // tools / subsessionPresentation 缝显性化自装载即生效（激活/注册成功时
    // 清除）。settingsSection 标注只承载桥装配意外失败（0.2.0 无需注册动作，
    // 正常态无此缝可缺——T-028 移除 install-section-missing 语义）。
    degradations.askAdvisorTool = 'tools-seam-not-activated';
    degradations.subsessionPresentation = 'subagents-seam-missing';
    // 租约形状金丝雀（T-036）：分类器自证源是租约 header（事件流为裸 log
    // 切片、不含自证事件——T-094 豁免结构性恒死根因的同类回归哨兵）。判
    // false 即激活期显性化（warn 进启动诊断 exporter，degradations 入
    // /advisor status）；固定清单与运行时清单解耦，只验形状不验清单。
    if (subsessionExemptFrom(REVIEWER_LEASE_CANARY, ['review']) !== true) {
        degradations.reviewerClassifier = 'reviewer-shape-canary-failed';
        logger.warn?.('advisor-flow: 审核类子会话分类器金丝雀未命中 — 豁免判定对租约形状失效，评审类子会话豁免可能恒不生效');
    }

    /**
     * 条件子上下文共享原语（五缝接入的单一模板，降低模板漂移面）：
     * `whenServiceAvailable(name, onActive)` 订阅一个可选服务——服务在场时
     * 子上下文激活并以 (service, serviceCtx) 调用 onActive（接缝 + 清除对应
     * 降级标注的回调职责在 onActive 内）；未激活时不动作（降级标注保持）。
     * 各回调内的 attached 守卫等特殊逻辑保留在各回调内。
     */
    function whenServiceAvailable(name, onActive) {
        if (typeof ctx?.inject !== 'function') {
            return; // 无法条件订阅（宿主异常形态）——保持降级标注
        }
        ctx.inject([name], (serviceCtx) => {
            onActive(serviceCtx?.[name], serviceCtx);
        });
    }

    // block-session 的会话停止缝：agents 已注入，其 cancel 类方法为停止缝；agents 已注入，其 cancel 类方法为停止缝；
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

    // 子会话呈现缝接入（R-02-007）：subagents 可选服务激活时装配呈现器并
    // 清除降级标注；名单无语义合规提供方时保持降级标注（呈现路径运行时
    // 兜底 fallback，不阻断咨询）。
    whenServiceAvailable('subagents', (subagentsSeam) => {
        const subagents = subagentsSeam?.subagents ?? subagentsSeam;
        if (typeof subagents?.start !== 'function' || typeof subagents?.list !== 'function') {
            degradations.subsessionPresentation = 'subagents-seam-missing';
            logger.warn?.('advisor-flow: subagents 缝形态不符——咨询呈现降级直调（联调验证项）');
            return;
        }
        subsessionPresenter = createSubsessionPresenter({
            subagents,
            logger,
            // T-022 登记缝：呈现缝发布子会话即登记 id（豁免判定源）。
            onPresented: (subsessionId) => {
                advisorSubsessions.add(subsessionId);
            },
            // 用量取数缝（R-02-002 语义衔接）：结算后、dispose 前读子会话
            // 事件的 assistant/message usage（T-012 载体契约）；读不到 = 台账
            // 按 unavailable 呈现，不虚构零值。
            extractUsage: async (subsessionId) => {
                const events = await getSessionEvents(subsessionId);
                if (!Array.isArray(events)) {
                    return undefined;
                }
                for (let index = events.length - 1; index >= 0; index -= 1) {
                    const event = events[index];
                    if (event?.type === 'assistant/message' && isRecord(event.data) && isRecord(event.data.usage)) {
                        return event.data.usage;
                    }
                }
                return undefined;
            },
        });
        delete degradations.subsessionPresentation;
        logger.info?.('advisor-flow: 子会话呈现缝已接入（subagents）');
    });

    const gateEngine = createGateEngine({
        consult: (request) => {
            applyFromSource(); // 读时求值：门评审用最新文件配置
            return engine.consult(request);
        },
        observer,
        // 门结果送达：一律 steer（文本 = **Decision: X** + 全文；C-007）。
        delivery: (sessionId, text) => delivery.steerAdvice(sessionId, text),
        getConfig: () => config,
        stopSession,
        budgetExhausted: (sessionId) => engine.budgetExhausted?.(sessionId) === true,
        logger,
    });
    // 收口评审（R-01-009；C-021）：硬模式在回合收口缝同步评审，软模式不触发。
    const turnReview = createTurnReview({
        consult: (request) => {
            applyFromSource(); // 读时求值：收口评审用最新文件配置
            return engine.consult(request);
        },
        delivery: (sessionId, text) => delivery.steerAdvice(sessionId, text),
        getConfig: () => config,
        budgetExhausted: (sessionId) => engine.budgetExhausted?.(sessionId) === true,
        sessionEnabled: (sessionId) => engine.sessionEnabled?.(sessionId),
        // T-022 递归守卫：顾问子会话收口豁免（判定源 = 呈现登记表）。
        isAdvisorSubsession: (sessionId) => advisorSubsessions.has(sessionId),
        // T-023/T-026：审核类子会话豁免判定由共享分类器承载（与工具面守卫
        // 同实例同缓存）；判定失败由处置器 fail-open（照常评审）。
        classifier: reviewerClassifier,
        logger,
    });
    const status = createStatusProvider({ config: () => {
        applyFromSource(); // 读时求值：状态快照前应用最新文件配置
        return config;
    }, engine: {
        // 复合引擎面：咨询引擎 + 门引擎的统计访问器（R-02-003/AC-03）。
        status: engine.status.bind(engine),
        pendingCount: engine.pendingCount,
        remainingCalls: engine.remainingCalls.bind(engine),
        decisionStats: gateEngine.decisionStats,
        turnReviewStats: turnReview.decisionStats,
        // R-01-001/AC-09、AC-10（C-025）：工具面守卫拒绝计数。
        toolFaceStats: toolFaceGuard.decisionStats,
        // R-02-007/AC-05（T-035；C-034）：子会话执行面否决计数。
        subsessionGuardStats: subsessionGuard.denialStats,
    }, usageLedger, degradations: () => degradations });
    // 手动命令经包装引擎：consult 前惰性应用最新文件配置（读时求值）——
    // 与工具/门路径一致（T-005 读时求值轮收尾）。
    const commandEngine = {
        consult: (request) => {
            applyFromSource();
            return engine.consult(request);
        },
        setSessionEnabled: (...args) => engine.setSessionEnabled(...args),
        sessionEnabled: (...args) => engine.sessionEnabled(...args),
    };
    const commandController = createCommandController({
        engine: commandEngine,
        statusProvider: status,
        // commands.js 的 startManual 以回调形态送达意见——传函数而非 delivery 对象；
        // 手动意见经 steer 送达（文本附 adviceId 回查行）。R-01-010 双顾问批次
        // 按顾问分别送达：成功意见带 model 时前置 `Advisor (model)` 分块行
        // （旧单顾问路径不携带 model 键，文本形态逐字不变）。
        delivery: (sessionId, advice) => {
            // R-01-002/AC-03、R-01-010/AC-08：字符串形态为失败通告（legacy 单
            // 顾问与双顾问按顾问失败标记）——必须原样经 steerAdvice 实际送达；
            // 此前仅认 record 形态，失败通告被静默丢弃（blocking 修复）。
            if (typeof advice === 'string') {
                if (advice.length > 0) {
                    delivery.steerAdvice(sessionId, advice);
                }
                return;
            }
            const text = isRecord(advice) && typeof advice.text === 'string'
                ? `${typeof advice.model === 'string' ? `Advisor (${advice.model})\n\n` : ''}${advice.text}\n（adviceId: ${advice.adviceId ?? 'unavailable'}）`
                : '';
            if (text.length > 0) {
                delivery.steerAdvice(sessionId, text);
            }
        },
        getConfig: () => config,
        logger,
    });

    // Live config re-apply: consultations pick the new config up per call;
    // a GATE-CONFIG signature change rebuilds gate state (atomic — pending
    // counters belong to the old rules). 0.2.0 桥（settingsBridge，见下）只
    // 供源与事件，live re-apply 逻辑在 applyFromSource。
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

    // settings 桥（R-02-001：卡片读写 + AC-01 持久化维度；T-028 0.2.0
    // SettingsForms 适配）：describe/update 由插件模块 Config 导出驱动
    // （entry.fiber.runtime.Config → dsh-settings schema(entry)），宿主无需
    // 注册动作——桥只承担 live source（cell 解包）与宿主热更新事件监听，
    // 不再依赖 settings 服务在场；持久写缝（settings.update）仍走条件子
    // 上下文。未激活/装配失败 → 一次性 error + degradations，保存保持
    // 运行时态、绝不静默。联调验证项（T-028 清单）：loader/volatile-update
    // 在真实宿主的可达性（Context.filter 裁决）。
    let settingsWriter;
    /**
     * settings 桥（apply 内同步装配）。applyFromSource 为「读时求值」原语
     * （T-005 实测第八发现：任何依赖 attach/事件时序的种子都不可靠；关键
     * 读数点前惰性应用，幂等廉价）。
     */
    let settingsBridge;
    /**
     * 上次读到的 source 原文（JSON 序列化）。读时求值仅在 source 变化时应用：
     * entry config 是宿主侧文档真相，而 gateway.set / services.applyConfig 的
     * 运行时写入领先于宿主 reconcile（卡片保存 → patch 落盘 → loader 热更新
     * cell）——未变化的 source 不得回退运行时真相（T-028：桥常在后的新约束）。
     */
    let lastSourceRawJson;
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
        let rawJson;
        try {
            rawJson = JSON.stringify(raw);
        } catch {
            return; // 循环引用等异常宿主形态——不覆盖
        }
        if (rawJson === lastSourceRawJson) {
            return; // source 未变化：不回退运行时写入（幂等廉价）
        }
        lastSourceRawJson = rawJson;
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
    // 启动期仅标注不记日志：写缝子上下文异步激活，接上即清除本标注；确认
    // 缺失/装配失败时才经 degradePersistence 记一次性日志——不虚报。
    degradations.persistence = 'settings-writer-seam-missing';

    // settings 桥同步装配（0.2.0：无 installSection，无需注册动作——不再
    // 依赖 settings 服务在场，T-028）。装配意外失败不致命（entry config 已
    // 在装载时解包生效，读时求值兜底），标注显性化。
    try {
        settingsBridge = installAdvisorFlowSettings(ctx, entryConfig, {
            logger,
            onChange: () => applyFromSource(),
        });
        // attach 即种子（尽力早刷）：entry 尚未产出值时 source 为空 →
        // applyFromSource 空值跳过（不覆盖 raw）——读时求值兜底，失败无妨。
        applyFromSource();
    } catch (error) {
        degradations.settingsSection = 'bridge-install-failed';
        logger.error?.(`advisor-flow: settings 桥装配失败——live 热更新不可用: ${String(error)}`);
    }
    whenServiceAvailable('settings', (settingsSeam) => {
        // 持久写缝（0.2.0：settings.update(ns, patch)——SettingsForms volatile
        // 写缝，落 profile patch 行配置）。写缝侧按 schema 顶层声明键投影：
        // 宿主 validatePaths 拒绝 schema 外顶层键，未知键须留在文档层
        // （strip+mergeLayers 保留未提交键）而非进补丁。
        const update = settingsSeam?.update ?? settingsSeam?.write;
        if (typeof update === 'function') {
            settingsWriter = (raw) => update.call(
                settingsSeam,
                ADVISOR_FLOW_NAMESPACE,
                projectSchemaKeys(AdvisorFlowConfigSchema, raw),
            );
            onPersistenceRecovered(); // 接上即清除缺失降级（恢复语义）
            logger.info?.('advisor-flow: settings 写缝已接入——保存持久化到 profile patch（entry config）');
        } else {
            degradePersistence('settings-writer-seam-missing');
        }
    });
    // 注意：写缝子上下文异步激活——启动期仅标注（见上），确认缺失/装配失败
    // 时才经 degradePersistence 记一次性日志；服务整个缺失（子上下文永不
    // 激活）时保持标注不虚报日志（真实宿主 settings 恒在，此为桩/无头形态）。


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
    on.call(ctx, 'tools/pre-execute', async (exec, next) => {
        // T-035 顾问子会话执行面守卫：命中登记表即否决，短路在门引擎之前
        // （one-shot 顾问不是执行者回路，其调用不进循环门计数）。
        const denial = subsessionGuard.check(exec);
        if (denial) {
            return denial;
        }
        return gateEngine.handlePreExecute(exec, next);
    }, { global: true });
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
            // 压缩/重写：观察状态（循环计数）失效 → 观察器重置。
            applyFromSource(); // 读时求值：提醒档位用最新文件配置（幂等廉价）
            const sessionId = sessionOf(enriched);
            observer.reset(sessionId);
            // 软模式守则提醒（R-01-009/AC-04）：压缩把激活守则的行为语境
            // （调用证据、意见反馈循环）一并摘要掉——重置后送达一条提醒。
            // enabled 门与守则注入前置同型：advisor 整体停用或配置无效不发。
            try {
                if (config.enabled === true && config.mode !== 'hard') {
                    delivery.steerReminder(sessionId);
                }
            } catch (error) {
                logger.error?.('advisor-flow: guideline reminder delivery failed — contained', { session: sessionId, error: String(error) });
            }
        }
    }, { global: true });
    // 收口评审缝（R-01-009；C-021）：agent/turn-stopping 串行派发（T-008 实测
    // 载体 `{turn, signal, agent}`）。监听器 fail-open：内部失败一律放行收口。
    // 触发读点读时求值：处置器判 enabled/mode 前惰性应用最新文件配置，
    // 与 consult/status/gateway 读点同型（lib/index.js:371 读时求值纪律）。
    on.call(ctx, 'agent/turn-stopping', (payload) => {
        applyFromSource(); // 读时求值：收口评审档位用最新文件配置（幂等廉价）
        return turnReview.handleTurnStopping(payload);
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
        // T-022：会话清理摘除呈现登记，判定源不随会话累积泄漏。
        advisorSubsessions.delete(sessionId);
        // T-023/T-026：会话清理摘除共享分类器判定缓存，同 id 复用时判定复位。
        turnReview.forgetSession?.(sessionId);
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
        // modelInfo 数据源（T-034）：目录快照不携带模型 limits，占位数值
        // 经自有 RPC 问宿主运行时（resolveModelInfo 本地解析不落网络）。
        // 直接委派不吞错（审核 N4）：llm 缝缺失或解析抛错交由 gateway
        // 统一降级并记 warn（resolve-failed 在生产装配下可达）。
        resolveModelLimits: (provider, model) => llm.resolveModelInfo(provider, model),
        logger,
    });
    whenServiceAvailable('typert', () => {
        import('./typert-gateway.js')
            .then(({ registerAdvisorFlowGateway }) => {
                const { disposer, gateway } = registerAdvisorFlowGateway(ctx, gatewayHandlers, logger);
                gatewayDisposer = disposer;
                if (gateway) {
                    delete degradations.settingsCard;
                    logger.info?.('advisor-flow: gateway 服务与端点已注册（/api/advisor-flow/get|set|modelInfo）');
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

    // 执行者守则注入：systemPrompt 条件子上下文——section 文本函数按活配置
    // 实时求值（R-01-003/004/006；未激活即守则缝缺失路径，降级标注保留）。
    let guidelinesDisposer;
    degradations.guidelines = 'systemprompt-seam-not-activated';
    whenServiceAvailable('systemPrompt', (systemPromptSeam) => {
        const seam = systemPromptSeam?.systemPrompt ?? systemPromptSeam;
        guidelinesDisposer = installAdvisorGuidelines(seam, () => {
            applyFromSource(); // 读时求值：守则用最新文件配置
            return config;
        }, logger, {
            // pi 语义：ask_advisor 未激活不出守则；预算行经引擎余量查询注入
            isAskAdvisorActive: () => degradations.askAdvisorTool === undefined,
            getRemaining: (sessionId) => engine.remainingCalls(sessionId),
        });
        delete degradations.guidelines;
        logger.info?.('advisor-flow: 执行者守则 section 已注入（systemPrompt）');
    });

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
        turnReview,
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
            guidelinesDisposer?.();
            engine.dispose();
        },
    };
}

// default 导出承载宿主发现（cordis unwrapExports 取 default）：Config 是
// 0.2.0 SettingsForms 的 schema 发现点（runtime.Config = default.Config），
// 缺失即 describe/update 拒绝服务本命名空间（`No configurable plugin entry`）。
export default { name, inject, apply, Config };
