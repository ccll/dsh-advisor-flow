window.__ModuleLoader__.load({ id: "dsh-advisor-flow", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// lib/client/index.js
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  createSettingsCardController: () => createSettingsCardController,
  default: () => index_default,
  inject: () => inject,
  name: () => name,
  renderSettingsCard: () => renderSettingsCard
});
module.exports = __toCommonJS(index_exports);

// lib/util.js
var isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
var CONSULTATION_ENTRIES = Object.freeze(["tool", "manual", "gate", "turn-review"]);

// lib/config.js
var DEFAULT_CALL_TIMEOUT_MS = 6e5;
var DEFAULT_TOOL_RESULT_MAX_BYTES = 8192;
var DEFAULT_CONTEXT_MAX_CHARS = 15e3;
var DEFAULT_GIT_CONTEXT_MAX_CHARS = 2e4;
var DEFAULT_GATE_THRESHOLD = 3;
var FAILURE_MODES = ["warn-and-continue", "block-tool", "block-session"];
var DEFAULT_FAILURE_MODE = "block-tool";
var PRESENTATION_MODES = ["subagent", "direct"];
var DEFAULT_PRESENTATION = "subagent";
var INTERVENTION_MODES = ["soft", "hard"];
var DEFAULT_INTERVENTION_MODE = "soft";
var DEFAULT_TURN_REVIEW_EXEMPT_PATTERNS = ["review", "\u5BA1\u6838", "\u5BA1\u67E5", "\u8BC4\u5BA1", "\u590D\u5BA1", "\u5BA1\u8BA1"];
var GUIDELINE_GATE_KINDS = ["plan", "failure", "completion"];
var HARD_GATE_KINDS = ["loop"];
var isPlainKey = (value) => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
function parsePositiveInt(fallback) {
  return (value) => {
    if (value === void 0 || value === null) {
      return { ok: true, value: fallback };
    }
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? { ok: true, value } : { ok: false };
  };
}
function parseOptionalPositiveInt() {
  return (value) => {
    if (value === void 0 || value === null) {
      return { ok: true, value: void 0 };
    }
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? { ok: true, value } : { ok: false };
  };
}
function parseEnum(allowed, fallback) {
  return (value) => {
    if (value === void 0 || value === null) {
      return { ok: true, value: fallback };
    }
    return typeof value === "string" && allowed.includes(value) ? { ok: true, value } : { ok: false };
  };
}
function parseBool(fallback) {
  return (value) => {
    if (value === void 0 || value === null) {
      return { ok: true, value: fallback };
    }
    return typeof value === "boolean" ? { ok: true, value } : { ok: false };
  };
}
function parseOptionalStringField(value) {
  if (value === void 0) {
    return { ok: true, value: void 0 };
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, value: void 0 };
  }
  return { ok: true, value };
}
function parseNonEmptyString(value) {
  if (value === void 0 || value === null) {
    return { ok: true, value: void 0 };
  }
  return typeof value === "string" && value.length > 0 ? { ok: true, value } : { ok: false };
}
function parseGateThreshold(fallback) {
  return (value) => {
    if (value === void 0 || value === null) {
      return { ok: true, value: fallback };
    }
    return typeof value === "number" && Number.isInteger(value) && value >= 2 ? { ok: true, value } : { ok: false };
  };
}
function parseRepoContext(fallback) {
  return (value) => {
    if (value === void 0 || value === null) {
      return { ok: true, value: fallback };
    }
    if (value === "none" || value === "patch") {
      return { ok: true, value: fallback, warning: `\u65E7\u503C ${value} \u5DF2\u56DE\u843D\u4E3A\u9ED8\u8BA4 ${fallback}` };
    }
    return ["off", "summary", "full"].includes(value) ? { ok: true, value } : { ok: false };
  };
}
function parseStringArray(fallback) {
  return (value) => {
    if (value === void 0 || value === null) {
      return { ok: true, value: fallback };
    }
    return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0) ? { ok: true, value } : { ok: false };
  };
}
function parseToolPolicies(fallback) {
  return (value) => {
    if (value === void 0 || value === null) {
      return { ok: true, value: fallback };
    }
    if (!isRecord(value)) {
      return { ok: false };
    }
    const out = {};
    for (const [tool, policy] of Object.entries(value)) {
      if (!isPlainKey(tool) || !["full", "summary", "exclude"].includes(policy)) {
        return { ok: false };
      }
      out[tool] = policy;
    }
    return { ok: true, value: out };
  };
}
function parseOptionalNonNegativeInt() {
  return (value) => {
    if (value === void 0 || value === null) {
      return { ok: true, value: void 0 };
    }
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? { ok: true, value } : { ok: false };
  };
}
var ADVISOR_FIELDS = [
  { key: "provider", parse: parseNonEmptyString, message: "\u5FC5\u987B\u4E3A\u975E\u7A7A\u5B57\u7B26\u4E32" },
  { key: "model", parse: parseNonEmptyString, message: "\u5FC5\u987B\u4E3A\u975E\u7A7A\u5B57\u7B26\u4E32" },
  { key: "reasoningEffort", parse: parseNonEmptyString, message: "\u5FC5\u987B\u4E3A\u975E\u7A7A\u5B57\u7B26\u4E32" },
  { key: "maxTokens", parse: parseOptionalPositiveInt(), message: "\u5FC5\u987B\u4E3A\u6B63\u6574\u6570\u6216\u7F3A\u7701\uFF08\u7F3A\u7701 = \u8DDF\u968F\u5BBF\u4E3B\u6A21\u578B\u914D\u7F6E\uFF09" },
  { key: "callTimeoutMs", parse: parsePositiveInt(DEFAULT_CALL_TIMEOUT_MS), message: "\u5FC5\u987B\u4E3A\u6B63\u6574\u6570" }
];
var PRIVACY_FIELDS = [
  { key: "repoContext", parse: parseRepoContext("summary"), message: "\u5FC5\u987B\u4E3A off|summary|full \u4E4B\u4E00" },
  { key: "toolResultMaxBytes", parse: parsePositiveInt(DEFAULT_TOOL_RESULT_MAX_BYTES), message: "\u5FC5\u987B\u4E3A\u6B63\u6574\u6570" },
  { key: "fileContent", parse: parseBool(false), message: "\u5FC5\u987B\u4E3A\u5E03\u5C14\u503C" },
  { key: "untrackedContent", parse: parseBool(false), message: "\u5FC5\u987B\u4E3A\u5E03\u5C14\u503C" },
  { key: "trackedFileContent", parse: parseBool(false), message: "\u5FC5\u987B\u4E3A\u5E03\u5C14\u503C" },
  { key: "redactSecrets", parse: parseBool(false), message: "\u5FC5\u987B\u4E3A\u5E03\u5C14\u503C" }
];
var BUDGET_FIELDS = [
  { key: "maxPerSession", parse: parseOptionalNonNegativeInt(), message: "\u5FC5\u987B\u4E3A\u975E\u8D1F\u6574\u6570\uFF08\u7F3A\u7701 = \u4E0D\u9650\uFF1B0 = \u7ACB\u5373\u8017\u5C3D\uFF0C\u5BF9\u9F50 pi\uFF09" }
];
function parseSection(section, path, fields, errors, warnings) {
  const out = {};
  const known = new Set(fields.map((field2) => field2.key));
  for (const field2 of fields) {
    const result = field2.parse(section[field2.key]);
    if (!result.ok) {
      errors.push(`${path}.${field2.key} ${field2.message}`);
      continue;
    }
    if (result.warning) {
      warnings.push(`${path}.${field2.key}: ${result.warning}`);
    }
    out[field2.key] = result.value;
  }
  for (const key of Object.keys(section)) {
    if (!known.has(key) && isPlainKey(key)) {
      warnings.push(`${path}.${key}`);
      out[key] = section[key];
    }
  }
  return out;
}
var SAVE_NOTICE_PERSISTED = "\u5DF2\u4FDD\u5B58\u5E76\u6301\u4E45\u5316\u3002";
function resolveAdvisorFlowConfig(raw) {
  const warnings = [];
  if (raw === void 0 || raw === null) {
    raw = {};
  }
  if (!isRecord(raw)) {
    return { ok: false, error: "advisor-flow \u914D\u7F6E\u5FC5\u987B\u4E3A\u5BF9\u8C61", warnings };
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
    mode: DEFAULT_INTERVENTION_MODE,
    turnReviewExemptPatterns: DEFAULT_TURN_REVIEW_EXEMPT_PATTERNS,
    contextMaxChars: DEFAULT_CONTEXT_MAX_CHARS,
    gitContextMaxChars: DEFAULT_GIT_CONTEXT_MAX_CHARS,
    customInvocation: void 0,
    modelWhitelist: [],
    blockOnBlocked: true,
    toolPolicies: {},
    outcomeLogging: false
  };
  if (raw.enabled !== void 0) {
    warnings.push("enabled: \u5DF2\u5F03\u7528\u2014\u2014\u542F\u7528\u72B6\u6001\u7531 advisor.provider/model \u6D3E\u751F\uFF0C\u672C\u952E\u5C06\u88AB\u5FFD\u7565\uFF1B\u505C\u7528\u8BF7\u8D70\u5BBF\u4E3B\u63D2\u4EF6\u5F00\u5173");
  }
  for (const [key, fields] of [
    ["advisor", ADVISOR_FIELDS],
    ["privacy", PRIVACY_FIELDS],
    ["budget", BUDGET_FIELDS]
  ]) {
    const section = raw[key];
    if (section !== void 0 && !isRecord(section)) {
      errors.push(`${key} \u5FC5\u987B\u4E3A\u5BF9\u8C61`);
      continue;
    }
    config[key] = parseSection(section != null ? section : {}, key, fields, errors, warnings);
  }
  for (const [key, parse, message] of [
    ["contextMaxChars", parsePositiveInt(DEFAULT_CONTEXT_MAX_CHARS), "\u5FC5\u987B\u4E3A\u6B63\u6574\u6570"],
    ["gitContextMaxChars", parsePositiveInt(DEFAULT_GIT_CONTEXT_MAX_CHARS), "\u5FC5\u987B\u4E3A\u6B63\u6574\u6570"],
    ["customInvocation", parseNonEmptyString, "\u5FC5\u987B\u4E3A\u975E\u7A7A\u5B57\u7B26\u4E32"],
    ["modelWhitelist", parseStringArray([]), "\u5FC5\u987B\u4E3A\u975E\u7A7A\u5B57\u7B26\u4E32\u6570\u7EC4"],
    ["turnReviewExemptPatterns", parseStringArray(DEFAULT_TURN_REVIEW_EXEMPT_PATTERNS), "\u5FC5\u987B\u4E3A\u975E\u7A7A\u5B57\u7B26\u4E32\u6570\u7EC4\uFF08\u7A7A\u6570\u7EC4 = \u8C41\u514D\u5173\u95ED\uFF09"],
    ["blockOnBlocked", parseBool(true), "\u5FC5\u987B\u4E3A\u5E03\u5C14\u503C"],
    ["toolPolicies", parseToolPolicies({}), "\u5FC5\u987B\u4E3A {\u5DE5\u5177\u540D: full|summary|exclude} \u6620\u5C04"],
    ["outcomeLogging", parseBool(false), "\u5FC5\u987B\u4E3A\u5E03\u5C14\u503C"],
    ["toolResultMaxLines", parseOptionalNonNegativeInt(), "\u5FC5\u987B\u4E3A\u975E\u8D1F\u6574\u6570\uFF08\u7F3A\u7701 = pi \u5BBF\u4E3B\u9ED8\u8BA4\uFF09"],
    ["userPreferences", parseOptionalStringField, "\u5FC5\u987B\u4E3A\u975E\u7A7A\u5B57\u7B26\u4E32\u6216\u7F3A\u7701"]
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
  const scout = raw.scout;
  if (scout !== void 0 && !isRecord(scout)) {
    errors.push("scout \u5FC5\u987B\u4E3A\u5BF9\u8C61");
  } else {
    const scoutFields = [
      { key: "enabled", parse: parseBool(false), message: "\u5FC5\u987B\u4E3A\u5E03\u5C14\u503C" },
      { key: "timeoutMs", parse: parseOptionalNonNegativeInt(), message: "\u5FC5\u987B\u4E3A\u975E\u8D1F\u6574\u6570\uFF08\u7F3A\u7701 = \u4E0D\u9650\uFF09" }
    ];
    const parsedScout = parseSection(scout != null ? scout : {}, "scout", scoutFields, errors, warnings);
    if (parsedScout.enabled === true) {
      config.scout = parsedScout;
    }
  }
  const gates = raw.gates;
  if (gates !== void 0 && !isRecord(gates)) {
    errors.push("gates \u5FC5\u987B\u4E3A\u5BF9\u8C61");
  } else {
    for (const kind of [...GUIDELINE_GATE_KINDS, ...HARD_GATE_KINDS]) {
      const fields = [
        { key: "enabled", parse: parseBool(true), message: "\u5FC5\u987B\u4E3A\u5E03\u5C14\u503C" },
        ...["loop"].includes(kind) ? [{ key: "threshold", parse: parseGateThreshold(DEFAULT_GATE_THRESHOLD), message: "\u5FC5\u987B\u4E3A\u4E0D\u5C0F\u4E8E 2 \u7684\u6B63\u6574\u6570" }] : []
      ];
      const gateRaw = gates == null ? void 0 : gates[kind];
      if (gateRaw !== void 0 && !isRecord(gateRaw)) {
        errors.push(`gates.${kind} \u5FC5\u987B\u4E3A\u5BF9\u8C61`);
        continue;
      }
      config.gates[kind] = parseSection(gateRaw != null ? gateRaw : {}, `gates.${kind}`, fields, errors, warnings);
    }
    const knownGates = /* @__PURE__ */ new Set([...GUIDELINE_GATE_KINDS, ...HARD_GATE_KINDS]);
    for (const key of Object.keys(gates != null ? gates : {})) {
      if (!knownGates.has(key) && isPlainKey(key)) {
        warnings.push(`gates.${key}`);
        config.gates[key] = gates[key];
      }
    }
  }
  const failureMode = parseEnum(FAILURE_MODES, DEFAULT_FAILURE_MODE)(raw.failureMode);
  if (!failureMode.ok) {
    errors.push(`failureMode \u5FC5\u987B\u4E3A ${FAILURE_MODES.join("|")} \u4E4B\u4E00`);
  } else {
    config.failureMode = failureMode.value;
  }
  const presentation = parseEnum(PRESENTATION_MODES, DEFAULT_PRESENTATION)(raw.presentation);
  if (!presentation.ok) {
    errors.push(`presentation \u5FC5\u987B\u4E3A ${PRESENTATION_MODES.join("|")} \u4E4B\u4E00`);
  } else {
    config.presentation = presentation.value;
  }
  const mode = parseEnum(INTERVENTION_MODES, DEFAULT_INTERVENTION_MODE)(raw.mode);
  if (!mode.ok) {
    errors.push(`mode \u5FC5\u987B\u4E3A ${INTERVENTION_MODES.join("|")} \u4E4B\u4E00`);
  } else {
    config.mode = mode.value;
  }
  const KNOWN = [
    "enabled",
    "advisor",
    "gates",
    "privacy",
    "budget",
    "failureMode",
    "presentation",
    "mode",
    "turnReviewExemptPatterns",
    "contextMaxChars",
    "gitContextMaxChars",
    "customInvocation",
    "modelWhitelist",
    "blockOnBlocked",
    "toolPolicies",
    "outcomeLogging",
    "scout",
    "userPreferences"
  ];
  for (const key of Object.keys(raw)) {
    if (!KNOWN.includes(key) && isPlainKey(key)) {
      warnings.push(key);
      config.unknown[key] = raw[key];
    }
  }
  if (errors.length > 0) {
    return { ok: false, error: errors.join("\uFF1B"), warnings };
  }
  config.enabled = Boolean(config.advisor.provider && config.advisor.model);
  if (!config.enabled) {
    config.reason = "missing-advisor-model";
  }
  return { ok: true, config, warnings };
}

// lib/gateway.js
function mergeAdvisorFlowConfig(base, patch) {
  const merged = { ...isRecord(base) ? base : {} };
  for (const key of Object.keys(patch)) {
    const incoming = patch[key];
    const current = merged[key];
    if (isRecord(incoming) && isRecord(current)) {
      const section = { ...current };
      for (const sub of Object.keys(incoming)) {
        if (key === "gates" && isRecord(incoming[sub]) && isRecord(current[sub])) {
          section[sub] = { ...current[sub], ...incoming[sub] };
        } else {
          section[sub] = incoming[sub];
        }
      }
      merged[key] = section;
    } else {
      merged[key] = incoming;
    }
  }
  return merged;
}

// lib/client/card-state.js
function flattenPatchToOps(patch) {
  const ops = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      ops.push({ op: "set", path, value: node });
      return;
    }
    if (isRecord(node)) {
      for (const [key, value] of Object.entries(node)) {
        walk(value, [...path, key]);
      }
      return;
    }
    ops.push({ op: "set", path, value: node });
  };
  if (isRecord(patch)) {
    for (const [key, value] of Object.entries(patch)) {
      walk(value, [key]);
    }
  }
  return ops;
}
function createSettingsCardController({ form, rpc, logger = console } = {}) {
  const state = {
    status: "idle",
    // idle | ready | error
    config: {},
    // raw namespace（未过解析器的可编辑真相；派生值走 deriveEnabled）
    error: void 0,
    patch: {},
    // uncommitted edits
    saving: false,
    savedNotice: void 0,
    writable: true,
    // 宿主表单只读位（describe 镜像；false 时保存钮禁用）
    // 模型目录（llm/listProviders + session/modelCatalog 实测契约）：
    // provider/model/effort 三级联动下拉的数据源；拉取失败回退手动输入。
    providers: [],
    catalogGroups: [],
    catalogReady: false,
    catalogDegraded: false,
    // 所选模型的宿主声明 limits（T-034 modelInfo RPC）：`${provider}\u0000${model}`
    // → defaultMaxTokens|undefined（含负缓存）；limitsDegraded = 通道一次性降级。
    modelLimits: {},
    limitsDegraded: false
  };
  const listeners = /* @__PURE__ */ new Set();
  let loadStarted = false;
  const limitsInflight = /* @__PURE__ */ new Set();
  let disposed = false;
  let unsubscribeForm;
  function emit() {
    for (const listener of [...listeners]) {
      listener();
    }
  }
  function effectiveConfig() {
    return mergeAdvisorFlowConfig(state.config, state.patch);
  }
  function deriveEnabled() {
    var _a;
    if (state.status !== "ready") {
      return void 0;
    }
    const resolved = resolveAdvisorFlowConfig(effectiveConfig());
    if (!resolved.ok) {
      return void 0;
    }
    return {
      enabled: resolved.config.enabled,
      disabledReason: resolved.config.enabled ? void 0 : (_a = resolved.config.reason) != null ? _a : "missing-advisor-model"
    };
  }
  function displayConfig() {
    if (state.status !== "ready") {
      return void 0;
    }
    const merged = effectiveConfig();
    const resolved = resolveAdvisorFlowConfig(merged);
    return resolved.ok ? resolved.config : merged;
  }
  async function unwrap(envelope) {
    var _a, _b, _c;
    if (!isRecord(envelope) || envelope.ok !== true) {
      const message = (_b = (_a = envelope == null ? void 0 : envelope.error) == null ? void 0 : _a.message) != null ? _b : "\u914D\u7F6E\u901A\u9053\u8FD4\u56DE\u5F02\u5E38";
      return { ok: false, value: void 0, message, code: (_c = envelope == null ? void 0 : envelope.error) == null ? void 0 : _c.code };
    }
    return { ok: true, value: envelope.value, message: void 0 };
  }
  function deriveFromForm() {
    var _a;
    try {
      const snapshot = typeof (form == null ? void 0 : form.getSnapshot) === "function" ? form.getSnapshot() : {};
      if (snapshot.status === "ready" && isRecord(snapshot.value)) {
        state.config = structuredClone(snapshot.value);
        state.status = "ready";
        state.error = void 0;
      } else if (snapshot.status === "unavailable") {
        state.status = "error";
        state.error = "\u914D\u7F6E\u670D\u52A1\u4E0D\u53EF\u7528\uFF0C\u7A0D\u540E\u81EA\u52A8\u91CD\u8BD5";
      } else if (state.status !== "ready") {
        state.status = "idle";
      }
      state.writable = snapshot.writable !== false;
    } catch (error) {
      (_a = logger.warn) == null ? void 0 : _a.call(logger, `advisor-flow client: \u914D\u7F6E\u5FEB\u7167\u6D3E\u751F\u5F02\u5E38\u2014\u2014\u4FDD\u6301\u73B0\u6709\u89C6\u56FE: ${String(error)}`);
    }
    maybeLoadModelLimits();
    emit();
  }
  async function loadCatalogs() {
    var _a;
    try {
      const [providersEnv, catalogEnv] = await Promise.all([
        rpc.call("/api", "llm/listProviders", { args: {} }),
        rpc.call("/api", "session/modelCatalog", { args: {} })
      ]);
      const providers = await unwrap(providersEnv);
      const catalog = await unwrap(catalogEnv);
      const providerList = Array.isArray(providers.value) ? providers.value : [];
      const groups = isRecord(catalog.value) && Array.isArray(catalog.value.groups) ? catalog.value.groups : [];
      if (providers.ok && providerList.length > 0 && catalog.ok && groups.length > 0) {
        state.providers = providerList.filter((entry) => isRecord(entry) && typeof entry.id === "string");
        state.catalogGroups = groups.filter((entry) => isRecord(entry) && typeof entry.id === "string");
        state.catalogReady = state.providers.length > 0 && state.catalogGroups.length > 0;
      }
      if (!state.catalogReady) {
        markCatalogDegraded();
      }
    } catch (error) {
      markCatalogDegraded();
      (_a = logger.warn) == null ? void 0 : _a.call(logger, `advisor-flow client: \u6A21\u578B\u76EE\u5F55\u62C9\u53D6\u5F02\u5E38\u2014\u2014\u56DE\u9000\u624B\u52A8\u8F93\u5165: ${String(error)}`);
    }
    emit();
  }
  function markCatalogDegraded() {
    var _a;
    if (state.catalogDegraded) {
      return;
    }
    state.catalogDegraded = true;
    state.degradations = { ...isRecord(state.degradations) ? state.degradations : {}, catalog: "catalog-fetch-failed" };
    (_a = logger.warn) == null ? void 0 : _a.call(logger, "advisor-flow client: \u6A21\u578B\u76EE\u5F55\u62C9\u53D6\u5931\u8D25\u2014\u2014provider/model/effort \u56DE\u9000\u624B\u52A8\u8F93\u5165\uFF08catalog-fetch-failed\uFF09");
  }
  function providerOptions() {
    var _a;
    if (!state.catalogReady) {
      return void 0;
    }
    const options = state.providers.map((entry) => {
      var _a2;
      return { value: entry.id, label: (_a2 = entry.name) != null ? _a2 : entry.id };
    });
    const current = (_a = effectiveConfig().advisor) == null ? void 0 : _a.provider;
    if (current && !options.some((option) => option.value === current)) {
      options.push({ value: current, label: `${current}\uFF08\u5F53\u524D\u503C\uFF0C\u76EE\u5F55\u5916\uFF09` });
    }
    return options;
  }
  function modelsFor(providerId, { keepCurrent = true } = {}) {
    var _a, _b;
    if (!state.catalogReady) {
      return void 0;
    }
    const group = state.catalogGroups.find((entry) => entry.id === providerId);
    const models = ((_a = group == null ? void 0 : group.models) != null ? _a : []).filter((model) => isRecord(model) && typeof model.id === "string").map((model) => {
      var _a2;
      return { value: model.id, label: (_a2 = model.name) != null ? _a2 : model.id };
    });
    const current = (_b = effectiveConfig().advisor) == null ? void 0 : _b.model;
    if (keepCurrent && current && !models.some((option) => option.value === current)) {
      models.push({ value: current, label: `${current}\uFF08\u5F53\u524D\u503C\uFF0C\u76EE\u5F55\u5916\uFF09` });
    }
    if (models.length === 0) {
      models.push({ value: "", label: "\u2014 \u9009\u62E9\u6A21\u578B \u2014" });
    }
    return models;
  }
  function effortOptions(modelId) {
    var _a, _b, _c, _d;
    if (!state.catalogReady) {
      return void 0;
    }
    const model = state.catalogGroups.flatMap((group) => {
      var _a2;
      return (_a2 = group.models) != null ? _a2 : [];
    }).find((model2) => isRecord(model2) && model2.id === modelId);
    const defaultEffort = (_a = model == null ? void 0 : model.reasoning) == null ? void 0 : _a.defaultEffort;
    const options = [{
      value: "",
      label: defaultEffort ? `\u8DDF\u968F\u6A21\u578B\u9ED8\u8BA4\uFF08default: ${defaultEffort}\uFF09` : "\u8DDF\u968F\u6A21\u578B\u9ED8\u8BA4"
    }];
    for (const effort of (_c = (_b = model == null ? void 0 : model.reasoning) == null ? void 0 : _b.efforts) != null ? _c : []) {
      if (isRecord(effort) && typeof effort.id === "string") {
        options.push({ value: effort.id, label: (_d = effort.name) != null ? _d : effort.id });
      }
    }
    return options;
  }
  function modelMaxTokens(providerId, modelId) {
    if (typeof providerId !== "string" || !providerId || typeof modelId !== "string" || !modelId) {
      return void 0;
    }
    const value = state.modelLimits[`${providerId}\0${modelId}`];
    return Number.isInteger(value) && value > 0 ? value : void 0;
  }
  function maybeLoadModelLimits() {
    var _a;
    if (state.status !== "ready" || state.limitsDegraded || typeof (rpc == null ? void 0 : rpc.call) !== "function") {
      return;
    }
    const advisor = (_a = effectiveConfig().advisor) != null ? _a : {};
    const provider = advisor.provider;
    const model = advisor.model;
    if (typeof provider !== "string" || !provider || typeof model !== "string" || !model) {
      return;
    }
    const key = `${provider}\0${model}`;
    if (key in state.modelLimits || limitsInflight.has(key)) {
      return;
    }
    limitsInflight.add(key);
    const degrade = () => {
      var _a2;
      limitsInflight.delete(key);
      if (disposed) {
        return;
      }
      state.limitsDegraded = true;
      (_a2 = logger.warn) == null ? void 0 : _a2.call(logger, "advisor-flow client: modelInfo \u901A\u9053\u4E0D\u53EF\u7528\u2014\u2014maxTokens \u5360\u4F4D\u56DE\u9000\u539F\u6587\uFF08model-info-unavailable\uFF09");
      emit();
    };
    rpc.call("/api", "advisor-flow/modelInfo", { args: { provider, model } }).then((envelope) => unwrap(envelope)).then((unwrapped) => {
      var _a2;
      limitsInflight.delete(key);
      if (disposed) {
        return;
      }
      if (!unwrapped.ok) {
        degrade();
        return;
      }
      const declared = (_a2 = unwrapped.value) == null ? void 0 : _a2.defaultMaxTokens;
      state.modelLimits[key] = Number.isInteger(declared) && declared > 0 ? declared : void 0;
      emit();
    }).catch(degrade);
  }
  return {
    /** Subscribe to state changes (render framework glue). */
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Derived card view (render framework glue). */
    getState() {
      const derived = deriveEnabled();
      return {
        ...state,
        effectiveConfig: state.status === "ready" ? effectiveConfig() : void 0,
        validationError: state.status === "ready" ? this.validate() : void 0,
        // 派生启用（C-030）：横幅与渲染按此求值，raw 无 enabled 键
        enabled: derived == null ? void 0 : derived.enabled,
        disabledReason: derived == null ? void 0 : derived.disabledReason,
        // 解析后显示配置（T-032）：门开关/介入强度下拉的缺省可见性
        displayConfig: state.status === "ready" ? displayConfig() : void 0,
        // 未保存显性化（R-02-001/AC-10～12，C-024）：与保存按钮的暂
        // 存语义同源——patch 非空即 dirty；不做深比较（改回原值仍算
        // 暂存，与「放弃修改/保存」既有语义一致，避免第二套真值）。
        dirty: state.status === "ready" && Object.keys(state.patch).length > 0
      };
    },
    /** provider 下拉选项；`undefined` = 目录不可用（render 回退自由文本）。 */
    providerOptions,
    /** 所选 provider 的模型下拉选项；`undefined` = 回退自由文本。 */
    modelsFor,
    /** 所选 model 的 effort 下拉选项；`undefined` = 回退硬编码档位。 */
    effortOptions,
    /** 所选模型声明的 maxTokens；`undefined` = 目录不可用或未声明。 */
    modelMaxTokens,
    /**
     * Ensure the host form is loaded and subscribe to its snapshots
     * (describe mirror drives loading/recovery; the catalog fetch stays
     * background so the form renders before the dropdown data lands).
     * 幂等守卫：只订阅一次——render 的 refresh 会重入 load，无守卫
     * 则 refresh→load→derive→emit→refresh 死循环（T-030 实测）。
     */
    load() {
      var _a;
      if (loadStarted || disposed) {
        return;
      }
      loadStarted = true;
      if (form && typeof form.ensure === "function") {
        try {
          form.ensure();
        } catch (error) {
          (_a = logger.warn) == null ? void 0 : _a.call(logger, `advisor-flow client: \u914D\u7F6E\u6E90\u62C9\u53D6\u542F\u52A8\u5931\u8D25\u2014\u2014${String(error)}`);
        }
      }
      if (form && typeof form.subscribe === "function") {
        unsubscribeForm = form.subscribe(deriveFromForm);
      }
      deriveFromForm();
      loadCatalogs();
    },
    /** 解绑宿主快照订阅（控制器被替换时调用；dispose 后 load/retry no-op）。 */
    dispose() {
      var _a;
      if (disposed) {
        return;
      }
      disposed = true;
      if (typeof unsubscribeForm === "function") {
        try {
          unsubscribeForm();
        } catch (error) {
          (_a = logger.warn) == null ? void 0 : _a.call(logger, `advisor-flow client: \u5FEB\u7167\u8BA2\u9605\u89E3\u7ED1\u5F02\u5E38\u2014\u2014${String(error)}`);
        }
      }
      unsubscribeForm = void 0;
    },
    /**
     * 重试：再拉一次宿主快照（ensure + 派生，不重复订阅）。error 态的
     * 「重试」按钮走这里——宿主 describe 镜像恢复后快照经 live 订阅
     * 自动到达，重试只是额外的显式拉取。
     */
    retry() {
      var _a;
      if (disposed) {
        return;
      }
      if (!loadStarted) {
        this.load();
        return;
      }
      if (form && typeof form.ensure === "function") {
        try {
          form.ensure();
        } catch (error) {
          (_a = logger.warn) == null ? void 0 : _a.call(logger, `advisor-flow client: \u914D\u7F6E\u6E90\u91CD\u62C9\u542F\u52A8\u5931\u8D25\u2014\u2014${String(error)}`);
        }
      }
      deriveFromForm();
    },
    /** Stage one dotted-path edit, e.g. `setField('advisor.provider', 'p')`. */
    setField(path, value) {
      var _a;
      if (state.savedNotice) {
        state.savedNotice = void 0;
      }
      const keys = String(path).split(".");
      let section = state.patch;
      for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (!isRecord(section[key])) {
          section[key] = {};
        }
        section = section[key];
      }
      section[keys[keys.length - 1]] = value;
      if (path === "advisor.provider" && state.catalogReady) {
        const models = modelsFor(value, { keepCurrent: false });
        const currentModel = (_a = effectiveConfig().advisor) == null ? void 0 : _a.model;
        if (Array.isArray(models) && currentModel && !models.some((option) => option.value === currentModel)) {
          section.model = null;
          section.reasoningEffort = null;
        }
      }
      maybeLoadModelLimits();
      emit();
    },
    /**
     * Client-side mirror of the host validation (same parser). Returns an
     * error message or `undefined` when the staged patch would save.
     */
    validate() {
      if (state.status !== "ready") {
        return "\u914D\u7F6E\u5C1A\u672A\u52A0\u8F7D";
      }
      const merged = effectiveConfig();
      const resolved = resolveAdvisorFlowConfig(merged);
      if (!resolved.ok) {
        return `\u914D\u7F6E\u65E0\u6548\uFF0C\u65E0\u6CD5\u4FDD\u5B58\uFF1A${resolved.error}`;
      }
      return void 0;
    },
    /** Discard the staged patch (no host write). */
    discard() {
      state.patch = {};
      emit();
    },
    /**
     * Save the staged patch as one atomic `settings.mutate` batch
     * (revision-fenced by the host controller; on rejection the host
     * recovers the snapshot and the staged patch survives for a retry).
     * A client-side validation failure blocks the write entirely.
     * Resolves `{ ok, error? }`, never throws.
     */
    async save() {
      const invalid = this.validate();
      if (invalid) {
        state.error = invalid;
        emit();
        return { ok: false, error: invalid };
      }
      state.saving = true;
      emit();
      try {
        if (Object.keys(state.patch).length === 0) {
          state.saving = false;
          state.error = void 0;
          emit();
          return { ok: true, persisted: false };
        }
        const accepted = await form.mutate(flattenPatchToOps(state.patch));
        state.saving = false;
        if (!accepted) {
          state.error = "\u4FDD\u5B58\u88AB\u5BBF\u4E3B\u62D2\u7EDD\uFF1A\u914D\u7F6E\u53EF\u80FD\u5DF2\u88AB\u5176\u4ED6\u7AEF\u4FEE\u6539\uFF0C\u8BF7\u91CD\u8BD5";
          emit();
          return { ok: false, error: state.error };
        }
        state.error = void 0;
        state.patch = {};
        state.savedNotice = SAVE_NOTICE_PERSISTED;
        emit();
        return { ok: true, persisted: true, notice: state.savedNotice };
      } catch (error) {
        state.error = `\u4FDD\u5B58\u5931\u8D25\uFF1A${String(error)}`;
        state.saving = false;
        emit();
        return { ok: false, error: state.error };
      }
    }
  };
}

