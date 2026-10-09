/**
 * Subagent presentation seam (R-02-007; C-020).
 *
 * 顾问咨询的会话可见形态：`presentation=subagent`（默认）时，装配后的咨询
 * 素材经宿主公开缝 `ctx.subagents.start` 以 one-shot 顾问子会话发起——
 * 会话界面出现父会话为当前会话的顾问子会话条目（label 标识顾问与入口）。
 * 缝缺失、无语义合规的呈现提供方或发布前发起失败时返回 `fallback`，由
 * 咨询引擎降级 llm.stream 直调并显性化（AC-03）；`start()` 发布成功后的
 * run 失败一律映射失败/中止终态，不降级重发（AC-04）。
 *
 * 契约保持：
 * - 素材契约不变——prompt 即素材装配器的装配产物（R-02-006 六区），子会话
 *   不继承父上下文（呈现提供方必须 `inheritsParentContext === false`）。
 * - NG-1 零工具——`toolFilter: { allow: [] }`（空 allowlist = 移除全部工具）。
 * - 协议提示——ADVISOR_SYSTEM / ADVISOR_DECISION 经子会话 `persona` 承载。
 * - 非阻断（R-02-005）——本缝绝不抛错：一切失败折叠为 `fallback` /
 *   `failure` / `aborted` 三类值。
 *
 * 纯逻辑：宿主缝经注入（`subagents`），单测以假缝承载；接线在 lib/index.js。
 *
 * @module dsh-advisor-flow/subsession
 */

import { isRecord, CONSULTATION_ENTRIES } from './util.js';

/** 子会话条目标签基底（AC-01：标识顾问）。 */
export const SUBSESSION_LABEL_BASE = 'Advisor review';

/** AC-01：条目标签标识顾问与发起入口（入口四态见 util.CONSULTATION_ENTRIES）。 */
export function subsessionLabel(entry) {
    const kind = CONSULTATION_ENTRIES.includes(entry) ? entry : 'tool';
    return `${SUBSESSION_LABEL_BASE} (${kind})`;
}

/**
 * 语义合规的呈现提供方判定：不继承父上下文（素材由 prompt 全量承载）、
 * 支持顾问路由覆盖（agentOptions）与零工具约束（toolFilter）。
 */
function isEligibleProvider(provider) {
    return isRecord(provider)
        && provider.inheritsParentContext === false
        && provider.capabilities?.agentOptions === true
        && provider.capabilities?.toolFilter === true;
}

/**
 * 解析呈现提供方：优先宿主 spawn 后端默认名（`spawn`），否则扫描已注册
 * 名单取首个语义合规者；无则返回 undefined（发布前失败 → 降级）。
 */
function resolvePresenterProvider(subagents, preferredName) {
    if (typeof subagents?.getProvider === 'function') {
        const preferred = subagents.getProvider(preferredName);
        if (isEligibleProvider(preferred)) {
            return preferred;
        }
    }
    if (typeof subagents?.list === 'function' && typeof subagents?.getProvider === 'function') {
        for (const name of subagents.list()) {
            const provider = subagents.getProvider(name);
            if (isEligibleProvider(provider)) {
                return provider;
            }
        }
    }
    return undefined;
}

/** SubagentResult.output → 意见文本：仅取文本块，空输出返回空串（AC-06）。 */
export function subsessionOutputText(output) {
    if (!Array.isArray(output)) {
        return '';
    }
    return output
        .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
}

/**
 * Create the subsession presenter.
 *
 * @param {object} options
 * @param {object} options.subagents the dsh `ctx.subagents` service
 * @param {{ info?, warn?, debug? }} [options.logger]
 * @param {string} [options.preferredProvider] host spawn backend name
 *   (default `spawn`; the deployment may rename it — the registry scan
 *   covers that case)
 * @param {(subsessionId: string) => Promise<undefined|object>} [options.extractUsage]
 *   usage extraction seam (the wiring reads the child session log); called
 *   BEFORE the run handle is disposed — the child session may not be
 *   readable afterwards.
 * @param {(subsessionId: string) => void} [options.onPresented]
 *   presentation registry seam (T-022): invoked with the child session id
 *   as soon as the run is published (BEFORE the result settles). The wiring
 *   records the id so the turn-review handler can exempt advisor
 *   subsessions from re-entry (recursion guard). Failures are contained —
 *   presentation must never depend on the registry.
 * @returns {{ present: (request: object) => Promise<object> }}
 */
