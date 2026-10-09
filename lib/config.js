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

/** Whole-call deadline for one advisor `llm.stream` (SOLUTION 运行时语义；默认 10 分钟，C-015). */
export const DEFAULT_CALL_TIMEOUT_MS = 600_000;
/** Per-session FIFO capacity; a full queue drops the newest consultation. */
export const DEFAULT_MAX_QUEUED = 32;
/** `toolResults: capped` byte cap. */
export const DEFAULT_TOOL_RESULT_MAX_BYTES = 8192;
/** 会话上下文总预算（pi contextMaxChars；C-008 ②）. */
export const DEFAULT_CONTEXT_MAX_CHARS = 15_000;
/** git 上下文独立上限（pi advisorGitContextMaxChars）. */
export const DEFAULT_GIT_CONTEXT_MAX_CHARS = 20_000;
/** Default loop gate threshold（pi advisorLoopThreshold=3）. */
export const DEFAULT_GATE_THRESHOLD = 3;
/** 循环门 blocked 决策与咨询失败的统一处置档位（pi GateFailureMode）. */
export const FAILURE_MODES = ['warn-and-continue', 'block-tool', 'block-session'];
/** 默认 block-tool：咨询失败与 blocked 裁决只拒绝当前一次调用，不封锁会话（偏离 pi 0.8.2 的 block-session，记 C-017；废弃 C-008 ② 该项裁定）. */
export const DEFAULT_FAILURE_MODE = 'block-tool';
/** 咨询呈现形态（R-02-007；C-020）：subagent = one-shot 顾问子会话（会话界面可见）；direct = llm.stream 直调（无子会话条目）. */
export const PRESENTATION_MODES = ['subagent', 'direct'];
/** presentation 缺省 subagent：东家可见性诉求为默认承诺（C-020）. */
export const DEFAULT_PRESENTATION = 'subagent';

/** 守则三门（软约束，布尔开关）与硬门（循环门）的键位表。 */
const GUIDELINE_GATE_KINDS = ['plan', 'failure', 'completion'];
const HARD_GATE_KINDS = ['loop'];

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

