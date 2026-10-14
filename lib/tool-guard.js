/**
 * Tool-face guard for `ask_advisor` (R-01-001/AC-09, AC-10; C-025).
 *
 * `ask_advisor` 执行面守卫：execute 前判定调用方会话——
 *
 * - 硬模式（`mode=hard`）：拒绝一切会话的工具调用（`TOOL_FACE_CLOSED`）。
 *   收口评审是硬模式唯一的自动 advisor，主动咨询形成多重评审。
 * - 软模式：拒绝审核类子会话（共享分类器阳性判定，R-01-001/AC-09）与已
 *   登记顾问子会话（T-022 登记缝命中——防御纵深，toolFilter 失效时阻断
 *   自我再入）。
 * - fail-open：未启用放行（沿用引擎自身禁用路径）；守卫组件失败放行；
 *   判定失败（分类器 fail-open）放行——仅阳性判定拒绝。
 * - 拒绝形态复用工具失败面 `{ ok:false, code, reason }`：reason 明示属预期、
 *   勿重试与替代路径；拒绝计数入 `/advisor status`。
 * - 非阻断不变量：守卫不 park 主循环，拒绝只是当次工具调用的失败结果值。
 *
 * @module dsh-advisor-flow/tool-guard
 */

import { DEFAULT_INTERVENTION_MODE, HARD_INTERVENTION_MODE } from './config.js';

/** 拒绝码：硬模式工具面关闭。 */
export const TOOL_FACE_CLOSED_CODE = 'TOOL_FACE_CLOSED';

/** 拒绝码：审核类子会话或顾问子会话（软模式）。 */
export const SESSION_EXEMPT_CODE = 'SESSION_EXEMPT';

/** hard 模式拒绝 reason（模型面英文；三点：属预期 / 勿重试 / 替代路径）。 */
export const TOOL_FACE_CLOSED_REASON =
    'Advisor tool consultation is closed while hard intervention mode is on: the automatic turn review at the end of each turn already reviews this session. This refusal is expected; do not retry ask_advisor. Continue your work — the turn-end review will advise before the turn is accepted.';

/** 软模式拒绝 reason（模型面英文；审核类子会话与顾问子会话同文案）。 */
export const SESSION_EXEMPT_REASON =
    'Advisor tool consultation is not available for review-type or advisor subsessions: a reviewer is itself a quality gate, and an on-demand consultation here would create a meta-review. This refusal is expected; do not retry ask_advisor. Continue your task and report your results to the parent session — advisor consultation remains available to the main session.';

/**
 * Create the tool-face guard.
 *
 * @param {object} options
 * @param {() => object} [options.getConfig] live runtime config
 * @param {() => void} [options.applyConfig] 读时求值原语（与包装引擎同型；
 *   判定前调用——盘上 mode 切换后的首次调用按新档位判定）
 * @param {{ isReviewerSubsession: (sessionId: string) => Promise<boolean> }} [options.classifier]
 *   共享审核类子会话分类器（与收口评审豁免同一实例；缺省不判定——豁免面
 *   收敛，fail-open 同型）
 * @param {(sessionId: string) => boolean} [options.isAdvisorSubsession]
 *   顾问子会话呈现登记表访问器（T-022 登记缝；命中即拒绝——防御纵深，
 *   toolFilter 失效时阻断自我再入）
 * @param {{ info? }} [options.logger]
 * @returns {(sessionId: string|undefined) => Promise<{code: string, reason: string}|undefined>}
 *   undefined = 放行；对象 = 拒绝（code + reason）
 */
export function createToolFaceGuard({ getConfig, applyConfig, classifier, isAdvisorSubsession, logger = console } = {}) {
    /** 拒绝计数（总数 + 按 code）：/advisor status 可查。 */
    const stats = { refused: 0, byCode: {} };

    function refuse(sessionId, code) {
        stats.refused += 1;
        stats.byCode[code] = (stats.byCode[code] ?? 0) + 1;
        logger.info?.(`advisor-flow: ask_advisor refused — ${code}`, { session: sessionId, code });
        const reason = code === TOOL_FACE_CLOSED_CODE ? TOOL_FACE_CLOSED_REASON : SESSION_EXEMPT_REASON;
        return { code, reason };
    }

    /**
     * One tool-call guard decision. Never throws — internal failure is
     * fail-open (allow) so the tool face keeps its legacy engine path.
     *
     * @param {string|undefined} sessionId 调用方会话（`sessionOf(exec)`）
     * @returns {Promise<{code: string, reason: string}|undefined>}
     *   undefined 放行；对象拒绝（code + reason）。
     */
    async function guard(sessionId) {
        try {
            // 时序缝修正（Advisor 复核发现）：包装引擎在 consult 内才应用
            // 文件配置；守卫先行判定必须用同一原语先刷新，否则盘上 mode
            // 切换后的首次调用按旧档位放行。
            applyConfig?.();
            const cfg = getConfig?.() ?? {};
            if (cfg?.enabled !== true) {
                return undefined; // 未启用：沿用引擎自身禁用路径，不加新拒绝
            }
            // mode 缺省随 DEFAULT_INTERVENTION_MODE 归一（C-032 起缺省 soft，
            // 废弃 C-022 缺省 hard；与守则停用谓词、状态呈现同一缺省语义，
            // 未定义 mode 不构成 fail-open 旁路）。
            const mode = typeof cfg?.mode === 'string' ? cfg.mode : DEFAULT_INTERVENTION_MODE;
            if (mode === HARD_INTERVENTION_MODE) {
                return refuse(sessionId, TOOL_FACE_CLOSED_CODE); // 硬模式工具面关闭（R-01-001/AC-10）
            }
            if (isAdvisorSubsession?.(sessionId) === true) {
                return refuse(sessionId, SESSION_EXEMPT_CODE); // 顾问子会话不自我咨询（T-022 防线纵深）
            }
            if (await classifier?.isReviewerSubsession?.(sessionId) === true) {
                return refuse(sessionId, SESSION_EXEMPT_CODE); // 审核类子会话（R-01-001/AC-09）
            }
            return undefined;
        } catch (error) {
            // 守卫组件失败：fail-open 放行（非阻断不变量；留痕可见）。
            logger.info?.('advisor-flow: tool face guard failed — fail-open allow consultation', { session: sessionId, error: String(error) });
            return undefined;
        }
    }

    guard.decisionStats = () => ({ refused: stats.refused, byCode: { ...stats.byCode } });
    return guard;
}