// lib/client/render.js
var CARD_TITLE = "Advisor Flow";
var CARD_DESCRIPTION = "\u6BCF\u6B21\u5173\u952E\u52A8\u4F5C\u524D\u7531\u72EC\u7ACB\u987E\u95EE\u6A21\u578B\u8BC4\u5BA1\u5E76\u6CE8\u5165\u5EFA\u8BAE";
var CSS = `
.advisorflow_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.advisorflow_card:hover{border-color:var(--dsw-alias-label-dimmed)}
.advisorflow_header{width:100%;font:inherit;color:inherit;text-align:left;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.advisorflow_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.advisorflow_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.advisorflow_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.advisorflow_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.advisorflow_form{flex-direction:column;gap:12px;padding:12px 0 0;display:flex}
/* \u62E8\u52A8\u5F00\u5173\uFF1A\u5B98\u65B9\u57FA\u5143 Switch \u9010\u9879\u590D\u523B\uFF08button[role=switch] 36\xD720\u3001
   \u9009\u4E2D brand-primary\u3001thumb 16\xD716 translate(16px)\u3001.12s ease\uFF09\u2014\u2014
   \u4E0E\u5BBF\u4E3B Subagent \u5361\u540C\u4E00\u89C6\u89C9\uFF08\u4E1C\u5BB6\u8981\u6C42\u5B8C\u5168\u5BF9\u9F50\uFF09\u3002 */
.advisorflow_switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:10px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer}
.advisorflow_switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.advisorflow_switch:disabled{cursor:default;opacity:.5}
.advisorflow_switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.advisorflow_thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s ease}
.advisorflow_switch[aria-checked=true] .advisorflow_thumb{transform:translate(16px)}
/* toggleRow\uFF1Alabel \u5DE6\u3001\u63A7\u4EF6\u53F3\uFF08\u5BBF\u4E3B Subagent \u5361\u540C\u6B3E\u5E03\u5C40\u884C\uFF09\u3002 */
.advisorflow_toggleRow{justify-content:space-between;align-items:center;gap:16px;display:flex}
.advisorflow_toggleLabel{color:var(--dsw-alias-label-primary);flex:1;min-width:0;font-size:13px;line-height:1.5}
.advisorflow_fieldset{border:none;flex-direction:column;gap:12px;margin:0;padding:0;display:flex}
.advisorflow_legend{color:var(--dsw-alias-label-secondary);font-size:14px;font-weight:600;line-height:20px}
.advisorflow_field{flex-direction:column;gap:6px;display:flex}
.advisorflow_fieldLabel{color:var(--dsw-alias-label-secondary);align-items:center;gap:10px;font-size:12px;font-weight:500;line-height:18px;display:inline-flex}
.advisorflow_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:14px;line-height:22px}
select.advisorflow_input{cursor:pointer}
.advisorflow_input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.advisorflow_input::placeholder{color:var(--dsw-alias-label-dimmed)}
.advisorflow_input:disabled{opacity:.6;cursor:default}
select.advisorflow_selectInput{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-position:right 12px center;background-repeat:no-repeat;background-size:12px 12px;padding-right:32px}
.advisorflow_numberFields{grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;display:grid}
.advisorflow_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
.advisorflow_notice{color:var(--dsw-alias-state-warn-label);margin:12px 0 0;font-size:12px;line-height:18px}
.advisorflow_savedNotice{color:var(--dsw-alias-state-success-primary);margin:12px 0 0;font-size:12px;line-height:18px}
.advisorflow_error{color:var(--dsw-alias-state-error-primary);margin:12px 0 0;font-size:12px;line-height:18px}
.advisorflow_banner{color:var(--dsw-alias-state-warn-label);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;margin:12px 16px 0;padding:10px 12px;font-size:12px;line-height:18px}
.advisorflow_footer{position:sticky;bottom:0;z-index:1;border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;margin:12px -16px 0;padding:12px 16px 12px;display:flex;background:var(--dsw-alias-bg-layer-2);border-radius:0 0 12px 12px}
.advisorflow_discard,.advisorflow_retry,.advisorflow_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.advisorflow_discard,.advisorflow_retry{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.advisorflow_discard:hover:not(:disabled),.advisorflow_retry:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.advisorflow_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.advisorflow_discard:disabled,.advisorflow_retry:disabled,.advisorflow_save:disabled{opacity:.4;cursor:default}
.advisorflow_discard:focus-visible,.advisorflow_retry:focus-visible,.advisorflow_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.advisorflow_dirtyBadge{flex:none;color:var(--dsw-alias-state-warn-label);border:1px solid currentColor;border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px}
`;
var STYLE_TAG_ID = "dsh-advisor-flow/advisor-card.module.css";
function injectStyles(document) {
  if (typeof (document == null ? void 0 : document.querySelector) !== "function" || !(document == null ? void 0 : document.head)) {
    return;
  }
  if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) {
    return;
  }
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-advisor-flow";
  tag.dataset.pluginCss = STYLE_TAG_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}
