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

// lib/config.js
var DEFAULT_CALL_TIMEOUT_MS = 18e4;
var DEFAULT_MAX_TOKENS = 16384;
var DEFAULT_TOOL_RESULT_MAX_BYTES = 8192;
var DEFAULT_RETRY_ATTEMPTS = 1;
var DEFAULT_GATE_THRESHOLD = 3;
var GATE_KINDS = ["plan", "failure", "loop", "completion"];
var GATE_POLICIES = ["review", "ask", "block"];
var FAILURE_GATE_POLICIES = ["review", "ask", "block", "block-session"];
var isPlainKey = (value) => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
function parsePositiveInt(fallback) {
  return (value) => {
    if (value === void 0 || value === null) {
      return { ok: true, value: fallback };
    }
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? { ok: true, value } : { ok: false };
  };
}
function parseNonNegativeInt(fallback) {
  return (value) => {
    if (value === void 0 || value === null) {
      return { ok: true, value: fallback };
    }
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? { ok: true, value } : { ok: false };
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
function parseNonEmptyString(value) {
  if (value === void 0 || value === null) {
    return { ok: true, value: void 0 };
  }
  return typeof value === "string" && value.length > 0 ? { ok: true, value } : { ok: false };
}
var ADVISOR_FIELDS = [
  { key: "provider", parse: parseNonEmptyString, message: "\u5FC5\u987B\u4E3A\u975E\u7A7A\u5B57\u7B26\u4E32" },
  { key: "model", parse: parseNonEmptyString, message: "\u5FC5\u987B\u4E3A\u975E\u7A7A\u5B57\u7B26\u4E32" },
  { key: "reasoningEffort", parse: parseNonEmptyString, message: "\u5FC5\u987B\u4E3A\u975E\u7A7A\u5B57\u7B26\u4E32" },
  { key: "maxTokens", parse: parsePositiveInt(DEFAULT_MAX_TOKENS), message: "\u5FC5\u987B\u4E3A\u6B63\u6574\u6570" },
  { key: "callTimeoutMs", parse: parsePositiveInt(DEFAULT_CALL_TIMEOUT_MS), message: "\u5FC5\u987B\u4E3A\u6B63\u6574\u6570" },
  { key: "retryAttempts", parse: parseNonNegativeInt(DEFAULT_RETRY_ATTEMPTS), message: "\u5FC5\u987B\u4E3A\u975E\u8D1F\u6574\u6570" }
];
var PRIVACY_FIELDS = [
  { key: "history", parse: parseEnum(["off", "delta", "window"], "window"), message: "\u5FC5\u987B\u4E3A off|delta|window \u4E4B\u4E00" },
  { key: "repoContext", parse: parseEnum(["none", "summary", "patch"], "summary"), message: "\u5FC5\u987B\u4E3A none|summary|patch \u4E4B\u4E00" },
  { key: "toolResults", parse: parseEnum(["off", "capped"], "capped"), message: "\u5FC5\u987B\u4E3A off|capped \u4E4B\u4E00" },
  { key: "toolResultMaxBytes", parse: parsePositiveInt(DEFAULT_TOOL_RESULT_MAX_BYTES), message: "\u5FC5\u987B\u4E3A\u6B63\u6574\u6570" },
  { key: "fileContent", parse: parseBool(false), message: "\u5FC5\u987B\u4E3A\u5E03\u5C14\u503C" },
  { key: "redactSecrets", parse: parseBool(true), message: "\u5FC5\u987B\u4E3A\u5E03\u5C14\u503C" }
];
var BUDGET_FIELDS = [
  { key: "maxPerSession", parse: parseNonNegativeInt(0), message: "\u5FC5\u987B\u4E3A\u975E\u8D1F\u6574\u6570\uFF080 = \u4E0D\u9650\uFF09" }
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
var SAVE_NOTICE_EPHEMERAL = "\u5DF2\u4FDD\u5B58\u5230\u5F53\u524D\u8FD0\u884C\u65F6\uFF1B\u6301\u4E45\u5316\u5C1A\u672A\u542F\u7528\uFF0C\u91CD\u542F\u540E\u4FEE\u6539\u4F1A\u4E22\u5931\u3002";
function advisorModelMissingMessage(missing) {
  return `\u5DF2\u542F\u7528\u4F46\u7F3A\u5C11 ${missing}\u2014\u2014\u8BF7\u8865\u9F50\u540E\u518D\u4FDD\u5B58\uFF0C\u5426\u5219\u54A8\u8BE2\u529F\u80FD\u5C06\u6574\u4F53\u7981\u7528`;
}
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
    budget: {}
  };
  const enabled = parseBool(false)(raw.enabled);
  if (!enabled.ok) {
    errors.push("enabled \u5FC5\u987B\u4E3A\u5E03\u5C14\u503C");
  } else {
    config.enabled = enabled.value;
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
    config[key] = parseSection(section ?? {}, key, fields, errors, warnings);
  }
  const gates = raw.gates;
  if (gates !== void 0 && !isRecord(gates)) {
    errors.push("gates \u5FC5\u987B\u4E3A\u5BF9\u8C61");
  } else {
    for (const kind of GATE_KINDS) {
      const policies = kind === "failure" ? FAILURE_GATE_POLICIES : GATE_POLICIES;
      const fields = [
        { key: "enabled", parse: parseBool(false), message: "\u5FC5\u987B\u4E3A\u5E03\u5C14\u503C" },
        { key: "policy", parse: parseEnum(policies, "review"), message: `\u5FC5\u987B\u4E3A ${policies.join("|")} \u4E4B\u4E00` },
        ...["failure", "loop"].includes(kind) ? [{ key: "threshold", parse: parsePositiveInt(DEFAULT_GATE_THRESHOLD), message: "\u5FC5\u987B\u4E3A\u6B63\u6574\u6570" }] : []
      ];
      const gateRaw = gates?.[kind];
      if (gateRaw !== void 0 && !isRecord(gateRaw)) {
        errors.push(`gates.${kind} \u5FC5\u987B\u4E3A\u5BF9\u8C61`);
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
  const KNOWN = ["enabled", "advisor", "gates", "privacy", "budget"];
  for (const key of Object.keys(raw)) {
    if (!KNOWN.includes(key) && isPlainKey(key)) {
      warnings.push(key);
      config.unknown[key] = raw[key];
    }
  }
  if (errors.length > 0) {
    return { ok: false, error: errors.join("\uFF1B"), warnings };
  }
  if (config.enabled && (!config.advisor.provider || !config.advisor.model)) {
    config.enabled = false;
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
function createSettingsCardController({ rpc, logger = console } = {}) {
  const state = {
    status: "idle",
    // idle | ready | error
    config: {},
    // raw namespace (the editable truth)
    warnings: [],
    error: void 0,
    patch: {},
    // uncommitted edits
    saving: false,
    savedNotice: void 0,
    persistError: void 0,
    // 卡片展开态（T-006 实测：emit 触发的重建式渲染若不持久化展开态，
    // setField → emit → 重绘会把卡片折叠回去——真实用户高频路径）。
    expanded: false,
    // 模型目录（llm/listProviders + session/modelCatalog 实测契约）：
    // provider/model/effort 三级联动下拉的数据源；拉取失败回退手动输入。
    providers: [],
    catalogGroups: [],
    catalogReady: false,
    catalogDegraded: false
  };
  const listeners = /* @__PURE__ */ new Set();
  function emit() {
    for (const listener of [...listeners]) {
      listener();
    }
  }
  function effectiveConfig() {
    return mergeAdvisorFlowConfig(state.config, state.patch);
  }
  async function unwrap(envelope) {
    if (!isRecord(envelope) || envelope.ok !== true) {
      const message = envelope?.error?.message ?? "\u914D\u7F6E\u901A\u9053\u8FD4\u56DE\u5F02\u5E38";
      return { ok: false, value: void 0, message, code: envelope?.error?.code };
    }
    return { ok: true, value: envelope.value, message: void 0 };
  }
  async function loadCatalogs() {
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
      logger.warn?.(`advisor-flow client: \u6A21\u578B\u76EE\u5F55\u62C9\u53D6\u5F02\u5E38\u2014\u2014\u56DE\u9000\u624B\u52A8\u8F93\u5165: ${String(error)}`);
    }
  }
  function markCatalogDegraded() {
    if (state.catalogDegraded) {
      return;
    }
    state.catalogDegraded = true;
    state.degradations = { ...isRecord(state.degradations) ? state.degradations : {}, catalog: "catalog-fetch-failed" };
    logger.warn?.("advisor-flow client: \u6A21\u578B\u76EE\u5F55\u62C9\u53D6\u5931\u8D25\u2014\u2014provider/model/effort \u56DE\u9000\u624B\u52A8\u8F93\u5165\uFF08catalog-fetch-failed\uFF09");
  }
  function providerOptions() {
    if (!state.catalogReady) {
      return void 0;
    }
    const options = state.providers.map((entry) => ({ value: entry.id, label: entry.name ?? entry.id }));
    const current = effectiveConfig().advisor?.provider;
    if (current && !options.some((option) => option.value === current)) {
      options.push({ value: current, label: `${current}\uFF08\u5F53\u524D\u503C\uFF0C\u76EE\u5F55\u5916\uFF09` });
    }
    return options;
  }
  function modelsFor(providerId, { keepCurrent = true } = {}) {
    if (!state.catalogReady) {
      return void 0;
    }
    const group = state.catalogGroups.find((entry) => entry.id === providerId);
    const models = (group?.models ?? []).filter((model) => isRecord(model) && typeof model.id === "string").map((model) => ({ value: model.id, label: model.name ?? model.id }));
    const current = effectiveConfig().advisor?.model;
    if (keepCurrent && current && !models.some((option) => option.value === current)) {
      models.push({ value: current, label: `${current}\uFF08\u5F53\u524D\u503C\uFF0C\u76EE\u5F55\u5916\uFF09` });
    }
    if (models.length === 0) {
      models.push({ value: "", label: "\u2014 \u9009\u62E9\u6A21\u578B \u2014" });
    }
    return models;
  }
  function effortOptions(modelId) {
    if (!state.catalogReady) {
      return void 0;
    }
    const model = state.catalogGroups.flatMap((group) => group.models ?? []).find((model2) => isRecord(model2) && model2.id === modelId);
    const defaultEffort = model?.reasoning?.defaultEffort;
    const options = [{
      value: "",
      label: defaultEffort ? `\u8DDF\u968F\u6A21\u578B\u9ED8\u8BA4\uFF08default: ${defaultEffort}\uFF09` : "\u8DDF\u968F\u6A21\u578B\u9ED8\u8BA4"
    }];
    for (const effort of model?.reasoning?.efforts ?? []) {
      if (isRecord(effort) && typeof effort.id === "string") {
        options.push({ value: effort.id, label: effort.name ?? effort.id });
      }
    }
    return options;
  }
  return {
    /** Subscribe to state changes (render framework glue). */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState() {
      return {
        ...state,
        effectiveConfig: state.status === "ready" ? effectiveConfig() : void 0,
        validationError: state.status === "ready" ? this.validate() : void 0
      };
    },
    /** provider 下拉选项；`undefined` = 目录不可用（render 回退自由文本）。 */
    providerOptions,
    /** 所选 provider 的模型下拉选项；`undefined` = 回退自由文本。 */
    modelsFor,
    /** 所选 model 的 effort 下拉选项；`undefined` = 回退硬编码档位。 */
    effortOptions,
    /** Load the current config through `advisor-flow/get`（retry 内部递归用）. */
    async load(retry) {
      state.status = state.status === "error" ? "error" : "idle";
      try {
        const unwrapped = await unwrap(await rpc.call("/api", "advisor-flow/get", { args: {} }));
        if (!unwrapped.ok || !isRecord(unwrapped.value) || !isRecord(unwrapped.value.config)) {
          state.status = "error";
          state.error = unwrapped.ok ? "\u914D\u7F6E\u901A\u9053\u8FD4\u56DE\u4E86\u610F\u5916\u5F62\u6001" : unwrapped.message;
        } else {
          const result = unwrapped.value;
          state.config = result.config;
          state.warnings = Array.isArray(result.warnings) ? result.warnings : [];
          state.error = result.error;
          state.status = "ready";
          void loadCatalogs().then(() => emit());
        }
      } catch (error) {
        if (retry !== true) {
          await new Promise((resolve) => setTimeout(resolve, 600));
          return this.load(true);
        }
        state.status = "error";
        state.error = `\u914D\u7F6E\u901A\u9053\u4E0D\u53EF\u7528\uFF1A${String(error)}`;
        logger.warn?.(`advisor-flow client: ${state.error}`);
      }
      emit();
      return state.status;
    },
    /**
     * 卡片展开/折叠（T-006 实测：展开态须跨 setField/emit 重绘与宿主
     * slot 重挂存续——存 controller state 而非 render 闭包）。不触发
     * 校验/回执语义，仅重绘。
     */
    setExpanded(value) {
      state.expanded = value === true;
      emit();
    },
    /** Stage one dotted-path edit, e.g. `setField('advisor.provider', 'p')`. */
    setField(path, value) {
      if (state.savedNotice) {
        state.savedNotice = void 0;
        state.persistError = void 0;
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
        const currentModel = effectiveConfig().advisor?.model;
        if (Array.isArray(models) && currentModel && !models.some((option) => option.value === currentModel)) {
          section.model = null;
          section.reasoningEffort = null;
        }
      }
      emit();
    },
    /**
     * Client-side mirror of the host validation (same parser, same
     * enabled-without-model block). Returns an error message or
     * `undefined` when the staged patch would save.
     */
    validate() {
      if (state.status !== "ready") {
        return "\u914D\u7F6E\u5C1A\u672A\u52A0\u8F7D";
      }
      const merged = effectiveConfig();
      const advisor = isRecord(merged.advisor) ? merged.advisor : {};
      if (merged.enabled === true && (!advisor.provider || !advisor.model)) {
        return advisorModelMissingMessage(advisor.provider ? "advisor.model" : "advisor.provider");
      }
      const resolved = resolveAdvisorFlowConfig(merged);
      if (!resolved.ok) {
        return `\u914D\u7F6E\u65E0\u6548\uFF0C\u65E0\u6CD5\u4FDD\u5B58\uFF1A${resolved.error}`;
      }
      return void 0;
    },
    /** Discard the staged patch (no gateway write). */
    discard() {
      state.patch = {};
      emit();
    },
    /**
     * Save the staged patch. A client-side validation failure blocks the
     * RPC entirely; a host rejection surfaces its message and keeps the
     * form. Resolves `{ ok, error? }`, never throws.
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
        const unwrapped = await unwrap(await rpc.call("/api", "advisor-flow/set", { args: { patch: state.patch } }));
        const result = unwrapped.value;
        if (!unwrapped.ok || !isRecord(result)) {
          state.error = unwrapped.ok ? "\u914D\u7F6E\u901A\u9053\u8FD4\u56DE\u4E86\u610F\u5916\u5F62\u6001" : unwrapped.message;
          state.saving = false;
          emit();
          return { ok: false, error: state.error, code: unwrapped.code };
        }
        if (result.ok) {
          state.config = isRecord(result.config) ? mergeToRaw(state.config, state.patch) : state.config;
          state.warnings = Array.isArray(result.warnings) ? result.warnings : [];
          state.error = void 0;
          state.patch = {};
          state.saving = false;
          const notice = result.notice ?? SAVE_NOTICE_EPHEMERAL;
          state.persistError = typeof result.persistError === "string" ? result.persistError : void 0;
          state.savedNotice = state.persistError ? `${notice}\uFF08\u539F\u56E0\uFF1A${state.persistError}\uFF09` : notice;
          emit();
          return {
            ok: true,
            persisted: result.persisted === true,
            notice: state.savedNotice,
            persistError: state.persistError
          };
        }
        state.error = result?.error ?? "\u4FDD\u5B58\u88AB\u62D2\u7EDD";
        state.saving = false;
        emit();
        return { ok: false, error: state.error };
      } catch (error) {
        state.error = `\u4FDD\u5B58\u5931\u8D25\uFF1A${String(error)}`;
        state.saving = false;
        emit();
        return { ok: false, error: state.error };
      }
    }
  };
}
function mergeToRaw(base, patch) {
  return mergeAdvisorFlowConfig(base, patch);
}

// lib/client/render.js
var CARD_TITLE = "Advisor Flow";
var CARD_DESCRIPTION = "\u6BCF\u6B21\u5173\u952E\u52A8\u4F5C\u524D\u7531\u72EC\u7ACB\u987E\u95EE\u6A21\u578B\u8BC4\u5BA1\u5E76\u6CE8\u5165\u5EFA\u8BAE";
var CSS = `
.advisorflow_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.advisorflow_card:hover{border-color:var(--dsw-alias-label-dimmed)}
.advisorflow_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.advisorflow_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.advisorflow_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.advisorflow_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.advisorflow_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.advisorflow_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.advisorflow_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s;display:flex}
.advisorflow_chevronOpen{transform:rotate(180deg)}
.advisorflow_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.advisorflow_form{flex-direction:column;gap:12px;padding:12px 0 0;display:flex}
.advisorflow_disabledGroup{opacity:.5}
/* \u62E8\u52A8\u5F00\u5173\uFF1A\u5B98\u65B9\u57FA\u5143 Switch \u9010\u9879\u590D\u523B\uFF08button[role=switch] 36\xD720\u3001
   \u9009\u4E2D brand-primary\u3001thumb 16\xD716 translate(16px)\u3001.12s ease\uFF09\u2014\u2014
   \u4E0E\u5BBF\u4E3B Subagent \u5361\u540C\u4E00\u89C6\u89C9\uFF08\u4E1C\u5BB6\u8981\u6C42\u5B8C\u5168\u5BF9\u9F50\uFF09\u3002 */
.advisorflow_switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:10px;background:var(--dsw-alias-border-l3);cursor:pointer}
.advisorflow_switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.advisorflow_switch:disabled{cursor:default;opacity:.5}
.advisorflow_switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.advisorflow_thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s ease}
.advisorflow_switch[aria-checked=true] .advisorflow_thumb{transform:translate(16px)}
/* toggleRow\uFF1Alabel \u5DE6\u3001\u63A7\u4EF6\u53F3\uFF08\u5BBF\u4E3B Subagent \u5361\u540C\u6B3E\u5E03\u5C40\u884C\uFF09\u3002 */
.advisorflow_toggleRow{justify-content:space-between;align-items:center;gap:16px;display:flex}
.advisorflow_toggleLabel{color:var(--dsw-alias-label-primary);flex:1;min-width:0;font-size:13px;line-height:1.5}
.advisorflow_fieldset{border:none;flex-direction:column;gap:12px;margin:0;padding:0;display:flex}
.advisorflow_legend{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:18px}
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
.advisorflow_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.advisorflow_discard,.advisorflow_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.advisorflow_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.advisorflow_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.advisorflow_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.advisorflow_discard:disabled,.advisorflow_save:disabled{opacity:.4;cursor:default}
.advisorflow_discard:focus-visible,.advisorflow_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
`;
var STYLE_TAG_ID = "dsh-advisor-flow/advisor-card.module.css";
function injectStyles(document) {
  if (typeof document?.querySelector !== "function" || !document?.head) {
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
function chevronIcon(document) {
  const create = typeof document.createElementNS === "function" ? (tag) => document.createElementNS("http://www.w3.org/2000/svg", tag) : (tag) => document.createElement(tag);
  const svg = create("svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = create("path");
  path.setAttribute("d", "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z");
  path.setAttribute("fill", "currentColor");
  svg.appendChild(path);
  return svg;
}
function switchControl(document, { id, checked, onChange, label, disabled }) {
  return el(document, "button", {
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
}
function toggleRow(document, { label, control }) {
  return el(document, "div", { class: "advisorflow_toggleRow" }, [
    el(document, "span", { class: "advisorflow_toggleLabel", text: label }),
    control
  ]);
}
function field(document, { id, label, control, hint, warnHint }) {
  return el(document, "div", { class: "advisorflow_field" }, [
    el(document, "label", { class: "advisorflow_fieldLabel", for: id, text: label }),
    control,
    ...hint ? [el(document, "p", { class: "advisorflow_hint", text: hint })] : [],
    ...warnHint ? [el(document, "p", { class: "advisorflow_warnHint", text: warnHint })] : []
  ]);
}
function selectControl(document, { id, value, options, onChange, disabled, ariaLabel }) {
  const select = el(document, "select", {
    id,
    class: "advisorflow_input advisorflow_selectInput",
    "aria-label": ariaLabel ?? label(),
    ...disabled ? { disabled: "disabled" } : {},
    onChange: (event) => onChange(event.target.value)
  });
  function label() {
    return ariaLabel ?? id;
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
    ...value === void 0 ? {} : { value: String(value) },
    ...disabled ? { disabled: "disabled" } : {},
    onChange: (event) => {
      const parsed = Number.parseInt(event.target.value, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        onChange(parsed);
      }
    }
  });
}
var GATE_LABELS = { plan: "Plan", failure: "Failure", loop: "Loop", completion: "Completion" };
function gateBlock(document, kind, gate, controller, disabled) {
  return el(document, "fieldset", { class: "advisorflow_fieldset", "data-gate": kind }, [
    toggleRow(document, {
      label: `\u542F\u7528 ${GATE_LABELS[kind] ?? kind} \u95E8`,
      control: switchControl(document, {
        id: `advisor-gate-${kind}-enabled`,
        checked: gate.enabled === true,
        label: `\u542F\u7528 ${GATE_LABELS[kind] ?? kind} \u95E8`,
        disabled,
        onChange: (value) => controller.setField(`gates.${kind}.enabled`, value)
      })
    }),
    el(document, "div", { class: "advisorflow_numberFields" }, [
      field(document, {
        id: `advisor-gate-${kind}-policy`,
        label: "\u7B56\u7565",
        control: selectControl(document, {
          id: `advisor-gate-${kind}-policy`,
          value: gate.policy ?? "review",
          options: kind === "failure" ? ["review", "ask", "block", "block-session"] : ["review", "ask", "block"],
          onChange: (value) => controller.setField(`gates.${kind}.policy`, value),
          disabled,
          ariaLabel: `${kind} \u95E8\u7B56\u7565`
        })
      }),
      ...["failure", "loop"].includes(kind) ? [field(document, {
        id: `advisor-gate-${kind}-threshold`,
        label: "\u9608\u503C",
        control: numberControl(document, {
          id: `advisor-gate-${kind}-threshold`,
          value: gate.threshold,
          min: 1,
          placeholder: "\u9ED8\u8BA4 3",
          // 空值 = 用默认阈值，消除歧义（T-006 目验 ③）
          onChange: (value) => controller.setField(`gates.${kind}.threshold`, value),
          disabled,
          ariaLabel: `${kind} \u95E8\u9608\u503C`
        })
      })] : []
    ])
  ]);
}
function renderSettingsCard({ document, container, controller }) {
  injectStyles(document);
  const root = document.createElement("div");
  root.setAttribute("class", "advisorflow_card");
  container.appendChild(root);
  function refresh() {
    const state = controller.getState();
    while (root.firstChild) {
      root.removeChild(root.firstChild);
    }
    const hasError = state.status === "error" || Boolean(state.error);
    const open = state.expanded === true || hasError;
    root.setAttribute("class", open ? "advisorflow_card advisorflow_cardOpen" : "advisorflow_card");
    root.appendChild(el(document, "button", {
      type: "button",
      class: "advisorflow_header",
      "aria-expanded": open ? "true" : "false",
      "aria-label": `${open ? "\u6536\u8D77" : "\u5C55\u5F00"}\uFF1A${CARD_TITLE}`,
      onClick: () => {
        controller.setExpanded(!open);
        refresh();
      }
    }, [
      el(document, "span", { class: "advisorflow_headText" }, [
        el(document, "span", { class: "advisorflow_name", text: CARD_TITLE }),
        el(document, "span", { class: "advisorflow_description", text: CARD_DESCRIPTION })
      ]),
      el(document, "span", {
        class: open ? "advisorflow_chevron advisorflow_chevronOpen" : "advisorflow_chevron"
      }, [chevronIcon(document)])
    ]));
    if (state.status === "idle") {
      void controller.load();
      return;
    }
    if (state.status === "error") {
      root.appendChild(el(document, "p", {
        class: "advisorflow_error advisor-flow-error",
        text: state.error ?? "\u914D\u7F6E\u52A0\u8F7D\u5931\u8D25"
      }));
      root.appendChild(el(document, "button", {
        type: "button",
        class: "advisorflow_discard advisor-flow-discard",
        text: "\u91CD\u8BD5",
        onClick: () => {
          controller.setExpanded(true);
          void controller.load();
        }
      }));
      return;
    }
    if (!open) {
      return;
    }
    const config = state.effectiveConfig ?? {};
    const advisor = isRecord(config.advisor) ? config.advisor : {};
    const form = el(document, "div", { class: "advisorflow_form" }, []);
    const disabled = config.enabled !== true;
    form.appendChild(toggleRow(document, {
      label: "\u542F\u7528 Advisor Flow",
      control: switchControl(document, {
        id: "advisor-enabled",
        checked: config.enabled === true,
        label: "\u542F\u7528 Advisor Flow",
        onChange: (value) => controller.setField("enabled", value)
      })
    }));
    const providerOptions = controller.providerOptions();
    const providerControl = Array.isArray(providerOptions) ? selectControl(document, {
      id: "advisor-provider",
      value: advisor.provider ?? "",
      options: [{ value: "", label: "\u2014 \u9009\u62E9 provider \u2014" }, ...providerOptions],
      onChange: (value) => controller.setField("advisor.provider", value === "" ? null : value),
      disabled,
      ariaLabel: "Advisor provider"
    }) : el(document, "input", {
      type: "text",
      id: "advisor-provider",
      class: "advisorflow_input",
      value: advisor.provider ?? "",
      "aria-label": "Advisor provider",
      disabled,
      onChange: (event) => controller.setField("advisor.provider", event.target.value)
    });
    const providerStale = Array.isArray(providerOptions) && Boolean(advisor.provider) && !providerOptions.some((option) => option.value === advisor.provider);
    form.appendChild(field(document, {
      id: "advisor-provider",
      label: "Advisor provider",
      control: providerControl,
      disabled,
      hint: providerStale ? `\u5F53\u524D\u503C ${advisor.provider} \u4E0D\u5728\u76EE\u5F55\u4E2D\uFF08\u4FDD\u7559\u900F\u4F20\uFF09` : void 0
    }));
    const modelOptions = controller.modelsFor(advisor.provider);
    const modelControl = Array.isArray(modelOptions) ? selectControl(document, {
      id: "advisor-model",
      value: advisor.model ?? "",
      options: modelOptions,
      onChange: (value) => controller.setField("advisor.model", value === "" ? null : value),
      disabled,
      ariaLabel: "Advisor model"
    }) : el(document, "input", {
      type: "text",
      id: "advisor-model",
      class: "advisorflow_input",
      value: advisor.model ?? "",
      "aria-label": "Advisor model",
      disabled,
      onChange: (event) => controller.setField("advisor.model", event.target.value)
    });
    const modelStale = Array.isArray(modelOptions) && Boolean(advisor.model) && !modelOptions.some((option) => option.value === advisor.model);
    form.appendChild(field(document, {
      id: "advisor-model",
      label: "Advisor model",
      control: modelControl,
      disabled,
      hint: modelStale ? `\u5F53\u524D\u503C ${advisor.model} \u4E0D\u5728\u76EE\u5F55\u4E2D\uFF08\u4FDD\u7559\u900F\u4F20\uFF09` : void 0
    }));
    const effortOptions = controller.effortOptions(advisor.model);
    const effortControl = Array.isArray(effortOptions) ? selectControl(document, {
      id: "advisor-reasoning-effort",
      value: advisor.reasoningEffort ?? "",
      options: effortOptions,
      onChange: (value) => controller.setField("advisor.reasoningEffort", value === "" ? null : value),
      disabled,
      ariaLabel: "advisor reasoningEffort"
    }) : selectControl(document, {
      id: "advisor-reasoning-effort",
      value: advisor.reasoningEffort ?? "",
      options: [
        { value: "", label: "\u4E0D\u6307\u5B9A\uFF08\u8DDF\u968F\u6A21\u578B\u9ED8\u8BA4\uFF09" },
        { value: "low", label: "\u4F4E (low)" },
        { value: "high", label: "\u9AD8 (high)" },
        { value: "max", label: "\u6700\u5927 (max)" },
        { value: "off", label: "\u5173\u95ED (off)" }
      ],
      onChange: (value) => controller.setField("advisor.reasoningEffort", value === "" ? null : value),
      disabled,
      ariaLabel: "advisor reasoningEffort"
    });
    form.appendChild(field(document, {
      id: "advisor-reasoning-effort",
      label: "advisor reasoningEffort",
      control: effortControl,
      hint: "\u6A21\u578B\u4E0D\u652F\u6301\u7684\u6863\u4F4D\u5C06\u56DE\u9000\u6A21\u578B\u9ED8\u8BA4"
    }));
    const gates = isRecord(config.gates) ? config.gates : {};
    const gatesFieldset = el(document, "fieldset", { class: "advisorflow_fieldset" }, []);
    for (const kind of ["plan", "failure", "loop", "completion"]) {
      const gateNode = gateBlock(document, kind, gates[kind] ?? {}, controller, disabled);
      if (disabled) {
        gateNode.setAttribute("class", `${gateNode.getAttribute("class") ?? ""} advisorflow_disabledGroup`.trim());
      }
      gatesFieldset.appendChild(gateNode);
    }
    form.appendChild(gatesFieldset);
    const privacy = isRecord(config.privacy) ? config.privacy : {};
    const privacyNode = el(document, "fieldset", { class: "advisorflow_fieldset" }, [
      el(document, "legend", { class: "advisorflow_legend", text: "\u9690\u79C1\u6863\u4F4D" }),
      field(document, {
        id: "advisor-privacy-history",
        label: "History \u6863\u4F4D",
        control: selectControl(document, {
          id: "advisor-privacy-history",
          value: privacy.history ?? "window",
          options: ["off", "delta", "window"],
          onChange: (value) => controller.setField("privacy.history", value),
          disabled,
          ariaLabel: "History \u6863\u4F4D"
        })
      }),
      field(document, {
        id: "advisor-privacy-repo-context",
        label: "RepoContext \u6863\u4F4D",
        control: selectControl(document, {
          id: "advisor-privacy-repo-context",
          value: privacy.repoContext ?? "summary",
          options: ["none", "summary", "patch"],
          onChange: (value) => controller.setField("privacy.repoContext", value),
          disabled,
          ariaLabel: "RepoContext \u6863\u4F4D"
        })
      }),
      toggleRow(document, {
        label: "\u5BC6\u94A5\u8131\u654F",
        control: switchControl(document, {
          id: "advisor-privacy-redact-secrets",
          checked: privacy.redactSecrets !== false,
          label: "\u5BC6\u94A5\u8131\u654F",
          disabled,
          onChange: (value) => controller.setField("privacy.redactSecrets", value)
        })
      })
    ]);
    if (disabled) {
      privacyNode.setAttribute("class", `${privacyNode.getAttribute("class") ?? ""} advisorflow_disabledGroup`.trim());
    }
    form.appendChild(privacyNode);
    const body = el(document, "div", { class: "advisorflow_body" }, [form]);
    const degraded = state.degradations ?? {};
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
        text: state.validationError ?? state.error
      }));
    }
    const save = el(document, "button", {
      type: "button",
      class: "advisorflow_save advisor-flow-save",
      text: "\u4FDD\u5B58",
      disabled: state.saving || state.validationError ? "disabled" : void 0,
      onClick: async () => {
        await controller.save();
        refresh();
      }
    });
    body.appendChild(el(document, "div", { class: "advisorflow_footer" }, [
      el(document, "button", {
        type: "button",
        class: "advisorflow_discard advisor-flow-discard",
        text: "\u653E\u5F03\u4FEE\u6539",
        onClick: () => {
          controller.discard();
          refresh();
        }
      }),
      save
    ]));
    root.appendChild(body);
  }
  controller.subscribe(refresh);
  refresh();
  return { refresh };
}

// lib/client/index.js
var name = "dsh-advisor-flow-client";
var inject = ["slots", "connection"];
function apply(ctx) {
  const logger = typeof ctx?.logger === "function" ? ctx.logger("advisor-flow") : console;
  const controller = createSettingsCardController({
    rpc: ctx?.connection?.rpc,
    logger
  });
  const React = typeof require === "function" ? require("react") : void 0;
  if (typeof React?.createElement !== "function" || typeof ctx?.slots?.inject !== "function") {
    logger.warn?.("advisor-flow client: slots/react \u7F1D\u7F3A\u5931\u2014\u2014\u5361\u7247\u672A\u6E32\u67D3\uFF08\u8054\u8C03\u9A8C\u8BC1\u9879 T-002\uFF09");
    return { controller, refresh: () => controller.load() };
  }
  const AdvisorFlowCard = () => {
    const containerRef = React.useRef(null);
    React.useEffect(() => {
      const container = containerRef.current;
      if (!container) return void 0;
      renderSettingsCard({ document: container.ownerDocument, container, controller });
      return () => {
        container.textContent = "";
      };
    }, []);
    return React.createElement("div", { ref: containerRef });
  };
  ctx.slots.inject("settings.plugin.item", function* () {
    yield ctx.slots.register({
      name: "settings.plugin.item",
      key: "advisor-flow"
    }, AdvisorFlowCard);
  });
  return { controller, refresh: () => controller.load() };
}
var index_default = { name, inject, apply };
return module.exports; } });
