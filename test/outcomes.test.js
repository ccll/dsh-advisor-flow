import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRecordOutcomeTool } from '../lib/tools/record-outcome.js';
import { createOutcomeStore } from '../lib/outcomes.js';
import { isRecord } from '../lib/util.js';
const { createConsultationEngine } = await import('../lib/consultation.js');
const { createFakeLlm, answer } = await import('./helpers.js');
const { resolveAdvisorFlowConfig } = await import('../lib/config.js');
function resolvedConfig({ advisor = {}, ...rest } = {}) {
    const raw = {
        enabled: true,
        ...rest,
        advisor: { provider: 'test', model: 'test-model', callTimeoutMs: 200, ...advisor },
    };
    const result = resolveAdvisorFlowConfig(raw);
    assert.equal(result.ok, true, `test config must resolve: ${result.error}`);
    return result.config;
}
const quietLogger = { info() {}, warn() {}, debug() {} };

const enabledEngine = {
    outcomeLoggingEnabled: true,
    reserveAdvice: (id) => (id === 'adv-1' ? { advice: '意见正文', trigger: 'executor-requested' } : undefined),
    commitAdvice: () => true,
    releaseAdvice: () => {},
    appendOutcome: async () => true,
};

test('R-01-008/AC-01 回写成功确认：有效 adviceId 记录采纳与验证状态', async () => {
    const tool = createRecordOutcomeTool({ engine: enabledEngine });
    const value = await tool.execute({ adviceId: 'adv-1', adoption: 'followed', validationStatus: 'passed' });
    assert.ok(isRecord(value));
    assert.equal(value.recorded, true);
});

test('R-01-008/AC-02 未知/已回写/未决 adviceId 拒绝且不抛出', async () => {
    const tool = createRecordOutcomeTool({ engine: enabledEngine });
    const value = await tool.execute({ adviceId: 'adv-404', adoption: 'followed', validationStatus: 'passed' });
    assert.ok(isRecord(value));
    assert.notEqual(value.recorded, true);
});

test('R-01-008/AC-04 回写功能禁用时返回提示值且不影响其他工具', async () => {
    const tool = createRecordOutcomeTool({ engine: { ...enabledEngine, outcomeLoggingEnabled: false } });
    const value = await tool.execute({ adviceId: 'adv-1', adoption: 'followed', validationStatus: 'passed' });
    assert.ok(isRecord(value));
    assert.equal(value.recorded, false);
});

test('R-01-008/AC-03 回写落盘以 HMAC 哈希承载意见原文，不存明文', async () => {
    const file = fileURLToPath(new URL('./.tmp-outcomes-ac03.jsonl', import.meta.url));
    const store = createOutcomeStore({ file, hmacKey: 'k'.repeat(32) });
    await store.append({
        adviceId: 'adv-1',
        advice: '意见明文不应落盘',
        trigger: 'executor-requested',
        adoption: 'followed',
        validationStatus: 'passed',
    });
    const raw = await fs.readFile(file, 'utf8');
    assert.ok(!raw.includes('意见明文不应落盘'));
    assert.match(raw, /[0-9a-f]{16}/); // pi adviceDigest：截断 16 hex（outcomes.ts:125）
    await fs.rm(file, { force: true });
});

test('R-01-008/AC-05 引擎销毁释放未决预留：不得永久占用回写资格', async () => {
    const ledger = new Map();
    const engine = createConsultationEngine({
        llm: createFakeLlm([answer('意见一。'), answer('意见二。')]),
        config: resolvedConfig({ outcomeLogging: false }),
        logger: quietLogger,
    });
    const first = await engine.consult({ entry: 'tool', question: 'q1' });
    assert.ok(first.ok);
    // dispose 前 reserve 可用；dispose 释放未决预留（AC-05）
    assert.ok(isRecord(engine.reserveAdvice(first.adviceId)));
    engine.dispose();
    assert.equal(engine.reserveAdvice(first.adviceId), undefined, 'dispose 释放未决预留');
});

test('R-01-008/AC-06 回写 fail-closed：无 outcomeStore 时功能显性禁用', async () => {
    const tool = createRecordOutcomeTool({ engine: { ...enabledEngine, outcomeLoggingEnabled: () => false } });
    const value = await tool.execute({ adviceId: 'adv-1', adoption: 'followed', validationStatus: 'passed' });
    assert.equal(value.recorded, false);
    assert.ok(typeof value.reason === 'string' && value.reason.length > 0);
});
