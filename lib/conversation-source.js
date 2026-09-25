/**
 * 会话脉络重建（Conversation Source，R-02-006；SOLUTION.md#素材装配器）。
 *
 * 以宿主 `sessionQuery.observeSession` 的有序事件流为源（T-012 spike 判据①）：
 * 过滤四类 SurfaceEvent → 按 seq 应用 surfaceOp（append 追加；compaction 的
 * replace 区间以替换节点覆盖）→ 有序消息节点 → 按 pi conversationEntry 口径
 * 渲染（User:/Executor:/[Tool Call: …]/[Tool Result for …]）+ per-tool 披露
 * 策略（C-7：full|summary|exclude）+ selectRecentEntries 省略标记与字符预算。
 *
 * 边界（宿主契约）：`ignorable` 事件跳过；未识别的非 ignorable 类型 fail-closed
 * 拒绝重建。
 *
 * @module dsh-advisor-flow/conversation-source
 */

import { DEFAULT_TOOL_RESULT_MAX_BYTES, DEFAULT_TOOL_RESULT_MAX_LINES, capToolResult } from './tool-result-cap.js';
import { redactText } from './redact.js';


/** 四类消息产出事件（宿主 SurfaceEventType；system 面不入脉络）。 */
const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);
/** 已知非表面词汇（宿主事件流常见伴生类型；宿主新词汇以 ignorable 标记兜底）。 */
const KNOWN_NON_SURFACE = new Set(['system/message', 'tool/call', 'session/started', 'session/ended', 'agent/created', 'agent/disposed', 'turn/start', 'step/start', 'permission/preset', 'sandbox/mode', 'approval/policy', 'agent/inbox/spliced']);
const isString = (value) => typeof value === 'string';
const isRecord = (value) => value !== null && typeof value === 'object';
/** 文本抽取：text 块按序拼接；tool-result 块递归其内层 content（pi textFrom 形态）。 */
export function textFrom(content) {
    const parts = Array.isArray(content) ? content : [];
    return parts
        .map((part) => {
            if (isString(part)) {
                return part;
            }
            if (isRecord(part) && part.type === 'text' && isString(part.text)) {
                return part.text;
            }
            if (isRecord(part) && part.type === 'tool-result') {
                // dsh ToolResultBlock：正文在其内层 content 块数组（staging v9 实测定位）。
                return textFrom(part.content);
            }
            return '';
        })
        .join('\n')
        .trim();
}

const redactOf = (value, redact) => (redact ? redactText(value) : value);

/**
 * 有序面重建（T-012 spike 定稿算法）：append 追加；replace 以替换节点覆盖
 * [startSeq, endSeq] 区间（compaction 压缩语义）；ignorable 跳过。
 */
export function reconstructSurface(events) {
    const surface = new Map();
    for (const event of events ?? []) {
        if (isRecord(event) && event.type === 'system/message') {
            // 系统提示面不入脉络（pi 无对应条目）。压缩摘要以 replace 节点承载
            // （宿主 compaction 语义）——按 pi conversationEntry 的 compaction
            // 分支渲染为 [System Compaction Summary]。
            if (typeof event.surfaceOp === 'object' && event.surfaceOp?.op === 'replace') {
                const op = event.surfaceOp;
                for (const node of [...surface.values()]) {
                    if (node.seq >= op.startSeq && node.seq <= op.endSeq) {
                        surface.delete(node.seq);
                    }
                }
                surface.set(event.seq, event);
            }
            continue;
        }
        if (!isRecord(event) || !SURFACE_EVENT_TYPES.has(event.type)) {
            // 宿主契约：未识别的必需（非 ignorable）表面类型可能改变其余日志的
            // 解释——fail-closed 拒绝重建；已知非表面词汇与 ignorable 标记跳过。
            if (isRecord(event) && event.type && event.ignorable !== true && !KNOWN_NON_SURFACE.has(event.type)) {
                throw new Error(`Unrecognized required session event type: ${event.type}`);
            }
            continue;
        }
        const op = event.surfaceOp ?? 'append';
        if (typeof op === 'object' && op?.op === 'replace') {
            for (const node of [...surface.values()]) {
                if (node.seq >= op.startSeq && node.seq <= op.endSeq) {
                    surface.delete(node.seq);
                }
            }
        }
        surface.set(event.seq, event);
    }
    return [...surface.values()].sort((a, b) => a.seq - b.seq);
}

/** toolCall 块参数文本（dsh 原始 JSON 字符串直用；pi 为对象后 stringify）。 */
function argumentsText(part, redact) {
    const raw = isString(part?.arguments) ? part.arguments : JSON.stringify(part?.arguments) ?? 'undefined';
    return redactOf(raw, redact);
}

/** Executor 行渲染（pi assistantEntry 口径：正文 + 工具调用按策略披露）。 */
export function assistantEntry(message, policies, redact) {
    const parts = [];
    const text = textFrom(message?.content);
    if (text) {
        parts.push(redactOf(text, redact));
    }
    for (const part of Array.isArray(message?.content) ? message.content : []) {
        if (!isRecord(part) || part.type !== 'tool-call') {
            continue;
        }
        const toolName = isString(part.name) ? part.name : 'unknown';
        const policy = policies[toolName] ?? 'full';
        if (policy === 'exclude') {
            parts.push(`[Tool Call: ${toolName}] (excluded by Advisor tool policy)`);
            continue;
        }
        if (policy === 'summary') {
            parts.push(`[Tool Call: ${toolName}] (arguments omitted by Advisor tool policy: summary)`);
            continue;
        }
        parts.push(`[Tool Call: ${toolName}(${redactOf(argumentsText(part, redact), false)})]`);
    }
    return parts.length > 0 ? `Executor: ${parts.join('\n')}` : undefined;
}

