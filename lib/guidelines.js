/**
 * 执行者守则（R-01-003/004/006; C-007 对齐 pi advisorInvocationGuidelines）。
 *
 * 计划/失败/收尾三类关键节点由注入执行者系统提示的行为守则约束——执行者
 * 在这些节点主动调用 ask_advisor。守则经 `ctx.systemPrompt.section` 注册，
 * text 为函数、按活配置实时求值（全关返回空串，配置变更即时生效）。
 *
 * @module dsh-advisor-flow/guidelines
 */

import { isRecord } from './util.js';

/** 各守则文案（pi 对齐，中文表述；语义逐条与 pi 一致）。 */
export const GUIDELINE_TEXTS = {
    plan: '在确定一个有实质影响的计划之前，先完成调查并形成你自己的候选方向，然后调用 ask_advisor 并附上简明草稿。草稿必须命名拟议工作、验证方式与剩余风险。草稿声明不是验证证据。',
    failure: '两次实质等价的尝试连续失败后，或修复动作重现了早先的失败，或两次动作无可测进展时，使用 ask_advisor。在咨询之前不要再做实质等价的尝试。',
    completion: '宣告成功之前，使用 ask_advisor 并附上命名了已变更工作、验证方式与剩余风险的简明草稿。草稿声明不是验证证据。仅对明显琐碎、低风险的工作跳过本守则。',
};

/** 收尾公共守则：空对象调用即一般性评审；不为请求评审而编造问题。 */
export const GUIDELINE_CLOSING =
    '默认以空对象调用 ask_advisor。不要为了请求评审而编造问题：顾问已经收到上下文。仅对真正具体的假设或取舍附加 question。';

/**
 * 由活配置求值守则文本（section.text 的函数形态）。
 *
 * @param {() => object} getConfig live resolved config
 * @returns {(context: object) => string} 每步组装时求值的守则文本
 */
export function guidelineTextFactory(getConfig) {
    return (context) => {
        if (context?.agent === undefined) {
            return ''; // agentless 组装不出守则
        }
        const config = getConfig?.() ?? {};
        if (config?.enabled !== true) {
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
        if (lines.length === 0) {
            return '';
        }
        lines.push(`- ${GUIDELINE_CLOSING}`);
        return [
            'Advisor 咨询守则（advisor-flow）：',
            ...lines,
        ].join('\n');
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
export function installAdvisorGuidelines(systemPrompt, getConfig, logger = console) {
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
        text: guidelineTextFactory(getConfig),
    });
}
