/**
 * Consultation engine — the single entry point for advisor model calls
 * (R-01-001, R-02-003, R-02-005; SOLUTION.md#咨询服务).
 *
 * Responsibilities:
 * - adviceId allocation (`randomUUID()`, pi 0.8.2 parity — a failed
 *   consultation never exposes an adviceId to callers);
 * - reasoning-effort capability gating via the optionally injected
 *   `llm.resolveModelInfo` — the configured effort is sent ONLY when the
 *   resolved model declares it; a missing API or a resolution error sends
 *   nothing and never caches the failure;
 * - a whole-call deadline (`advisor.callTimeoutMs`, default 180s) fused with
 *   the dispose/caller signals and raced against EVERY stream chunk, so a
 *   hung provider stream is terminable even when the provider ignores the
 *   abort signal (dsh-advisor's proven pattern);
 * - failures resolve immediately as failed consultations（无重试）；the gate
 *   layer dispositions them by the configured failure mode（C-007）. Every drop
 *   is surfaced as an info-level log line carrying the reason and entry type
 *   (R-02-003/AC-01 — failures must be visible, never silent);
 * - the non-stall invariant: `consult()` NEVER rejects — the tool face gets
 *   a result object carrying a diagnostic code
 *   （NO_ADVISOR_MODEL / ADVISOR_TIMEOUT / ADVISOR_FAILED / ADVISOR_GATE_INVALID /
 *   ADVISOR_BUDGET_EXHAUSTED）；无重试/暂停/停机语义（C-007）
 * - per-session FIFO serialization with a bounded queue (drop-newest when
 *   full, logged); different sessions run independently;
 * - advice is free text (no strict JSON framing); the on-demand protocol is
 *   the `Verdict: sound` first-line convention（C-007，无 severity 分级）;
 *   outcome can be appended after the fact.
 *
 * @module dsh-advisor-flow/consultation
 */

import { DEFAULT_CALL_TIMEOUT_MS, DEFAULT_MAX_QUEUED } from './config.js';
import { buildAdvisorUserMessage } from './context.js';
import { redactText } from './redact.js';
import { isRecord } from './util.js';
import { parseDecision } from './decision.js';
import { randomUUID } from 'node:crypto';

/** Diagnostic codes the tool face and gates surface to callers. */
export const DIAGNOSTIC_CODES = Object.freeze([
    'NO_ADVISOR_MODEL',
    'ADVISOR_TIMEOUT',
    'ADVISOR_FAILED',
    'ADVISOR_GATE_INVALID',
    'ADVISOR_BUDGET_EXHAUSTED',
]);

/** 按需咨询协议提示（pi 0.8.2 ADVISOR_SYSTEM 逐字，R-01-001/AC-05；C-009 基线冻结）：
 * 自由文本 + 二值 Verdict 头部——完全无问题时首行恰为 `Verdict: sound`；无严重度分级。 */
export const ADVISOR_SYSTEM_PROMPT = [
    'You are the Advisor: a senior engineer giving a brief second opinion to an autonomous coding agent.',
    'You already have the relevant reconstructed conversation context. No question or other input from the Executor is needed for a general review.',
    'When no targeted focus is supplied, proactively review the task, risks, proposed direction, and validation from the context. Do not ask the Executor for a question, clarification, more input, or confirmation.',
    'The context may be truncated, so state any material uncertainty and make the best recommendation you can from what is present.',
    'A supplied draft is an unverified Executor claim, not evidence. Critique it concretely and never treat claimed changes or passing tests as independently verified.',
    'When the implementation is fully sound based on the supplied evidence and you have no material concern or recommended change, begin with exactly `Verdict: sound`. Do not use that verdict when uncertainty, a risk, or a recommendation remains.',
    'You do not act or take over planning. Answer the Executor\'s request directly in concise, human-readable Markdown. State uncertainty plainly and never claim verification that the supplied evidence does not show.',
].join(' ');

