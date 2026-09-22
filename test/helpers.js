/**
 * Test doubles for the consultation engine: a programmable fake llm whose
 * `stream()` replays per-call programs (chunk sequences / errors / hangs /
 * manual release) and records every call, plus a configurable
 * `resolveModelInfo`.
 */

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
