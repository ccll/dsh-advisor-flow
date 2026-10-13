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

test('R-02-001/AC-01 T-028 挂载：工厂执行后 apply 在 plugins.row.config keyed 槽注册行配置卡', () => {
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
    const registrations = [];
    const slots = {
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
    // 直接同步注册（不等槽声明——等声明会 park 激活，慢设备输给 boot 门审计竞态）
    assert.equal(registrations.length, 1, 'apply 内直接注册 keyed 槽');
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

test('R-02-001/AC-01 槽未声明时注册重试且不阻塞激活（手机端竞态回归）', async () => {
    const text = readFileSync(join(here, '../lib/client.js'), 'utf8');
    let loaded;
    const windowStub = { __ModuleLoader__: { load: (spec) => { loaded = spec; } } };
    new Function('window', text)(windowStub);

    const React = {
        Fragment: 'Fragment',
        createElement: (type, props) => ({ type, props }),
        useRef: (initial) => ({ current: initial }),
        useEffect: () => {},
    };
    const registrations = [];
    const scheduled = [];
    let calls = 0;
    const slots = {
        register: (options, component) => {
            calls += 1;
            if (calls === 1) {
                throw new Error('slot "plugins.row.config" is not declared (a parent entry\'s children table must declare it)');
            }
            registrations.push({ options, component });
            return Promise.resolve(() => {});
        },
    };
    const ctx = {
        logger: () => ({ warn() {}, info() {}, debug() {}, error() {} }),
        connection: { rpc: {} },
        slots,
        setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
    };
    const mod = loaded.factory((id) => {
        if (id === 'react') {
            return React;
        }
        throw new Error(`unexpected require: ${id}`);
    });
    const applied = mod.apply(ctx);
    assert.equal(registrations.length, 0, '未声明时不注册');
    assert.equal(scheduled.length, 1, '安排了 timer 重试');
    assert.equal(scheduled[0].ms, 200);
    await scheduled[0].fn();
    assert.equal(registrations.length, 1, '声明就绪后重试注册成功');
    assert.equal(typeof applied.refresh, 'function');
});

