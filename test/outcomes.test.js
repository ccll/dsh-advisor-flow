import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRecordOutcomeTool } from '../lib/tools/record-outcome.js';
import { createOutcomeStore } from '../lib/outcomes.js';
import { isRecord } from '../lib/util.js';

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
