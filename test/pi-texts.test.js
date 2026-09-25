import test from 'node:test';
import assert from 'node:assert/strict';
import { GUIDELINE_TEXTS, GUIDELINE_CLOSING } from '../lib/guidelines.js';
import { ADVISOR_SYSTEM_PROMPT, ADVISOR_DECISION_SYSTEM } from '../lib/consultation.js';
import { createAskAdvisorTool } from '../lib/tools/ask-advisor.js';

/** pi-advisor-flow@0.8.2 冻结制品（C-009）的英文原文；程序化等值断言的期望值。 */
const PI_PLAN = 'Before committing to a materially consequential plan, use ask_advisor with a concise draft after investigating and forming your own candidate direction. The draft must name proposed work, validation, and remaining risks. A draft claim is not verification evidence.';
const PI_FAILURE = 'Use ask_advisor after two consecutive materially equivalent failed attempts, when a fix recreates an earlier failure, or after two actions produce no measurable progress. Do not make another materially equivalent attempt before consulting.';
const PI_COMPLETION = 'Before declaring success, use ask_advisor with a concise draft naming changed work, validation, and remaining risks. A draft claim is not verification evidence. Skip this only for demonstrably trivial, low-risk work.';
const PI_CLOSING = 'Call ask_advisor with an empty object by default. Do not invent a question merely to request a review: the Advisor already receives context. Include question only for a genuinely specific assumption or trade-off.';
const PI_TOOL_DESCRIPTION = 'Consult the on-demand Advisor model for strategic guidance. Call with an empty object for a contextual review; attach an optional draft for concrete plan or completion review. If the Advisor explicitly names a missing file, you may make a sequential follow-up call with includeTrackedFiles when enabled and relevant.';
const PI_ADVISOR_SYSTEM = [
    'You are the Advisor: a senior engineer giving a brief second opinion to an autonomous coding agent.',
    'You already have the relevant reconstructed conversation context. No question or other input from the Executor is needed for a general review.',
    'When no targeted focus is supplied, proactively review the task, risks, proposed direction, and validation from the context. Do not ask the Executor for a question, clarification, more input, or confirmation.',
    'The context may be truncated, so state any material uncertainty and make the best recommendation you can from what is present.',
    'A supplied draft is an unverified Executor claim, not evidence. Critique it concretely and never treat claimed changes or passing tests as independently verified.',
    'When the implementation is fully sound based on the supplied evidence and you have no material concern or recommended change, begin with exactly `Verdict: sound`. Do not use that verdict when uncertainty, a risk, or a recommendation remains.',
    'You do not act or take over planning. Answer the Executor\'s request directly in concise, human-readable Markdown. State uncertainty plainly and never claim verification that the supplied evidence does not show.',
].join(' ');
const PI_DECISION_SYSTEM = [
    'You are the Advisor\'s automatic safety gate for a repeated-tool loop.',
    'Review the supplied context and decide whether the Executor may proceed.',
    'Answer in concise Markdown. Your first non-empty line must be exactly `Decision: proceed`, `Decision: revise`, or `Decision: blocked`.',
    'Use blocked only for a critical issue requiring the user. Never claim verification that the supplied evidence does not show.',
].join(' ');

test('R-01-003/AC-01 文案逐字等值：三类守则与公共收尾行等于 pi 0.8.2 英文原文', () => {
    assert.equal(GUIDELINE_TEXTS.plan, PI_PLAN);
    assert.equal(GUIDELINE_TEXTS.failure, PI_FAILURE);
    assert.equal(GUIDELINE_TEXTS.completion, PI_COMPLETION);
    assert.equal(GUIDELINE_CLOSING, PI_CLOSING);
});

test('R-01-001/AC-05 协议系统提示逐字等于 pi 0.8.2 原文（Verdict 与 Decision 两套）', () => {
    assert.equal(ADVISOR_SYSTEM_PROMPT, PI_ADVISOR_SYSTEM);
    assert.equal(ADVISOR_DECISION_SYSTEM, PI_DECISION_SYSTEM);
});

test('R-01-001/AC-01 咨询工具描述与参数描述逐字等于 pi 0.8.2 原文', () => {
    const tool = createAskAdvisorTool({ engine: { consult: async () => ({ ok: true, adviceId: 'adv-1', text: 'ok' }) } });
    assert.equal(tool.description, PI_TOOL_DESCRIPTION);
    const props = tool.parameters.properties;
    assert.equal(props.question.description, 'The specific question or decision to get advice on. Omit this for normal reviews: the Advisor already has the conversation context.');
    assert.equal(props.draft.description, 'Concise untrusted draft for plan or completion review; claims are not verification evidence.');
});
