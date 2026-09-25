/**
 * 意见采纳回写工具（R-01-008；record_advisor_outcome 对应物）。
 *
 * 执行者自愿回写某条意见的采纳与验证结果：一次性且不可重复（AC-01/02）；
 * 功能禁用返回提示值（AC-04）；落盘经引擎 appendOutcome 缝（HMAC 哈希承载
 * 原文，AC-03）。
 *
 * @module dsh-advisor-flow/tools/record-outcome
 */

import { isRecord } from '../util.js';

const ADOPTIONS = new Set(['followed', 'not-followed', 'unknown']);
const VALIDATIONS = new Set(['passed', 'failed', 'not-run', 'unknown']);

/**
 * @param {object} options.engine 引擎缝：outcomeLoggingEnabled / reserveAdvice /
 *   commitAdvice / releaseAdvice / appendOutcome
 */
export function createRecordOutcomeTool({ engine }) {
    return {
        name: 'advisor_record_outcome',
        label: 'Advisor outcome',
        description:
            'Record the adoption and validation result of a specific Advisor response. Requires the adviceId from the Advisor response. Recording is one-shot per advice; unknown or already-recorded ids are rejected without throwing.',
        parameters: {
            type: 'object',
            properties: {
                adviceId: { type: 'string', description: 'The adviceId from the Advisor response being reviewed.' },
                adoption: { type: 'string', enum: ['followed', 'not-followed', 'unknown'], description: 'Whether the advice was followed.' },
                validationStatus: { type: 'string', enum: ['passed', 'failed', 'not-run', 'unknown'], description: 'Outcome of any validation performed against the advice.' },
            },
            required: ['adviceId', 'adoption', 'validationStatus'],
        },
        async execute(params = {}) {
            const adviceId = typeof params.adviceId === 'string' ? params.adviceId : '';
            const adoption = ADOPTIONS.has(params.adoption) ? params.adoption : 'unknown';
            const validationStatus = VALIDATIONS.has(params.validationStatus) ? params.validationStatus : 'unknown';
            const enabled = typeof engine?.outcomeLoggingEnabled === 'function'
                ? engine.outcomeLoggingEnabled()
                : engine?.outcomeLoggingEnabled === true;
            if (!enabled) {
                return { recorded: false, reason: 'Advisor outcome logging is disabled by configuration.' };
            }
            const reserved = engine.reserveAdvice(adviceId);
            if (!isRecord(reserved) || typeof reserved.advice !== 'string') {
                // 未知 / 已回写 / 未决态以外的标识：明确拒绝且不抛出（AC-02）。
                return { recorded: false, reason: `No pending Advisor response for adviceId "${adviceId || '(missing)'}".` };
            }
            try {
                const stored = await engine.appendOutcome({
                    adviceId,
                    advice: reserved.advice,
                    trigger: reserved.trigger ?? 'executor-requested',
                    adoption,
                    validationStatus,
                });
                if (stored !== true && !(stored && typeof stored === 'object')) {
                    engine.releaseAdvice(adviceId);
                    return { recorded: false, reason: 'Advisor outcome could not be persisted.' };
                }
                if (engine.commitAdvice(adviceId) !== true) {
                    return { recorded: false, reason: 'Advice outcome was already recorded.' };
                }
                return { recorded: true };
            } catch (error) {
                engine.releaseAdvice(adviceId);
                return {
                    recorded: false,
                    reason: `Advisor outcome recording failed: ${error instanceof Error ? error.message : String(error)}`,
                };
            }
        },
    };
}
