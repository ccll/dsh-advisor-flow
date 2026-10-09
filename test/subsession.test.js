import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubsessionPresenter, subsessionLabel, subsessionOutputText, SUBSESSION_LABEL_BASE } from '../lib/subsession.js';

const quietLogger = { info() {}, warn() {}, debug() {} };

/** 语义合规的假呈现提供方（spawn 形态：零父上下文 + 路由覆盖 + 零工具能力）。 */
function eligibleProvider(name = 'spawn') {
    return {
        name,
        capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
        inheritsParentContext: false,
    };
}

const PARENT = { id: 'parent-session-1' };

/** 构造一个结算为给定 result 的假 run；记录 dispose 调用。 */
function fakeRun(result, { failDispose = false } = {}) {
    const run = {
        id: 'subsession-1',
        result: Promise.resolve(result),
        disposeCalls: 0,
        dispose() {
            this.disposeCalls += 1;
            return failDispose ? Promise.reject(new Error('dispose failed')) : Promise.resolve();
        },
    };
    return run;
}

/**
 * 构造假 subagents 缝：登记 providers；start 捕获请求并按脚本返回 run
 * （或抛错模拟发布前失败）。
 */
function createFakeSubagents({ providers = [eligibleProvider()], runs = [], startError } = {}) {
    const registry = new Map(providers.map((provider) => [provider.name, provider]));
    const requests = [];
    return {
        registry,
        requests,
        startCalls: 0,
        async start(name, request) {
            this.startCalls += 1;
            this.requests.push({ name, request });
            if (startError) {
                throw startError;
            }
            const run = runs.shift();
            if (!run) {
                throw new Error('fake subagents: no scripted run');
            }
            return run;
        },
        getProvider: (name) => registry.get(name),
        list: () => [...registry.keys()],
    };
}

test('R-02-007/AC-01 子会话发起：label 标识顾问与入口，start 请求承载 prompt/parent/signal/agentOptions/toolFilter/persona', async () => {
    const run = fakeRun({ stopReason: 'completed', output: [{ type: 'text', text: '意见全文。' }] });
    const subagents = createFakeSubagents({ runs: [run] });
    const presenter = createSubsessionPresenter({ subagents, logger: quietLogger });
    const outcome = await presenter.present({
        promptText: '素材全文',
        parent: PARENT,
        signal: new AbortController().signal,
        agentOptions: { provider: 'gpu', model: 'advisor-model', maxTokens: 1024 },
        persona: 'ADVISOR SYSTEM PROMPT',
        entry: 'manual',
    });
    assert.equal(outcome.kind, 'answered');
    assert.equal(outcome.text, '意见全文。');
    assert.equal(subagents.startCalls, 1);
    const { name, request } = subagents.requests[0];
    assert.equal(name, 'spawn'); // 宿主 spawn 后端默认名（R-02-007 呈现提供方）
    assert.equal(request.label, 'Advisor review (manual)'); // AC-01：标签标识顾问与入口
    assert.equal(request.prompt.length, 1);
    assert.equal(request.prompt[0].type, 'text');
    assert.equal(request.prompt[0].text, '素材全文'); // AC-05：prompt 即装配产物（R-02-006 契约不变）
    assert.equal(request.parent, PARENT); // 父会话关联（子会话条目挂当前会话）
    assert.equal(request.toolFilter.allow.length, 0); // AC-05：零工具（NG-1）
    assert.equal(request.persona, 'ADVISOR SYSTEM PROMPT'); // 协议提示经 persona 承载
    assert.deepEqual(request.agentOptions, { provider: 'gpu', model: 'advisor-model', maxTokens: 1024 });
    assert.equal(run.disposeCalls, 1); // 结算后句柄释放
});

test('R-02-007/AC-01 标签按入口区分：tool/manual/gate 三态；非入口值回退 tool', () => {
    assert.equal(subsessionLabel('tool'), 'Advisor review (tool)');
    assert.equal(subsessionLabel('manual'), 'Advisor review (manual)');
    assert.equal(subsessionLabel('gate'), 'Advisor review (gate)');
    assert.equal(subsessionLabel('other'), 'Advisor review (tool)');
});

