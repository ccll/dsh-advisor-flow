/**
 * `advisor-flow` settings-namespace parser (R-02-001).
 *
 * The parser is the SSOT for the namespace contract (SOLUTION.md#产品契约):
 * it validates known keys against per-section field tables, collects unknown
 * keys as warnings while keeping them pass-through, and resolves the
 * disabled-with-reason gate — `enabled: true` without an advisor
 * provider/model disables the whole consultation feature with a queryable
 * reason instead of failing calls one by one (R-02-001/AC-03).
 *
 * Invalid *values* are rejected; unknown *keys* are warnings, never a
 * rejection. The parser never throws — it returns a result object.
 *
 * @module dsh-advisor-flow/config
 */

import { isRecord } from './util.js';

export const ADVISOR_FLOW_NAMESPACE = 'advisor-flow';

/** Whole-call deadline for one advisor `llm.stream` (SOLUTION 运行时语义). */
export const DEFAULT_CALL_TIMEOUT_MS = 180_000;
/** Per-call output token budget (thinking-capable advisor models need headroom). */
export const DEFAULT_MAX_TOKENS = 16384;
/** Per-session FIFO capacity; a full queue drops the newest consultation. */
export const DEFAULT_MAX_QUEUED = 32;
/** `toolResults: capped` byte cap. */
export const DEFAULT_TOOL_RESULT_MAX_BYTES = 8192;
/** Transient retries after the first attempt (R-01-001/AC-03 retry budget). */
export const DEFAULT_RETRY_ATTEMPTS = 1;
/** Default loop/failure gate threshold. */
export const DEFAULT_GATE_THRESHOLD = 3;

const GATE_KINDS = ['plan', 'failure', 'loop', 'completion'];
const GATE_POLICIES = ['review', 'ask', 'block'];
/** The failure gate additionally allows the session-stopping policy. */
const FAILURE_GATE_POLICIES = ['review', 'ask', 'block', 'block-session'];

const isPlainKey = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);

// ---------------------------------------------------------------------------
// Field parsers: each entry returns { ok, value } — `ok: false` means the
// value was present but invalid; absent (`undefined`/`null`) falls back to
// the parser's default and is not an error.
// ---------------------------------------------------------------------------
function parsePositiveInt(fallback) {
    return (value) => {
        if (value === undefined || value === null) {
            return { ok: true, value: fallback };
        }
        return typeof value === 'number' && Number.isInteger(value) && value > 0
            ? { ok: true, value }
            : { ok: false };
    };
}

function parseNonNegativeInt(fallback) {
    return (value) => {
        if (value === undefined || value === null) {
            return { ok: true, value: fallback };
        }
        return typeof value === 'number' && Number.isInteger(value) && value >= 0
            ? { ok: true, value }
            : { ok: false };
    };
}

function parseEnum(allowed, fallback) {
    return (value) => {
        if (value === undefined || value === null) {
            return { ok: true, value: fallback };
        }
        return typeof value === 'string' && allowed.includes(value)
            ? { ok: true, value }
            : { ok: false };
    };
}

function parseBool(fallback) {
    return (value) => {
        if (value === undefined || value === null) {
            return { ok: true, value: fallback };
        }
        return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
    };
}

function parseNonEmptyString(value) {
    if (value === undefined || value === null) {
        return { ok: true, value: undefined };
    }
    return typeof value === 'string' && value.length > 0 ? { ok: true, value } : { ok: false };
}

/** Field spec tables per section (SOLUTION.md#产品契约 naming). */
const ADVISOR_FIELDS = [
    { key: 'provider', parse: parseNonEmptyString, message: '必须为非空字符串' },
    { key: 'model', parse: parseNonEmptyString, message: '必须为非空字符串' },
    { key: 'reasoningEffort', parse: parseNonEmptyString, message: '必须为非空字符串' },
    { key: 'maxTokens', parse: parsePositiveInt(DEFAULT_MAX_TOKENS), message: '必须为正整数' },
    { key: 'callTimeoutMs', parse: parsePositiveInt(DEFAULT_CALL_TIMEOUT_MS), message: '必须为正整数' },
    { key: 'retryAttempts', parse: parseNonNegativeInt(DEFAULT_RETRY_ATTEMPTS), message: '必须为非负整数' },
];
const PRIVACY_FIELDS = [
    { key: 'history', parse: parseEnum(['off', 'delta', 'window'], 'window'), message: '必须为 off|delta|window 之一' },
    { key: 'repoContext', parse: parseEnum(['none', 'summary', 'patch'], 'summary'), message: '必须为 none|summary|patch 之一' },
    { key: 'toolResults', parse: parseEnum(['off', 'capped'], 'capped'), message: '必须为 off|capped 之一' },
    { key: 'toolResultMaxBytes', parse: parsePositiveInt(DEFAULT_TOOL_RESULT_MAX_BYTES), message: '必须为正整数' },
    { key: 'fileContent', parse: parseBool(false), message: '必须为布尔值' },
    { key: 'redactSecrets', parse: parseBool(true), message: '必须为布尔值' },
];
const BUDGET_FIELDS = [
    { key: 'maxPerSession', parse: parseNonNegativeInt(0), message: '必须为非负整数（0 = 不限）' },
];

