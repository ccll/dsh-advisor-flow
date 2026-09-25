/**
 * git 上下文构建器（Git Context Builder，R-02-004/006；SOLUTION.md#git 上下文构建器）。
 *
 * 五态采集语义逐条移植 pi 0.8.2 collectGitContext（git.ts:116-187）：
 * disabled / not-a-repository / failed / no-changes / collected；
 * 跨命令共享 5s 总时限与 16MB 缓冲、绝不经过 shell、summary 档省略 patch、
 * 脱敏先于调用方截断。
 *
 * @module dsh-advisor-flow/git-context
 */

import { execFileSync } from 'node:child_process';
import { capRepositoryContext } from './redact.js';
import { escapeRepositoryText } from './materials.js';

const GIT_TOTAL_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
/** git 空树对象：尚无提交的仓库以此作 diff 基线（pi 同源常量，git.ts:78）。 */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** 仓库上下文档位（执行者档位 none|summary|full；配置层 off 与 none 同义）。 */
export const GIT_CONTEXT_LEVELS = ['none', 'summary', 'full'];

const LEVEL_RANK = { none: 0, off: 0, summary: 1, full: 2 };

/** 执行者只能收窄（R-01-001/AC-06）：请求档位高于允许档位时被收窄。 */
export function clampGitContextLevel(requested, allowed) {
    const wanted = LEVEL_RANK[requested];
    if (wanted === undefined) {
        return 'none';
    }
    const allowedRank = LEVEL_RANK[allowed] ?? 1;
    return wanted <= allowedRank ? requested : (allowedRank === 0 ? 'none' : allowedRank === 1 ? 'summary' : 'full');
}

const STATUS_NOTES = {
    disabled:
        'Repository context was disabled or had no disclosure budget; it was withheld. Do not assume the working tree is clean.',
    failed:
        'Repository context could not be collected. Do not assume the working tree is clean.',
    'no-changes': 'The working tree has no uncommitted changes.',
    'not-a-repository': 'No Git repository is available for this session.',
};

/** 已披露状态（collected）在被拦档位时需明示受限（pi LEVEL_WITHHELD）。 */
const LEVEL_WITHHELD = { collected: true };

/** 档位受限注记（pi gitContextNote；R-02-006/AC-02）。 */
export function gitContextNote(result, requested, allowed) {
    if (requested !== allowed && LEVEL_WITHHELD[result?.status] === true) {
        return `Repository context was limited to "${allowed}" by user configuration; a fuller view was requested but withheld.`;
    }
    return STATUS_NOTES[result?.status];
}

/** 跨命令共享总时限，病态仓库不能把各命令超时累加（pi deadlineRunner）。 */
function deadlineRunner() {
    const expiresAt = Date.now() + GIT_TOTAL_TIMEOUT_MS;
    return (args, cwd) => {
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) {
            throw new Error('Git context collection exceeded its time budget.');
        }
        return execFileSync('git', args, {
            cwd,
            encoding: 'utf-8',
            maxBuffer: GIT_MAX_BUFFER,
            // 绝不经过 shell：参数固定，不得被重新解析。
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: remaining,
            windowsHide: true,
        });
    };
}

/** 解析 diff 基线：无任何提交时回退 git 空树对象（pi diffBase 形态）。 */
const diffBase = (run, cwd) => {
    try {
        run(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
        return 'HEAD';
    } catch {
        return EMPTY_TREE;
    }
};

/**
 * 采集仓库上下文（pi collectGitContext 语义移植；五态）：
 * summary 档省略 patch（git 从未触及行可复现密钥，hunk 头随之省略）；
 * 脱敏先于调用方截断——上限不可能把密钥切成可读残片。
 */
export function collectGitContext(
    cwd,
    level,
    maxChars,
    redact = (value) => value,
    run = deadlineRunner()
) {
    if (level === 'off' || level === 'none' || maxChars <= 0) {
        return { level: 'off', status: 'disabled', text: '' };
    }
    try {
        run(['rev-parse', '--is-inside-work-tree'], cwd);
    } catch (error) {
        return {
            detail: error instanceof Error ? error.message : String(error),
            level,
            status: 'not-a-repository',
            text: '',
        };
    }

    try {
        const base = diffBase(run, cwd);
        const nameStatus = run(['diff', '--name-status', base], cwd).trim();
        const shortstat = run(['diff', '--shortstat', base], cwd).trim();
        const untracked = run(['ls-files', '--others', '--exclude-standard'], cwd).trim();

        if (!(nameStatus || untracked)) {
            return { level, status: 'no-changes', text: '' };
        }

        const sections = [
            'Working-tree changes against the last commit (staged and unstaged).',
            nameStatus ? `Changed files:\n${nameStatus}` : '',
            shortstat ? `Totals: ${shortstat}` : '',
            untracked
                ? `Untracked files (names only, contents withheld):\n${untracked}`
                : '',
        ];

        if (level === 'full') {
            const patch = run(['diff', base], cwd);
            sections.push(
                patch.trim()
                    ? `Patch:\n${patch}`
                    : 'Patch: (no tracked-file content changes)'
            );
        } else {
            sections.push(
                'Full patch withheld by configuration; file contents were not disclosed.'
            );
        }

        // 脱敏先于调用方截断：上限不可能把密钥切成可读残片。
        return {
            level,
            status: 'collected',
            text: redact(sections.filter(Boolean).join('\n\n')),
        };
    } catch (error) {
        return {
            detail: error instanceof Error ? error.message : String(error),
            level,
            status: 'failed',
            text: '',
        };
    }
}

/**
 * 按预算渲染仓库上下文（pi advisorRepositoryContext 语义）：
 * 注记为控制元数据不占 git 预算；采集期已脱敏的正文在此转义后按字符预算截断。
 */
export function advisorRepositoryContext(result, requested, allowed, budget, redactOptions = {}) {
    const note = gitContextNote(result, requested, allowed);
    const payload = result?.text
        ? capRepositoryContext(escapeRepositoryText(result.text), budget).text
        : '';
    return [note, payload].filter(Boolean).join('\n\n');
}