test('R-02-007/AC-03 降级链：缝缺失、无合规提供方、发布前失败均返回 fallback（不抛错）', async () => {
    // 缝缺失：无 subagents。
    const missing = createSubsessionPresenter({ logger: quietLogger });
    assert.equal((await missing.present({})).kind, 'fallback');
    // 名单无语义合规提供方：spawn 不在场、唯一 provider 继承父上下文。
    const inheritedProvider = { name: 'fork', capabilities: { agentOptions: true, toolFilter: true }, inheritsParentContext: true };
    const subagents = createFakeSubagents({ providers: [inheritedProvider] });
    const presenter = createSubsessionPresenter({ subagents, logger: quietLogger });
    const fallback = await presenter.present({ promptText: 'x', parent: PARENT, signal: new AbortController().signal, entry: 'tool' });
    assert.equal(fallback.kind, 'fallback');
    assert.equal(subagents.startCalls, 0); // 发布前判定：不发起 start
    // 发布前失败：start 抛错 → fallback（无 run 可 dispose）。
    const failing = createFakeSubagents({ startError: new Error('provider rejected') });
    const failingPresenter = createSubsessionPresenter({ subagents: failing, logger: quietLogger });
    const afterStart = await failingPresenter.present({ promptText: 'x', parent: PARENT, signal: new AbortController().signal, entry: 'tool' });
    assert.equal(afterStart.kind, 'fallback');
    assert.match(afterStart.reason, /provider rejected/);
    // 缺 parent：发布前失败。
    const noParent = await presenter.present({ promptText: 'x', entry: 'tool' });
    assert.equal(noParent.kind, 'fallback');
});

test('R-02-007/AC-04 发布后 run 失败映射 failure 终态；dispose 无条件执行（dispose 抛错也被包含）', async () => {
    const run = fakeRun({ stopReason: 'error', diagnostic: 'model transport failed' }, { failDispose: true });
    const subagents = createFakeSubagents({ runs: [run] });
    const presenter = createSubsessionPresenter({ subagents, logger: quietLogger });
    const outcome = await presenter.present({ promptText: 'x', parent: PARENT, signal: new AbortController().signal, entry: 'tool' });
    assert.equal(outcome.kind, 'failure');
    assert.match(outcome.failure.message, /model transport failed/);
    assert.equal(run.disposeCalls, 1); // AC-04：句柄无条件释放（dispose 失败也被包含）
    // aborted 停止：aborted 终态（超时区分归调用方 deadline 判定）。
    const abortedRun = fakeRun({ stopReason: 'aborted' });
    const abortedSubagents = createFakeSubagents({ runs: [abortedRun] });
    const abortedOutcome = await createSubsessionPresenter({ subagents: abortedSubagents, logger: quietLogger })
        .present({ promptText: 'x', parent: PARENT, signal: new AbortController().signal, entry: 'gate' });
    assert.equal(abortedOutcome.kind, 'aborted');
    assert.equal(abortedRun.disposeCalls, 1);
});

test('R-02-007/AC-04 max-tokens 与 refusal 停止同为 failure 终态（不降级重发）', async () => {
    for (const stopReason of ['max-tokens', 'refusal']) {
        const run = fakeRun({ stopReason, diagnostic: `stopped: ${stopReason}` });
        const subagents = createFakeSubagents({ runs: [run] });
        const outcome = await createSubsessionPresenter({ subagents, logger: quietLogger })
            .present({ promptText: 'x', parent: PARENT, signal: new AbortController().signal, entry: 'tool' });
        assert.equal(outcome.kind, 'failure');
        assert.match(outcome.failure.message, new RegExp(stopReason));
        assert.equal(run.disposeCalls, 1);
    }
});

test('R-02-007/AC-04 发布后 run.result 拒绝映射失败终态：绝不 fallback（不降级直调重发）', async () => {
    // run.result 的 rejection 承载 seam 无法以 stopReason 表达的基础设施故障。
    let disposed = 0;
    const run = {
        id: 'subsession-1',
        result: Promise.reject(new Error('infra fault after publish')),
        dispose: async () => { disposed += 1; },
    };
    const subagents = createFakeSubagents({ runs: [run] });
    const outcome = await createSubsessionPresenter({ subagents, logger: quietLogger })
        .present({ promptText: 'x', parent: PARENT, signal: new AbortController().signal, entry: 'tool' });
    assert.equal(outcome.kind, 'failure'); // 非 fallback——fallback 会触发降级重发（AC-04 禁止）
    assert.match(outcome.failure.message, /infra fault after publish/);
    assert.equal(outcome.failure.code, 'SUBSESSION');
    assert.equal(disposed, 1); // 句柄仍无条件释放
});

