/**
 * 顾问子会话执行面守卫（T-035；NG-1、R-02-007/AC-05；C-034）。
 *
 * 宿主 dsh-tool-subagent 把委派工具（`subagent`/`list_subagent_models`）
 * 注册进被 spawn 子会话的 own 层，dsh-tools 的 restrict 只过滤继承面、
 * own 层注册恒可见——插件的 `toolFilter:{allow:[]}` 因此拦不住委派对
 * （真机实证：顾问子会话 step1 即委派子代理执行命令）。本守卫在
 * `tools/pre-execute` 执行边界对已登记顾问子会话（呈现缝登记表，T-022）
 * 的**一切**工具调用做同步否决——NG-1 是全称不变量（顾问不执行任何工具），
 * 不做名单收窄；插件不使用 outputSchema，子会话作答走最终文本，无内联
 * 工具需求。指令面纵深由 persona 附加段（ADVISOR_NO_DELEGATION_ADDENDUM，
 * lib/consultation.js）承载，能力面以本守卫兜底。
 *
 * fail-open 纪律（对齐工具面守卫 C-025）：仅登记表阳性判定否决；载体畸形、
 * 访问器抛错一律放行——误伤正常会话工具面的代价高于放过本缺陷（泄漏本身
 * 是宿主侧缺陷，本守卫是插件侧防线纵深而非唯一防线）。
 *
 * @module dsh-advisor-flow/subsession-guard
 */

import { isRecord, sessionOf } from './util.js';

/** 否决码（状态快照与日志标识）。 */
export const SUBSESSION_TOOL_DENIED_CODE = 'SUBSESSION_TOOL_DENIED';

/**
 * 模型面英文拒绝文案（插件自撰，非冻结基线；三点式对齐工具面守卫先例）：
 * 属预期 / 勿重试 / 替代路径（以素材直接作答）。
 */
export const SUBSESSION_TOOL_DENIED_REASON = [
    'Tool execution is disabled inside advisor subsessions: the advisor is advisory-only and must not act — no tools, no file changes.',
    'This refusal is expected; do not retry.',
    'Perform your analysis from the supplied materials and return your advice as your final message.',
].join(' ');

/**
 * Create the advisor-subsession execution guard.
 *
 * @param {{ isAdvisorSubsession?: (sessionId: string) => boolean,
 *           logger?: object }} [options]
 *   `isAdvisorSubsession` 是 T-022 呈现登记表的读取访问器（Set.has 语义，
 *   同步无错误路径）；判定为 `true` 即否决。
 * @returns {{ check(exec: object): (undefined|object), denialStats: () => object }}
 *   `check` 同步返回 `{ kind: 'deny', reason }` 或 undefined（放行/透传）。
 */
export function createSubsessionExecutionGuard({ isAdvisorSubsession, logger = console } = {}) {
    const stats = { denied: 0, byTool: {} };
    return {
        /**
         * Pre-execute denial check. Synchronous by design: the advisor
         * registry is an in-memory Set (no async judgment on this face).
         *
         * @param {object} exec the `tools/pre-execute` carrier
         * @returns {undefined | { kind: string, reason: string }}
         *   undefined = 放行（含畸形载体与守卫异常——fail-open，与守卫族
         *   惯例一致：错误时不得误伤正常会话的工具面）
         */
        check(exec) {
            try {
                if (!isRecord(exec) || typeof exec.name !== 'string') {
                    return undefined; // 与门引擎同判：畸形载体不归属、直接透传
                }
                const sessionId = sessionOf(exec);
                if (isAdvisorSubsession?.(sessionId) !== true) {
                    return undefined; // 仅登记表阳性否决；外来会话（含审核类子会话）不受本守卫约束
                }
                stats.denied += 1;
                stats.byTool[exec.name] = (stats.byTool[exec.name] ?? 0) + 1;
                logger.info?.(`advisor-flow: advisor subsession tool call denied — ${SUBSESSION_TOOL_DENIED_CODE}`, {
                    session: sessionId,
                    tool: exec.name,
                });
                // pre-execute 否决契约只有 {kind, reason}——code 仅作日志/统计标识，
                // 不外溢进载体（消费方按 kind 分派）。
                return { kind: 'deny', reason: SUBSESSION_TOOL_DENIED_REASON };
            } catch (error) {
                logger.warn?.('advisor-flow: subsession execution guard failed — allow (fail-open)', { error: String(error) });
                return undefined;
            }
        },
        /** 否决统计（/advisor status 快照面；byTool 供泄漏面诊断）。 */
        denialStats: () => ({ denied: stats.denied, byTool: { ...stats.byTool } }),
    };
}
