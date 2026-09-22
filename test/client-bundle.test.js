import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// T-005 回归（client 装载实测）：client bundle 必须以经典脚本可解析。dsh web shell 把
// /plugins/<id>/client.js 当 classic <script> 拼进全插件合并 bundle——
// 任何裸 ESM 语句或 import.meta 都是解析期 SyntaxError，会拖垮整个
// 前端（症状：白屏 "Failed to load plugins"）。
const here = dirname(fileURLToPath(import.meta.url));

test('client bundle 是经典脚本（closure-factory CJS），无裸 ESM', () => {
    const text = readFileSync(join(here, '../lib/client.js'), 'utf8');
    assert.ok(text.includes('window.__ModuleLoader__.load('), '缺少 loader 注册入口');
    assert.ok(text.includes('"dsh-advisor-flow"'), '注册 id 必须是插件名');
    // 经典脚本编译：裸 import/export 或 import.meta 会在此抛 SyntaxError。
    assert.doesNotThrow(() => new Function(text));
});
