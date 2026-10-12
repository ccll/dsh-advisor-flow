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

test('T-028 挂载：工厂执行后 apply 在 plugins.row.config keyed 槽注册行配置卡', () => {
    const text = readFileSync(join(here, '../lib/client.js'), 'utf8');
    assert.ok(!text.includes('settings.plugin.item'), '旧挂点已退役（0.2.0 全宿主零引用）');
    let loaded;
    const windowStub = { __ModuleLoader__: { load: (spec) => { loaded = spec; } } };
    new Function('window', text)(windowStub); // 经典脚本语义装载
    assert.equal(loaded.id, 'dsh-advisor-flow');

    const React = {
        Fragment: 'Fragment',
        createElement: (type, props) => ({ type, props }),
        useRef: (initial) => ({ current: initial }),
        useEffect: () => {},
    };
    const slotCalls = [];
    const registrations = [];
    const slots = {
        inject: (name, thunk) => {
            slotCalls.push({ name, thunk });
        },
        register: (options, component) => {
            registrations.push({ options, component });
            return Promise.resolve(() => {});
        },
    };
    const ctx = {
        logger: () => ({ warn() {}, info() {}, error() {} }),
        connection: { rpc: {} },
        slots,
    };
    const mod = loaded.factory((id) => {
        if (id === 'react') {
            return React;
        }
        throw new Error(`unexpected require: ${id}`);
    });
    assert.equal(typeof mod.apply, 'function');
    const applied = mod.apply(ctx);
    assert.equal(slotCalls.length, 1, '同步注册 keyed 槽');
    assert.equal(slotCalls[0].name, 'plugins.row.config');
    // 宿主契约模板：thunk → register(options, component)
    slotCalls[0].thunk();
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].options.name, 'plugins.row.config');
    assert.equal(registrations[0].options.key, 'dsh-advisor-flow#advisor-flow');
    assert.equal(typeof registrations[0].component, 'function');
    assert.equal(typeof applied.refresh, 'function');

    // ownerProps 契约：view=summary 一行摘要、view=page 整卡容器（ref 由内部 useRef 提供）
    const summary = registrations[0].component({ view: 'summary' });
    assert.ok(String(summary.type) === 'Fragment', 'summary 视图渲染一行摘要');
    const page = registrations[0].component({ view: 'page' });
    assert.equal(page.type, 'div');
    assert.equal(typeof page.props.ref, 'object');
});
