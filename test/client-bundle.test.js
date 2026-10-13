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

/** 装载 bundle 工厂（经典脚本语义）并断言旧挂点退役。 */
function loadBundleFactory() {
    const text = readFileSync(join(here, '../lib/client.js'), 'utf8');
    assert.ok(!text.includes('settings.plugin.item'), '旧挂点已退役（0.2.0 全宿主零引用）');
    assert.ok(!text.includes('plugins.row.config'), '行级槽已退役（bundle 级 dsh-context 同构）');
    let loaded;
    const windowStub = { __ModuleLoader__: { load: (spec) => { loaded = spec; } } };
    new Function('window', text)(windowStub);
    assert.equal(loaded.id, 'dsh-advisor-flow');
    return loaded;
}

const REACT_STUB = {
    Fragment: 'Fragment',
    createElement: (type, props) => ({ type, props }),
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
};

function runFactory(loaded, ctx) {
    const mod = loaded.factory((id) => (id === 'react' ? REACT_STUB : Promise.reject(new Error(`unexpected require: ${id}`))));
    return mod.apply(ctx);
}

test('client bundle 是经典脚本（closure-factory CJS），无裸 ESM', () => {
    const text = readFileSync(join(here, '../lib/client.js'), 'utf8');
    assert.ok(text.includes('window.__ModuleLoader__.load('), '缺少 loader 注册入口');
    assert.ok(text.includes('"dsh-advisor-flow"'), '注册 id 必须是插件名');
    // 经典脚本编译：裸 import/export 或 import.meta 会在此抛 SyntaxError。
    assert.doesNotThrow(() => new Function(text));
});

test('R-02-001/AC-01 T-030 挂载：configForms 管线 + whileServed 门控注册 bundle 配置卡（dsh-context 同构）', async () => {
    const loaded = loadBundleFactory();

    const injected = [];
    const registered = [];
    let watched;
    let effectCalls = 0;
    const configForms = {
        get: (ns) => {
            assert.equal(ns, 'advisor-flow', '控制器按 settings 命名空间获取');
            return { ensure() {}, subscribe() { return () => {}; } };
        },
        whileServed: (namespaces, registerFn) => {
            watched = namespaces;
            // served 即挂卡（宿主门控语义）；返回宿主 off
            return registerFn();
        },
    };
    const slots = {
        register: (options, component) => {
            registered.push({ options, component });
            return () => {};
        },
        inject: (name, factory) => {
            const outcome = factory(); // factory 内部走 slots.register
            injected.push({ name, outcome });
            return outcome;
        },
    };
    const ctx = {
        logger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
        connection: { rpc: {} },
        slots,
        inject: (names, fn) => fn({ configForms }),
        effect: (fn) => { effectCalls += 1; return fn(); },
    };
    const applied = runFactory(loaded, ctx);
    await Promise.resolve();
    assert.equal(effectCalls, 1, '注册整体活在 ctx.effect 内（apply 帧零 slots 触碰）');
    assert.deepEqual(watched, ['advisor-flow'], 'whileServed 监听本插件命名空间');
    assert.equal(injected.length, 1, 'whileServed served 后注册 keyed 槽');
    assert.equal(injected[0].name, 'plugins.bundle.config', '挂点=bundle 配置页（dsh-context 同构）');
    assert.equal(registered[0].options.key, 'dsh-advisor-flow', 'key=包名（宿主契约 entryKey=包名）');
    assert.equal(registered[0].options.locale, undefined, 'locale 未声明即不注册（F2：卡片零 locale 消费）');
    assert.equal(registered[0].options.name, 'plugins.bundle.config');
    assert.equal(typeof registered[0].component, 'function');
    assert.equal(typeof applied.refresh, 'function');

    // ownerProps 契约：bundle 配置页渲染整卡（组件返回 div 容器，useRef 挂 DOM）
    const page = registered[0].component({ view: 'page' });
    assert.equal(page.type, 'div');
    assert.equal(typeof page.props.ref, 'object');
});

