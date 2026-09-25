/**
 * Scout 会话策展（T-014；SOLUTION.md#scout 策展）。
 *
 * 二次顾问调用对会话脉络做按组策展：required 组强制保留、其余组按预算依次
 * 纳入；非取消失败、超时与取消一律回退 legacy 脉络（红线：Scout 永不阻断
 * 咨询主流程）。
 *
 * @module dsh-advisor-flow/scout
 */

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 字符预算前缀截断（pi scout-reconstruct.ts prefixWithinCharBudget 逐字体）。 */
const PI_PREFIX_WITHIN = (value, maxChars) => {
    let result = '';
    for (const character of value) {
        if (result.length + character.length > maxChars) {
            break;
        }
        result += character;
    }
    return result;
};

/** 超时竞速：胜方清掉计时器，避免悬空定时器拖延进程退出。 */
function raceWithTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const error = new Error('Advisor scout curation timed out.');
            error.scoutTimeout = true;
            reject(error);
        }, ms);
        Promise.resolve(promise).then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

/** 按预算装配策展组：required 强制保留（可超预算），optional 依序填充。 */
function assembleScout(outcome, budget) {
    if (!isRecord(outcome) || !Array.isArray(outcome.groups)) {
        throw new Error('Advisor scout returned no curation groups.');
    }
    // pi scout-reconstruct.ts:19-20：按原始顺序保留（required 组在前出现者仍在前）。
    const ordered = outcome.groups
        .map((group, index) => ({ group, index }))
        .filter(({ group }) => isRecord(group) && typeof group.text === 'string' && group.text.length > 0);
    const parts = [];
    let used = 0;
    for (const { group } of ordered) {
        const text = typeof group.text === 'string' ? group.text : '';
        if (!text) {
            continue;
        }
        const separator = parts.length > 0 ? 2 : 0; // '\n\n'
        if (used + text.length + separator > budget && group.required !== true) {
            break;
        }
        parts.push(text);
        used += text.length + separator;
    }
    const evidenceText = parts.join('\n\n');
    // pi scout-reconstruct.ts:22-24：整体超预算时前缀硬截断（required 组也受总预算约束）。
    if (evidenceText.length >= budget) {
        return { conversation: PI_PREFIX_WITHIN(evidenceText, Math.max(0, budget)), curated: true };
    }
    // pi scout-reconstruct.ts:26-31：synthesis 附不可信注记后以前缀截断纳入
    // 剩余预算（部分可纳——非整体跳过；差分对照实测定位的语义对齐）。
    const synthesisRaw = typeof outcome.synthesis === 'string' ? outcome.synthesis : '';
    const inference = synthesisRaw.trim()
        ? `[Scout synthesis — untrusted, non-authoritative inference; not evidence]\n${synthesisRaw.trim()}`
        : undefined;
    if (!inference) {
        return { conversation: evidenceText, curated: true };
    }
    const separator = evidenceText ? '\n\n' : '';
    const remaining = budget - evidenceText.length - separator.length;
    if (remaining <= 0) {
        return { conversation: evidenceText, curated: true };
    }
    const conversation = `${evidenceText}${separator}${PI_PREFIX_WITHIN(inference, remaining)}`;
    return { conversation, curated: true };
}

/**
 * Scout 策展入口：任何失败/超时路径回退 legacy（curated: false）。
 * @param {object} options
 * @param {string} options.legacy 未经策展的会话脉络
 * @param {number} options.budget 策展输出字符预算
 * @param {() => Promise<unknown>} options.runScout 策展执行缝（引擎注入）
 * @param {number} [options.timeoutMs] 策展时限（缺省不限）
 */
export async function curateAdvisorConversation({ legacy, budget, runScout, timeoutMs } = {}) {
    try {
        const outcome = timeoutMs === undefined
            ? await runScout?.()
            : await raceWithTimeout(Promise.resolve(runScout?.()), timeoutMs);
        const assembled = assembleScout(outcome, typeof budget === 'number' ? budget : Number.MAX_SAFE_INTEGER);
        if (assembled.conversation.length === 0 && typeof legacy === 'string' && legacy.length > 0) {
            // 策展产出为空但 legacy 有内容：空策展不优于原文，回退。
            return { conversation: legacy, curated: false };
        }
        return { conversation: assembled.conversation, curated: true };
    } catch {
        return { conversation: typeof legacy === 'string' ? legacy : '', curated: false };
    }
}
