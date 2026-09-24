import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecision, adviceForGateText, DECISION_FAILURE_CATEGORIES } from '../lib/decision.js';

/**
 * 决策行解析对抗用例（R-01-005；移植 pi-advisor-flow 0.8.1 gate-protocol，C-007）。
 * 门回复必须以首非空行恰为 `Decision: proceed|revise|blocked` 开头；重复/
 * 矛盾决策行判失败；平衡围栏内决策行是示例不采信；未闭合围栏 fail-closed。
 * 解析器绝不抛出。
 */

test('R-01-005/AC-01 三值决策解析：proceed/revise/blocked 首非空行匹配，markdown 全文随结果返回', () => {
    assert.deepEqual(parseDecision('Decision: proceed'), { ok: true, decision: 'proceed', markdown: 'Decision: proceed' });
    assert.deepEqual(parseDecision('Decision: blocked\n后续动作建议'), {
        ok: true,
        decision: 'blocked',
        markdown: 'Decision: blocked\n后续动作建议',
    });
    // 大小写与空白容差
    assert.equal(parseDecision('decision: PROCEED').decision, 'proceed');
    assert.equal(parseDecision('Decision:  revise ').decision, 'revise');
    // 首行允许是空行（首「非空」行才算决策行）
    assert.equal(parseDecision('\n\nDecision: revise\n意见').decision, 'revise');
});

test('R-01-005/AC-04 空回复与纯空白回复解析为 empty-response，不抛出', () => {
    for (const text of ['', '   \n  ', '\n']) {
        const parsed = parseDecision(text);
        assert.equal(parsed.ok, false);
        assert.equal(parsed.category, 'empty-response');
        assert.equal('markdown' in parsed, false); // 空回复无 markdown 可言
        assert.ok(parsed.message.length > 0);
    }
});

test('R-01-005/AC-04 缺决策行与畸形决策行分别给出 missing/malformed 类别', () => {
    // 首非空行不是决策行 → missing-decision
    const missing = parseDecision('先说结论：一切正常。\nDecision: proceed');
    assert.equal(missing.ok, false);
    assert.equal(missing.category, 'missing-decision');
    assert.equal(missing.markdown, '先说结论：一切正常。\nDecision: proceed');

    // decision: 前缀在但取值非法/带尾随文字 → malformed-decision
    for (const text of ['Decision: proceed extra', 'Decision: possibly', 'Decision:（中文冒号不合法）proceed']) {
        const malformed = parseDecision(text);
        assert.equal(malformed.ok, false, text);
        assert.equal(malformed.category, 'malformed-decision', text);
    }
});

test('R-01-005/AC-04 对抗性检查：重复决策行判 duplicate-decision，矛盾决策行判 contradictory-decision', () => {
    assert.equal(parseDecision('Decision: proceed\nDecision: proceed').category, 'duplicate-decision');
    assert.equal(parseDecision('Decision: revise\nDecision: revise').category, 'duplicate-decision');
    assert.equal(parseDecision('Decision: proceed\nDecision: revise').category, 'contradictory-decision');
    assert.equal(parseDecision('Decision: revise\nDecision: blocked').category, 'contradictory-decision');
    // 首个后续决策行定类别：proceed 后跟 revise 再跟 proceed → 矛盾
    assert.equal(parseDecision('Decision: proceed\nDecision: revise\nDecision: proceed').category, 'contradictory-decision');
    // 大小写不影响重复判定
    assert.equal(parseDecision('Decision: proceed\nDecision: PROCEED').category, 'duplicate-decision');
});

test('R-01-005/AC-04 围栏对抗：平衡围栏内的 Decision 行是示例不采信；未闭合围栏 fail-closed', () => {
    // 平衡围栏内的 Decision 行是示例，不采信
    const fenced = parseDecision('Decision: proceed\n```js\nDecision: revise\n```');
    assert.equal(fenced.ok, true);
    assert.equal(fenced.decision, 'proceed');
    // 波浪围栏同语义
    assert.equal(parseDecision('Decision: proceed\n~~~\nDecision: blocked\n~~~').ok, true);
    // 未闭合围栏：其中的决策行被采信 → fail-closed（畸形 Markdown 不得让门 fail-open）
    const unclosed = parseDecision('Decision: proceed\n```js\nDecision: revise');
    assert.equal(unclosed.ok, false);
    assert.equal(unclosed.category, 'contradictory-decision');
    // 引用前缀不是决策行（不匹配行首形态），不参与重复/矛盾判定
    assert.equal(parseDecision('Decision: proceed\n> Decision: revise').ok, true);
});

test('adviceForGateText：加粗决策行 + 空行 + 意见全文（执行者可见的门结果文本契约）', () => {
    assert.equal(adviceForGateText({ decision: 'proceed', markdown: 'MD' }), '**Decision: proceed**\n\nMD');
    assert.equal(adviceForGateText({ decision: 'revise', markdown: 'a\nb' }), '**Decision: revise**\n\na\nb');
});

test('DECISION_FAILURE_CATEGORIES 覆盖全部命名失败类别（门失败留痕的可查询面）', () => {
    assert.deepEqual(
        [...DECISION_FAILURE_CATEGORIES].sort(),
        ['budget-exhausted', 'contradictory-decision', 'duplicate-decision', 'empty-response', 'malformed-decision', 'missing-decision', 'provider-error'].sort(),
    );
});
