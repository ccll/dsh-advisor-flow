import test from 'node:test';
import assert from 'node:assert/strict';
import { gitContextNote, clampGitContextLevel } from '../lib/git-context.js';

test('R-02-006/AC-02 五态注记与 clamp：disabled/failed 不得假设工作树干净，被拦档位明示受限', () => {
    assert.equal(gitContextNote({ status: 'no-changes' }, 'full', 'full'), 'The working tree has no uncommitted changes.');
    assert.equal(gitContextNote({ status: 'not-a-repository' }, 'full', 'full'), 'No Git repository is available for this session.');
    assert.equal(gitContextNote({ status: 'failed' }, 'full', 'full'), 'Repository context could not be collected. Do not assume the working tree is clean.');
    assert.equal(gitContextNote({ status: 'disabled' }, 'full', 'full'), 'Repository context was disabled or had no disclosure budget; it was withheld. Do not assume the working tree is clean.');
    // 执行者请求超出允许档：明示受限（控制元数据，不占 git 预算）
    assert.equal(
        gitContextNote({ status: 'collected', text: 'x' }, 'full', 'summary'),
        'Repository context was limited to "summary" by user configuration; a fuller view was requested but withheld.',
    );
    // executor 只能收窄：clamp 到允许档
    assert.equal(clampGitContextLevel('full', 'summary'), 'summary');
    assert.equal(clampGitContextLevel('none', 'full'), 'none');
    assert.equal(clampGitContextLevel('summary', 'full'), 'summary');
});
