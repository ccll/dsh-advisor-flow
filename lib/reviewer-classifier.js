/**
 * Reviewer-subsession classifier (T-026; C-025) — the shared judgment for
 * both the turn-review exemption (T-023) and the ask_advisor tool-face guard.
 *
 * 判定语义与 T-023 一致（SOLUTION.md#运行时、并发与失败语义「子会话审核豁免」）：
 * - 自证前置：会话自身日志 header `origin === 'subagent'`（fork 会话无该
 *   字段，不判为子会话）。
 * - 关键词命中：`subagent/descriptor` 的创建标签或首条 `agent/inbox/spliced`
 *   提示词命中豁免模式清单（大小写不敏感子串，两源分离匹配）。
 * - fail-open：缝缺失、读取失败、解析失败一律 false（照常评审/放行工具）；
 *   只凭阳性判定豁免。
 * - 缓存：仅成功读取的判定按会话缓存（含 false）；清单变更失配重判；随
 *   `session/disposed` 摘除（forgetSession 缝，接线调用）。
 *
 * @module dsh-advisor-flow/reviewer-classifier
 */

import { textFrom } from './conversation-source.js';

/**
 * 审核类子会话判定（纯函数，T-023）：自证（header `origin === 'subagent'`）
 * 且豁免清单命中创建标签（`subagent/descriptor` 的 `data.label`）或首条
 * `agent/inbox/spliced` 提示词。匹配为大小写不敏感的子串包含（标签与
 * 提示词各自独立匹配，等价 OR，不跨源拼接——避免跨界拼出清单词）。
 * 空清单或缺事件流一律 false（判定关闭与 fail-open 同向）。
 *
 * @param {object[]|undefined} events 会话有序事件流（sessionQuery 租约产物）
 * @param {string[]} patterns 豁免模式清单（非空字符串数组）
 * @returns {boolean}
 */
export function subsessionExemptFrom(events, patterns) {
    if (!Array.isArray(events) || !Array.isArray(patterns) || patterns.length === 0) {
        return false;
    }
    const header = events.find((event) => event?.type === 'session');
    if (header?.origin !== 'subagent') {
        return false; // 自证前置：主会话与 fork 会话（无 origin 字段）不是子会话
    }
    const descriptor = events.find((event) => event?.type === 'subagent/descriptor');
    const label = typeof descriptor?.data?.label === 'string' ? descriptor.data.label : '';
    let prompt = '';
    for (const event of events) {
        if (event?.type !== 'agent/inbox/spliced') {
            continue;
        }
        const inserted = Array.isArray(event?.data?.inserted) ? event.data.inserted : [];
        const text = inserted
            .map((message) => textFrom(message?.content))
            .filter((part) => part.length > 0)
            .join('\n');
        if (text.trim().length > 0) {
            prompt = text; // 首条非空提示词（实测子会话日志无 user/message 事件）
            break;
        }
    }
    const labelHay = label.toLowerCase();
    const promptHay = prompt.toLowerCase();
    return patterns.some((pattern) => {
        if (typeof pattern !== 'string' || pattern.length === 0) {
            return false;
        }
        const needle = pattern.toLowerCase();
        return labelHay.includes(needle) || promptHay.includes(needle);
    });
}

/**
 * Create the shared reviewer-subsession classifier.
 *
 * 判定语义与 fail-open 方向与 T-023 豁免一致：仅阳性判定（自证 + 命中）
 * 返回 true；清单为空直接关闭（零日志读取）；缝缺失、读取失败、解析失败
 * 一律 false 且不缓存（暂态故障下次判定重判）。
 *
 * @param {object} options
 * @param {() => object} [options.getConfig] live runtime config（清单读时求值）
 * @param {(sessionId: string) => Promise<object[]|undefined>} [options.getEvents]
 *   会话事件流读取缝（sessionQuery 租约归一；未注入时判定恒 false——判定面
 *   收敛，fail-open 同型）
 * @param {{ info? }} [options.logger]
 * @returns {{ isReviewerSubsession: (sessionId: string) => Promise<boolean>,
 *   forgetSession: (sessionId: string) => void }}
 */
export function createReviewerClassifier({ getConfig, getEvents, logger = console } = {}) {
    /** 判定缓存：sessionId → { patternsKey, verdict }；清单变更失配重判。 */
    const verdicts = new Map();

    /** 会话清理摘除判定缓存（session/disposed 接线调用）。 */
    function forgetSession(sessionId) {
        verdicts.delete(sessionId);
    }

    /**
     * 审核类子会话判定：清单空直接关闭（零日志读取）；仅成功读取（events
     * 为数组）所得判定（含 false）按会话缓存——清单变更失配重判（读时求值）。
     * 缝缺失/读取失败/解析失败（生产缝以 undefined 表达失败，不抛错）与抛错
     * 同型 fail-open 返回 false 且一律不缓存（暂态故障次轮重判）。
     */
    async function isReviewerSubsession(sessionId) {
        const patterns = getConfig?.()?.turnReviewExemptPatterns;
        const list = Array.isArray(patterns) ? patterns : [];
        if (list.length === 0) {
            return false; // 判定关闭：不读日志（R-01-009/AC-11 清单空语义）
        }
        const patternsKey = list.join('\u0000');
        const cached = verdicts.get(sessionId);
        if (cached && cached.patternsKey === patternsKey) {
            return cached.verdict;
        }
        try {
            const events = await getEvents?.(sessionId);
            if (!Array.isArray(events)) {
                // 生产缝以 undefined 表达缝缺失/读取失败（不抛错）：与抛错
                // 同型 fail-open（R-01-009/AC-12），且不落缓存。
                logger.info?.('advisor-flow: reviewer subsession check failed — no events read, fail-open proceeds', { session: sessionId });
                return false;
            }
            const verdict = subsessionExemptFrom(events, list);
            verdicts.set(sessionId, { patternsKey, verdict });
            return verdict;
        } catch (error) {
            // 解析/读取抛错：fail-open 放行，不缓存。
            logger.info?.('advisor-flow: reviewer subsession check failed — fail-open proceeds', { session: sessionId, error: String(error) });
            return false;
        }
    }

    return {
        isReviewerSubsession,
        forgetSession,
    };
}
