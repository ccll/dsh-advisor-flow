/**
 * The `ask_advisor` tool face (R-01-001; SOLUTION.md#咨询工具).
 *
 * Thin surface only: parameter validation plus error translation into
 * diagnostic-coded results. All judgment lives in the consultation engine
 * (SOLUTION.md#咨询工具: 工具体仅转发咨询服务，不含判定逻辑). `execute`
 * NEVER throws — a failed consultation resolves to an error result with a
 * diagnostic code, so the caller's tool loop keeps working
 * (R-02-005 non-stall invariant).
 *
 * @module dsh-advisor-flow/tools/ask-advisor
 */

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {object} options
 * @param {object} options.engine the consultation engine
 * @returns {object} tool descriptor: `{ name, description, parameters, execute }`
 */
export function createAskAdvisorTool({ engine } = {}) {
    return {
        name: 'ask_advisor',
        description:
            '向顾问模型请求第二意见。可不带参数请求一般性评审，也可携带 question（具体问题）'
            + '或 draft（待评审草稿）聚焦评审；返回意见文本与 adviceId，采纳与否由执行者决定。',
        parameters: {
            type: 'object',
            properties: {
                question: { type: 'string', description: '要请顾问评审的具体问题（可选）' },
                draft: { type: 'string', description: '要请顾问评审的草稿/计划文本（可选）' },
            },
            additionalProperties: false,
        },
        async execute(args) {
            const badParam = validateArgs(args);
            if (badParam) {
                return errorResult('ADVISOR_FAILED', badParam);
            }
            const req = isRecord(args) ? args : {};
            let result;
            try {
                result = await engine.consult({
                    entry: 'tool',
                    question: req.question,
                    draft: req.draft,
                });
            } catch (error) {
                // The engine must not reject; this is defense in depth.
                return errorResult('ADVISOR_FAILED', `内部错误：${String(error)}`);
            }
            if (result.ok) {
                return {
                    adviceId: result.adviceId,
                    severity: result.severity,
                    content: result.text,
                };
            }
            return errorResult(result.code, result.reason);
        },
    };
}

function validateArgs(args) {
    if (args === undefined || args === null) {
        return undefined;
    }
    if (!isRecord(args)) {
        return '参数必须为对象（question/draft 均为可选字符串）';
    }
    for (const key of ['question', 'draft']) {
        const value = args[key];
        if (value !== undefined && typeof value !== 'string') {
            return `参数 ${key} 必须为字符串`;
        }
    }
    const allowed = ['question', 'draft'];
    for (const key of Object.keys(args)) {
        if (!allowed.includes(key)) {
            return `未知参数 ${key}（仅支持 question/draft）`;
        }
    }
    return undefined;
}

function errorResult(code, message) {
    return { error: true, code, message };
}
