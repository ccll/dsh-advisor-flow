/**
 * 执行者守则（R-01-003/004/006; C-007 对齐 pi advisorInvocationGuidelines）。
 *
 * 计划/失败/收尾三类关键节点由注入执行者系统提示的行为守则约束——执行者
 * 在这些节点主动调用 ask_advisor。守则经 `ctx.systemPrompt.section` 注册，
 * text 为函数、按活配置实时求值（全关返回空串，配置变更即时生效）。
 *
 * @module dsh-advisor-flow/guidelines
 */

import { advisorModelAllowed, isRecord } from './util.js';

/** 各守则文案（pi 0.8.2 advisorInvocationGuidelines 逐字，R-01-003/AC-01；
 * C-009 基线冻结）。 */
export const GUIDELINE_TEXTS = {
    plan: 'Before committing to a materially consequential plan, use ask_advisor with a concise draft after investigating and forming your own candidate direction. The draft must name proposed work, validation, and remaining risks. A draft claim is not verification evidence.',
    failure: 'Use ask_advisor after two consecutive materially equivalent failed attempts, when a fix recreates an earlier failure, or after two actions produce no measurable progress. Do not make another materially equivalent attempt before consulting.',
    completion: 'Before declaring success, use ask_advisor with a concise draft naming changed work, validation, and remaining risks. A draft claim is not verification evidence. Skip this only for demonstrably trivial, low-risk work.',
};

/** 收尾公共守则（pi 逐字）：空对象调用即一般性评审；不为请求评审而编造问题。 */
export const GUIDELINE_CLOSING =
    'Call ask_advisor with an empty object by default. Do not invent a question merely to request a review: the Advisor already receives context. Include question only for a genuinely specific assumption or trade-off.';

/** pi 守则块头部与行格式（register-lifecycle.ts:89）：`Advisor invocation
 * settings:` + `- ` 前缀列表；预算行整段追加在最后。 */
export const GUIDELINE_HEADER = 'Advisor invocation settings:';

/** 预算行模板（register-lifecycle.ts:80-82 逐字）。 */
export const GUIDELINE_BUDGET = (remaining) =>
    `Advisor calls remaining this session: ${remaining}.\nReserve calls for material decisions, repeated failures, or final review.`;

/**
 * 由活配置求值守则文本（section.text 的函数形态；pi register-lifecycle.ts:70-92
 * 语义：ask_advisor 未激活或顾问模型不可用时不注入守则）。
 *
 * @param {() => object} getConfig live resolved config
 * @param {{ isAskAdvisorActive?: () => boolean, getRemaining?: (sessionId: string) => number|undefined }} [hooks]
 *   工具缝激活旗标与每会话余量查询（接线注入；缺省视为激活/无预算）。
 * @returns {(context: object) => string} 每步组装时求值的守则文本
 */
export function guidelineTextFactory(getConfig, hooks = {}) {
    return (context) => {
        if (hooks.isAskAdvisorActive?.() === false) {
            return ''; // pi 语义：ask_advisor 未激活则不出守则（R-01-007/AC-04）
        }
        if (context?.agent === undefined) {
            return ''; // agentless 组装不出守则
        }
        const config = getConfig?.() ?? {};
        if (config?.enabled !== true) {
            return '';
        }
        // pi advisorModelAccess 前置：白名单不可用 → 不注入（共享谓词）。
        if (!advisorModelAllowed(config)) {
            return '';
        }
        const gates = config.gates ?? {};
        const lines = [];
        if (gates.plan?.enabled === true) {
            lines.push(`- ${GUIDELINE_TEXTS.plan}`);
        }
        if (gates.failure?.enabled === true) {
            lines.push(`- ${GUIDELINE_TEXTS.failure}`);
        }
        if (gates.completion?.enabled === true) {
            lines.push(`- ${GUIDELINE_TEXTS.completion}`);
        }
        if (typeof config.customInvocation === 'string' && config.customInvocation.length > 0) {
            lines.push(`- Also use ask_advisor when: ${config.customInvocation}`);
        }
        if (lines.length === 0) {
            return '';
        }
        lines.push(`- ${GUIDELINE_CLOSING}`);
        const remaining = hooks.getRemaining?.(context?.agent?.id);
        if (typeof remaining === 'number') {
            lines.push(`- ${GUIDELINE_BUDGET(remaining)}`);
        }
        return [GUIDELINE_HEADER, ...lines].join('\n');
    };
}


/**
 * Install the guidelines prompt section（条件 systemPrompt 子上下文的回调体）。
 *
 * @param {object} systemPrompt the host systemPrompt registry seam
 * @param {() => object} getConfig live runtime config
 * @param {{ info? }} [logger]
 * @returns {Function} disposer
 */
export function installAdvisorGuidelines(systemPrompt, getConfig, logger = console, hooks = {}) {
    if (!isRecord(systemPrompt) || typeof systemPrompt.section !== 'function') {
        logger.info?.('advisor-flow: systemPrompt 缝形态不符——守则未注入（degraded）');
        return () => {};
    }
    const order = typeof systemPrompt.getSectionOrder === 'function'
        ? systemPrompt.getSectionOrder('PLAN_POLICY')
        : 400;
    return systemPrompt.section({
        name: 'advisor-flow:guidelines',
        order,
        text: guidelineTextFactory(getConfig, hooks),
    });
}
