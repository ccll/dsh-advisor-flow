/**
 * The `ask_advisor` tool face (R-01-001; SOLUTION.md#咨询工具).
 *
 * Thin surface only: parameter validation plus error translation into
 * diagnostic-coded values. All judgment lives in the consultation engine
 * (SOLUTION.md#咨询工具: 工具体仅转发咨询服务，不含判定逻辑). `execute`
 * NEVER throws — a failed consultation resolves to an `{ok:false, code,
 * reason}` value with a diagnostic code, so the caller's tool loop keeps
 * working (R-02-005 non-stall invariant).
 *
 * 注册契约（T-008 真机实测，dsh-tools `tools.register`）：定义必须声明
 * `output { schema, render }`——缺失时注册抛 TypeError，工具永远无法注册。
 *
 * 参数面（R-01-001/AC-01；pi 0.8.2 register-ask-advisor.ts:234-279 逐字，
 * C-009 基线冻结）：question/draft/gitContext/includeTrackedFiles/
 * includeUntracked 全可选；`force` 属 Jev 谱系（NG-6 不移植）。
 *
 * @module dsh-advisor-flow/tools/ask-advisor
 */

import { isRecord } from '../util.js';

/** pi 工具描述逐字（register-ask-advisor.ts:72-74）。 */
export const TOOL_DESCRIPTION =
    'Consult the on-demand Advisor model for strategic guidance. Call with an empty object for a contextual review; attach an optional draft for concrete plan or completion review. If the Advisor explicitly names a missing file, you may make a sequential follow-up call with includeTrackedFiles when enabled and relevant.';

/** pi 参数描述逐字（register-ask-advisor.ts:234-279）。 */
export const TOOL_PARAM_DESCRIPTIONS = Object.freeze({
    question:
        'The specific question or decision to get advice on. Omit this for normal reviews: the Advisor already has the conversation context.',
    draft: 'Concise untrusted draft for plan or completion review; claims are not verification evidence.',
    gitContext:
        "How much of the working tree to include. Use full when the review depends on the exact code changes, such as a completion review. Use summary for changed file names only, or none when the question is not about the current changes. The user's configured allowance is the ceiling and a larger request is narrowed to it.",
    includeTrackedFiles:
        'Exact tracked repository-relative files to attach after the Advisor explicitly names a file it cannot review. Requires global advisorTrackedFileContent consent; current working-tree contents are sent as untrusted data.',
    includeUntracked:
        'Exact new repository-relative files to include only when user configuration allows it.',
});

/** pi renderAdvisorResult 的无意见兜底文案（render-advisor-result.ts:177）。 */
export const NO_ADVICE_TEXT = '(Advisor returned no advice.)';

/**
 * @param {object} options
 * @param {object} options.engine the consultation engine
 * @returns {object} tool descriptor: `{ name, description, parameters,
 *   output: { schema, render }, execute }` — the `output` block is REQUIRED
 *   by the host registry (`tools.register` throws on a definition without
 *   `output { schema, render }` — T-008 实测).
 */