/** 工具结果行（pi toolResultEntry 口径逐条；工具名经 tool/call 配对取得）。 */
export function toolResultEntry(message, toolResultMaxLines, toolResultMaxBytes, policies, redact, toolName) {
    const name = isString(toolName) ? toolName : 'unknown';
    const policy = policies[name] ?? 'full';
    const status = message?.isError ? 'error' : 'success';
    const source = textFrom(message?.content);
    if (policy === 'exclude') {
        return `[Tool Result for ${name}] (excluded by Advisor tool policy)`;
    }
    if (policy === 'summary') {
        const capped = capToolResult(source, toolResultMaxLines, toolResultMaxBytes);
        return `[Tool Result for ${name}] (output omitted by Advisor tool policy: summary; status: ${status}; ${capped.totalLines} lines, ${capped.totalBytes} bytes; source output was${capped.truncated ? '' : ' not'} truncated)`;
    }
    const disclosed = redactOf(source, redact);
    const capped = capToolResult(disclosed, toolResultMaxLines, toolResultMaxBytes);
    return `[Tool Result for ${name}] (${message?.isError ? 'Error ' : ''}output):\n${capped.content}`;
}

/**
 * 单条渲染（pi conversationEntry 口径；R-02-006/AC-04 素材按档位裁剪）。
 * @param {object} event 一个表面事件节点（reconstructSurface 产物）
 * @param {Map<string, string>} toolNames callId → 工具名（tool/call 事件配对）
 */
export function conversationEntry(event, toolResultMaxLines, toolResultMaxBytes, policies, redact, toolNames = new Map()) {
    if (!isRecord(event) || !isRecord(event.data)) {
        return undefined;
    }
    if (event.type === 'system/message') {
        // 压缩摘要节点（replace 承载，reconstructSurface 仅保留该形态）：
        // pi conversation.ts conversationEntry compaction 分支逐字。
        const text = textFrom(event.data.message?.content);
        return text ? `[System Compaction Summary]: ${redactOf(text, redact)}` : undefined;
    }
    if (event.type === 'user/message') {
        const text = textFrom(event.data.message?.content);
        return text ? `User: ${redactOf(text, redact)}` : undefined;
    }
    if (event.type === 'assistant/message') {
        return assistantEntry(event.data.message, policies, redact);
    }
    if (event.type === 'tool/result') {
        const message = event.data.message;
        const callId = message?.source?.callId;
        return toolResultEntry(message, toolResultMaxLines, toolResultMaxBytes, policies, redact, toolNames.get(callId));
    }
    return undefined;
}

const omissionMarker = (omitted) =>
    `[Older context omitted: ${omitted} complete entr${omitted === 1 ? 'y' : 'ies'}]`;

/** 最近条目选择（pi selectRecentEntries 逐条：省略标记 + 最新条截断 + 字符预算）。 */
export function selectRecentEntries(entries, maxChars) {
    const separator = '\n\n';
    const joined = entries.join(separator);
    if (joined.length <= maxChars || maxChars === Number.MAX_SAFE_INTEGER) {
        return joined;
    }
    const newestTruncated = '[Newest entry truncated]';
    if (entries.length === 1) {
        const prefix = `${newestTruncated}${separator}`;
        return `${prefix}${entries[0].slice(0, Math.max(0, maxChars - prefix.length))}`.slice(0, maxChars);
    }
    const selected = [];
    let selectedLength = 0;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        const candidateCount = selected.length + 1;
        const omitted = entries.length - candidateCount;
        const candidateLength =
            selectedLength + entry.length + (selected.length > 0 ? separator.length : 0);
        if (omissionMarker(omitted).length + separator.length + candidateLength > maxChars) {
            break;
        }
        selected.unshift(entry);
        selectedLength = candidateLength;
    }
    const omitted = entries.length - Math.max(1, selected.length);
    const marker = omissionMarker(omitted);
    if (selected.length > 0) {
        return `${marker}${separator}${selected.join(separator)}`;
    }
    const prefix = `${marker}${separator}${newestTruncated}${separator}`;
    return `${prefix}${entries.at(-1)?.slice(0, Math.max(0, maxChars - prefix.length)) ?? ''}`.slice(0, maxChars);
}

/**
 * 会话脉络文本（pi recentConversation 语义）：
 * 重建有序面 → 逐条渲染 → 字符预算内的最新条目选择。
 * @param {object[]} events 会话有序事件流（sessionQuery.observeSession().events）
 */
export function recentConversation(events, {
    maxChars = 15000,
    toolResultMaxLines = DEFAULT_TOOL_RESULT_MAX_LINES,
    toolResultMaxBytes = DEFAULT_TOOL_RESULT_MAX_BYTES,
    policies = {},
    redact = false,
} = {}) {
    if (maxChars === 0) {
        return '';
    }
    const surface = reconstructSurface(events ?? []);
    // 工具名配对：tool/call 事件按 callId 登记（ToolResultMessage 不携带名字）。
    const toolNames = new Map();
    for (const event of events ?? []) {
        if (event?.type === 'tool/call' && isString(event.data?.callId)) {
            toolNames.set(event.data.callId, isString(event.data.name) ? event.data.name : 'unknown');
        }
    }
    const entries = surface
        .map((node) => conversationEntry(node, toolResultMaxLines, toolResultMaxBytes, policies, redact, toolNames))
        .filter((entry) => isString(entry));
    return selectRecentEntries(entries, maxChars);
}
