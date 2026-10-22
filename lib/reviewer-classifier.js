/**
 * Reviewer-subsession classifier (T-026; C-025) — the shared judgment for
 * both the turn-review exemption (T-023) and the ask_advisor tool-face guard.
 *
 * 判定语义与 T-023 一致（SOLUTION.md#运行时、并发与失败语义「子会话审核豁免」）：
 * - 自证前置：sessionQuery 租约 header `origin === 'subagent'`（T-036：
 *   header 是租约独立属性，事件流为裸 log 切片、不含自证事件；fork 会话
 *   无该字段，不判为子会话）。
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
import { isRecord } from './util.js';

/**
 * 激活期金丝雀样本（T-036）：租约形状的合成评审类子会话——自证在租约
 * header（origin === 'subagent'），事件流为裸 log 切片（descriptor seq0，
 * 不含自证事件）。判定恒真：label 命中固定清单 ['review']。接线在激活期
 * 以固定清单重判此样本，判 false 即说明分类器对租约形状失效（T-094 根因
 * 的同类回归），经 degradations 显性化。
 */
export const REVIEWER_LEASE_CANARY = Object.freeze({
    header: Object.freeze({ type: 'session', id: 'canary-sub', origin: 'subagent' }),
    events: Object.freeze([
        { type: 'subagent/descriptor', seq: 0, data: { mode: 'one-shot', label: 'Advisor review (tool)' } },
    ]),
});

/**
 * 审核类子会话判定（纯函数，T-023）：自证（租约 header `origin === 'subagent'`）
 * 且豁免清单命中创建标签（`subagent/descriptor` 的 `data.label`）或首条
 * `agent/inbox/spliced` 提示词。匹配为大小写不敏感的子串包含（标签与
 * 提示词各自独立匹配，等价 OR，不跨源拼接——避免跨界拼出清单词）。
 * 空清单或缺租约一律 false（判定关闭与 fail-open 同向）。
 *
 * 自证源是租约 header（T-036）：生产 sessionQuery 租约把 header 作为独立
 * 属性承载（dsh-session-query live()），事件流为裸 log 切片、不含
 * `type:'session'` 自证事件——持久化文件首行形状（header 在流内）只是
 * 序列化产物，不是运行时事件流形状。
 *
 * @param {{ events?: object[], header?: object }|undefined} lease
 *   sessionQuery 租约归一形态（header 独立属性 + 有序事件流）
 * @param {string[]} patterns 豁免模式清单（非空字符串数组）
 * @returns {boolean}
 */
export function subsessionExemptFrom(lease, patterns) {
    if (!isRecord(lease) || !Array.isArray(lease.events) || !Array.isArray(patterns) || patterns.length === 0) {
        return false;
    }
    const events = lease.events;
    // 自证前置：租约 header origin（主会话与 fork 会话——origin 缺失——不是子会话）。
    if (lease.header?.origin !== 'subagent') {
        return false;
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
 * @param {(sessionId: string) => Promise<{ events?: object[], header?: object }|undefined>} [options.getLease]
 *   sessionQuery 租约读取缝（归一为 `{events, header}`；未注入或返回缺
 *   header 的畸形租约时判定恒 false——判定面收敛，fail-open 同型）
 * @param {{ info? }} [options.logger]
 * @returns {{ isReviewerSubsession: (sessionId: string) => Promise<boolean>,
 *   forgetSession: (sessionId: string) => void }}
 */
export function createReviewerClassifier({ getConfig, getLease, logger = console } = {}) {
    /** 判定缓存：sessionId → { patternsKey, verdict }；清单变更失配重判。 */
    const verdicts = new Map();

    /** 会话清理摘除判定缓存（session/disposed 接线调用）。 */
    function forgetSession(sessionId) {
        verdicts.delete(sessionId);
    }

    /**
     * 审核类子会话判定：清单空直接关闭（零日志读取）；仅成功读取（租约
     * 带 header 且 events 为数组）所得判定（含 false）按会话缓存——清单变更
     * 失配重判（读时求值）。缝缺失/读取失败/畸形租约（生产缝以 undefined
     * 表达失败，缺 header 的租约视为异常形态）与抛错同型 fail-open 返回
     * false 且一律不缓存（暂态故障次轮重判）。
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
            const lease = await getLease?.(sessionId);
            if (!isRecord(lease) || lease.header == null) {
                // 租约缺失（生产缝以 undefined 表达失败，不抛错）或 header
                // 缺失的畸形租约（T-094 根因的异常形态）：与抛错同型
                // fail-open（R-01-009/AC-12），且不落缓存。
                logger.info?.('advisor-flow: reviewer subsession check failed — lease unreadable or header missing, fail-open proceeds', { session: sessionId });
                return false;
            }
            if (!Array.isArray(lease.events)) {
                // 租约缺事件流：fail-open（R-01-009/AC-12），且不落缓存。
                logger.info?.('advisor-flow: reviewer subsession check failed — no events read, fail-open proceeds', { session: sessionId });
                return false;
            }
            const verdict = subsessionExemptFrom(lease, list);
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
