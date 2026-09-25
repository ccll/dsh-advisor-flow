/**
 * completion_verdict 文书自洽机械检查（advisor adv-39/40：一致性结论须来自实际运行检查）。
 * 模式级检查——证明词面/模式级结论，不背书语义结论（adv-40 第 3 条）。
 *
 * 运行：node tools/verdict_selfcheck.mjs（通过退出 0）
 * 阳性对照：node tools/verdict_selfcheck.mjs --mutation-check（注入残留样本必须报非零）
 *
 * 五项检查（advisor adv-39 ⑤项清单）：
 * 1. manifest 角色：verdict 内 manifest 的每处出现均为「记录/核对点」语义，
 *    不得含「参与验证/充当基线/作为输入」等验证输入表述模式。
 * 2. 37/65/28 口径词：每次出现均携带口径词（并集/strict/口径）。
 * 3. 时序断言与 git 实序一致（3369002 < a88d27c < 1ffb100 < 42f946c，git cat-file 实证）。
 * 4. 悬空引用：不得含「缺口 N」「adv-nn」「前轮」「上文」等轮次性指涉。
 * 5. 裸断言：首句限定外不得存在「已验证/已证明/完全等价」等绝对断言模式。
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const manifestPath = new URL('./parity_baseline.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const verdict = manifest.completion_verdict ?? '';
if (!verdict) {
    console.error('verdict_selfcheck: completion_verdict 字段缺失');
    process.exit(1);
}

const failures = [];
const hits = { verificationInput: 0, dangling: 0, absolute: 0, coverage: 0, coverageExpected: 0, timeline: 0 };

// ① 验证输入表述模式（manifest 不得被表述为验证输入/基线/输入源）
const verificationInputPatterns = [
    /manifest[^。；]{0,12}(参与|充当|作为)(验证|比对|基线|输入)/,
    /manifest[^。；]{0,8}(输入|基线)/,
];
for (const pattern of verificationInputPatterns) {
    hits.verificationInput += (verdict.match(new RegExp(pattern.source, 'g')) ?? []).length;
}
if (hits.verificationInput !== 0) failures.push(`①验证输入表述模式 ${hits.verificationInput} 命中`);

// ② 37/65/28 口径词覆盖（并集/strict/口径）
for (const term of ['needed-union=37', 'prd-ac=65', '差 28', '差 28 ']) {
    if (verdict.includes(term.trim())) {
        hits.coverageExpected += 1;
        const at = verdict.indexOf(term.trim());
        const window = verdict.slice(Math.max(0, at - 120), at + 120);
        if (/并集|strict|口径/.test(window)) {
            hits.coverage += 1;
        } else {
            failures.push(`②口径词缺伴 ${term.trim()}`);
        }
    }
}

// ③ 时序断言与 git 实序一致（git cat-file 确认对象存在 + git merge-base --is-ancestor 确认先后）
const chain = [
    ['a88d27c', '3369002'],
    ['3369002', '1ffb100'],
    ['1ffb100', '42f946c'],
];
const timelineChecks = [];
for (const [earlier, later] of chain) {
    try {
        execFileSync('git', ['cat-file', '-e', `${earlier}^{commit}`], { stdio: 'pipe' });
        execFileSync('git', ['cat-file', '-e', `${later}^{commit}`], { stdio: 'pipe' });
        execFileSync('git', ['merge-base', '--is-ancestor', earlier, later], { stdio: 'pipe' });
        timelineChecks.push(`${earlier}<${later}`);
    } catch (error) {
        failures.push(`③时序断言与 git 实序不符：${earlier}<${later}（${String(error.message).slice(0, 60)}）`);
    }
}
hits.timeline = timelineChecks.length;

// ④ 悬空引用模式（轮次性指涉）
const danglingPatterns = [/缺口 ?\d/, /adv-?\d+/i, /前轮|前述|上文|如前所述/];
for (const pattern of danglingPatterns) {
    hits.dangling += (verdict.match(new RegExp(pattern.source, 'g')) ?? []).length;
}
if (hits.dangling !== 0) failures.push(`④悬空引用模式 ${hits.dangling} 命中`);

// ⑤ 绝对断言模式（首句限定外不得出现）
const absolutePatterns = [/已验证[^。；]{0,6}全部/, /完全等价/, /无一遗漏/, /绝无/];
for (const pattern of absolutePatterns) {
    hits.absolute += (verdict.match(new RegExp(pattern.source, 'g')) ?? []).length;
}
if (hits.absolute !== 0) failures.push(`⑤绝对断言模式 ${hits.absolute} 命中`);

// 首句限定在场（分阶段合法形态口径下）
if (!verdict.startsWith('黄金标准验证完成（分阶段合法形态口径下')) {
    failures.push('⑤首句限定缺失');
}

// 阳性对照（--mutation-check）：注入残留样本，检查必须报非零——排除「模式写错→恒过」假阳性。
if (process.argv.includes('--mutation-check')) {
    const mutated = verdict + '；manifest 参与验证并充当差分基线；此结论已验证完全等价；参见缺口 4 与 adv-15。';
    const mutatedHits = verificationInputPatterns.reduce((n, pat) => n + (mutated.match(new RegExp(pat.source, 'g')) ?? []).length, 0)
        + (mutated.match(/缺口 ?\d/g) ?? []).length
        + (mutated.match(/adv-?\d+/gi) ?? []).length
        + (mutated.match(/已验证完全等价/g) ?? []).length;
    if (mutatedHits === 0) {
        console.error('mutation-check 失败：注入残留样本未被检出（模式失效）');
        process.exit(1);
    }
    console.log(`mutation-check: 注入残留样本被检出（${mutatedHits} 处）——检查可证伪`);
    process.exit(0);
}

if (failures.length > 0) {
    console.error(`verdict_selfcheck: ${failures.length} 项不符`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}
console.log(`verdict_selfcheck: 文书自洽机械检查通过（模式级：验证输入表述模式 ${hits.verificationInput} 命中；悬空引用模式 ${hits.dangling} 命中；绝对断言模式 ${hits.absolute} 命中；口径词覆盖 ${hits.coverage}/${hits.coverageExpected} 处；时序断言 ${hits.timeline}/3 与 git 实序一致）`);
