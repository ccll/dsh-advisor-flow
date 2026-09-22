/**
 * `advisor-flow` settings-namespace parser (R-02-001).
 *
 * The parser is the SSOT for the namespace contract (SOLUTION.md#产品契约):
 * it validates known keys, collects unknown keys as warnings while keeping
 * them pass-through, and resolves the disabled-with-reason gate —
 * `enabled: true` without an advisor provider/model disables the whole
 * consultation feature with a queryable reason instead of failing calls
 * one by one (R-02-001/AC-03).
 *
 * Invalid *values* are rejected; unknown *keys* are warnings, never a
 * rejection. The parser never throws — it returns a result object.
 *
 * @module dsh-advisor-flow/config
 */

export const ADVISOR_FLOW_NAMESPACE = 'advisor-flow';

/** Whole-call deadline for one advisor `llm.stream` (SOLUTION 运行时语义). */
export const DEFAULT_CALL_TIMEOUT_MS = 180_000;
/** Per-call output token budget (thinking-capable advisor models need headroom). */
export const DEFAULT_MAX_TOKENS = 16384;
/** Per-session FIFO capacity; a full queue drops the newest consultation. */
export const DEFAULT_MAX_QUEUED = 32;
/** `toolResults: capped` byte cap. */
export const DEFAULT_TOOL_RESULT_MAX_BYTES = 8192;

const GATE_KINDS = ['plan', 'failure', 'loop', 'completion'];
const GATE_POLICIES = ['review', 'ask', 'block'];
/** The failure gate additionally allows the session-stopping policy. */
const FAILURE_GATE_POLICIES = ['review', 'ask', 'block', 'block-session'];
const HISTORY_LEVELS = ['off', 'delta', 'window'];
const REPO_CONTEXT_LEVELS = ['none', 'summary', 'patch'];
const TOOL_RESULT_LEVELS = ['off', 'capped'];

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isPlainKey = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);

/**
 * Parse one positive integer option. Returns `{ ok, value }`; `ok: false`
 * means the value was present but invalid (absent values fall back to the
 * caller's default and are not an error).
 */
function parsePositiveInt(value, fallback) {
    if (value === undefined || value === null) {
        return { ok: true, value: fallback };
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        return { ok: false };
    }
    return { ok: true, value };
}

function parseEnum(value, allowed, fallback) {
    if (value === undefined || value === null) {
        return { ok: true, value: fallback };
    }
    if (typeof value !== 'string' || !allowed.includes(value)) {
        return { ok: false };
    }
    return { ok: true, value };
}

function parseBool(value, fallback) {
    if (value === undefined || value === null) {
        return { ok: true, value: fallback };
    }
    if (typeof value !== 'boolean') {
        return { ok: false };
    }
    return { ok: true, value };
}

function parseOptionalString(value) {
    if (value === undefined || value === null) {
        return { ok: true, value: undefined };
    }
    if (typeof value !== 'string' || value.length === 0) {
        return { ok: false };
    }
    return { ok: true, value };
}

/**
 * Validate one gate object against its policy set. Unknown nested keys are
 * collected into `unknown` (dotted paths) and preserved on the parsed gate.
 */
function parseGate(raw, kind, unknown) {
    const policies = kind === 'failure' ? FAILURE_GATE_POLICIES : GATE_POLICIES;
    const gate = { enabled: false, policy: 'review' };
    if (kind === 'failure' || kind === 'loop') {
        const threshold = parsePositiveInt(raw.threshold, 3);
        if (!threshold.ok) {
            return { error: `gates.${kind}.threshold 必须为正整数` };
        }
        gate.threshold = threshold.value;
    }
    const enabled = parseBool(raw.enabled, false);
    if (!enabled.ok) {
        return { error: `gates.${kind}.enabled 必须为布尔值` };
    }
    gate.enabled = enabled.value;
    const policy = parseEnum(raw.policy, policies, 'review');
    if (!policy.ok) {
        return { error: `gates.${kind}.policy 必须为 ${policies.join('|')} 之一` };
    }
    gate.policy = policy.value;
    for (const key of Object.keys(raw)) {
        if (key !== 'enabled' && key !== 'policy' && key !== 'threshold' && isPlainKey(key)) {
            unknown.push(`gates.${kind}.${key}`);
            gate[key] = raw[key];
        }
    }
    return { gate };
}

