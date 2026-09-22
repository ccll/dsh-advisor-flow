/**
 * Consultation engine — the single entry point for advisor model calls
 * (R-01-001, R-02-003, R-02-005; SOLUTION.md#咨询服务).
 *
 * Responsibilities:
 * - adviceId allocation (`adv-<n>`, increments within the session);
 * - reasoning-effort capability gating via the optionally injected
 *   `llm.resolveModelInfo` — the configured effort is sent ONLY when the
 *   resolved model declares it; a missing API or a resolution error sends
 *   nothing and never caches the failure;
 * - a whole-call deadline (`advisor.callTimeoutMs`, default 180s) fused with
 *   the dispose/caller signals and raced against EVERY stream chunk, so a
 *   hung provider stream is terminable even when the provider ignores the
 *   abort signal (dsh-advisor's proven pattern);
 * - the three-way failure classification: transient → the configured
 *   `advisor.retryAttempts` retries (default 1, 1s backoff) → drop; quota →
 *   pause the session's advisor; permanent
 *   (NO_ADAPTER / model-not-found / invalid_request) → halt. Every drop is
 *   surfaced as an info-level log line carrying the reason and entry type
 *   (R-02-003/AC-01 — failures must be visible, never silent);
 * - the non-stall invariant: `consult()` NEVER rejects — the tool face gets
 *   a result object carrying a diagnostic code
 *   (`NO_ADVISOR_MODEL` / `ADVISOR_ROUTE_MISSING` / `ADVISOR_TIMEOUT` /
 *   `ADVISOR_FAILED` / `ADVISOR_PAUSED` / `ADVISOR_HALTED`);
 * - per-session FIFO serialization with a bounded queue (drop-newest when
 *   full, logged); different sessions run independently;
 * - advice is free text (no strict JSON framing); severity is declared by
 *   the advisor in the reply (`severity: blocker|concern|nit`), defaulting
 *   to `nit`; outcome can be appended after the fact.
 *
 * @module dsh-advisor-flow/consultation
 */

import { DEFAULT_CALL_TIMEOUT_MS, DEFAULT_MAX_QUEUED } from './config.js';
import { buildAdvisorUserMessage } from './context.js';
import { redactText } from './redact.js';
import { isRecord } from './util.js';

/** Diagnostic codes the tool face and gates surface to callers. */
export const DIAGNOSTIC_CODES = Object.freeze([
    'NO_ADVISOR_MODEL',
    'ADVISOR_ROUTE_MISSING',
    'ADVISOR_TIMEOUT',
    'ADVISOR_FAILED',
    'ADVISOR_PAUSED',
    'ADVISOR_HALTED',
]);

export const ADVISOR_SYSTEM_PROMPT = [
    '你是一名资深软件顾问（advisor），为正在执行任务的执行者提供第二意见。',
    '你只给出建议，不执行任何工具、不修改任何文件。',
    '基于提供的素材指出风险、更优方向与需要验证的步骤；没有实质问题时给一般性确认。',
    '回复为自由文本；在回复中用一行显式声明意见严重度，格式：severity: blocker|concern|nit。',
    'blocker = 继续执行将浪费工作或造成损失；concern = 实质风险；nit = 次要改进。不确定时用 nit。',
].join('\n');

/** Retry backoff between transient attempts. */
const DEFAULT_RETRY_BACKOFF_MS = 1_000;
/** Bounded consultation history for outcome writes and status. */
const MAX_CONSULTATION_RECORDS = 256;

const PERMANENT_FAILURE_PATTERN = /invalid_request_error|model[_ ]not[_ ]found|is not supported when|does not exist|no adapter|no provider adapter|no route/i;
const ROUTE_MISSING_PATTERN = /no adapter|no provider adapter|no route/i;

function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultClock() {
    return Date.now();
}