export function createAskAdvisorTool({ engine } = {}) {
    return {
        name: 'ask_advisor',
        description: TOOL_DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                question: {
                    type: 'string',
                    description:
                        'The specific question or decision to get advice on. Omit this for normal reviews: the Advisor already has the conversation context.',
                },
                draft: {
                    type: 'string',
                    description:
                        'Concise untrusted draft for plan or completion review; claims are not verification evidence.',
                },
                // pi Type.Union([none, summary, full]) → JSON Schema enum 形态
                //（机制移植：TypeBox → JSON Schema，描述文本逐字保留）。
                gitContext: {
                    type: 'string',
                    enum: ['none', 'summary', 'full'],
                    description:
                        "How much of the working tree to include. Use full when the review depends on the exact code changes, such as a completion review. Use summary for changed file names only, or none when the question is not about the current changes. The user's configured allowance is the ceiling and a larger request is narrowed to it.",
                },
                // pi 把描述放在 items 的 string 上；dsh JSON Schema 把数组
                // 描述挂在 array 节点——文本逐字、位置属宿主 schema 形态适配。
                includeTrackedFiles: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Exact tracked repository-relative files to attach after the Advisor explicitly names a file it cannot review. Requires global advisorTrackedFileContent consent; current working-tree contents are sent as untrusted data.',
                },
                includeUntracked: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Exact new repository-relative files to include only when user configuration allows it.',
                },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    adviceId: { type: 'string' },
                    text: { type: 'string' },
                    model: { type: 'string' },
                    code: { type: 'string' },
                    reason: { type: 'string' },
                },
                additionalProperties: false,
            },
            render(args, value) {
                // R-01-001/AC-05：结果文本以 `Advisor (model)` 前缀起始并附
                // 意见全文；adviceId 随渲染输出（staging 实测裁决：可回查）。
                const adviceId = isRecord(value) && typeof value.adviceId === 'string' && value.adviceId.length > 0
                    ? `\n（adviceId: ${value.adviceId}）`
                    : '';
                if (isRecord(value) && typeof value.text === 'string' && value.text.length > 0) {
                    const model = typeof value.model === 'string' && value.model.length > 0 ? value.model : 'advisor';
                    return [{ type: 'text', text: `Advisor (${model})\n\n${value.text}${adviceId}` }];
                }
                const reason = isRecord(value) && typeof value.reason === 'string' ? value.reason : '';
                const code = isRecord(value) && typeof value.code === 'string' ? value.code : 'UNKNOWN';
                const text = reason.length > 0
                    ? `Advisor consultation failed (${typeof value.code === 'string' ? value.code : 'UNKNOWN'}): ${reason}`
                    : '(Advisor returned no advice.)';
                return [{ type: 'text', text }];
            },
        },
        async execute(args) {
            const badParam = validateArgs(args);
            if (badParam) {
                return { ok: false, code: 'ADVISOR_FAILED', reason: badParam };
            }
            const req = isRecord(args) ? args : {};
            let result;
            try {
                result = await engine.consult({
                    entry: 'tool',
                    question: req.question,
                    draft: req.draft,
                    gitContext: req.gitContext,
                    includeTrackedFiles: req.includeTrackedFiles,
                    includeUntracked: req.includeUntracked,
                });
            } catch (error) {
                // The engine must not reject; this is defense in depth.
                return { ok: false, code: 'ADVISOR_FAILED', reason: `internal error: ${String(error)}` };
            }
            if (isRecord(result) && result.ok) {
                return {
                    ok: true,
                    adviceId: result.adviceId,
                    text: result.text,
                    model: result.model,
                };
            }
            return {
                ok: false,
                code: isRecord(result) && typeof result.code === 'string' ? result.code : 'ADVISOR_FAILED',
                reason: isRecord(result) && typeof result.reason === 'string' ? result.reason : 'unknown',
            };
        },
    };
}

function validateArgs(args) {
    if (args === undefined || args === null) {
        return undefined;
    }
    if (!isRecord(args)) {
        return 'arguments must be an object (question/draft/gitContext/includeTrackedFiles/includeUntracked are optional)';
    }
    for (const key of ['question', 'draft']) {
        const value = args[key];
        if (value !== undefined && typeof value !== 'string') {
            return `argument ${key} must be a string`;
        }
    }
    if (args.gitContext !== undefined && !['none', 'summary', 'full'].includes(args.gitContext)) {
        return 'argument gitContext must be one of none|summary|full';
    }
    for (const key of ['includeTrackedFiles', 'includeUntracked']) {
        const value = args[key];
        if (value !== undefined && !(Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0))) {
            return `argument ${key} must be an array of non-empty strings`;
        }
    }
    const allowed = ['question', 'draft', 'gitContext', 'includeTrackedFiles', 'includeUntracked'];
    for (const key of Object.keys(args)) {
        if (!allowed.includes(key)) {
            return `unknown argument ${key} (only question/draft/gitContext/includeTrackedFiles/includeUntracked are supported)`;
        }
    }
    return undefined;
}