function applyStickyBottomInset(root, document) {
  const footer = typeof (root == null ? void 0 : root.querySelector) === "function" ? root.querySelector(".advisorflow_footer") : null;
  if (!footer || !footer.style || typeof footer.style.setProperty !== "function") {
    return;
  }
  if (typeof getComputedStyle !== "function") {
    return;
  }
  let node = footer.parentElement;
  while (node && node !== document.documentElement) {
    const style = getComputedStyle(node);
    if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      const inset = Number.parseFloat(style.paddingBottom) || 0;
      footer.style.bottom = inset > 0 ? `${-inset}px` : "0px";
      return;
    }
    node = node.parentElement;
  }
}
function el(document, tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === void 0) {
      continue;
    }
    if (key === "text") {
      node.textContent = value;
    } else if (key === "onChange") {
      node.addEventListener("change", value);
    } else if (key === "onClick") {
      node.addEventListener("click", value);
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child !== void 0 && child !== null) {
      node.appendChild(child);
    }
  }
  return node;
}
function switchControl(document, { id, checked, onChange, label, disabled }) {
  const button = el(document, "button", {
    type: "button",
    role: "switch",
    class: "advisorflow_switch",
    id,
    "aria-checked": checked === true ? "true" : "false",
    "aria-label": label,
    ...disabled ? { disabled: "disabled" } : {},
    onClick: () => {
      if (!disabled) {
        onChange(!(checked === true));
      }
    }
  }, [
    el(document, "span", { class: "advisorflow_thumb" })
  ]);
  if (typeof button.addEventListener === "function") {
    button.addEventListener("mousedown", (event) => event.preventDefault());
  }
  return button;
}
function toggleRow(document, { label, control }) {
  return el(document, "div", { class: "advisorflow_toggleRow" }, [
    el(document, "span", { class: "advisorflow_toggleLabel", text: label }),
    control
  ]);
}
function hintParagraph(document, text) {
  return el(document, "p", { class: "advisorflow_hint", text });
}
function field(document, { id, label, control, hint, warnHint }) {
  return el(document, "div", { class: "advisorflow_field" }, [
    el(document, "label", { class: "advisorflow_fieldLabel", for: id, text: label }),
    control,
    ...hint ? [hintParagraph(document, hint)] : [],
    ...warnHint ? [el(document, "p", { class: "advisorflow_warnHint", text: warnHint })] : []
  ]);
}
function selectControl(document, { id, value, options, onChange, disabled, ariaLabel }) {
  const select = el(document, "select", {
    id,
    class: "advisorflow_input advisorflow_selectInput",
    "aria-label": ariaLabel != null ? ariaLabel : label(),
    ...disabled ? { disabled: "disabled" } : {},
    onChange: (event) => onChange(event.target.value)
  });
  function label() {
    return ariaLabel != null ? ariaLabel : id;
  }
  for (const option of options) {
    const entry = typeof option === "string" ? { value: option, label: option } : option;
    const node = el(document, "option", { value: entry.value, text: entry.label });
    if (entry.value === value) {
      node.setAttribute("selected", "selected");
    }
    select.appendChild(node);
  }
  return select;
}
function numberControl(document, { id, value, min, onChange, disabled, ariaLabel, placeholder }) {
  return el(document, "input", {
    type: "number",
    id,
    class: "advisorflow_input",
    "aria-label": ariaLabel,
    ...min !== void 0 ? { min: String(min) } : {},
    ...placeholder !== void 0 ? { placeholder } : {},
    // null = 未配置（回归缺省）——渲染为空输入框，与占位文案一致。
    ...value === void 0 || value === null ? {} : { value: String(value) },
    ...disabled ? { disabled: "disabled" } : {},
    onChange: (event) => {
      if (event.target.value === "") {
        onChange(null);
        return;
      }
      const parsed = Number.parseInt(event.target.value, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        onChange(parsed);
      }
    }
  });
}
var GATE_LABELS = { plan: "\u8BA1\u5212\u5B88\u5219", failure: "\u5931\u8D25\u5B88\u5219", loop: "\u5FAA\u73AF\u95E8", completion: "\u5B8C\u6210\u5B88\u5219" };
var GATE_HINTS = {
  plan: "\u542F\u7528\u540E\uFF0C\u6267\u884C\u8005\u5728\u5236\u5B9A\u6709\u5B9E\u8D28\u5F71\u54CD\u7684\u8BA1\u5212\u524D\u5148\u8C03\u7528 ask_advisor \u5E76\u9644\u4E0A\u8349\u7A3F\uFF08\u547D\u540D\u62DF\u8BAE\u5DE5\u4F5C\u3001\u9A8C\u8BC1\u65B9\u5F0F\u4E0E\u5269\u4F59\u98CE\u9669\uFF09",
  failure: "\u542F\u7528\u540E\uFF0C\u7B49\u4EF7\u5C1D\u8BD5\u8FDE\u7EED\u5931\u8D25\u6216\u65E0\u53EF\u6D4B\u8FDB\u5C55\u65F6\u5148\u54A8\u8BE2\uFF0C\u54A8\u8BE2\u4E4B\u524D\u4E0D\u518D\u505A\u5B9E\u8D28\u7B49\u4EF7\u7684\u5C1D\u8BD5",
  loop: "\u542F\u7528\u540E\uFF0C\u7B49\u4EF7\u5DE5\u5177\u8C03\u7528\u91CD\u590D\u8FBE\u5230\u9608\u503C\u7684\u90A3\u6B21\u8C03\u7528\uFF0C\u6267\u884C\u524D\u5148\u7ECF\u987E\u95EE\u8BC4\u5BA1\uFF08Decision \u4E09\u503C\u51B3\u7B56\uFF09",
  completion: "\u542F\u7528\u540E\uFF0C\u6267\u884C\u8005\u5728\u5BA3\u544A\u5B8C\u6210\u524D\u5148\u8C03\u7528 ask_advisor \u5E76\u9644\u4E0A\u547D\u540D\u5DF2\u53D8\u66F4\u5DE5\u4F5C\u3001\u9A8C\u8BC1\u65B9\u5F0F\u4E0E\u5269\u4F59\u98CE\u9669\u7684\u8349\u7A3F"
};
var THRESHOLD_HINT = "\u7B49\u4EF7\u5DE5\u5177\u8C03\u7528\u91CD\u590D\u8FBE\u5230\u8BE5\u6B21\u6570\u7684\u90A3\u6B21\u8C03\u7528\u5373\u53D7\u5BA1\uFF1B\u7559\u7A7A\u7528\u9ED8\u8BA4 3";
var FAILURE_MODE_OPTIONS = [
  { value: "warn-and-continue", label: "\u8B66\u544A\u5E76\u653E\u884C\uFF08warn-and-continue\uFF09" },
  { value: "block-tool", label: "\u62E6\u622A\u672C\u6B21\u8C03\u7528\uFF08block-tool\uFF09" },
  { value: "block-session", label: "\u5C01\u9501\u4F1A\u8BDD\uFF08block-session\uFF09" }
];
var FAILURE_MODE_HINT = "\u5FAA\u73AF\u95E8 blocked \u51B3\u7B56\u4E0E\u54A8\u8BE2\u5931\u8D25\u7684\u7EDF\u4E00\u5904\u7F6E\u6863\u4F4D";
var MODE_OPTIONS = [
  { value: "soft", label: "\u8F6F\u6A21\u5F0F\uFF1A\u5B88\u5219\u5EFA\u8BAE\uFF08soft\uFF09" },
  { value: "hard", label: "\u786C\u6A21\u5F0F\uFF1A\u56DE\u5408\u6536\u53E3\u5F3A\u5236\u8BC4\u5BA1\uFF08hard\uFF09" }
];
var MODE_HINT = "\u8F6F\u6A21\u5F0F\u53EA\u4EE5\u5B88\u5219\u5EFA\u8BAE\uFF1B\u786C\u6A21\u5F0F\u5728\u6BCF\u6B21\u56DE\u5408\u6536\u53E3\u524D\u5F3A\u5236\u53D1\u8D77\u4E00\u6B21\u987E\u95EE\u8BC4\u5BA1\uFF08Decision \u4E09\u503C\u88C1\u51B3\uFF09";
function guidelineGateBlock(document, kind, gate, controller) {
  var _a, _b;
  return el(document, "fieldset", { class: "advisorflow_fieldset", "data-gate": kind }, [
    toggleRow(document, {
      label: `\u542F\u7528${(_a = GATE_LABELS[kind]) != null ? _a : kind}`,
      control: switchControl(document, {
        id: `advisor-gate-${kind}-enabled`,
        checked: gate.enabled === true,
        label: `\u542F\u7528${(_b = GATE_LABELS[kind]) != null ? _b : kind}`,
        onChange: (value) => controller.setField(`gates.${kind}.enabled`, value)
      })
    }),
    hintParagraph(document, GATE_HINTS[kind])
  ]);
}
function loopGateBlock(document, gate, controller) {
  const gateDisabled = gate.enabled !== true;
  return el(document, "fieldset", { class: "advisorflow_fieldset", "data-gate": "loop" }, [
    toggleRow(document, {
      label: "\u542F\u7528\u5FAA\u73AF\u95E8",
      control: switchControl(document, {
        id: "advisor-gate-loop-enabled",
        checked: gate.enabled === true,
        label: "\u542F\u7528\u5FAA\u73AF\u95E8",
        onChange: (value) => controller.setField("gates.loop.enabled", value)
      })
    }),
    hintParagraph(document, GATE_HINTS.loop),
    field(document, {
      id: "advisor-gate-loop-threshold",
      label: "\u9608\u503C",
      control: numberControl(document, {
        id: "advisor-gate-loop-threshold",
        value: gate.threshold,
        min: 1,
        placeholder: "\u9ED8\u8BA4 3",
        // 空值 = 用默认阈值，消除歧义（T-006 目验 ③）
        onChange: (value) => controller.setField("gates.loop.threshold", value),
        disabled: gateDisabled,
        ariaLabel: "\u5FAA\u73AF\u95E8\u9608\u503C"
      }),
      hint: THRESHOLD_HINT
    })
  ]);
}
function renderSettingsCard({ document, container, controller }) {
  injectStyles(document);
  const root = document.createElement("div");
  root.setAttribute("class", "advisorflow_card");
  container.appendChild(root);
  const footerRole = (node) => {
    if (node && typeof node.closest === "function") {
      if (node.closest(".advisorflow_save")) {
        return "save";
      }
      if (node.closest(".advisorflow_discard")) {
        return "discard";
      }
      return null;
    }
    const cls = typeof (node == null ? void 0 : node.getAttribute) === "function" ? node.getAttribute("class") : "";
    if (typeof cls === "string") {
      if (cls.includes("advisorflow_save")) {
        return "save";
      }
      if (cls.includes("advisorflow_discard")) {
        return "discard";
      }
    }
    return null;
  };
  let pressIntent = null;
  const executeFooterAction = (role) => {
    if (role === "save") {
      const state = controller.getState();
      if (state.saving === true || Boolean(state.validationError) || state.writable === false) {
        return;
      }
      void (async () => {
        await controller.save();
        refresh();
      })();
      return;
    }
    controller.discard();
    refresh();
  };
  root.addEventListener("mousedown", (event) => {
    pressIntent = footerRole(event == null ? void 0 : event.target);
  }, true);
  root.addEventListener("mouseup", (event) => {
    const role = footerRole(event == null ? void 0 : event.target);
    const intent = pressIntent;
    pressIntent = null;
    if (!intent || role !== intent) {
      return;
    }
    executeFooterAction(role);
  }, true);
  root.addEventListener("click", (event) => {
    if ((event == null ? void 0 : event.detail) !== 0) {
      return;
    }
    const role = footerRole(event == null ? void 0 : event.target);
    if (!role) {
      return;
    }
    executeFooterAction(role);
  }, true);
  function refresh() {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r;
    const state = controller.getState();
    const focusedId = typeof ((_a = document.activeElement) == null ? void 0 : _a.id) === "string" && document.activeElement.id ? document.activeElement.id : null;
    const nodes = [];
    root.setAttribute("class", "advisorflow_card");
    const mount = () => {
      var _a2, _b2;
      if (typeof root.replaceChildren === "function") {
        root.replaceChildren(...nodes);
      } else {
        while (root.firstChild) {
          root.removeChild(root.firstChild);
        }
        for (const node of nodes) {
          root.appendChild(node);
        }
      }
      if (focusedId && typeof root.querySelector === "function") {
        (_b2 = (_a2 = root.querySelector(`#${focusedId}`)) == null ? void 0 : _a2.focus) == null ? void 0 : _b2.call(_a2, { preventScroll: true });
      }
      applyStickyBottomInset(root, document);
    };
    nodes.push(el(document, "div", { class: "advisorflow_header" }, [
      el(document, "span", { class: "advisorflow_headText" }, [
        el(document, "span", { class: "advisorflow_name", text: CARD_TITLE }),
        el(document, "span", { class: "advisorflow_description", text: CARD_DESCRIPTION })
      ]),
      // 未保存徽标（R-02-001/AC-10，C-024）：dirty 时头部常显；纯标识
      // 不可点，保存动作由 sticky footer 承担（保存或放弃后徽标消失，
      // R-02-001/AC-12）。
      ...state.dirty ? [el(document, "span", { class: "advisorflow_dirtyBadge", text: "\u672A\u4FDD\u5B58" })] : []
    ]));
    const disabledReason = state.disabledReason;
    if (disabledReason) {
      nodes.push(el(document, "div", {
        class: "advisorflow_banner",
        text: disabledReason === "missing-advisor-model" ? "advisor \u672A\u542F\u7528\uFF1A\u7F3A\u5C11\u987E\u95EE\u63D0\u4F9B\u65B9\u6216\u6A21\u578B\u2014\u2014\u5728\u4E0B\u65B9\u8865\u9F50\u540E\u4FDD\u5B58\u5373\u53EF\u542F\u7528" : `advisor \u672A\u542F\u7528\uFF08${disabledReason}\uFF09`
      }));
    }
    if (state.status === "idle") {
      mount();
      void controller.load();
      return;
    }
    if (state.status === "error") {
      nodes.push(el(document, "p", {
        class: "advisorflow_error advisor-flow-error",
        text: (_b = state.error) != null ? _b : "\u914D\u7F6E\u52A0\u8F7D\u5931\u8D25"
      }));
      nodes.push(el(document, "button", {
        type: "button",
        // 角色类与样式类分离：advisorflow_* 前缀是委托的角色命名空间
        // （footerRole 匹配 .advisorflow_discard 会触发放弃语义），
        // 重试按钮只借样式，用独立角色类 advisorflow_retry——否则
        // 键盘/按下-抬起委托会把重试误判为放弃。
        class: "advisorflow_retry advisor-flow-discard",
        text: "\u91CD\u8BD5",
        onClick: () => {
          void controller.retry();
        }
      }));
      mount();
      return;
    }
    const config = (_c = state.effectiveConfig) != null ? _c : {};
    const advisor = isRecord(config.advisor) ? config.advisor : {};
    const form = el(document, "div", { class: "advisorflow_form" }, []);
    form.appendChild(field(document, {
      id: "advisor-mode",
      label: "\u4ECB\u5165\u5F3A\u5EA6",
      control: selectControl(document, {
        id: "advisor-mode",
        value: (_d = config.mode) != null ? _d : DEFAULT_INTERVENTION_MODE,
        options: MODE_OPTIONS,
        onChange: (value) => controller.setField("mode", value),
        ariaLabel: "\u4ECB\u5165\u5F3A\u5EA6"
      }),
      hint: MODE_HINT
    }));
    const patternsValue = Array.isArray(config.turnReviewExemptPatterns) ? config.turnReviewExemptPatterns : DEFAULT_TURN_REVIEW_EXEMPT_PATTERNS;
    form.appendChild(field(document, {
      id: "advisor-turn-review-exempt-patterns",
      label: "\u6536\u53E3\u8BC4\u5BA1\u8C41\u514D\u5173\u952E\u8BCD",
      control: el(document, "input", {
        type: "text",
        id: "advisor-turn-review-exempt-patterns",
        value: patternsValue.join(", "),
        class: "advisorflow_input",
        ariaLabel: "\u6536\u53E3\u8BC4\u5BA1\u8C41\u514D\u5173\u952E\u8BCD",
        onChange: (event) => {
          var _a2;
          const list = String((_a2 = event.target.value) != null ? _a2 : "").split(/[,，\n]/).map((item) => item.trim()).filter((item) => item.length > 0);
          controller.setField("turnReviewExemptPatterns", list);
        }
      }),
      hint: "\u5BA1\u6838\u7C7B\u5B50\u4F1A\u8BDD\u6536\u53E3\u8C41\u514D\u7684\u5173\u952E\u8BCD\uFF08\u5B50\u4E32\u5339\u914D\uFF0C\u5927\u5C0F\u5199\u4E0D\u654F\u611F\uFF09\uFF0C\u9017\u53F7\u5206\u9694\uFF1B\u6E05\u7A7A\u4FDD\u5B58 = \u5173\u95ED\u8C41\u514D\uFF08\u7167\u5E38\u8BC4\u5BA1\uFF09"
    }));
    const hasRealOption = (options) => Array.isArray(options) && options.some((option) => isRecord(option) && option.value !== "");
    const providerOptions = controller.providerOptions();
    const providerControl = hasRealOption(providerOptions) ? selectControl(document, {
      id: "advisor-provider",
      value: (_e = advisor.provider) != null ? _e : "",
      options: [{ value: "", label: "\u2014 \u9009\u62E9\u63D0\u4F9B\u65B9 \u2014" }, ...providerOptions],
      onChange: (value) => controller.setField("advisor.provider", value === "" ? null : value),
      ariaLabel: "\u987E\u95EE\u63D0\u4F9B\u65B9"
    }) : el(document, "input", {
      type: "text",
      id: "advisor-provider",
      class: "advisorflow_input",
      value: (_f = advisor.provider) != null ? _f : "",
      "aria-label": "\u987E\u95EE\u63D0\u4F9B\u65B9",
      onChange: (event) => controller.setField("advisor.provider", event.target.value)
    });
    const providerStale = Array.isArray(providerOptions) && Boolean(advisor.provider) && !providerOptions.some((option) => option.value === advisor.provider);
    form.appendChild(field(document, {
      id: "advisor-provider",
      label: "\u987E\u95EE\u63D0\u4F9B\u65B9",
      control: providerControl,
      hint: providerStale ? `\u5F53\u524D\u503C ${advisor.provider} \u4E0D\u5728\u76EE\u5F55\u4E2D\uFF08\u4FDD\u7559\u900F\u4F20\uFF09` : "\u987E\u95EE\u6A21\u578B\u7684\u8DEF\u7531\u63D0\u4F9B\u65B9\uFF1B\u9009\u9879\u6765\u81EA\u672C\u673A\u5DF2\u914D\u7F6E\u7684\u6A21\u578B\u76EE\u5F55"
    }));
    const modelOptions = controller.modelsFor(advisor.provider);
    const modelControl = hasRealOption(modelOptions) ? selectControl(document, {
      id: "advisor-model",
      value: (_g = advisor.model) != null ? _g : "",
      // 占位项必须有：空值未选择时 <select> 会把第一个真实选项
      // 显示成已选中（幽灵回显，东家生产报障：看起来已配置，
      // 实际存储为空、保存发不出 model 操作、横幅按真实状态常挂）。
      options: [{ value: "", label: "\u2014 \u9009\u62E9\u6A21\u578B \u2014" }, ...modelOptions],
      onChange: (value) => controller.setField("advisor.model", value === "" ? null : value),
      ariaLabel: "\u987E\u95EE\u6A21\u578B"
    }) : el(document, "input", {
      type: "text",
      id: "advisor-model",
      class: "advisorflow_input",
      value: (_h = advisor.model) != null ? _h : "",
      "aria-label": "\u987E\u95EE\u6A21\u578B",
      onChange: (event) => controller.setField("advisor.model", event.target.value)
    });
    const modelStale = Array.isArray(modelOptions) && Boolean(advisor.model) && !modelOptions.some((option) => option.value === advisor.model);
    form.appendChild(field(document, {
      id: "advisor-model",
      label: "\u987E\u95EE\u6A21\u578B",
      control: modelControl,
      hint: modelStale ? `\u5F53\u524D\u503C ${advisor.model} \u4E0D\u5728\u76EE\u5F55\u4E2D\uFF08\u4FDD\u7559\u900F\u4F20\uFF09` : Array.isArray(modelOptions) && !hasRealOption(modelOptions) ? "\u76EE\u5F55\u4E2D\u8BE5\u63D0\u4F9B\u65B9\u6682\u65E0\u6A21\u578B\u58F0\u660E\u2014\u2014\u76F4\u63A5\u8F93\u5165\u6A21\u578B ID \u5373\u53EF" : "\u63D0\u4F9B\u7B2C\u4E8C\u610F\u89C1\u7684\u987E\u95EE\u6A21\u578B\uFF1B\u5019\u9009\u968F\u6240\u9009\u63D0\u4F9B\u65B9\u8054\u52A8"
    }));
    const effortOptions = controller.effortOptions(advisor.model);
    const effortControl = Array.isArray(effortOptions) ? selectControl(document, {
      id: "advisor-reasoning-effort",
      value: (_i = advisor.reasoningEffort) != null ? _i : "",
      options: effortOptions,
      onChange: (value) => controller.setField("advisor.reasoningEffort", value === "" ? null : value),
      ariaLabel: "\u63A8\u7406\u6863\u4F4D"
    }) : selectControl(document, {
      id: "advisor-reasoning-effort",
      value: (_j = advisor.reasoningEffort) != null ? _j : "",
      options: [
        { value: "", label: "\u4E0D\u6307\u5B9A\uFF08\u8DDF\u968F\u6A21\u578B\u9ED8\u8BA4\uFF09" },
        { value: "low", label: "\u4F4E (low)" },
        { value: "high", label: "\u9AD8 (high)" },
        { value: "max", label: "\u6700\u5927 (max)" },
        { value: "off", label: "\u5173\u95ED (off)" }
      ],
      onChange: (value) => controller.setField("advisor.reasoningEffort", value === "" ? null : value),
      ariaLabel: "\u63A8\u7406\u6863\u4F4D"
    });
    form.appendChild(field(document, {
      id: "advisor-reasoning-effort",
      label: "\u63A8\u7406\u6863\u4F4D",
      control: effortControl,
      hint: "\u987E\u95EE\u6A21\u578B\u7684\u63A8\u7406\u529B\u5EA6\uFF1B\u7559\u7A7A\u8DDF\u968F\u6A21\u578B\u9ED8\u8BA4\uFF0C\u6A21\u578B\u4E0D\u652F\u6301\u7684\u6863\u4F4D\u81EA\u52A8\u56DE\u9000\u9ED8\u8BA4"
    }));
    const declaredMaxTokens = (_k = controller.modelMaxTokens) == null ? void 0 : _k.call(controller, advisor.provider, advisor.model);
    form.appendChild(field(document, {
      id: "advisor-max-tokens",
      label: "\u8F93\u51FA\u4E0A\u9650\uFF08maxTokens\uFF09",
      control: numberControl(document, {
        id: "advisor-max-tokens",
        value: advisor.maxTokens,
        min: 1,
        placeholder: declaredMaxTokens !== void 0 ? `\u8DDF\u968F\u6240\u9009\u6A21\u578B\u914D\u7F6E\uFF08\u5F53\u524D ${declaredMaxTokens}\uFF09` : "\u8DDF\u968F\u6240\u9009\u6A21\u578B\u914D\u7F6E",
        onChange: (value) => controller.setField("advisor.maxTokens", value),
        ariaLabel: "\u8F93\u51FA\u4E0A\u9650"
      }),
      hint: "\u5355\u6B21\u54A8\u8BE2\u7684\u8F93\u51FA token \u4E0A\u9650\uFF1B\u7559\u7A7A\u8DDF\u968F\u6240\u9009\u6A21\u578B\u5728\u63D0\u4F9B\u65B9\u914D\u7F6E\u4E2D\u58F0\u660E\u7684 maxTokens\uFF0C\u586B\u5199\u5219\u8986\u76D6"
    }));
    form.appendChild(field(document, {
      id: "advisor-call-timeout-ms",
      label: "\u54A8\u8BE2\u8D85\u65F6\uFF08callTimeoutMs\uFF09",
      control: numberControl(document, {
        id: "advisor-call-timeout-ms",
        value: advisor.callTimeoutMs,
        min: 1,
        placeholder: "\u9ED8\u8BA4 600000\uFF0810 \u5206\u949F\uFF09",
        onChange: (value) => controller.setField("advisor.callTimeoutMs", value),
        ariaLabel: "\u54A8\u8BE2\u8D85\u65F6"
      }),
      hint: "\u5355\u6B21\u54A8\u8BE2\u7684\u6574\u4F53\u8D85\u65F6\u4E0A\u9650\uFF08\u6BEB\u79D2\uFF09\uFF0C\u5FAA\u73AF\u95E8\u5185\u8054\u7B49\u5F85\u540C\u53D7\u6B64\u9650\uFF1B\u7559\u7A7A\u7528\u9ED8\u8BA4 600000\uFF0810 \u5206\u949F\uFF09"
    }));
    const display = isRecord(state.displayConfig) ? state.displayConfig : config;
    const gates = isRecord(display.gates) ? display.gates : {};
    const gatesFieldset = el(document, "fieldset", { class: "advisorflow_fieldset" }, []);
    for (const kind of ["plan", "failure", "completion"]) {
      gatesFieldset.appendChild(guidelineGateBlock(document, kind, (_l = gates[kind]) != null ? _l : {}, controller));
    }
    gatesFieldset.appendChild(loopGateBlock(document, (_m = gates.loop) != null ? _m : {}, controller));
    form.appendChild(gatesFieldset);
    form.appendChild(field(document, {
      id: "advisor-failure-mode",
      label: "\u963B\u65AD\u6A21\u5F0F",
      control: selectControl(document, {
        id: "advisor-failure-mode",
        value: (_n = config.failureMode) != null ? _n : DEFAULT_FAILURE_MODE,
        options: FAILURE_MODE_OPTIONS,
        onChange: (value) => controller.setField("failureMode", value),
        ariaLabel: "\u963B\u65AD\u6A21\u5F0F"
      }),
      hint: FAILURE_MODE_HINT
    }));
    const privacy = isRecord(config.privacy) ? config.privacy : {};
    const privacyNode = el(document, "fieldset", { class: "advisorflow_fieldset" }, [
      el(document, "legend", { class: "advisorflow_legend", text: "\u9690\u79C1\u6863\u4F4D" }),
      field(document, {
        id: "advisor-privacy-history",
        label: "\u4F1A\u8BDD\u5386\u53F2\u6863\u4F4D",
        control: selectControl(document, {
          id: "advisor-privacy-history",
          value: (_o = privacy.history) != null ? _o : "window",
          options: [
            { value: "off", label: "\u4E0D\u53D1\u9001\uFF08off\uFF09" },
            { value: "delta", label: "\u6700\u8FD1\u5207\u7247\uFF08delta\uFF09" },
            { value: "window", label: "\u6700\u8FD1\u7A97\u53E3\uFF08window\uFF09" }
          ],
          onChange: (value) => controller.setField("privacy.history", value),
          ariaLabel: "\u4F1A\u8BDD\u5386\u53F2\u6863\u4F4D"
        }),
        hint: "\u968F\u54A8\u8BE2\u53D1\u9001\u7684\u4F1A\u8BDD\u5386\u53F2\u8303\u56F4\uFF1Aoff \u4E0D\u53D1\u9001\uFF1Bdelta \u6700\u8FD1\u7EA6 8k \u5B57\u7B26\uFF1Bwindow \u6700\u8FD1\u7EA6 24k \u5B57\u7B26"
      }),
      field(document, {
        id: "advisor-privacy-repo-context",
        label: "\u4ED3\u5E93\u4E0A\u4E0B\u6587\u6863\u4F4D",
        control: selectControl(document, {
          id: "advisor-privacy-repo-context",
          value: (_p = privacy.repoContext) != null ? _p : "summary",
          options: [
            { value: "none", label: "\u4E0D\u53D1\u9001\uFF08none\uFF09" },
            { value: "summary", label: "\u4EC5\u7ED3\u6784\u6458\u8981\uFF08summary\uFF09" },
            { value: "patch", label: "\u542B\u53D8\u66F4\u8865\u4E01\uFF08patch\uFF09" }
          ],
          onChange: (value) => controller.setField("privacy.repoContext", value),
          ariaLabel: "\u4ED3\u5E93\u4E0A\u4E0B\u6587\u6863\u4F4D"
        }),
        hint: "\u968F\u54A8\u8BE2\u53D1\u9001\u7684\u4ED3\u5E93\u4FE1\u606F\u8303\u56F4\uFF1Anone \u4E0D\u53D1\u9001\uFF08\u987E\u95EE\u4F1A\u88AB\u544A\u77E5\u65E0\u4ED3\u5E93\u8BBF\u95EE\uFF09\uFF1Bsummary \u4EC5\u7ED3\u6784\u6458\u8981\uFF1Bpatch \u542B\u5F53\u524D\u53D8\u66F4\u8865\u4E01\uFF08\u53D7\u5B57\u8282\u4E0A\u9650\uFF09"
      }),
      toggleRow(document, {
        label: "\u5BC6\u94A5\u8131\u654F",
        control: switchControl(document, {
          id: "advisor-privacy-redact-secrets",
          checked: privacy.redactSecrets !== false,
          label: "\u5BC6\u94A5\u8131\u654F",
          onChange: (value) => controller.setField("privacy.redactSecrets", value)
        })
      }),
      hintParagraph(document, "\u5F00\u542F\u540E\uFF0C\u5BC6\u94A5\u5F62\u72B6\u7684\u503C\u5728\u53D1\u9001\u7ED9\u987E\u95EE\u524D\u66FF\u6362\u4E3A\u5360\u4F4D\u7B26")
    ]);
    form.appendChild(privacyNode);
    const body = el(document, "div", { class: "advisorflow_body" }, [form]);
    const degraded = (_q = state.degradations) != null ? _q : {};
    const degradedKeys = Object.keys(degraded);
    if (degradedKeys.length > 0) {
      body.appendChild(el(document, "p", {
        class: "advisorflow_notice",
        text: `\u964D\u7EA7\uFF1A${degradedKeys.map((key) => `${key}=${degraded[key]}`).join("\uFF1B")}`
      }));
    }
    if (state.savedNotice) {
      body.appendChild(el(document, "p", {
        class: "advisorflow_savedNotice advisor-flow-notice",
        text: state.savedNotice
      }));
    }
    if (state.validationError || state.error) {
      body.appendChild(el(document, "p", {
        class: "advisorflow_error advisor-flow-error",
        text: (_r = state.validationError) != null ? _r : state.error
      }));
    }
    if (state.writable === false) {
      body.appendChild(el(document, "p", {
        class: "advisorflow_notice",
        text: "\u5F53\u524D\u914D\u7F6E\u4E3A\u53EA\u8BFB\uFF0C\u4FEE\u6539\u6682\u4E0D\u53EF\u4FDD\u5B58\u3002"
      }));
    }
    body.appendChild(el(document, "div", { class: "advisorflow_footer" }, [
      el(document, "button", {
        type: "button",
        class: "advisorflow_discard advisor-flow-discard",
        text: "\u653E\u5F03\u4FEE\u6539"
      }),
      el(document, "button", {
        type: "button",
        class: "advisorflow_save advisor-flow-save",
        text: "\u4FDD\u5B58",
        disabled: state.saving || state.validationError || state.writable === false ? "disabled" : void 0
      })
    ]));
    nodes.push(body);
    mount();
  }
  controller.subscribe(refresh);
  refresh();
  return { refresh };
}

