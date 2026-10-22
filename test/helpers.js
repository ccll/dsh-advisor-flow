/**
 * Test doubles for the consultation engine: a programmable fake llm whose
 * `stream()` replays per-call programs (chunk sequences / errors / hangs /
 * manual release) and records every call, plus a configurable
 * `resolveModelInfo`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * One program drives one `llm.stream` call (consumed in call order):
 * - `chunks`: array of chunks to yield (`text-delta` / `usage` / `finish`);
 * - `error`: the iterator (or `stream()` itself, with `throwImmediately`)
 *   fails with this value;
 * - `throwImmediately`: `stream()` itself throws synchronously;
 * - `hang`: `next()` pends forever, ignoring abort signals — the hung
 *   provider stream the deadline race must survive;
 * - `hangUntilReleased`: `next()` pends until the matching `release(i)`
 *   is called on the fake (`llm.release(i)`);
 * - `delayMs`: per-chunk delay.
 */
export function createFakeLlm(programs = []) {
    const calls = [];
    const releaseFns = [];
    const modelInfoCalls = [];
    let modelInfo;
    let modelInfoShouldThrow = false;

    const llm = {
        calls,
        modelInfoCalls,
        /** Program the capability answer: a value; pass { throws: true } + an Error to throw. */
        setModelInfo(value, { throws = false } = {}) {
            modelInfo = value;
            modelInfoShouldThrow = throws;
        },
        release(callIndex) {
            releaseFns[callIndex]?.();
        },
        stream(options) {
            const call = { options, returned: false };
            calls.push(call);
            const program = programs[calls.length - 1] ?? { chunks: [] };
            let index = 0;
            let releaseGate = Promise.resolve();
            if (program.hangUntilReleased) {
                releaseGate = new Promise((resolve) => {
                    releaseFns.push(resolve);
                });
            }
            return {
                [Symbol.asyncIterator]() {
                    return {
                        async next() {
                            await releaseGate;
                            if (program.hang) {
                                await new Promise(() => {}); // hang forever, ignore signals
                            }
                            if (program.delayMs) {
                                await new Promise((resolve) => setTimeout(resolve, program.delayMs));
                            }
                            if (program.error) {
                                throw program.error;
                            }
                            if (index >= program.chunks.length) {
                                return { done: true };
                            }
                            return { done: false, value: program.chunks[index++] };
                        },
                        async return() {
                            call.returned = true;
                            return { done: true };
                        },
                    };
                },
            };
        },
        async resolveModelInfo(provider, model, signal) {
            modelInfoCalls.push({ provider, model, signal });
            if (modelInfoShouldThrow) {
                throw modelInfo ?? new Error('resolveModelInfo failed');
            }
            return modelInfo;
        },
    };
    return llm;
}

/** Convenience: one successful stream program emitting `text` then finishing. */
export function answer(text, { usage } = {}) {
    const chunks = [];
    if (usage !== undefined) {
        chunks.push({ type: 'usage', usage });
    }
    chunks.push({ type: 'text-delta', text });
    chunks.push({ type: 'finish', reason: { kind: 'stop' } });
    return { chunks };
}

/** Convenience: a failed stream program. */
export function failure(error, { throwImmediately = false } = {}) {
    return { error, throwImmediately };
}

/** Convenience: a hung stream program (never yields, never ends). */
export function hung() {
    return { hang: true };
}

/**
 * Manual clock + timer pair: `advance(ms)` moves virtual time and fires due
 * timers synchronously (abort deadlines run deterministically, no real
 * waiting). Feed `timers` into the engine's `timers` option and
 * `timers.clock` into its `clock` option.
 */
export function createManualTimers({ now = 0 } = {}) {
    let current = now;
    let seq = 0;
    const pending = new Map();
    return {
        clock: () => current,
        setTimeout(fn, ms) {
            const id = ++seq;
            pending.set(id, { fn, at: current + (ms ?? 0) });
            return id;
        },
        clearTimeout(id) {
            pending.delete(id);
        },
        advance(ms) {
            current += ms;
            for (const [id, timer] of [...pending.entries()].sort((a, b) => a[1].at - b[1].at)) {
                if (timer.at <= current) {
                    pending.delete(id);
                    timer.fn();
                }
            }
        },
        pendingCount: () => pending.size,
    };
}