/** 循环门决策协议提示（pi 0.8.2 ADVISOR_DECISION_SYSTEM 逐字，R-01-001/AC-05）：
 * 首非空行恰为 `Decision: proceed|revise|blocked`；blocked 仅用于需要用户
 * 介入的关键问题。 */
export const ADVISOR_DECISION_SYSTEM = [
    'You are the Advisor\'s automatic safety gate for a repeated-tool loop.',
    'Review the supplied context and decide whether the Executor may proceed.',
    'Answer in concise Markdown. Your first non-empty line must be exactly `Decision: proceed`, `Decision: revise`, or `Decision: blocked`.',
    'Use blocked only for a critical issue requiring the user. Never claim verification that the supplied evidence does not show.',
].join(' ');

/** Bounded consultation history for outcome writes and status. */
const MAX_CONSULTATION_RECORDS = 256;

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
 * Parse the advisor reply into free-text advice（C-007：无 severity 分级）。
 * pi 0.8.2 契约：意见为流文本整体（trim），无 JSON 帧解包——任何 JSON 形状
 * 的回复都原样呈现给执行者。
 */
export function parseAdvice(text) {
    const raw = typeof text === 'string' ? text : '';
    return { text: raw.trim() };
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
 * @param {() => number} [options.clock] injectable epoch-ms clock (tests)
 */
export function createConsultationEngine(options) {
    const {
        llm,
        logger = console,
        usageLedger,
        maxQueued = DEFAULT_MAX_QUEUED,
        timers = {},
        clock = defaultClock,
    } = options ?? {};
    const setTimeout_ = timers.setTimeout ?? setTimeout;
    const clearTimeout_ = timers.clearTimeout ?? clearTimeout;

    let config = options?.config ?? { enabled: false };
    let disposed = false;
    const engineController = new AbortController();
    /**
     * Session-level ephemeral overrides (`/advisor on|off`): entries are the
     * session's explicit switch; absent entries fall back to `config.enabled`
     * live. Never touches persisted config (SOLUTION 命令面契约).
     */
    const sessionOverrides = new Map();
    /** session id → { queue, running, inFlight, adviceSeq, calls, runtime, lastActivity } */
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
                calls: 0,
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

    /** pi advisorRef 形态：provider/model 复合串（工具渲染 `Advisor (model)` 的数据源）. */
    const advisorModelRef = () => `${config.advisor.provider}/${config.advisor.model}`;

    /** pi 语义：用户配置的允许档位是上限，更大的请求被收窄到上限
     * （R-01-001/AC-06）；none 与 off 同义。 */
    function clampGitContext(requested) {
        if (typeof requested !== 'string') {
            return undefined;
        }
        const ranks = { none: 0, off: 0, summary: 1, full: 2 };
        const allowed = ranks[config.privacy?.repoContext] ?? 1;
        const wanted = ranks[requested];
        if (wanted === undefined) {
            return undefined;
        }
        const effectiveRank = Math.min(wanted, allowed);
        return effectiveRank === 0 ? 'off' : effectiveRank === 1 ? 'summary' : 'full';
    }

    function failResult(code, reason, extra = {}) {
        return { ok: false, code, reason, ...extra };
    }

    /**
     * Request one consultation. Resolves (never rejects) with:
     * `{ ok: true, adviceId, text }` or
     * `{ ok: false, code, reason }`.
     */
    async function consult(request = {}) {
        const req = isRecord(request) ? request : {};
        const sessionId = typeof req.session === 'string' && req.session.length > 0 ? req.session : 'default';
        const entry = ['tool', 'manual', 'gate'].includes(req.entry) ? req.entry : 'tool';
        // R-01-001/AC-06：仓库上下文档位只能收窄——请求档位高于会话主配置
        // 允许档位时被收窄到允许档位（pi "configured allowance is the
        // ceiling" 语义；素材装配消费该档位在 T-012）。
        if (req.gitContext !== undefined) {
            req.gitContext = clampGitContext(req.gitContext);
        }
        try {
            if (disposed) {
                return failResult('ADVISOR_FAILED', 'engine disposed');
            }
            // Session-level override wins over the persisted switch
            // (`override ?? config.enabled`), so `/advisor on|off` takes
            // effect immediately and never touches the persisted config.
            const override = sessionOverrides.get(sessionId);
            if (override === false || (override === undefined && config.enabled !== true)
                || !config.advisor?.provider || !config.advisor?.model) {
                return failResult(
                    'NO_ADVISOR_MODEL',
                    override === false
                        ? 'advisor 已在本会话临时关闭（/advisor on 恢复）'
                        : config.reason ?? 'advisor 模型未配置（advisor-flow 未启用或缺 provider/model）',
                );
            }
            const state = getState(sessionId);
            if (state.queue.length >= maxQueued) {
                // Drop-newest: a full queue means the advisor is far behind.
                logger.info?.('advisor-flow: consultation dropped — per-session queue full', { session: sessionId, entry, reason: 'queue-full', maxQueued });
                return failResult('ADVISOR_FAILED', `咨询队列已满（${maxQueued}），本次咨询被丢弃`, entry === 'gate' ? { category: 'provider-error' } : undefined);
            }
            // 预算执行（pi reserveAdvisorCall 语义）：maxPerSession 0 = 不限；
            // 超限的咨询直接失败（gate 入口带 budget-exhausted 类别，由门层
            // 按阻断模式处置）。
            const budget = Number.isInteger(config.budget?.maxPerSession) && config.budget.maxPerSession > 0
                ? config.budget.maxPerSession
                : 0;
            if (budget > 0 && state.calls >= budget) {
                logger.info?.('advisor-flow: consultation rejected — per-session budget exhausted', { session: sessionId, entry, budget });
                // pi 语义：工具面 "Advisor call budget exhausted for this session."；门面
            // "Advisor gate call budget is exhausted."（按入口区分文案）。
            const budgetMessage = entry === 'gate'
                ? 'Advisor gate call budget is exhausted.'
                : 'Advisor call budget exhausted for this session.';
            return failResult('ADVISOR_BUDGET_EXHAUSTED', budgetMessage, entry === 'gate' ? { category: 'budget-exhausted' } : undefined);
            }
            state.calls = (state.calls ?? 0) + 1;
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
            while (!disposed && state.queue.length > 0) {
                const job = state.queue.shift();
                state.inFlight += 1;
                const action = await processJob(state, job);
                state.inFlight -= 1;
                if (action !== 'continue') {
                    // An aborted job (dispose or a cancelled caller signal)
                    // must converge the remaining queue NOW —
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
        // A dispose that left queued jobs behind resolves them here.
        if (disposed) {
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
     * Process one queued consultation: a SINGLE attempt（C-007：无重试——
     * 失败直接收敛为 failed，处置归门控的阻断模式）。Returns the drain
     * action: `'continue'` (queue may proceed), `'stop-aborted'` (job
     * cancelled/disposed).
     */
    async function processJob(state, job) {
        const { req, sessionId, entry, resolve } = job;
        state.adviceSeq += 1;
        const adviceId = randomUUID();
        const record = {
            adviceId,
            session: sessionId,
            entry,
            state: 'pending',
            startedAt: clock(),
        };
        remember(record);
        if (disposed) {
            resolve(failResult('ADVISOR_FAILED', 'engine disposed'));
            return 'stop-aborted';
        }
        const outcome = await callAdvisor(req, entry, sessionId, adviceId, record);
        if (outcome.kind === 'answered') {
            record.state = 'answered';
            record.finishedAt = clock();
            state.lastActivity = clock();
            if (entry === 'gate') {
                // 决策协议：解析 Decision 行（对抗性），失败即为门失败类别，
                // 由门层按阻断模式处置（R-01-005/AC-04）。
                const parsed = parseDecision(outcome.text);
                if (!parsed.ok) {
                    logger.info?.('advisor-flow: gate reply has no valid decision — failure-mode disposition', { session: sessionId, entry, category: parsed.category, reason: parsed.message });
                    record.state = 'failed';
                    resolve({ ok: false, code: 'ADVISOR_GATE_INVALID', reason: parsed.message, category: parsed.category });
                    return 'continue';
                }
                resolve({
                    ok: true,
                    adviceId,
                    decision: parsed.decision,
                    markdown: parsed.markdown,
                    model: advisorModelRef(),
                    entry,
                    session: sessionId,
                });
                return 'continue';
            }
            resolve({
                ok: true,
                adviceId,
                text: outcome.text,
                model: advisorModelRef(),
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
        record.state = 'failed';
        record.finishedAt = clock();
        const code = failure.code === 'TIMEOUT' ? 'ADVISOR_TIMEOUT' : 'ADVISOR_FAILED';
        // pi gate-protocol 分类对齐：空意见 → empty-response，其余 provider-error
        const category = entry === 'gate'
            ? (failure.code === 'EMPTY' ? 'empty-response' : 'provider-error')
            : undefined;
        logger.info?.('advisor-flow: consultation dropped — failure dispositioned by the gate failure mode', {
            session: sessionId,
            entry,
            reason: failure.message ?? 'unknown',
            code,
        });
        resolve(failResult(code, `咨询失败：${failure?.message ?? 'unknown'}`, category ? { category } : undefined));
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
                    system: entry === 'gate' ? ADVISOR_DECISION_SYSTEM : ADVISOR_SYSTEM_PROMPT,
                    // 载体契约（T-008 staging 实弹裁决）：GenerateOptions.messages
                    // 的 content 是 ContentBlock 数组（dsh-llm 消息契约）——
                    // 字符串 content 会在适配器的内容遍历处抛
                    // 「content.some is not a function」。
                    messages: [{ role: 'user', content: [{ type: 'text', text: outbound }] }],
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
            // pi 0.8.2：空意见即失败（AdvisorNoAdviceError → empty-response
            // 类别），不向执行者返回空意见（R-01-001/AC-04）。
            if (advice.text.length === 0) {
                recordUsage({ adviceId, entry, sessionId, usage });
                return { kind: 'failure', failure: { code: 'EMPTY', message: 'Advisor returned no advice.' } };
            }
            recordUsage({ adviceId, entry, sessionId, usage });
            return { kind: 'answered', text: advice.text };
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
        // 载体契约（T-008 staging 实弹核对）：宿主 TokenUsage 的缓存字段是
        // cacheReadTokens/cacheWriteTokens（离散计数，无 cacheTokens）。
        const source = isRecord(usage) ? usage : {};
        usageLedger.record({
            adviceId,
            entry,
            session: sessionId,
            inputTokens: source.inputTokens,
            outputTokens: source.outputTokens,
            cacheReadTokens: source.cacheReadTokens,
            cacheWriteTokens: source.cacheWriteTokens,
            totalTokens: source.totalTokens,
            reasoningTokens: source.reasoningTokens,
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
     * Session-level ephemeral switch (`/advisor on|off`). `true` sets the
     * override on; `false` sets it off; `undefined` clears the override so
     * the session follows the persisted switch again. NEVER persists.
     */
    function setSessionEnabled(sessionId, enabled) {
        if (enabled === undefined) {
            sessionOverrides.delete(sessionId);
            return;
        }
        sessionOverrides.set(sessionId, enabled === true);
    }

    /** The session's explicit override, or `undefined` when following config. */
    function sessionEnabled(sessionId) {
        return sessionOverrides.get(sessionId);
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
        /** pi remainingCalls（register-lifecycle.ts:78-87）：预算未配置或 0
         * 返回 undefined——守则不出预算行；配置时返回 max(0, limit - consumed)，
         * 供守则预算行注入（R-01-007/AC-02）。 */
        remainingCalls(sessionId) {
            const limit = config.budget?.maxPerSession;
            if (!Number.isInteger(limit) || limit <= 0) {
                return undefined;
            }
            const sid = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'default';
            const state = sessions.get(sid);
            return Math.max(0, limit - (state?.calls ?? 0));
        },
        setSessionEnabled,
        sessionEnabled,
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