test('R-02-007/AC-04 发布后拒绝且信号已中止 → aborted 终态（超时区分归调用方）', async () => {
    const controller = new AbortController();
    controller.abort(new Error('manual consultation cancelled'));
    const run = {
        id: 'subsession-1',
        result: Promise.reject(new Error('aborted mid-flight')),
        dispose: async () => {},
    };
    const subagents = createFakeSubagents({ runs: [run] });
    const outcome = await createSubsessionPresenter({ subagents, logger: quietLogger })
        .present({ promptText: 'x', parent: PARENT, signal: controller.signal, entry: 'manual' });
    assert.equal(outcome.kind, 'aborted');
    assert.match(outcome.reason, /manual consultation cancelled/);
});

test('R-02-007/AC-05 呈现提供方语义约束：零工具 allowlist 与素材透传经 start 请求断言；优先 spawn 后端', async () => {
    const renamed = eligibleProvider('spawn-renamed'); // 部署改名场景
    const run = fakeRun({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] });
    const subagents = createFakeSubagents({ providers: [renamed], runs: [run] });
    const promptText = '<conversation>...</conversation>\nTargeted focus: q';
    const outcome = await createSubsessionPresenter({ subagents, logger: quietLogger })
        .present({ promptText, parent: PARENT, signal: new AbortController().signal, agentOptions: { provider: 'p', model: 'm' }, persona: 'P', entry: 'tool' });
    assert.equal(outcome.kind, 'answered');
    assert.equal(subagents.requests[0].name, 'spawn-renamed'); // 名单解析覆盖改名
    assert.equal(subagents.requests[0].request.prompt[0].text, promptText); // 素材原样出境（R-02-006 不变）
    assert.deepEqual(subagents.requests[0].request.toolFilter, { allow: [] }); // 零工具
});

test('R-02-007/AC-06 空输出或无非空文本按失败处置：EMPTY 诊断；用量在 dispose 前提取', async () => {
    const emptyRun = fakeRun({ stopReason: 'completed', output: [] });
    const subagents = createFakeSubagents({ runs: [emptyRun] });
    const usageSeen = [];
    const presenter = createSubsessionPresenter({
        subagents,
        logger: quietLogger,
        extractUsage: async (id) => {
            usageSeen.push({ id, disposed: emptyRun.disposeCalls });
            return { inputTokens: 1, outputTokens: 2 };
        },
    });
    const empty = await presenter.present({ promptText: 'x', parent: PARENT, signal: new AbortController().signal, entry: 'tool' });
    assert.equal(empty.kind, 'failure');
    assert.equal(empty.failure.code, 'EMPTY'); // R-01-001/AC-04 同语义：空意见即失败
    // 非文本块输出同样按空处置。
    const nonTextRun = fakeRun({ stopReason: 'completed', output: [{ type: 'image', url: 'x' }] });
    const nonText = await createSubsessionPresenter({ subagents: createFakeSubagents({ runs: [nonTextRun] }), logger: quietLogger })
        .present({ promptText: 'x', parent: PARENT, signal: new AbortController().signal, entry: 'tool' });
    assert.equal(nonText.kind, 'failure');
    assert.equal(nonText.failure.code, 'EMPTY');
    // 成功路径：extractUsage 在 dispose 之前被调用（结算后子会话仍可读）。
    const okRun = fakeRun({ stopReason: 'completed', output: [{ type: 'text', text: '意见' }] });
    const okSubagents = createFakeSubagents({ runs: [okRun] });
    const okSeen = [];
    const okOutcome = await createSubsessionPresenter({
        subagents: okSubagents,
        logger: quietLogger,
        extractUsage: async (id) => {
            okSeen.push({ id, disposed: okRun.disposeCalls });
            return { inputTokens: 3 };
        },
    }).present({ promptText: 'x', parent: PARENT, signal: new AbortController().signal, entry: 'manual' });
    assert.equal(okOutcome.kind, 'answered');
    assert.deepEqual(okOutcome.usage, { inputTokens: 3 });
    assert.deepEqual(okSeen, [{ id: 'subsession-1', disposed: 0 }]); // dispose 前提取
    assert.equal(okRun.disposeCalls, 1);
    assert.equal(usageSeen[0].disposed, 0); // 空输出路径同样在 dispose 前探测
});

test('R-02-007/AC-06 输出提取：非文本块过滤、文本块拼接（纯函数）', () => {
    assert.equal(subsessionOutputText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
    assert.equal(subsessionOutputText([{ type: 'image' }]), '');
    assert.equal(subsessionOutputText(undefined), '');
});