/** Drain microtasks (lets abort-triggered promise chains settle). */
export async function pump(turns = 6) {
    for (let i = 0; i < turns; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

/** 语义合规的假呈现提供方（spawn 形态：零父上下文 + 路由覆盖 + 零工具能力）。 */
export function eligibleSpawnProvider(name = 'spawn') {
    return {
        name,
        capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
        inheritsParentContext: false,
    };
}

/** 构造一个结算为给定 result 的假 run；记录 dispose 调用。 */
export function fakeRun(result, { failDispose = false } = {}) {
    return {
        id: 'subsession-1',
        result: Promise.resolve(result),
        disposeCalls: 0,
        dispose() {
            this.disposeCalls += 1;
            return failDispose ? Promise.reject(new Error('dispose failed')) : Promise.resolve();
        },
    };
}

/**
 * 假 subagents 缝：登记 providers；start 捕获请求并按脚本返回 run（或抛错
 * 模拟发布前失败）。脚本 run 耗尽时经 `makeRun(callIndex)` 兜底生成。
 */
export function createFakeSubagents({ providers = [eligibleSpawnProvider()], runs = [], startError, makeRun } = {}) {
    const registry = new Map(providers.map((provider) => [provider.name, provider]));
    const requests = [];
    let autoRuns = 0;
    return {
        registry,
        requests,
        startCalls: 0,
        async start(name, request) {
            this.startCalls += 1;
            requests.push({ name, request });
            if (startError) {
                throw startError;
            }
            const run = runs.shift() ?? (makeRun ? makeRun(++autoRuns) : undefined);
            if (!run) {
                throw new Error('fake subagents: no scripted run');
            }
            return run;
        },
        getProvider: (name) => registry.get(name),
        list: () => [...registry.keys()],
    };
}

/**
 * 审核类子会话租约夹具（T-023/T-026/T-036 共用单点；sessionQuery 租约形状
 * ——T-094 豁免恒死根因的形状锚：header 是租约独立属性、事件流为裸 log
 * 切片（seq===index 自 0 连续，无 type:'session' 自证事件），
 * `subagent/descriptor` 承载创建标签（生产 seq 0）、`agent/inbox/spliced`
 * 承载首条提示词）。消费方：subsessionExemptFrom（收租约对象）。
 */
export function reviewerSubsessionLease({ header = { type: 'session', id: 'sub-1', origin: 'subagent' }, label = 'Standards review of T-032', prompt = 'Review the changes since main.' } = {}) {
    const events = [];
    if (label !== undefined) {
        events.push({ type: 'subagent/descriptor', seq: 0, data: { mode: 'one-shot', label } });
    }
    if (prompt !== undefined) {
        events.push({ type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', inserted: [{ content: [{ type: 'text', text: prompt }] }] } });
    }
    return { header, events };
}

/**
 * 历史「文件形状」夹具（T-036 结构性死路防回归专用）：header 作为自证事件
 * 塞进事件流（seq0）且 descriptor 占 seq6——宿主 seq===index 校验下不可能
 * 的持久化序列化形状。仅供断言该形状不再构成豁免判定的输入（旧数组形状
 * 判 false 的防回归锚）；生产/新用例一律用 reviewerSubsessionLease。
 */
export function reviewerSubsessionEvents({ header = { type: 'session', seq: 0, id: 'sub-1', origin: 'subagent' }, label = 'Standards review of T-032', prompt = 'Review the changes since main.' } = {}) {
    const events = [];
    if (header) {
        events.push(header);
    }
    if (prompt !== undefined) {
        events.push({ type: 'agent/inbox/spliced', seq: 3, data: { target: 'next-turn', inserted: [{ content: [{ type: 'text', text: prompt }] }] } });
    }
    if (label !== undefined) {
        events.push({ type: 'subagent/descriptor', seq: 6, data: { mode: 'one-shot', label } });
    }
    return events;
}

/**
 * 真实 T-094 会话租约回归锚（T-036）：生产持久化日志实测形状归一为
 * sessionQuery 租约对象——header 独立于事件流、descriptor 占 seq 0、
 * 事件流不含 type:'session' 自证事件。豁免判定的生产形状锚点。
 */
export function readReviewLogFixture() {
    const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reviewer-subsession-t094.json'), 'utf8');
    return JSON.parse(raw);
}