export function createSubsessionPresenter({ subagents, logger = console, preferredProvider = 'spawn', extractUsage, onPresented } = {}) {
    return {
        /**
         * Present one consultation via a one-shot advisor subsession.
         *
         * Resolves (never rejects) with:
         * - `{ kind: 'answered', text, usage? }` — the child's final advice;
         * - `{ kind: 'failure', failure: { message, code } }` — published-run
         *   failure (error/max-tokens/refusal) or empty output;
         * - `{ kind: 'aborted', reason }` — the run was cancelled/disposed
         *   (the caller distinguishes timeout via its own deadline signal);
         * - `{ kind: 'fallback', reason }` — pre-publication failure; the
         *   caller degrades to the direct llm.stream path (AC-03).
         *
         * @param {object} request
         * @param {string} request.promptText the assembled consultation
         *   message text (R-02-006 contract product)
         * @param {object} request.parent the spawning live Agent (required;
         *   a missing parent is a pre-publication failure)
         * @param {AbortSignal} request.signal the fused deadline signal
         * @param {object} request.agentOptions the advisor route override
         *   (provider/model/reasoningEffort/maxTokens)
         * @param {string} request.persona the advisor protocol prompt
         * @param {string} request.entry tool|manual|gate
         */
        async present(request = {}) {
            const {
                promptText,
                parent,
                signal,
                agentOptions,
                persona,
                entry,
            } = isRecord(request) ? request : {};
            try {
                if (typeof subagents?.start !== 'function') {
                    return { kind: 'fallback', reason: 'subagents 缝缺失' };
                }
                const provider = resolvePresenterProvider(subagents, preferredProvider);
                if (!provider) {
                    return { kind: 'fallback', reason: 'subagents 缝无语义合规的呈现提供方' };
                }
                if (!isRecord(parent) || typeof parent.id !== 'string') {
                    return { kind: 'fallback', reason: '咨询请求未携带父会话 Agent' };
                }
                let run;
                try {
                    run = await subagents.start(provider.name, {
                        label: subsessionLabel(entry),
                        prompt: [{ type: 'text', text: typeof promptText === 'string' ? promptText : '' }],
                        parent,
                        signal,
                        agentOptions: isRecord(agentOptions) ? agentOptions : {},
                        toolFilter: { allow: [] },
                        persona: typeof persona === 'string' ? persona : undefined,
                    });
                } catch (error) {
                    // 发布前失败（含 start 校验拒绝）：无 run 可.dispose，
                    // 降级直调（AC-03）。
                    return { kind: 'fallback', reason: `子会话发布前失败：${String(error)}` };
                }
                // T-022 登记缝：发布成功且 run.id 为字符串时登记（先于
                // result 结算），收口评审豁免以此判定本插件发出的子会话。
                // 登记失败 info 级留痕——守卫降级必须可观测，呈现路径绝不
                // 依赖登记成功。
                try {
                    if (typeof onPresented === 'function' && typeof run?.id === 'string') {
                        onPresented(run.id);
                    }
                } catch (error) {
                    logger.info?.('advisor-flow: subsession presentation registry failed — contained', { error: String(error) });
                }
                // run 在手：此后任何异常都是发布后异常——映射 failure/aborted
                // 终态，绝不返回 fallback（AC-04：发布后失败不得降级直调重发
                // 请求；C-020）。await run.result 的 resolve 路径承载子级失败
                // （stopReason: 'error'）；rejection 仅承载 seam 无法以
                // stopReason 表达的基础设施故障。
                try {
                    const result = await run.result;
                    if (result?.stopReason === 'completed') {
                        const text = subsessionOutputText(result.output);
                        // 用量在 dispose 前提取——结算后子会话可能不再可读；
                        // 空输出（EMPTY 失败）同样记账（与直调路径 EMPTY 记账
                        // 语义一致，R-02-002/AC-02）。
                        const usage = typeof extractUsage === 'function'
                            ? await Promise.resolve(extractUsage(run.id)).catch(() => undefined)
                            : undefined;
                        const usableUsage = isRecord(usage) ? usage : undefined;
                        if (text.length === 0) {
                            return { kind: 'failure', failure: { code: 'EMPTY', message: 'Advisor returned no advice.' }, usage: usableUsage };
                        }
                        return { kind: 'answered', text, usage: usableUsage };
                    }
                    if (result?.stopReason === 'aborted') {
                        return { kind: 'aborted', reason: result.diagnostic ?? 'disposed or cancelled' };
                    }
                    return {
                        kind: 'failure',
                        failure: {
                            message: result?.diagnostic || `子会话结算异常（${result?.stopReason ?? 'unknown'}）`,
                            code: 'SUBSESSION',
                        },
                    };
                } catch (error) {
                    // 发布后 rejection：信号已中止 → 中止终态（超时区分归调用
                    // 方 deadline）；否则失败终态（诊断码由调用方映射）。
                    if (signal?.aborted) {
                        return { kind: 'aborted', reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'disposed or cancelled') };
                    }
                    return { kind: 'failure', failure: { message: String(error), code: 'SUBSESSION' } };
                } finally {
                    // AC-04：句柄无条件释放（成功、失败、中止各路径一致；
                    // one-shot 契约要求消费方总是 dispose）。
                    try {
                        await run.dispose?.();
                    } catch (error) {
                        logger.debug?.('advisor-flow: subsession dispose failed — contained', { error: String(error) });
                    }
                }
            } catch (error) {
                // Containment：本缝绝不抛错（R-02-005）；兜底降级直调。
                logger.warn?.('advisor-flow: subsession presentation contained an error — fallback', { error: String(error) });
                return { kind: 'fallback', reason: `子会话呈现内部错误：${String(error)}` };
            }
        },
    };
}
