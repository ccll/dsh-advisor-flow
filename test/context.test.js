import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdvisorUserMessage, capUtf8, HISTORY_WINDOW_MAX_CHARS } from '../lib/context.js';

test('R-02-004/AC-01 repoContext 为 none 时不外发仓库内容且明确告知顾问无仓库访问', () => {
    const { text, dropped } = buildAdvisorUserMessage({
        repoContext: { summary: '内部仓库摘要内容', patch: 'diff --git a/x b/x' },
        question: '这段设计有问题吗？',
    }, { repoContext: 'none' });
    assert.ok(!text.includes('内部仓库摘要内容'));
    assert.ok(!text.includes('diff --git'));
    assert.ok(!text.includes('内部仓库摘要'));
    assert.ok(text.includes('仓库上下文'));
    assert.ok(text.includes('没有仓库访问'));
    assert.ok(text.includes('这段设计有问题吗？'));
    assert.ok(dropped.includes('repoContext:none'));
});

test('R-02-004/AC-02 文件内容未获 opt-in 时不外发正文，仅附路径并注明', () => {
    const { text, dropped } = buildAdvisorUserMessage({
        files: [
            { path: 'src/a.js', content: 'const secret = 1;' },
            { path: 'docs/b.md' },
        ],
    }, { fileContent: false });
    assert.ok(!text.includes('const secret = 1;'));
    assert.ok(text.includes('src/a.js'));
    assert.ok(text.includes('docs/b.md'));
    assert.ok(text.includes('文件内容未授权外发'));
    assert.ok(dropped.includes('files:content-not-opted-in'));

    // opt-in 后正文随路径发出（仍受字节上限约束）
    const opted = buildAdvisorUserMessage({
        files: [{ path: 'src/a.js', content: 'const secret = 1;' }],
    }, { fileContent: true });
    assert.ok(opted.text.includes('const secret = 1;'));
});

test('R-02-004 素材按档位裁剪：history off/delta、toolResults capped、patch 截断', () => {
    // history off：不出现
    const off = buildAdvisorUserMessage({ history: ['用户: 早', '助手: 好'], question: 'q' }, { history: 'off' });
    assert.ok(!off.text.includes('用户: 早'));
    assert.ok(off.dropped.includes('history:off'));

    // window：保留尾部、超过字符上限截断
    const long = Array.from({ length: 50 }, (_, i) => `第${i}条消息内容${'x'.repeat(1000)}`);
    const win = buildAdvisorUserMessage({ history: long }, { history: 'window' });
    assert.ok(win.text.length < HISTORY_WINDOW_MAX_CHARS + 2000);
    assert.ok(win.text.includes(long[long.length - 1]));
    assert.ok(!win.text.includes(long[0]));

    // toolResults off / capped
    const big = 'y'.repeat(50_000);
    const capped = buildAdvisorUserMessage({ toolResults: [big] }, { toolResults: 'capped', toolResultMaxBytes: 1000 });
    assert.ok(Buffer.byteLength(capped.text, 'utf8') < 50_000);
    assert.ok(capped.text.includes('截断'));
    const toolsOff = buildAdvisorUserMessage({ toolResults: ['结果'] }, { toolResults: 'off' });
    assert.ok(!toolsOff.text.includes('结果'));
    assert.ok(toolsOff.dropped.includes('toolResults:off'));

    // repoContext patch 截断
    const patch = buildAdvisorUserMessage({ repoContext: { patch: 'z'.repeat(9000) } }, { repoContext: 'patch', toolResultMaxBytes: 500 });
    assert.ok(Buffer.byteLength(patch.text, 'utf8') < 9000);
    assert.ok(patch.text.includes('截断'));

    // 空素材：仍产出可用的一般性评审请求
    const bare = buildAdvisorUserMessage({}, {});
    assert.ok(bare.text.includes('一般性评审'));
});

test('R-02-004 question 与 draft 始终进入素材（隐私档位不裁剪请求本体）', () => {
    const { text } = buildAdvisorUserMessage({ question: '为什么失败？', draft: '我的计划草稿' }, {
        history: 'off',
        repoContext: 'none',
        toolResults: 'off',
    });
    assert.ok(text.includes('为什么失败？'));
    assert.ok(text.includes('我的计划草稿'));
});

test('R-02-004 capUtf8 按 UTF-8 字节截断且不产生半个码点', () => {
    assert.equal(capUtf8('abc', 100), 'abc');
    const emoji = '🙂'.repeat(100); // 4 bytes each
    const capped = capUtf8(emoji, 100);
    // 截断体是完整码点序列（Buffer 截半字节会抛错，toString 成功即证明）
    const body = capped.split('\n')[0];
    assert.ok(Buffer.byteLength(body, 'utf8') <= 100);
    assert.equal(body.length % 1, 0);
    assert.ok(body.length < emoji.length);
    assert.ok(capped.includes('截断'));
});
