import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageLedger } from '../lib/usage.js';

test('R-02-002/AC-01 咨询完成后逐项 token 与成本明细记录并归入会话累计', () => {
    const ledger = createUsageLedger();
    ledger.record({
        adviceId: 'adv-1',
        entry: 'tool',
        session: 's1',
        inputTokens: 100,
        outputTokens: 50,
        cacheTokens: 20,
        cost: 0.25,
    });
    ledger.record({
        adviceId: 'adv-2',
        entry: 'tool',
        session: 's1',
        inputTokens: 30,
        outputTokens: 10,
        cacheTokens: 5,
        cost: 0.05,
    });
    const totals = ledger.totals();
    assert.equal(totals.total.calls, 2);
    assert.equal(totals.total.inputTokens, 130);
    assert.equal(totals.total.outputTokens, 60);
    assert.equal(totals.total.cacheTokens, 25);
    assert.ok(Math.abs(totals.total.cost - 0.30) < 1e-9);
    const [first, second] = ledger.records();
    assert.equal(first.adviceId, 'adv-1');
    assert.equal(first.inputTokens, 100);
    assert.equal(second.cost, 0.05);
});

test('R-02-002/AC-02 提供方未给出的用量项显示为不可得而非零', () => {
    const ledger = createUsageLedger();
    ledger.record({ adviceId: 'adv-1', entry: 'tool', session: 's1', outputTokens: 12 });
    const [record] = ledger.records();
    assert.equal(record.inputTokens, 'unavailable');
    assert.equal(record.cacheTokens, 'unavailable');
    assert.equal(record.cost, 'unavailable');
    assert.equal(record.outputTokens, 12);

    // 累计侧： unavailable 不参与求和、不落零
    ledger.record({ adviceId: 'adv-2', entry: 'tool', session: 's1', outputTokens: 8 });
    const totals = ledger.totals();
    assert.equal(totals.total.outputTokens, 20);
    assert.equal(totals.total.inputTokens, 'unavailable');
    assert.equal(totals.total.cost, 'unavailable');

    // 完全没有用量对象的记录仍计数
    ledger.record({ adviceId: 'adv-3', entry: 'tool' });
    assert.equal(ledger.totals().total.calls, 3);
});

test('R-02-002/AC-03 按需/手动/门触发三类入口分别计数', () => {
    const ledger = createUsageLedger();
    ledger.record({ adviceId: 'a', entry: 'tool', inputTokens: 1 });
    ledger.record({ adviceId: 'b', entry: 'manual', inputTokens: 2 });
    ledger.record({ adviceId: 'c', entry: 'gate', inputTokens: 4 });
    ledger.record({ adviceId: 'd', entry: 'tool', inputTokens: 8 });
    const totals = ledger.totals();
    assert.equal(totals.byEntry.tool.calls, 2);
    assert.equal(totals.byEntry.tool.inputTokens, 9);
    assert.equal(totals.byEntry.manual.calls, 1);
    assert.equal(totals.byEntry.manual.inputTokens, 2);
    assert.equal(totals.byEntry.gate.calls, 1);
    assert.equal(totals.byEntry.gate.inputTokens, 4);
    assert.equal(totals.total.calls, 4);
});

test('R-02-002 JSONL 落盘逐行追加；落盘失败被包含不影响台账', () => {
    const lines = [];
    const failingFs = { appendFileSync: () => { throw new Error('disk full'); } };
    const warnings = [];
    const ledger = createUsageLedger({
        path: '/tmp/advisor-usage.jsonl',
        fs: { appendFileSync: (path, line) => lines.push(line) },
    });
    ledger.record({ adviceId: 'adv-1', entry: 'tool', inputTokens: 3 });
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.adviceId, 'adv-1');
    assert.equal(parsed.inputTokens, 3);
    assert.equal(parsed.entry, 'tool');

    const resilient = createUsageLedger({
        path: '/tmp/advisor-usage.jsonl',
        fs: failingFs,
        logger: { warn: (message) => warnings.push(message) },
    });
    const record = resilient.record({ adviceId: 'adv-2', entry: 'manual' });
    assert.equal(record.adviceId, 'adv-2'); // record 仍正常返回
    assert.equal(resilient.totals().total.calls, 1); // 内存台账照常
    assert.equal(warnings.length, 1);

    // 无路径 → 仅内存
    const memoryOnly = createUsageLedger();
    memoryOnly.record({ adviceId: 'adv-3', entry: 'gate' });
    assert.equal(memoryOnly.totals().total.calls, 1);
});
