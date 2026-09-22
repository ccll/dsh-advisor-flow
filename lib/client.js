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
    persistError: void 0
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
    /** Load the current config through `advisor-flow/get`. */
    async load() {
      state.status = state.status === "error" ? "error" : "idle";
      try {
        const result = await rpc.call("/api", "advisor-flow/get", { args: {} });
        if (!isRecord(result) || !isRecord(result.config)) {
          state.status = "error";
          state.error = result?.error ?? "\u914D\u7F6E\u901A\u9053\u8FD4\u56DE\u5F02\u5E38";
        } else {
          state.config = result.config;
          state.warnings = Array.isArray(result.warnings) ? result.warnings : [];
          state.error = result.error;
          state.status = "ready";
        }
      } catch (error) {
        state.status = "error";
        state.error = `\u914D\u7F6E\u901A\u9053\u4E0D\u53EF\u7528\uFF1A${String(error)}`;
        logger.warn?.(`advisor-flow client: ${state.error}`);
      }
      emit();
      return state.status;
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
        const result = await rpc.call("/api", "advisor-flow/set", { args: { patch: state.patch } });
        if (isRecord(result) && result.ok) {
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
function checkbox(document, { checked, onChange, label, disabled }) {
  const box = el(document, "input", {
    type: "checkbox",
    ...checked ? { checked: "checked" } : {},
    ...disabled ? { disabled: "disabled" } : {},
    onChange: (event) => onChange(event.target.checked)
  });
  return el(document, "label", {}, [
    box,
    el(document, "span", { text: label })
  ]);
}
function textField(document, { value, onChange, label, disabled }) {
  return el(document, "label", {}, [
    el(document, "span", { text: label }),
    el(document, "input", {
      type: "text",
      value: value ?? "",
      ...disabled ? { disabled: "disabled" } : {},
      onChange: (event) => onChange(event.target.value)
    })
  ]);
}
function selectField(document, { value, options, onChange, label, hint }) {
  const select = el(document, "select", {
    onChange: (event) => onChange(event.target.value)
  });
  for (const option of options) {
    const entry = typeof option === "string" ? { value: option, label: option } : option;
    const node = el(document, "option", { value: entry.value, text: entry.label });
    if (entry.value === value) {
      node.setAttribute("selected", "selected");
    }
    select.appendChild(node);
  }
  return el(document, "label", {}, [
    el(document, "span", { text: label }),
    select,
    ...hint ? [el(document, "span", { class: "advisor-flow-hint", text: hint })] : []
  ]);
}
function numberField(document, { value, onChange, label }) {
  return el(document, "label", {}, [
    el(document, "span", { text: label }),
    el(document, "input", {
      type: "number",
      value: value === void 0 ? "" : String(value),
      onChange: (event) => {
        const parsed = Number.parseInt(event.target.value, 10);
        if (Number.isInteger(parsed) && parsed > 0) {
          onChange(parsed);
        }
      }
    })
  ]);
}
function gateRow(document, kind, gate, controller) {
  return el(document, "div", { class: "advisor-flow-gate", "data-gate": kind }, [
    checkbox(document, {
      checked: gate.enabled === true,
      label: `${kind} \u95E8`,
      onChange: (value) => controller.setField(`gates.${kind}.enabled`, value)
    }),
    selectField(document, {
      value: gate.policy ?? "review",
      options: kind === "failure" ? ["review", "ask", "block", "block-session"] : ["review", "ask", "block"],
      label: "\u7B56\u7565",
      onChange: (value) => controller.setField(`gates.${kind}.policy`, value)
    }),
    ...kind === "failure" || kind === "loop" ? [numberField(document, {
      value: gate.threshold,
      label: "\u9608\u503C",
      onChange: (value) => controller.setField(`gates.${kind}.threshold`, value)
    })] : []
  ]);
}
function renderSettingsCard({ document, container, controller }) {
  const root = document.createElement("div");
  root.setAttribute("class", "advisor-flow-card");
  container.appendChild(root);
  function refresh() {
    const state = controller.getState();
    while (root.firstChild) {
      root.removeChild(root.firstChild);
    }
    root.appendChild(el(document, "h3", { text: "Advisor Flow" }));
    if (state.status === "idle") {
      void controller.load();
      return;
    }
    if (state.status === "error") {
      root.appendChild(el(document, "p", { class: "advisor-flow-error", text: state.error ?? "\u914D\u7F6E\u52A0\u8F7D\u5931\u8D25" }));
      return;
    }
    const config = state.effectiveConfig ?? {};
    root.appendChild(checkbox(document, {
      checked: config.enabled === true,
      label: "\u542F\u7528 Advisor Flow",
      onChange: (value) => controller.setField("enabled", value)
    }));
    const advisor = isRecord(config.advisor) ? config.advisor : {};
    root.appendChild(textField(document, {
      value: advisor.provider,
      label: "advisor provider",
      onChange: (value) => controller.setField("advisor.provider", value)
    }));
    root.appendChild(textField(document, {
      value: advisor.model,
      label: "advisor model",
      onChange: (value) => controller.setField("advisor.model", value)
    }));
    root.appendChild(selectField(document, {
      value: advisor.reasoningEffort ?? "",
      options: [
        { value: "", label: "\u4E0D\u6307\u5B9A\uFF08\u8DDF\u968F\u6A21\u578B\u9ED8\u8BA4\uFF09" },
        { value: "low", label: "\u4F4E (low)" },
        { value: "high", label: "\u9AD8 (high)" },
        { value: "max", label: "\u6700\u5927 (max)" },
        { value: "off", label: "\u5173\u95ED (off)" }
      ],
      label: "advisor reasoningEffort",
      hint: "\u6A21\u578B\u4E0D\u652F\u6301\u7684\u6863\u4F4D\u5C06\u56DE\u9000\u6A21\u578B\u9ED8\u8BA4",
      // 空选映射为 null 而非 undefined：真实 JSON 通道会丢弃 undefined
      // 键，merge 就会保留 raw 旧档位（卡片与持久真相分歧）；null 可穿
      // 越序列化，且解析器对 null 同样按「未配置=跟随默认」处理。
      onChange: (value) => controller.setField("advisor.reasoningEffort", value === "" ? null : value)
    }));
    const gates = isRecord(config.gates) ? config.gates : {};
    for (const kind of ["plan", "failure", "loop", "completion"]) {
      root.appendChild(gateRow(document, kind, gates[kind] ?? {}, controller));
    }
    const privacy = isRecord(config.privacy) ? config.privacy : {};
    root.appendChild(selectField(document, {
      value: privacy.history ?? "window",
      options: ["off", "delta", "window"],
      label: "history \u6863\u4F4D",
      onChange: (value) => controller.setField("privacy.history", value)
    }));
    root.appendChild(selectField(document, {
      value: privacy.repoContext ?? "summary",
      options: ["none", "summary", "patch"],
      label: "repoContext \u6863\u4F4D",
      onChange: (value) => controller.setField("privacy.repoContext", value)
    }));
    root.appendChild(checkbox(document, {
      checked: privacy.redactSecrets !== false,
      label: "\u5BC6\u94A5\u8131\u654F",
      onChange: (value) => controller.setField("privacy.redactSecrets", value)
    }));
    const degraded = state.degradations ?? {};
    const degradedKeys = Object.keys(degraded);
    if (degradedKeys.length > 0) {
      root.appendChild(el(document, "p", {
        class: "advisor-flow-degraded",
        text: `\u964D\u7EA7\uFF1A${degradedKeys.map((key) => `${key}=${degraded[key]}`).join("\uFF1B")}`
      }));
    }
    if (state.validationError) {
      root.appendChild(el(document, "p", { class: "advisor-flow-error", text: state.validationError }));
    }
    if (state.savedNotice) {
      root.appendChild(el(document, "p", { class: "advisor-flow-notice", text: state.savedNotice }));
    }
    if (state.error) {
      root.appendChild(el(document, "p", { class: "advisor-flow-error", text: state.error }));
    }
    const save = el(document, "button", {
      type: "button",
      class: "advisor-flow-save",
      text: "\u4FDD\u5B58",
      disabled: state.saving || state.validationError ? "disabled" : void 0,
      onClick: async () => {
        await controller.save();
        refresh();
      }
    });
    root.appendChild(el(document, "div", { class: "advisor-flow-actions" }, [
      el(document, "button", {
        type: "button",
        class: "advisor-flow-discard",
        text: "\u653E\u5F03\u4FEE\u6539",
        onClick: () => {
          controller.discard();
          refresh();
        }
      }),
      save
    ]));
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