function normalizeFailure(value) {
    if (value instanceof Error) {
        return {
            message: value.message,
            code: typeof value.code === 'string' && value.code.length > 0 ? value.code : 'UNKNOWN',
        };
    }
    if (isRecord(value) && (typeof value.message === 'string' || typeof value.code === 'string')) {
        // Provider-shaped failure payloads ({ code, message }) arrive as plain
        // objects — keep their fields instead of stringifying the whole thing.
        return {
            message: typeof value.message === 'string' ? value.message : String(value.message ?? value),
            code: typeof value.code === 'string' && value.code.length > 0 ? value.code : 'UNKNOWN',
        };
    }
    return { message: String(value), code: 'UNKNOWN' };
}

/** Three-way failure classification (quota → pause, permanent → halt, else transient). */
export function classifyFailure(failure) {
    const code = typeof failure?.code === 'string' ? failure.code : '';
    const message = typeof failure?.message === 'string' ? failure.message : '';
    if (code === 'QUOTA_EXCEEDED' || code === 'RATE_LIMIT' || /quota|rate limit|429/i.test(message)) {
        return 'quota';
    }
    if (code === 'NO_ADAPTER' || code === 'INVALID_CREDENTIAL' || PERMANENT_FAILURE_PATTERN.test(message)) {
        return 'permanent';
    }
    return 'transient';
}

/**
 * Race one async-iterator demand against an abort signal: resolves with the
 * iterator's next result, or `'aborted'` when the signal fires first.
 * Provider errors reject through the race for the caller to classify.
 */
function raceIteratorNext(iterator, signal) {
    if (signal.aborted) {
        return Promise.resolve('aborted');
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => resolve('aborted');
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve()
            .then(() => iterator.next())
            .then((result) => {
                signal.removeEventListener('abort', onAbort);
                resolve(result);
            }, (error) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            });
    });
}

/**
 * Yield every top-level balanced `{…}` region of `text`, skipping braces
 * inside string literals so a quoted `{`/`}` never corrupts the balance
 * (the proven dsh-advisor extraction shape).
 */
function* balancedObjects(text) {
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
        } else if (char === '{') {
            if (start < 0) {
                start = index;
                depth = 1;
            } else {
                depth++;
            }
        } else if (char === '}' && start >= 0 && --depth === 0) {
            yield text.slice(start, index + 1);
            start = -1;
        }
    }
}

function normalizeSeverity(value) {
    const lowered = typeof value === 'string' ? value.toLowerCase() : '';
    return lowered === 'blocker' || lowered === 'concern' ? lowered : 'nit';
}

/**
 * Parse the advisor reply into free-text advice + severity.
 *
 * Advice is free text (no strict JSON framing), but a JSON-shaped reply is
 * accepted leniently: the first balanced `{…}` object (tolerant of
 * surrounding prose/markdown fences) with a non-empty `note` field is
 * unwrapped into the advice text and its declared severity — the executor
 * never sees raw JSON. Otherwise the whole reply is the advice, with the
 * severity taken from an explicit `severity: blocker|concern|nit` line and
 * defaulting to `nit`.
 */
