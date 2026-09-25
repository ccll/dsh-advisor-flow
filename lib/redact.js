/**
 * Secret-shaped value redaction for advisor outbound material (R-02-004).
 *
 * Values whose *shape* looks like a credential are replaced with
 * `[REDACTED]` before the material leaves the trust boundary
 * (SOLUTION.md#数据流与信任边界图: redaction runs after privacy trimming,
 * before the send). Redaction can be switched off via
 * `advisor-flow.privacy.redactSecrets: false` — `redactText` then returns
 * the input unchanged.
 *
 * @module dsh-advisor-flow/redact
 */

/** Placeholder written over every redacted value. */
export const REDACTED = '[REDACTED]';

/** `sk-…` style API keys (8+ key chars after the prefix). */
const SK_PATTERN = /sk-[A-Za-z0-9_-]{8,}/g;
/** AWS access key ids. */
const AKIA_PATTERN = /AKIA[0-9A-Z]{16}/g;
/** `Bearer <token>` authorization headers — only the token is replaced. */
const BEARER_PATTERN = /Bearer\s+\S+/gi;
/**
 * `password=…` / `token: …` style assignments — only the value is replaced,
 * the key stays readable so the advisor can still reason about the field.
 */
const KEY_VALUE_PATTERN = /((?:password|token|secret|api[_-]?key)\s*[=:]\s*)\S+/gi;

/**
 * Replace every secret-shaped value in `text` with {@link REDACTED}.
 *
 * Order matters: bare token shapes run first so a value like
 * `api_key=sk-…` is fully covered even if the assignment pattern would
 * already have matched it; the assignment pattern is idempotent over the
 * placeholder (`key=[REDACTED]` rewrites to itself). Never throws; a
 * non-string input is stringified.
 *
 * @param {unknown} text material about to be sent to the advisor
 * @param {{ enabled?: boolean }} [options] `enabled: false` disables redaction
 *   entirely (the caller is responsible for surfacing that risk to the
 *   session owner).
 * @returns {string} the redacted text
 */
export function redactText(text, { enabled = true } = {}) {
    if (!enabled) {
        return typeof text === 'string' ? text : String(text);
    }
    let out = typeof text === 'string' ? text : String(text);
    out = out.replace(SK_PATTERN, REDACTED);
    out = out.replace(AKIA_PATTERN, REDACTED);
    out = out.replace(BEARER_PATTERN, `Bearer ${REDACTED}`);
    out = out.replace(KEY_VALUE_PATTERN, `$1${REDACTED}`);
    return out;
}

/** 截断通告（pi capRepositoryContext 文案对齐，git.ts:59-60）。 */
export const TRUNCATION_NOTICE =
    '\n[Repository context truncated: it exceeded the configured limit.]';

/** 字符数上限截断：超限时保留头部并追加截断通告（pi capRepositoryContext 形态）。 */
export function capRepositoryContext(value, maxChars) {
    if (value.length <= maxChars) {
        return { text: value, truncated: false };
    }
    const contentChars = Math.max(0, maxChars - TRUNCATION_NOTICE.length);
    return {
        text:
            maxChars < TRUNCATION_NOTICE.length
                ? TRUNCATION_NOTICE.slice(0, maxChars)
                : `${value.slice(0, contentChars)}${TRUNCATION_NOTICE}`,
        truncated: true,
    };
}

/**
 * 先脱敏后截断（R-02-004/AC-04）：截断作用于已脱敏文本——任何上限都不能把
 * 密钥切成低于形状阈值的残片泄漏（pi capRepositoryContext 形态移植，字符数口径）。
 */
export function redactAndCapText(text, maxChars, options = {}) {
    const source = typeof text === 'string' ? text : '';
    return capRepositoryContext(redactText(source, options), maxChars).text;
}
