/**
 * Consultation material assembly under privacy tiers (R-02-004).
 *
 * Takes the raw material inputs available at the call site and produces the
 * single user message the advisor receives, trimmed per the configured
 * privacy tiers. Trimming happens BEFORE redaction (SOLUTION.md#数据流与信任
 * 边界图: the caller runs `redactText` on the returned text right before the
 * send). File contents are opt-in (`privacy.fileContent`, default `false`):
 * without the opt-in only file paths travel, with a note saying so
 * (R-02-004/AC-02). With `repoContext: none` the advisor is explicitly told
 * it has no repository access (R-02-004/AC-01).
 *
 * @module dsh-advisor-flow/context
 */

/** Default byte cap for `toolResults: capped` material. */
export const DEFAULT_TOOL_RESULT_MAX_BYTES = 8192;
/** Char cap for the `history: window` tail (bounded context, C-002). */
export const HISTORY_WINDOW_MAX_CHARS = 24_000;
/** Char cap for the `history: delta` slice. */
export const HISTORY_DELTA_MAX_CHARS = 8_000;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function normalizePrivacy(privacy = {}) {
    const p = isRecord(privacy) ? privacy : {};
    return {
        history: ['off', 'delta', 'window'].includes(p.history) ? p.history : 'window',
        repoContext: ['none', 'summary', 'patch'].includes(p.repoContext) ? p.repoContext : 'summary',
        toolResults: ['off', 'capped'].includes(p.toolResults) ? p.toolResults : 'capped',
        fileContent: p.fileContent === true,
        toolResultMaxBytes: typeof p.toolResultMaxBytes === 'number'
            && Number.isInteger(p.toolResultMaxBytes) && p.toolResultMaxBytes > 0
            ? p.toolResultMaxBytes
            : DEFAULT_TOOL_RESULT_MAX_BYTES,
    };
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes (whole-codepoint safe). */
export function capUtf8(text, maxBytes) {
    if (typeof text !== 'string') {
        return '';
    }
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
        return text;
    }
    let out = text;
    while (out.length > 0 && Buffer.byteLength(out, 'utf8') > maxBytes) {
        // Drop ~25% of the remaining characters per pass — bounded loops even
        // for pathological multi-byte content, exact on the final pass.
        const step = Math.max(1, Math.floor(out.length / 4));
        out = out.slice(0, out.length - step);
    }
    while (out.length > 0 && Buffer.byteLength(out, 'utf8') > maxBytes) {
        out = out.slice(0, -1);
    }
    return `${out}\n…（超出字节上限，已截断）`;
}

function historySlice(history, tier) {
    const entries = Array.isArray(history) ? history : [history];
    const lines = entries
        .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim());
    if (lines.length === 0) {
        return undefined;
    }
    const charCap = tier === 'delta' ? HISTORY_DELTA_MAX_CHARS : HISTORY_WINDOW_MAX_CHARS;
    // window/delta both keep the TAIL: the most recent context matters most.
    let joined = lines.join('\n');
    if (joined.length > charCap) {
        joined = joined.slice(joined.length - charCap);
    }
    return joined;
}

function toolResultSlice(toolResults, tier, maxBytes) {
    const items = Array.isArray(toolResults) ? toolResults : [toolResults];
    const lines = items
        .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim());
    if (tier === 'off' || lines.length === 0) {
        return undefined;
    }
    return capUtf8(lines.join('\n'), maxBytes);
}

function fileSection(files, allowContent, maxBytes) {
    const list = Array.isArray(files) ? files.filter(isRecord) : [];
    if (list.length === 0) {
        return { text: undefined, redactedContent: false };
    }
    const lines = [];
    for (const file of list) {
        const path = typeof file.path === 'string' ? file.path : String(file.path ?? '');
        if (!path) {
            continue;
        }
        if (allowContent && typeof file.content === 'string') {
            lines.push(`### ${path}\n${capUtf8(file.content, maxBytes)}`);
        } else {
            lines.push(`- ${path}（文件内容未授权外发，仅含路径）`);
        }
    }
    if (lines.length === 0) {
        return { text: undefined, redactedContent: false };
    }
    return { text: lines.join('\n'), redactedContent: !allowContent };
}

/**
 * Assemble the advisor user message from raw materials under privacy tiers.
 *
 * @param {object} materials raw inputs: `{ history?, repoContext?, toolResults?,
 *   files?, question?, draft? }` — `repoContext` is `{ summary?, patch? }`,
 *   `files` is `Array<{ path, content? }>`
 * @param {object} [privacy] resolved `advisor-flow.privacy` section
 * @returns {{ text: string, dropped: string[] }} the single user message text
 *   and a list of machine-readable notes about what was dropped and why
 */
export function buildAdvisorUserMessage(materials, privacy) {
    const mats = isRecord(materials) ? materials : {};
    const tiers = normalizePrivacy(privacy);
    const dropped = [];
    const sections = [];

    const question = typeof mats.question === 'string' ? mats.question.trim() : '';
    const draft = typeof mats.draft === 'string' ? mats.draft.trim() : '';
    if (question) {
        sections.push(`## 评审问题\n${question}`);
    }
    if (draft) {
        sections.push(`## 待评审草稿\n${draft}`);
    }

    if (tiers.history === 'off') {
        dropped.push('history:off');
    } else {
        const history = historySlice(mats.history, tiers.history);
        if (history !== undefined) {
            sections.push(`## 会话近期脉络\n${history}`);
        } else {
            dropped.push('history:empty');
        }
    }

    if (tiers.repoContext === 'none') {
        dropped.push('repoContext:none');
        // R-02-004/AC-01: the advisor must be told explicitly that it has no
        // repository access, so it cannot hallucinate repo-aware advice.
        sections.push('## 仓库上下文\n（本次请求不包含仓库内容：你没有仓库访问能力，请勿假设任何仓库状态。）');
    } else {
        const repo = isRecord(mats.repoContext) ? mats.repoContext : {};
        const body = tiers.repoContext === 'summary'
            ? (typeof repo.summary === 'string' ? repo.summary : undefined)
            : (typeof repo.patch === 'string' ? capUtf8(repo.patch, tiers.toolResultMaxBytes) : undefined);
        if (body !== undefined) {
            sections.push(`## 仓库上下文\n${body}`);
        } else {
            dropped.push(`repoContext:${tiers.repoContext}:empty`);
        }
    }

    if (tiers.toolResults === 'off') {
        dropped.push('toolResults:off');
    } else {
        const toolText = toolResultSlice(mats.toolResults, tiers.toolResults, tiers.toolResultMaxBytes);
        if (toolText !== undefined) {
            sections.push(`## 工具结果摘录\n${toolText}`);
        } else {
            dropped.push('toolResults:empty');
        }
    }

    const files = fileSection(mats.files, tiers.fileContent, tiers.toolResultMaxBytes);
    if (files.redactedContent) {
        dropped.push('files:content-not-opted-in');
    }
    if (files.text !== undefined) {
        sections.push(`## 涉及文件\n${files.text}`);
    }

    if (sections.length === 0) {
        sections.push('（无附加素材：请对当前任务给出一般性评审意见。）');
    }

    return { text: sections.join('\n\n'), dropped };
}