/** 可选正整数：缺省 = undefined（跟随宿主，如 advisor.maxTokens；C-015）。 */
function parseOptionalPositiveInt() {
    return (value) => {
        if (value === undefined || value === null) {
            return { ok: true, value: undefined };
        }
        return typeof value === 'number' && Number.isInteger(value) && value > 0
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

/** 偏好区来源（可选非空字符串；缺省=无偏好区，R-02-006/AC-05）。 */
function parseOptionalStringField(value) {
    if (value === undefined) {
        return { ok: true, value: undefined };
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
        return { ok: false, value: undefined };
    }
    return { ok: true, value };
}

function parseNonEmptyString(value) {
    if (value === undefined || value === null) {
        return { ok: true, value: undefined };
    }
    return typeof value === 'string' && value.length > 0 ? { ok: true, value } : { ok: false };
}

/** 门阈值下界为 2（pi advisorLoopThreshold ≥2；R-02-001/AC-05）. */
function parseGateThreshold(fallback) {
    return (value) => {
        if (value === undefined || value === null) {
            return { ok: true, value: fallback };
        }
        return typeof value === 'number' && Number.isInteger(value) && value >= 2
            ? { ok: true, value }
            : { ok: false };
    };
}

/** 仓库上下文档位（pi gitContext 语义：off|summary|full；旧值 none/patch 警告回落默认）. */
function parseRepoContext(fallback) {
    return (value) => {
        if (value === undefined || value === null) {
            return { ok: true, value: fallback };
        }
        if (value === 'none' || value === 'patch') {
            return { ok: true, value: fallback, warning: `旧值 ${value} 已回落为默认 ${fallback}` };
        }
        return ['off', 'summary', 'full'].includes(value)
            ? { ok: true, value }
            : { ok: false };
    };
}

/** 非空字符串数组（模型白名单）. */
function parseStringArray(fallback) {
    return (value) => {
        if (value === undefined || value === null) {
            return { ok: true, value: fallback };
        }
        return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)
            ? { ok: true, value }
            : { ok: false };
    };
}

/** per-tool 披露策略：工具名 → full|summary|exclude（C-008 ⑥）. */
function parseToolPolicies(fallback) {
    return (value) => {
        if (value === undefined || value === null) {
            return { ok: true, value: fallback };
        }
        if (!isRecord(value)) {
            return { ok: false };
        }
        const out = {};
        for (const [tool, policy] of Object.entries(value)) {
            if (!isPlainKey(tool) || !['full', 'summary', 'exclude'].includes(policy)) {
                return { ok: false };
            }
            out[tool] = policy;
        }
        return { ok: true, value: out };
    };
}

/** 缺省=不限的预算（pi maxCallsPerSession undefined 语义；0 亦不限）. */
function parseOptionalNonNegativeInt() {
    return (value) => {
        if (value === undefined || value === null) {
            return { ok: true, value: undefined };
        }
        return typeof value === 'number' && Number.isInteger(value) && value >= 0
            ? { ok: true, value }
            : { ok: false };
    };
}

/** Field spec tables per section (SOLUTION.md#产品契约 naming). */
const ADVISOR_FIELDS = [
    { key: 'provider', parse: parseNonEmptyString, message: '必须为非空字符串' },
    { key: 'model', parse: parseNonEmptyString, message: '必须为非空字符串' },
    { key: 'reasoningEffort', parse: parseNonEmptyString, message: '必须为非空字符串' },
    { key: 'maxTokens', parse: parseOptionalPositiveInt(), message: '必须为正整数或缺省（缺省 = 跟随宿主模型配置）' },
    { key: 'callTimeoutMs', parse: parsePositiveInt(DEFAULT_CALL_TIMEOUT_MS), message: '必须为正整数' },
];
const PRIVACY_FIELDS = [
    { key: 'repoContext', parse: parseRepoContext('summary'), message: '必须为 off|summary|full 之一' },
    { key: 'toolResultMaxBytes', parse: parsePositiveInt(DEFAULT_TOOL_RESULT_MAX_BYTES), message: '必须为正整数' },
    { key: 'fileContent', parse: parseBool(false), message: '必须为布尔值' },
    { key: 'untrackedContent', parse: parseBool(false), message: '必须为布尔值' },
    { key: 'trackedFileContent', parse: parseBool(false), message: '必须为布尔值' },
    { key: 'redactSecrets', parse: parseBool(false), message: '必须为布尔值' },
];
const BUDGET_FIELDS = [
    { key: 'maxPerSession', parse: parseOptionalNonNegativeInt(), message: '必须为非负整数（缺省 = 不限；0 = 立即耗尽，对齐 pi）' },
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
        if (result.warning) {
            warnings.push(`${path}.${field.key}: ${result.warning}`);
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
        failureMode: DEFAULT_FAILURE_MODE,
        presentation: DEFAULT_PRESENTATION,
        contextMaxChars: DEFAULT_CONTEXT_MAX_CHARS,
        gitContextMaxChars: DEFAULT_GIT_CONTEXT_MAX_CHARS,
        customInvocation: undefined,
        modelWhitelist: [],
        blockOnBlocked: true,
        toolPolicies: {},
        outcomeLogging: false,
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

    // --- 标量顶层键（对齐 pi；C-008 ⑥⑦ 与 R-02-006 素材预算） -------------
    for (const [key, parse, message] of [
        ['contextMaxChars', parsePositiveInt(DEFAULT_CONTEXT_MAX_CHARS), '必须为正整数'],
        ['gitContextMaxChars', parsePositiveInt(DEFAULT_GIT_CONTEXT_MAX_CHARS), '必须为正整数'],
        ['customInvocation', parseNonEmptyString, '必须为非空字符串'],
        ['modelWhitelist', parseStringArray([]), '必须为非空字符串数组'],
        ['blockOnBlocked', parseBool(true), '必须为布尔值'],
        ['toolPolicies', parseToolPolicies({}), '必须为 {工具名: full|summary|exclude} 映射'],
        ['outcomeLogging', parseBool(false), '必须为布尔值'],
        ['toolResultMaxLines', parseOptionalNonNegativeInt(), '必须为非负整数（缺省 = pi 宿主默认）'],
        ['userPreferences', parseOptionalStringField, '必须为非空字符串或缺省'],
    ]) {
        const result = parse(raw[key]);
        if (!result.ok) {
            errors.push(`${key} ${message}`);
            continue;
        }
        if (result.warning) {
            warnings.push(`${key}: ${result.warning}`);
        }
        config[key] = result.value;
    }

    // --- scout: 策展开关与时限（T-014） --------------------------------------
    const scout = raw.scout;
    if (scout !== undefined && !isRecord(scout)) {
        errors.push('scout 必须为对象');
    } else {
        const scoutFields = [
            { key: 'enabled', parse: parseBool(false), message: '必须为布尔值' },
            { key: 'timeoutMs', parse: parseOptionalNonNegativeInt(), message: '必须为非负整数（缺省 = 不限）' },
        ];
        const parsedScout = parseSection(scout ?? {}, 'scout', scoutFields, errors, warnings);
        if (parsedScout.enabled === true) {
            config.scout = parsedScout;
        }
    }

    // --- gates: 守则三门为布尔开关；循环门含阈值 ----------------------------
    const gates = raw.gates;
    if (gates !== undefined && !isRecord(gates)) {
        errors.push('gates 必须为对象');
    } else {
        for (const kind of [...GUIDELINE_GATE_KINDS, ...HARD_GATE_KINDS]) {
            const fields = [
                { key: 'enabled', parse: parseBool(true), message: '必须为布尔值' },
                ...(['loop'].includes(kind)
                    ? [{ key: 'threshold', parse: parseGateThreshold(DEFAULT_GATE_THRESHOLD), message: '必须为不小于 2 的正整数' }]
                    : []),
            ];
            const gateRaw = gates?.[kind];
            if (gateRaw !== undefined && !isRecord(gateRaw)) {
                errors.push(`gates.${kind} 必须为对象`);
                continue;
            }
            config.gates[kind] = parseSection(gateRaw ?? {}, `gates.${kind}`, fields, errors, warnings);
        }
        const knownGates = new Set([...GUIDELINE_GATE_KINDS, ...HARD_GATE_KINDS]);
        for (const key of Object.keys(gates ?? {})) {
            if (!knownGates.has(key) && isPlainKey(key)) {
                warnings.push(`gates.${key}`);
                config.gates[key] = gates[key];
            }
        }
    }

    // --- failureMode（阻断模式，全局统一处置档位） --------------------------
    const failureMode = parseEnum(FAILURE_MODES, DEFAULT_FAILURE_MODE)(raw.failureMode);
    if (!failureMode.ok) {
        errors.push(`failureMode 必须为 ${FAILURE_MODES.join('|')} 之一`);
    } else {
        config.failureMode = failureMode.value;
    }

    // --- presentation（咨询呈现形态，R-02-007） ------------------------------
    const presentation = parseEnum(PRESENTATION_MODES, DEFAULT_PRESENTATION)(raw.presentation);
    if (!presentation.ok) {
        errors.push(`presentation 必须为 ${PRESENTATION_MODES.join('|')} 之一`);
    } else {
        config.presentation = presentation.value;
    }

    // --- unknown top-level keys: warn + passthrough ------------------------
    const KNOWN = [
        'enabled',
        'advisor',
        'gates',
        'privacy',
        'budget',
        'failureMode',
        'presentation',
        'contextMaxChars',
        'gitContextMaxChars',
        'customInvocation',
        'modelWhitelist',
        'blockOnBlocked',
        'toolPolicies',
        'outcomeLogging',
        'scout',
        'userPreferences',
    ];
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