export function parseAdvice(text) {
    const raw = typeof text === 'string' ? text : '';
    for (const frame of balancedObjects(raw)) {
        let parsed;
        try {
            parsed = JSON.parse(frame);
        } catch {
            continue; // not JSON — try the next balanced region
        }
        if (!isRecord(parsed)) {
            continue;
        }
        const note = parsed.note;
        if (typeof note !== 'string' || note.trim().length === 0) {
            continue;
        }
        return { text: note.trim(), severity: normalizeSeverity(parsed.severity) };
    }
    const match = raw.match(/\bseverity\b\s*[:=：]\s*["']?(blocker|concern|nit)\b/i);
    return { text: raw.trim(), severity: normalizeSeverity(match?.[1]) };
}

/**
 * Create the consultation engine.
 *
 * @param {object} options
 * @param {object} options.llm the dsh LLM service — resolved from the app
 *   ROOT by the wiring (`ctx.root?.get?.('llm') ?? ctx.llm`, handoff: an
 *   isolated scope's llm has no provider adapter). Optional
 *   `resolveModelInfo(provider, model)` enables effort capability gating.
 * @param {object} options.config the RESOLVED `advisor-flow` config (the
 *   `.config` of `resolveAdvisorFlowConfig`); live changes are applied via
 *   `applyConfig()` and take effect on subsequent consultations.
 * @param {{ info?, warn?, debug? }} [options.logger] `ctx.logger('advisor-flow')`
 * @param {object} [options.usageLedger] `createUsageLedger()` instance
 * @param {number} [options.maxQueued] per-session FIFO capacity
 * @param {number} [options.retryBackoffMs] transient retry backoff
 * @param {(ms: number) => Promise<void>} [options.sleep] injectable backoff sleep (tests)
 * @param {{ setTimeout?, clearTimeout? }} [options.timers] injectable timer pair (tests)
 * @param {() => number} [options.clock] injectable epoch-ms clock (tests)
 */
export function createConsultationEngine(options) {
    const {
        llm,
        logger = console,
        usageLedger,
        maxQueued = DEFAULT_MAX_QUEUED,
        retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS,
        sleep = defaultSleep,
        timers = {},
        clock = defaultClock,
    } = options ?? {};
    const setTimeout_ = timers.setTimeout ?? setTimeout;
    const clearTimeout_ = timers.clearTimeout ?? clearTimeout;

    let config = options?.config ?? { enabled: false };
    let disposed = false;
    const engineController = new AbortController();
    /** session id → { queue, running, adviceSeq, runtime, lastActivity, budgetUsed } */
    const sessions = new Map();
    /** Per-(provider, model) reasoning-effort capability verdict cache. */
    const effortCache = new Map();
    /** adviceId → consultation record (bounded) for outcome appends + status. */
    const history = [];

    function getState(sessionId) {
        let state = sessions.get(sessionId);
        if (!state) {
            state = {
                queue: [],
                running: false,
                inFlight: 0,
                adviceSeq: 0,
                runtime: 'active',
                lastActivity: undefined,
                budgetUsed: 0,
            };
            sessions.set(sessionId, state);
        }
        return state;
    }

    function remember(record) {
        history.push(record);
        if (history.length > MAX_CONSULTATION_RECORDS) {
            history.shift();
        }
    }

    function failResult(code, reason, extra = {}) {
        return { ok: false, code, reason, ...extra };
    }

    /**
     * Request one consultation. Resolves (never rejects) with:
     * `{ ok: true, adviceId, severity, text }` or
     * `{ ok: false, code, reason }`.
     */
    async function consult(request = {}) {
        const req = isRecord(request) ? request : {};
        const sessionId = typeof req.session === 'string' && req.session.length > 0 ? req.session : 'default';
        const entry = ['tool', 'manual', 'gate'].includes(req.entry) ? req.entry : 'tool';
        try {
            if (disposed) {
                return failResult('ADVISOR_FAILED', 'engine disposed');
            }
            if (config.enabled !== true || !config.advisor?.provider || !config.advisor?.model) {
                return failResult('NO_ADVISOR_MODEL', config.reason ?? 'advisor 模型未配置（advisor-flow 未启用或缺 provider/model）');
            }
            const state = getState(sessionId);
            if (state.runtime === 'halted') {
                return failResult('ADVISOR_HALTED', 'advisor 已因永久失败停机，需重建运行时');
            }
            if (state.runtime === 'paused') {
                logger.info?.('advisor-flow: consultation rejected — advisor paused (quota)', { session: sessionId, entry, reason: 'quota-paused' });
                return failResult('ADVISOR_PAUSED', 'advisor 因配额耗尽暂停，待恢复后再试');
            }
            if (state.queue.length >= maxQueued) {
                // Drop-newest: a full queue means the advisor is far behind.
                logger.info?.('advisor-flow: consultation dropped — per-session queue full', { session: sessionId, entry, reason: 'queue-full', maxQueued });
                return failResult('ADVISOR_FAILED', `咨询队列已满（${maxQueued}），本次咨询被丢弃`);
            }
            // TODO(T-002): budget.maxPerSession enforcement lives with the gate
            // wiring (which entry types count against the budget) — parsed in
            // config, consumed there.
            return await enqueueAndWait(state, { req, sessionId, entry });
        } catch (error) {
            // Non-stall invariant: a consultation must never surface an
            // unhandled exception to its caller.
            logger.warn?.('advisor-flow: consult() contained an unexpected error', { error: String(error) });
            return failResult('ADVISOR_FAILED', `内部错误：${String(error)}`);
        }
    }

    function enqueueAndWait(state, job) {
        return new Promise((resolve) => {
            state.queue.push({ ...job, resolve });
            if (!state.running) {
                state.running = true;
                drain(state).catch((error) => {
                    // Defense in depth: the drain is serialized fire-and-forget
                    // work; per-consultation failures are contained inside
                    // processJob, so this would be an engine bug.
                    state.running = false;
                    logger.warn?.('advisor-flow: session drain loop failed — contained', { error: String(error) });
                });
            }
        });
    }

    async function drain(state) {
        try {
            while (!disposed && state.queue.length > 0 && state.runtime !== 'paused' && state.runtime !== 'halted') {
                const job = state.queue.shift();
                state.inFlight += 1;
                const action = await processJob(state, job);
                state.inFlight -= 1;
                if (action !== 'continue') {
                    // Paused/halted have already flushed their queues inside
                    // processJob; an aborted job (dispose or a cancelled
                    // caller signal) must converge the remaining queue NOW —
                    // leaving it queued would hang those awaiters until the
                    // next consult happens to trigger the drain (P4).
                    if (action === 'stop-aborted' && state.queue.length > 0) {
                        flushQueue(state, 'ADVISOR_FAILED', '前置咨询被取消/中止，排队咨询按丢弃策略收敛');
                    }
                    return;
                }
            }
        } finally {
            state.running = false;
        }
        // A halt/dispose that left queued jobs behind resolves them here.
        if (state.runtime === 'halted') {
            flushQueue(state, 'ADVISOR_HALTED', 'advisor 已因永久失败停机');
        } else if (disposed) {
            flushQueue(state, 'ADVISOR_FAILED', 'engine disposed');
        }
    }

    /** Resolve every queued consultation with a drop result, each logged. */
    function flushQueue(state, code, reason) {
        while (state.queue.length > 0) {
            const job = state.queue.shift();
            logger.info?.('advisor-flow: pending consultation dropped', {
                session: job.sessionId,
                entry: job.entry,
                reason,
                code,
            });
            job.resolve(failResult(code, reason));
        }
    }

    /**
     * Process one queued consultation: attempt + configured transient
     * retries → classify. Returns the drain action: `'continue'` (queue may
     * proceed), `'stop-aborted'` (job cancelled/disposed), `'stop-paused'`
     * or `'stop-halt'` (runtime left the active state).
     */
    async function processJob(state, job) {
        const { req, sessionId, entry, resolve } = job;
        const adviceId = `adv-${++state.adviceSeq}`;
        const record = {
            adviceId,
            session: sessionId,
            entry,
            state: 'pending',
            startedAt: clock(),
        };
        remember(record);
        // Retry budget from config (R-01-001/AC-03): `advisor.retryAttempts`
        // transient retries after the first attempt; read per job so an
        // `applyConfig` change takes effect on the next consultation.
        const retryAttempts = Number.isInteger(config.advisor?.retryAttempts) && config.advisor.retryAttempts >= 0
            ? config.advisor.retryAttempts
            : 1;
        for (let attempt = 0; attempt <= retryAttempts; attempt++) {
            if (attempt > 0) {
                if (disposed) {
                    resolve(failResult('ADVISOR_FAILED', 'engine disposed'));
                    return 'stop-aborted';
                }
                await sleep(retryBackoffMs);
                if (disposed) {
                    resolve(failResult('ADVISOR_FAILED', 'engine disposed'));
                    return 'stop-aborted';
                }
            }
            const outcome = await callAdvisor(req, entry, sessionId, adviceId, record);
            if (outcome.kind === 'answered') {
                record.state = 'answered';
                record.finishedAt = clock();
                record.severity = outcome.severity;
                state.lastActivity = clock();
                resolve({
                    ok: true,
                    adviceId,
                    severity: outcome.severity,
                    text: outcome.text,
                    entry,
                    session: sessionId,
                });
                return 'continue';
            }
            if (outcome.kind === 'aborted') {
                record.state = 'aborted';
                record.finishedAt = clock();
                logger.info?.('advisor-flow: consultation aborted', { session: sessionId, entry, reason: outcome.reason ?? 'disposed or cancelled' });
                resolve(failResult('ADVISOR_FAILED', outcome.reason ?? '咨询被取消'));
                return 'stop-aborted';
            }
            const failure = outcome.failure;
            const category = classifyFailure(failure);
            if (category === 'quota') {
                state.runtime = 'paused';
                record.state = 'failed';
                record.finishedAt = clock();
                logger.info?.('advisor-flow: consultation paused — quota/rate limit reached', { session: sessionId, entry, reason: failure.message, code: failure.code });
                resolve(failResult('ADVISOR_PAUSED', `配额受限：${failure.message}`));
                flushQueue(state, 'ADVISOR_PAUSED', 'advisor 因配额耗尽暂停');
                return 'stop-paused';
            }
            if (category === 'permanent') {
                state.runtime = 'halted';
                record.state = 'failed';
                record.finishedAt = clock();
                const code = failure.code === 'NO_ADAPTER' || ROUTE_MISSING_PATTERN.test(failure.message)
                    ? 'ADVISOR_ROUTE_MISSING'
                    : 'ADVISOR_HALTED';
                logger.info?.('advisor-flow: consultation halted — permanent model error', { session: sessionId, entry, reason: failure.message, code: failure.code });
                resolve(failResult(code, `永久失败：${failure.message}`));
                flushQueue(state, 'ADVISOR_HALTED', 'advisor 已因永久失败停机');
                return 'stop-halt';
            }
            // transient → retry while the budget lasts (the loop's next iteration)
            record.lastFailure = failure;
        }
        record.state = 'failed';
        record.finishedAt = clock();
        const lastFailure = record.lastFailure;
        const droppedCode = lastFailure?.code === 'TIMEOUT' ? 'ADVISOR_TIMEOUT' : 'ADVISOR_FAILED';
        logger.info?.('advisor-flow: consultation dropped — transient failure after retry', {
            session: sessionId,
            entry,
            reason: lastFailure?.message ?? 'unknown',
            code: droppedCode,
            retryAttempts,
        });
        resolve(failResult(droppedCode, `咨询失败（已重试 ${retryAttempts} 次）：${lastFailure?.message ?? 'unknown'}`));
        return 'continue';
    }

    /** One advisor model call: assemble → redact → stream → collect. */
    async function callAdvisor(req, entry, sessionId, adviceId, record) {
        let deadlineSignal;
        try {
            const materials = {
                question: typeof req.question === 'string' ? req.question : undefined,
                draft: typeof req.draft === 'string' ? req.draft : undefined,
                ...(isRecord(req.materials) ? req.materials : {}),
            };
            const assembled = buildAdvisorUserMessage(materials, config.privacy);
            const outbound = redactText(assembled.text, { enabled: config.privacy?.redactSecrets !== false });
            record.dropped = assembled.dropped;
            record.sentBytes = Buffer.byteLength(outbound, 'utf8');

            // Whole-call deadline: created BEFORE the capability lookup so a
            // hung resolveModelInfo is bounded by the same deadline, and
            // disposed in this function's finally. Fused with the caller's
            // signal and the engine dispose signal.
            deadlineSignal = createDeadlineSignal(req.signal, engineController.signal);
            const timedOut = () => deadlineSignal.signal.reason?.advisorTimeout === true;

            const reasoningEffort = await resolveReasoningEffort(deadlineSignal);
            let text = '';
            let finish;
            let usage;
            try {
                const stream = llm.stream({
                    provider: config.advisor.provider,
                    model: config.advisor.model,
                    system: ADVISOR_SYSTEM_PROMPT,
                    messages: [{ role: 'user', content: outbound }],
                    maxTokens: config.advisor.maxTokens,
                    signal: deadlineSignal.signal,
                    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
                    // `purpose` stays unset: it is a closed union (compaction /
                    // session-title); an advisor call is an ordinary request.
                });
                const iterator = stream[Symbol.asyncIterator]();
                for (;;) {
                    const next = await raceIteratorNext(iterator, deadlineSignal.signal);
                    if (next === 'aborted') {
                        // Best-effort teardown of a provider still mid-flight;
                        // never await a hung teardown.
                        iterator.return?.().catch(() => {});
                        if (timedOut()) {
                            return failureOutcome(`advisor call timed out after ${config.advisor.callTimeoutMs}ms`, 'TIMEOUT');
                        }
                        return { kind: 'aborted', reason: 'disposed or cancelled' };
                    }
                    if (next.done) {
                        break;
                    }
                    const chunk = next.value;
                    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
                        text += chunk.text;
                    } else if (chunk?.type === 'usage') {
                        usage = chunk.usage;
                    } else if (chunk?.type === 'finish') {
                        finish = chunk;
                    }
                }
            } catch (error) {
                return { kind: 'failure', failure: normalizeFailure(error) };
            }

            if (finish === undefined) {
                return failureOutcome('advisor stream ended without a finish chunk', 'UNKNOWN');
            }
            const reason = finish.reason ?? finish;
            if (reason?.kind === 'error') {
                return { kind: 'failure', failure: normalizeFailure(reason.failure ?? reason) };
            }
            if (reason?.kind === 'aborted') {
                if (timedOut()) {
                    return failureOutcome(`advisor call timed out after ${config.advisor.callTimeoutMs}ms`, 'TIMEOUT');
                }
                if (disposed || engineController.signal.aborted || req.signal?.aborted) {
                    return { kind: 'aborted', reason: 'disposed or cancelled' };
                }
                return { kind: 'failure', failure: normalizeFailure(reason.failure ?? reason) };
            }
            usage = usage ?? reason?.usage;
            const advice = parseAdvice(text);
            recordUsage({ adviceId, entry, sessionId, usage });
            return { kind: 'answered', text: advice.text, severity: advice.severity };
        } catch (error) {
            // Containment: anything unexpected in the call path is a failure
            // result, never an exception escaping into the drain.
            return { kind: 'failure', failure: normalizeFailure(error) };
        } finally {
            deadlineSignal?.dispose();
        }
    }

    function failureOutcome(message, code) {
        return { kind: 'failure', failure: { message, code } };
    }

    /**
     * Whole-call deadline: one abort controller armed with `callTimeoutMs`,
     * fused with the caller's signal and the engine dispose signal. The
     * timeout abort carries `advisorTimeout: true` so the caller can tell a
     * deadline expiry from a dispose abort. The timer is always cleared.
     */
    function createDeadlineSignal(...sources) {
        const controller = new AbortController();
        const handle = setTimeout_(() => {
            controller.abort({ advisorTimeout: true });
        }, config.advisor.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
        const onAbort = () => controller.abort(engineController.signal.reason);
        const listeners = [];
        for (const signal of sources) {
            if (signal?.aborted) {
                onAbort();
            } else if (signal) {
                signal.addEventListener('abort', onAbort, { once: true });
                listeners.push(signal);
            }
        }
        return {
            signal: controller.signal,
            dispose: () => {
                clearTimeout_(handle);
                for (const signal of listeners) {
                    signal.removeEventListener('abort', onAbort);
                }
            },
        };
    }

    /**
     * Capability-gate the configured `advisor.reasoningEffort`
     * (handoff: an effort the model does not declare kills the call with
     * UNSUPPORTED_REASONING_EFFORT). Verdicts are cached per
     * (provider, model, configured effort) — keying on the configured effort
     * means an `applyConfig` change naturally invalidates the stale verdict
     * (R-02-001/AC-01 配置即时生效). ONLY definitive verdicts are cached: a
     * `resolveModelInfo` absence is definitive and cacheable; a resolution
     * ERROR is never cached, so the next call resolves afresh.
     */
    async function resolveReasoningEffort(deadlineSignal) {
        const effort = config.advisor.reasoningEffort;
        if (!effort || !llm || typeof llm.stream !== 'function') {
            return undefined;
        }
        const key = `${config.advisor.provider}\u0000${config.advisor.model}\u0000${effort}`;
        if (effortCache.has(key)) {
            return effortCache.get(key);
        }
        if (typeof llm.resolveModelInfo !== 'function') {
            // Definitive verdict: no capability API at all — cacheable.
            effortCache.set(key, undefined);
            return undefined;
        }
        try {
            const info = await llm.resolveModelInfo(config.advisor.provider, config.advisor.model, deadlineSignal.signal);
            const efforts = info?.reasoning?.efforts;
            const supported = Array.isArray(efforts) && efforts.some((item) => (isRecord(item) ? item.id : item) === effort);
            effortCache.set(key, supported ? effort : undefined);
        } catch (error) {
            // Resolution failure: proceed WITHOUT the option, never cache it.
            logger.debug?.('advisor-flow: resolveModelInfo failed — reasoningEffort omitted this call', { error: String(error) });
            return undefined;
        }
        return effortCache.get(key);
    }

    function recordUsage({ adviceId, entry, sessionId, usage }) {
        if (!usageLedger) {
            return;
        }
        // Every answered consultation is recorded; fields the provider never
        // reported arrive as undefined and become 'unavailable' in the ledger.
        const source = isRecord(usage) ? usage : {};
        usageLedger.record({
            adviceId,
            entry,
            session: sessionId,
            inputTokens: source.inputTokens,
            outputTokens: source.outputTokens,
            cacheTokens: source.cacheTokens,
            cost: source.cost,
        });
    }

    /** Live config re-apply (R-02-001/AC-01): takes effect on the NEXT consult. */
    function applyConfig(nextResolved) {
        if (isRecord(nextResolved)) {
            config = nextResolved;
        }
    }

    /**
     * Resume every quota-paused session's advisor (`/advisor on`, T-002
     * wiring). A halted runtime is terminal in place — recovery there is
     * dispose-and-recreate by the command layer, never this method.
     */
    function resume() {
        for (const state of sessions.values()) {
            if (state.runtime !== 'paused') {
                continue;
            }
            state.runtime = 'active';
            if (!state.running && state.queue.length > 0) {
                state.running = true;
                drain(state).catch((error) => {
                    state.running = false;
                    logger.warn?.('advisor-flow: session drain loop failed — contained', { error: String(error) });
                });
            }
        }
    }

    /** Per-session status rows (T-001 core; gates data lands with T-002). */
    function status() {
        const list = [];
        for (const [sessionId, state] of sessions) {
            list.push({
                session: sessionId,
                runtime: state.runtime,
                pending: state.queue.length + state.inFlight,
                lastActivity: state.lastActivity,
                consultations: state.adviceSeq,
            });
        }
        return list;
    }

    /** Append an adoption outcome to a terminal consultation record. */
    function recordOutcome(adviceId, outcome) {
        const record = history.find((item) => item.adviceId === adviceId);
        if (!record) {
            return false;
        }
        record.outcome = outcome;
        return true;
    }

    /** Abort in-flight calls and reject everything queued. */
    function dispose() {
        if (disposed) {
            return;
        }
        disposed = true;
        engineController.abort({ engineDisposed: true });
        for (const state of sessions.values()) {
            flushQueue(state, 'ADVISOR_FAILED', 'engine disposed');
        }
    }

    return {
        consult,
        applyConfig,
        resume,
        recordOutcome,
        status,
        dispose,
        get pendingCount() {
            let total = 0;
            for (const s of sessions.values()) {
                total += s.queue.length + s.inFlight;
            }
            return total;
        },
    };
}
