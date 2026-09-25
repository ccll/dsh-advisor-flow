import test from 'node:test';
import assert from 'node:assert/strict';
import { collectGitContext, advisorRepositoryContext, clampGitContextLevel } from '../lib/git-context.js';
import { buildAdvisorMessageText } from '../lib/materials.js';

test('R-02-004/AC-01 仓库上下文档位为关闭档时：采集返回 disabled，注记明示无仓库访问（不得假设干净）', () => {
    const result = collectGitContext(process.cwd(), 'off', 20000, (v) => v, (() => {
        throw new Error('should not run git');
    }));
    assert.equal(result.status, 'disabled');
    const rendered = advisorRepositoryContext(result, 'none', 'none', 10000);
    assert.ok(!rendered.includes('内部仓库'));
    assert.ok(rendered.includes('Do not assume the working tree is clean'));
    // 组装层：off 档位不产生正文，仅注记（六区布局）
    const text = buildAdvisorMessageText({ conversation: '', changes: rendered, question: '问' });
    assert.ok(text.includes('Targeted focus:\n问'));
});

test('R-02-004/AC-06 执行者请求档位超出配置档：clamp 收窄并经注记明示受限', () => {
    assert.equal(clampGitContextLevel('full', 'summary'), 'summary');
    assert.equal(clampGitContextLevel('full', 'off'), 'none');
    const result = { status: 'collected', level: 'summary', text: 'M a.js' };
    const rendered = advisorRepositoryContext(result, 'full', 'summary', 10000);
    assert.ok(rendered.includes('was limited to "summary" by user configuration'));
    // 渲染层不再重复脱敏（采集期已脱敏），转义后按预算截断
    assert.ok(rendered.includes('M a.js'));
});

test('R-02-006/AC-03 预算切分：git 预算 = min(gitMax, ⌊ctxMax/2⌋)，脉络预算 = ctxMax − 仓库区实际占用', async () => {
    const { advisorGitContextBudget } = await import('../lib/materials.js');
    assert.equal(advisorGitContextBudget(15000, 20000), 7500);
    assert.equal(advisorGitContextBudget(4000, 20000), 2000);
    // 渲染正文占用计入脉络预算扣除项
    const rendered = advisorRepositoryContext({ status: 'collected', level: 'summary', text: 'x'.repeat(300) }, 'summary', 'summary', 10000);
    const remainder = 15000 - rendered.length;
    assert.ok(remainder > 0 && remainder < 15000);
});