/**
 * Resolve the raw `advisor-flow` namespace object into the structured
 * runtime config.
 *
 * @param {unknown} raw the namespace value from settings.yaml (may be any
 *   garbage — the parser never throws)
 * @returns {{ ok: true, config: object, warnings: string[] }
 *   | { ok: false, error: string, warnings: string[] }} the parsed config
 *   with unknown keys preserved, or a rejection listing every invalid value
 */
export function resolveAdvisorFlowConfig(raw) {
    const warnings = [];
    if (raw === undefined || raw === null) {
        return { ok: true, config: defaultConfig(), warnings };
    }
    if (!isRecord(raw)) {
        return { ok: false, error: 'advisor-flow 配置必须为对象', warnings };
    }

    const errors = [];
    const config = {
        unknown: {},
        enabled: false,
        advisor: {},
        gates: {},
        privacy: {},
        budget: {},
    };

    // --- enabled -----------------------------------------------------------
    const enabled = parseBool(raw.enabled, false);
    if (!enabled.ok) {
        errors.push('enabled 必须为布尔值');
    } else {
        config.enabled = enabled.value;
    }

    // --- advisor -----------------------------------------------------------
    const advisor = raw.advisor ?? {};
    if (advisor !== null && typeof advisor !== 'object') {
        errors.push('advisor 必须为对象');
    } else if (isRecord(advisor) || advisor === undefined) {
        const section = advisor ?? {};
        const provider = parseOptionalString(section.provider);
        if (!provider.ok) {
            errors.push('advisor.provider 必须为非空字符串');
        } else {
            config.advisor.provider = provider.value;
        }
        const model = parseOptionalString(section.model);
        if (!model.ok) {
            errors.push('advisor.model 必须为非空字符串');
        } else {
            config.advisor.model = model.value;
        }
        const effort = parseOptionalString(section.reasoningEffort);
        if (!effort.ok) {
            errors.push('advisor.reasoningEffort 必须为非空字符串');
        } else {
            config.advisor.reasoningEffort = effort.value;
        }
        const maxTokens = parsePositiveInt(section.maxTokens, DEFAULT_MAX_TOKENS);
        if (!maxTokens.ok) {
            errors.push('advisor.maxTokens 必须为正整数');
        } else {
            config.advisor.maxTokens = maxTokens.value;
        }
        const timeout = parsePositiveInt(section.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS);
        if (!timeout.ok) {
            errors.push('advisor.callTimeoutMs 必须为正整数');
        } else {
            config.advisor.callTimeoutMs = timeout.value;
        }
        for (const key of Object.keys(section)) {
            if (!['provider', 'model', 'reasoningEffort', 'maxTokens', 'callTimeoutMs'].includes(key)
                && isPlainKey(key)) {
                warnings.push(`advisor.${key}`);
                config.advisor[key] = section[key];
            }
        }
    }

    // --- gates -------------------------------------------------------------
    const gates = raw.gates ?? {};
    if (gates !== null && typeof gates !== 'object') {
        errors.push('gates 必须为对象');
    } else {
        for (const kind of GATE_KINDS) {
            const gateRaw = gates[kind];
            if (gateRaw === undefined) {
                config.gates[kind] = { enabled: false, policy: 'review' };
                if (kind === 'failure' || kind === 'loop') {
                    config.gates[kind].threshold = 3;
                }
                continue;
            }
            if (!isRecord(gateRaw)) {
                errors.push(`gates.${kind} 必须为对象`);
                continue;
            }
            const unknown = [];
            const parsed = parseGate(gateRaw, kind, unknown);
            if (parsed.error) {
                errors.push(parsed.error);
                continue;
            }
            config.gates[kind] = parsed.gate;
            for (const path of unknown) {
                warnings.push(path);
            }
        }
        for (const key of Object.keys(gates)) {
            if (!GATE_KINDS.includes(key) && isPlainKey(key)) {
                warnings.push(`gates.${key}`);
                config.gates[key] = gates[key];
            }
        }
    }

    // --- privacy -----------------------------------------------------------
    const privacy = raw.privacy ?? {};
    if (privacy !== null && typeof privacy !== 'object') {
        errors.push('privacy 必须为对象');
    } else if (isRecord(privacy) || privacy === undefined) {
        const section = privacy ?? {};
        const history = parseEnum(section.history, HISTORY_LEVELS, 'window');
        if (!history.ok) {
            errors.push('privacy.history 必须为 off|delta|window 之一');
        } else {
            config.privacy.history = history.value;
        }
        const repo = parseEnum(section.repoContext, REPO_CONTEXT_LEVELS, 'summary');
        if (!repo.ok) {
            errors.push('privacy.repoContext 必须为 none|summary|patch 之一');
        } else {
            config.privacy.repoContext = repo.value;
        }
        const toolResults = parseEnum(section.toolResults, TOOL_RESULT_LEVELS, 'capped');
        if (!toolResults.ok) {
            errors.push('privacy.toolResults 必须为 off|capped 之一');
        } else {
            config.privacy.toolResults = toolResults.value;
        }
        const fileContent = parseBool(section.fileContent, false);
        if (!fileContent.ok) {
            errors.push('privacy.fileContent 必须为布尔值');
        } else {
            config.privacy.fileContent = fileContent.value;
        }
        const redact = parseBool(section.redactSecrets, true);
        if (!redact.ok) {
            errors.push('privacy.redactSecrets 必须为布尔值');
        } else {
            config.privacy.redactSecrets = redact.value;
        }
        const maxBytes = parsePositiveInt(section.toolResultMaxBytes, DEFAULT_TOOL_RESULT_MAX_BYTES);
        if (!maxBytes.ok) {
            errors.push('privacy.toolResultMaxBytes 必须为正整数');
        } else {
            config.privacy.toolResultMaxBytes = maxBytes.value;
        }
        for (const key of Object.keys(section)) {
            if (!['history', 'repoContext', 'toolResults', 'fileContent', 'redactSecrets', 'toolResultMaxBytes'].includes(key)
                && isPlainKey(key)) {
                warnings.push(`privacy.${key}`);
                config.privacy[key] = section[key];
            }
        }
    }

    // --- budget ------------------------------------------------------------
    const budget = raw.budget ?? {};
    if (budget !== null && typeof budget !== 'object') {
        errors.push('budget 必须为对象');
    } else if (isRecord(budget) || budget === undefined) {
        const section = budget ?? {};
        const maxPerSession = section.maxPerSession;
        if (maxPerSession === undefined || maxPerSession === null) {
            config.budget.maxPerSession = 0;
        } else if (typeof maxPerSession !== 'number' || !Number.isInteger(maxPerSession) || maxPerSession < 0) {
            errors.push('budget.maxPerSession 必须为非负整数（0 = 不限）');
        } else {
            config.budget.maxPerSession = maxPerSession;
        }
        for (const key of Object.keys(section)) {
            if (key !== 'maxPerSession' && isPlainKey(key)) {
                warnings.push(`budget.${key}`);
                config.budget[key] = section[key];
            }
        }
    }

    // --- unknown top-level keys: warn + passthrough ------------------------
    const KNOWN = ['enabled', 'advisor', 'gates', 'privacy', 'budget'];
    for (const key of Object.keys(raw)) {
        if (!KNOWN.includes(key) && isPlainKey(key)) {
            warnings.push(key);
            config.unknown[key] = raw[key];
        }
    }

    if (errors.length > 0) {
        return { ok: false, error: errors.join('；'), warnings };
    }

    // --- disabled-with-reason gate (R-02-001/AC-03) ------------------------
    // `enabled: true` without a configured advisor provider/model disables the
    // whole consultation feature up front; the reason stays queryable via
    // status instead of failing every call with NO_ADVISOR_MODEL.
    if (config.enabled && (!config.advisor.provider || !config.advisor.model)) {
        config.enabled = false;
        config.reason = 'missing-advisor-model';
    }

    return { ok: true, config, warnings };
}

function defaultConfig() {
    return resolveAdvisorFlowConfig({}).config;
}
