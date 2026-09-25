/**
 * 工具结果行/字节双上限（pi tool-result-cap.ts 形态移植）。
 *
 * @module dsh-advisor-flow/tool-result-cap
 */

/** 头尾保留时的省略标记（pi OMITTED_MARKER 逐字）。 */
export const OMITTED_MARKER = '[... omitted tool-result section ...]';

const byteLength = (value) => Buffer.byteLength(value, 'utf8');

/** UTF-8 字节上限截断（pi capUtf8Bytes 语义：按码点累积，不切半个字符）。 */
export function capUtf8Bytes(value, maxBytes) {
    if (byteLength(value) <= maxBytes) {
        return value;
    }
    let acc = '';
    let used = 0;
    for (const char of value) {
        const width = byteLength(char);
        if (used + width > maxBytes) {
            break;
        }
        acc += char;
        used += width;
    }
    return acc;
}

const collect = (candidates, maxEntries, maxContentBytes) => {
    const selected = [];
    let used = 0;
    for (const line of candidates.slice(0, maxEntries)) {
        const next = used + byteLength(line) + (selected.length ? 1 : 0);
        if (next > maxContentBytes) {
            break;
        }
        selected.push(line);
        used = next;
    }
    return selected;
};

/**
 * 工具结果截断（pi capToolResult 算法逐条移植）：
 * 零上限即整体省略；未超限原样；超限时头/尾各保留一半行并以省略标记衔接。
 */
export function capToolResult(
    value,
    maxLines = 200,
    maxBytes = 8192
) {
    const lines = value.split('\n');
    const totalLines = lines.length;
    const totalBytes = byteLength(value);
    if ((maxLines === 0 || maxBytes === 0) && value.length > 0) {
        return {
            content: '[Tool result omitted: configured limit is zero]',
            omittedLines: totalLines,
            totalBytes,
            totalLines,
            truncated: true,
        };
    }
    if (totalLines <= maxLines && totalBytes <= maxBytes) {
        return {
            content: value,
            omittedLines: 0,
            totalBytes,
            totalLines,
            truncated: false,
        };
    }

    const markerBytes = byteLength(OMITTED_MARKER);
    if (maxBytes < markerBytes || maxLines === 1) {
        return {
            content: capUtf8Bytes(OMITTED_MARKER, maxBytes),
            omittedLines: totalLines,
            totalBytes,
            totalLines,
            truncated: true,
        };
    }
    const headCount = Math.floor((maxLines - 1) / 2);
    const tailCount = maxLines - 1 - headCount;
    const availableBytes = maxBytes - markerBytes - 2;
    const head = collect(lines, headCount, Math.floor(availableBytes / 2));
    const tail = collect(
        lines.slice(Math.max(head.length, lines.length - tailCount)),
        tailCount,
        availableBytes - byteLength(head.join('\n'))
    );
    const content = [...head, OMITTED_MARKER, ...tail].join('\n');
    return {
        content,
        omittedLines: Math.max(0, totalLines - head.length - tail.length),
        totalBytes,
        totalLines,
        truncated: true,
    };
}

/** pi 宿主默认行数上限（PI_DEFAULT_MAX_LINES；具体数值待联调核定，见 T-012）。 */
export const DEFAULT_TOOL_RESULT_MAX_LINES = 200;
/** pi 宿主默认字节上限（PI_DEFAULT_MAX_BYTES；port config 默认 8192 对齐）。 */
export const DEFAULT_TOOL_RESULT_MAX_BYTES = 8192;