/**
 * Parse one settings section against its field table: known fields are
 * validated via their parser (invalid → `errors`, absent → default), unknown
 * keys are collected as warnings and preserved on the parsed section.
 */
function parseSection(section, path, fields, errors, warnings) {
    const out = {};
    const known = new Set(fields.map((field) => field.key));
    for (const field of fields) {
        const result = field.parse(section[field.key]);
        if (!result.ok) {
            errors.push(`${path}.${field.key} ${field.message}`);
            continue;
        }
        out[field.key] = result.value;
    }
    for (const key of Object.keys(section)) {
        if (!known.has(key) && isPlainKey(key)) {
            warnings.push(`${path}.${key}`);
            out[key] = section[key];
        }
    }
    return out;
}

/**
 * Save-success receipts, shared by the host gateway and the web card. A
 * gateway save applies to the runtime in every case; whether it ALSO
 * persisted to settings.yaml depends on the settings write seam:
 * - persisted → `SAVE_NOTICE_PERSISTED`;
 * - write seam missing or the write failed → `SAVE_NOTICE_EPHEMERAL`
 *   (the card must say the state is runtime-only — never imply a
 *   restart-safe write happened).
 */
export const SAVE_NOTICE_PERSISTED = '已保存并持久化到 settings.yaml。';
export const SAVE_NOTICE_EPHEMERAL = '已保存到当前运行时；持久化尚未启用，重启后修改会丢失。';
// 写入失败专属回执：与「缝缺失」区分——功能在，只是这次写入失败（避免
// 缺失场景文案被误读为持久化能力整体缺失）。
export const SAVE_NOTICE_WRITE_FAILED = '已保存到运行时；写入 settings.yaml 失败，重启即失（原因见详情）。';

/**
 * The blocked-save message for `enabled: true` without a complete advisor
 * route — one wording shared by the host gateway and the web card
 * (R-02-001/AC-03).
 */
export function advisorModelMissingMessage(missing) {
    return `已启用但缺少 ${missing}——请补齐后再保存，否则咨询功能将整体禁用`;
}

/**
 * Resolve the raw `advisor-flow` namespace object into the structured
 * runtime config.
 *
 * 双清单纪律（与 lib/settings.js 的 schemastery Schema 互指）：本文件
 * （解析器 + 字段表）是配置键的 SSOT；settings.js 的 Schema 是 GUI 投影
 * （settings 卡/describe 呈现用）。新增配置键 = 两处双写义务——漏写本文件
 * 则运行时拒绝该键，漏写 Schema 则设置卡不可编辑该键。
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
        raw = {};
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
    const enabled = parseBool(false)(raw.enabled);
    if (!enabled.ok) {
        errors.push('enabled 必须为布尔值');
    } else {
        config.enabled = enabled.value;
    }

    // --- advisor / privacy / budget (shared section shape) -----------------
    for (const [key, fields] of [
        ['advisor', ADVISOR_FIELDS],
        ['privacy', PRIVACY_FIELDS],
        ['budget', BUDGET_FIELDS],
    ]) {
        const section = raw[key];
        if (section !== undefined && !isRecord(section)) {
            errors.push(`${key} 必须为对象`);
            continue;
        }
        config[key] = parseSection(section ?? {}, key, fields, errors, warnings);
    }

    // --- gates: per-kind sections sharing the same field-table shape -------
    const gates = raw.gates;
    if (gates !== undefined && !isRecord(gates)) {
        errors.push('gates 必须为对象');
    } else {
        for (const kind of GATE_KINDS) {
            const policies = kind === 'failure' ? FAILURE_GATE_POLICIES : GATE_POLICIES;
            const fields = [
                { key: 'enabled', parse: parseBool(false), message: '必须为布尔值' },
                { key: 'policy', parse: parseEnum(policies, 'review'), message: `必须为 ${policies.join('|')} 之一` },
                ...(['failure', 'loop'].includes(kind)
                    ? [{ key: 'threshold', parse: parsePositiveInt(DEFAULT_GATE_THRESHOLD), message: '必须为正整数' }]
                    : []),
            ];
            const gateRaw = gates?.[kind];
            if (gateRaw !== undefined && !isRecord(gateRaw)) {
                errors.push(`gates.${kind} 必须为对象`);
                continue;
            }
            config.gates[kind] = parseSection(gateRaw ?? {}, `gates.${kind}`, fields, errors, warnings);
        }
        const knownGates = new Set(GATE_KINDS);
        for (const key of Object.keys(gates ?? {})) {
            if (!knownGates.has(key) && isPlainKey(key)) {
                warnings.push(`gates.${key}`);
                config.gates[key] = gates[key];
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