test('R-02-001/AC-01 configForms 缝缺失降级：不注册、告警恰好一条、apply 正常返回（boot 不受累）', async () => {
    const text = readFileSync(join(here, '../lib/client.js'), 'utf8');
    let loaded;
    const windowStub = { __ModuleLoader__: { load: (spec) => { loaded = spec; } } };
    new Function('window', text)(windowStub);
    const warnings = [];
    const registered = [];
    const slots = { register: (options, component) => { registered.push({ options, component }); return () => {}; } };
    const ctx = {
        logger: () => ({ warn: (message) => warnings.push(String(message)), info() {}, error() {}, debug() {} }),
        connection: { rpc: {} },
        slots,
        inject: (names, fn) => fn({}), // configForms 缝不可用
        effect: (fn) => fn(),
    };
    const applied = runFactory(loaded, ctx);
    await Promise.resolve();
    assert.equal(registered.length, 0, 'configForms 缝缺失不注册');
    assert.equal(warnings.length, 1, '降级告警恰好一条');
    assert.match(warnings[0], /configForms/, '告警指明 configForms 缝');
    assert.equal(typeof applied.refresh, 'function', 'apply 正常返回——boot 不受累');
});

test('R-02-001/AC-01 whileServed 未服务不挂卡、恢复服务后注册（宿主官方门控回归）', async () => {
    const text = readFileSync(join(here, '../lib/client.js'), 'utf8');
    let loaded;
    const windowStub = { __ModuleLoader__: { load: (spec) => { loaded = spec; } } };
    new Function('window', text)(windowStub);

    const registered = [];
    let slotInjects = 0;
    let registerCallback;
    const slots = {
        register: (options, component) => { registered.push({ options, component }); return () => {}; },
        inject: (slotName, factory) => { slotInjects += 1; const value = factory(); return value; },
    };
    // whileServed 桩：模拟宿主门控——watched 命名空间未服务时不调用注册回调
    let watched;
    const configForms = {
        get: (ns) => ({ ensure() {}, subscribe() { return () => {}; } }),
        whileServed: (namespaces, callback) => {
            watched = namespaces;
            registerCallback = callback; // 未服务：只记回调，不执行
            return () => {};
        },
    };
    const ctx = {
        logger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
        connection: { rpc: {} },
        slots,
        inject: (names, fn) => fn({ configForms }),
        effect: (fn) => fn(),
    };
    const applied = runFactory(loaded, ctx);
    await Promise.resolve();
    assert.equal(typeof applied.refresh, 'function', 'apply 正常返回');
    assert.deepEqual(watched, ['advisor-flow']);
    assert.equal(slotInjects, 0, '未服务时不注册');
    // 宿主判定本命名空间被服务 → 注册回调执行 → 注册发生
    const unmount = registerCallback();
    assert.equal(slotInjects, 1, '恢复服务后注册');
    assert.equal(typeof unmount, 'function', '注册回调返回卸载句柄（失去服务时卸卡）');
});

test('R-02-001/AC-01 configForms.get 无控制器：告警一条、不注册、不炸 apply（窄窗兜底不绕门控）', async () => {
    const text = readFileSync(join(here, '../lib/client.js'), 'utf8');
    let loaded;
    const windowStub = { __ModuleLoader__: { load: (spec) => { loaded = spec; } } };
    new Function('window', text)(windowStub);
    const warnings = [];
    const registered = [];
    let slotInjects = 0;
    let registerCallback;
    const slots = {
        register: (options, component) => { registered.push({ options, component }); return () => {}; },
        inject: (slotName, factory) => { slotInjects += 1; return factory(); },
    };
    const configForms = {
        get: () => undefined, // apply 时刻 describe 镜像尚未服务本命名空间
        whileServed: (namespaces, callback) => {
            registerCallback = callback;
            return () => {};
        },
    };
    const ctx = {
        logger: () => ({ warn: (message) => warnings.push(String(message)), info() {}, error() {}, debug() {} }),
        connection: { rpc: {} },
        slots,
        inject: (names, fn) => fn({ configForms }),
        effect: (fn) => fn(),
    };
    const applied = runFactory(loaded, ctx);
    await Promise.resolve();
    assert.equal(typeof applied.refresh, 'function', 'apply 正常返回');
    registerCallback();
    assert.equal(slotInjects, 0, '无控制器不注册槽');
    assert.equal(registered.length, 0);
    assert.equal(warnings.length, 1, '降级告警恰好一条');
    assert.match(warnings[0], /advisor-flow 控制器/, '告警指明控制器缺失');
});