// lib/client/index.js
var name = "dsh-advisor-flow-client";
var inject = ["slots", "connection"];
var SETTINGS_NAMESPACE = "advisor-flow";
var BUNDLE_CONFIG_KEY = "dsh-advisor-flow";
function apply(ctx) {
  var _a, _b;
  const logger = typeof (ctx == null ? void 0 : ctx.logger) === "function" ? ctx.logger("advisor-flow") : console;
  const React = typeof require === "function" ? require("react") : void 0;
  if (typeof (React == null ? void 0 : React.createElement) !== "function" || typeof ((_a = ctx == null ? void 0 : ctx.slots) == null ? void 0 : _a.register) !== "function") {
    (_b = logger.warn) == null ? void 0 : _b.call(logger, "advisor-flow client: slots/react \u7F1D\u7F3A\u5931\u2014\u2014\u914D\u7F6E\u5361\u4E0D\u6E32\u67D3\uFF08\u964D\u7EA7\uFF0C\u4E0D\u963B\u585E\u542F\u52A8\uFF09");
    return void 0;
  }
  let cardController;
  let disposeController = () => {
  };
  const AdvisorFlowCard = () => {
    const containerRef = React.useRef(null);
    React.useEffect(() => {
      const container = containerRef.current;
      if (!container) {
        return void 0;
      }
      renderSettingsCard({ document: container.ownerDocument, container, controller: cardController });
      return () => {
        container.textContent = "";
      };
    }, []);
    return React.createElement("div", { ref: containerRef });
  };
  ctx.inject(["configForms"], (services) => {
    var _a2, _b2;
    const configForms = services == null ? void 0 : services.configForms;
    if (configForms === void 0 || typeof configForms.get !== "function" || typeof configForms.whileServed !== "function") {
      (_a2 = logger.warn) == null ? void 0 : _a2.call(logger, "advisor-flow client: configForms \u7F1D\u4E0D\u53EF\u7528\u2014\u2014\u914D\u7F6E\u5361\u4E0D\u6302\u8F7D");
      return void 0;
    }
    if (typeof ctx.effect !== "function") {
      (_b2 = logger.warn) == null ? void 0 : _b2.call(logger, "advisor-flow client: effect \u7F1D\u7F3A\u5931\u2014\u2014\u914D\u7F6E\u5361\u4E0D\u6302\u8F7D");
      return void 0;
    }
    ctx.effect(() => configForms.whileServed([SETTINGS_NAMESPACE], () => {
      var _a3, _b3, _c, _d;
      try {
        const form = configForms.get(SETTINGS_NAMESPACE);
        if (!form) {
          (_a3 = logger.warn) == null ? void 0 : _a3.call(logger, "advisor-flow client: configForms \u672A\u63D0\u4F9B advisor-flow \u63A7\u5236\u5668\u2014\u2014\u914D\u7F6E\u5361\u4E0D\u6302\u8F7D");
          return () => {
          };
        }
        disposeController();
        cardController = createSettingsCardController({ form, rpc: (_b3 = ctx == null ? void 0 : ctx.connection) == null ? void 0 : _b3.rpc, logger });
        disposeController = () => {
          var _a4;
          return (_a4 = cardController == null ? void 0 : cardController.dispose) == null ? void 0 : _a4.call(cardController);
        };
        return ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
          name: "plugins.bundle.config",
          key: BUNDLE_CONFIG_KEY
        }, AdvisorFlowCard));
      } catch (error) {
        (_d = logger.warn) == null ? void 0 : _d.call(logger, `advisor-flow client: \u914D\u7F6E\u5361\u6CE8\u518C\u5931\u8D25\u2014\u2014${(_c = error == null ? void 0 : error.message) != null ? _c : error}`);
        return () => {
        };
      }
    }), "advisor-flow: plugins-page card");
    return void 0;
  });
  return void 0;
}
var index_default = { name, inject, apply };
return module.exports; } });
