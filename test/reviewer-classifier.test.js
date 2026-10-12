import test from 'node:test';
import assert from 'node:assert/strict';
import { subsessionExemptFrom, createReviewerClassifier } from '../lib/reviewer-classifier.js';
import { reviewerSubsessionEvents } from './helpers.js';
import { DEFAULT_TURN_REVIEW_EXEMPT_PATTERNS } from '../lib/config.js';

/**
 * 共享审核类子会话分类器（T-026；判定语义 = T-023 豁免判定原样抽取）：
 * - 纯函数：自证（header `origin === 'subagent'`）+ label 或首条提示词命中
 *   豁免清单（大小写不敏感子串、两源分离匹配）。
 * - 分类器：仅成功读取的判定按会话缓存（含 false）；patternsKey 失配重判；
 *   失败不缓存次轮重判（fail-open）；随会话清理摘除。
 * - 判定结果与缓存供收口评审豁免与咨询工具面守卫共用（同实例零重读）。
 */

const quietLogger = { info() {}, warn() {}, error() {} };

test('R-01-009/AC-11 纯判定：自证 + label 命中即 true（默认双语清单）', () => {
    assert.equal(subsessionExemptFrom(reviewerSubsessionEvents(), DEFAULT_TURN_REVIEW_EXEMPT_PATTERNS), true);
});

test('R-01-009/AC-11 纯判定：首条提示词命中、大小写不敏感', () => {
    assert.equal(subsessionExemptFrom(reviewerSubsessionEvents({ label: '数据整理', prompt: 'Please REVIEW the diff.' }), ['review']), true);
});

test('R-01-009/AC-11 纯判定：主会话与 fork（无 origin 字段）不判为子会话', () => {
    assert.equal(subsessionExemptFrom(reviewerSubsessionEvents({ header: { type: 'session', seq: 0, id: 'root-1' }, label: 'review', prompt: 'review' }), ['review']), false);
    assert.equal(subsessionExemptFrom(reviewerSubsessionEvents({ header: { type: 'session', seq: 0, id: 'f-1', isSeeded: true }, label: 'review', prompt: 'review' }), ['review']), false);
});

test('R-01-009/AC-11 纯判定：执行类子会话（双源不命中）与空清单/空流一律 false', () => {
    assert.equal(subsessionExemptFrom(reviewerSubsessionEvents({ label: '数据整理', prompt: '搜索仓库中的实现并汇报。' }), DEFAULT_TURN_REVIEW_EXEMPT_PATTERNS), false);
    assert.equal(subsessionExemptFrom(reviewerSubsessionEvents(), []), false);
    assert.equal(subsessionExemptFrom(undefined, DEFAULT_TURN_REVIEW_EXEMPT_PATTERNS), false);
});

test('R-01-009/AC-11 纯判定：标签与提示词分离匹配，跨源拼接不构成命中', () => {
    assert.equal(subsessionExemptFrom(reviewerSubsessionEvents({ label: '粗 修 re', prompt: 'view the diff' }), ['review']), false);
});

test('T-026 分类器缓存：同会话判定复用零重读，patterns 变更失配重判', async () => {
    let reads = 0;
    const config = { turnReviewExemptPatterns: ['review'] };
    const classifier = createReviewerClassifier({
        getConfig: () => config,
        getEvents: async () => { reads += 1; return reviewerSubsessionEvents(); },
        logger: quietLogger,
    });
    assert.equal(await classifier.isReviewerSubsession('sub-1'), true);
    assert.equal(await classifier.isReviewerSubsession('sub-1'), true);
    assert.equal(reads, 1); // 同会话缓存复用
    config.turnReviewExemptPatterns = ['cleanup']; // 清单变更 → 签名失配 → 重判
    assert.equal(await classifier.isReviewerSubsession('sub-1'), false); // 新清单不命中既有日志
    assert.equal(reads, 2);
});

test('R-01-009/AC-12 分类器 fail-open：缝缺失/读取失败/抛错一律 false 且不缓存', async () => {
    let reads = 0;
    const config = { turnReviewExemptPatterns: ['review'] };
    const undefinedSeam = createReviewerClassifier({
        getConfig: () => config,
        getEvents: async () => { reads += 1; return reads === 1 ? undefined : reviewerSubsessionEvents(); },
        logger: quietLogger,
    });
    assert.equal(await undefinedSeam.isReviewerSubsession('sub-1'), false); // 首判失败照常放行
    assert.equal(await undefinedSeam.isReviewerSubsession('sub-1'), true); // 失败不缓存：次轮重判命中
    assert.equal(reads, 2);
    const throwing = createReviewerClassifier({
        getConfig: () => config,
        getEvents: async () => { throw new Error('seam down'); },
        logger: quietLogger,
    });
    assert.equal(await throwing.isReviewerSubsession('sub-1'), false);
    assert.equal(await throwing.isReviewerSubsession('sub-1'), false);
});

test('R-01-009/AC-11 分类器清单为空：零日志读取直接 false（判定关闭）', async () => {
    let reads = 0;
    const classifier = createReviewerClassifier({
        getConfig: () => ({ turnReviewExemptPatterns: [] }),
        getEvents: async () => { reads += 1; return reviewerSubsessionEvents(); },
        logger: quietLogger,
    });
    assert.equal(await classifier.isReviewerSubsession('sub-1'), false);
    assert.equal(reads, 0);
});

test('T-026 分类器多会话隔离与 forgetSession 复位（session/disposed 接线语义）', async () => {
    let reads = 0;
    const config = { turnReviewExemptPatterns: ['review'] };
    const classifier = createReviewerClassifier({
        getConfig: () => config,
        getEvents: async () => { reads += 1; return reviewerSubsessionEvents(); },
        logger: quietLogger,
    });
    assert.equal(await classifier.isReviewerSubsession('sub-a'), true);
    assert.equal(await classifier.isReviewerSubsession('sub-b'), true);
    assert.equal(reads, 2); // 会话键隔离：各判各读
    classifier.forgetSession('sub-a');
    assert.equal(await classifier.isReviewerSubsession('sub-a'), true);
    assert.equal(reads, 3); // 摘除后重读
    assert.equal(await classifier.isReviewerSubsession('sub-b'), true);
    assert.equal(reads, 3); // 未清理会话缓存不受影响
});
