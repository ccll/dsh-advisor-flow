import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AdvisorFlowConfigSchema,
    unwrapVolatileConfig,
    projectSchemaKeys,
    installAdvisorFlowSettings,
} from '../lib/settings.js';

/** cosmokit volatile cell 同义构造（frozen `{get,[write]}`，0.2.0 宿主 resolve 形态）。 */
function makeCell(value) {
    let current = value;
    return Object.freeze({
        get: () => current,
        [Symbol.for('cosmokit.volatile.write')]: (next) => {
            current = next;
        },
    });
}

test('R-02-001/AC-01 Config schema：每顶层声明键 volatile（0.2.0 describe/update 编辑面判定）', () => {
    const dict = AdvisorFlowConfigSchema.dict ?? {};
    for (const key of Object.keys(dict)) {
        assert.equal(dict[key].meta?.volatile, true, `${key} 必须 volatile`);
    }
});

test('R-02-001/AC-02 Config schema resolve（0.2.0 装载契约）：零校验零填充、未知键透传、声明键整值 cell 化', () => {
    // 宽松形态：垃圾值原样通过 resolve——校验单点在 lib/config.js 解析器
    // （派生启用容忍语义，T-005 回归），不炸行装载。路径取
    // cordis 实调的 ~standard.validate（= Schema.resolve）。
    const junk = { failureMode: 'halt-everything', advisor: 42, junkKey: 'keep' };
    const { value } = AdvisorFlowConfigSchema['~standard'].validate(structuredClone(junk));
    assert.equal(value.failureMode.get(), 'halt-everything');
    assert.equal(value.advisor.get(), 42);
    assert.equal(value.junkKey, 'keep'); // 未知键照常透传
    // 空对象 → 全声明键 undefined cell（unwrap 侧按 authored 形态还原）
    const { value: empty } = AdvisorFlowConfigSchema['~standard'].validate({});
    for (const key of Object.keys(AdvisorFlowConfigSchema.dict)) {
        assert.equal(empty[key].get(), undefined, `${key} 空 resolve 仍产出 cell`);
    }
});

test('R-02-001/AC-02 Config schema：enabled 已退役为未知键（T-031/C-030 派生启用）', () => {
    assert.equal('enabled' in AdvisorFlowConfigSchema.dict, false);
    // 遗留 enabled 值走未知键透传（不进编辑面、不进写缝补丁）
    const { value } = AdvisorFlowConfigSchema['~standard'].validate({ enabled: true });
    assert.equal(value.enabled, true); // 普通值，非 cell
});

test('R-02-001/AC-01 unwrapVolatileConfig：cell 递归解包、顶层 undefined 丢弃、非 record 原样返回', () => {
    const entry = {
        advisor: makeCell({ provider: 'test', model: 'm' }),
        mode: undefined,
        junk: 'keep',
    };
    const plain = unwrapVolatileConfig(entry);
    assert.deepEqual(plain.advisor, { provider: 'test', model: 'm' });
    assert.equal('mode' in plain, false); // 顶层 undefined 丢弃（空文档还原 authored 形态）
    assert.equal(plain.junk, 'keep');
    assert.equal(unwrapVolatileConfig(undefined), undefined);
    assert.equal(unwrapVolatileConfig('x'), 'x');
});

test('R-02-001/AC-02 projectSchemaKeys：只保留 schema 声明的顶层键（宿主 validatePaths 拒绝未知顶层键）', () => {
    const projected = projectSchemaKeys(AdvisorFlowConfigSchema, {
        enabled: true, // T-031：已退役键不再声明 → 落入未知顶层键，被投影剥除
        advisor: { model: 'm', junkInside: 'kept' }, // 嵌套不递归过滤（volatile 祖先短路）
        junkKey: { keep: true },
        scalar: 1,
    });
    assert.deepEqual(Object.keys(projected).sort(), ['advisor']);
    assert.deepEqual(projected.advisor, { model: 'm', junkInside: 'kept' });
    // 非 record 输入原样返回（防御）
    assert.equal(projectSchemaKeys(AdvisorFlowConfigSchema, 'x'), 'x');
    assert.deepEqual(projectSchemaKeys(undefined, { a: 1 }), { a: 1 });
});

test('R-02-001/AC-01 installAdvisorFlowSettings：source 每调用解包 cell；volatile-update 事件驱动 onChange', () => {
    const subscriptions = [];
    const entry = { advisor: makeCell({ provider: 'p', model: 'm' }) };
    const fired = [];
    const bridge = installAdvisorFlowSettings(
        { on: (event, handler) => subscriptions.push({ event, handler }) },
        entry,
        { logger: { warn() {} }, onChange: () => fired.push('change') },
    );
    assert.deepEqual(bridge.source(), { advisor: { provider: 'p', model: 'm' } });
    assert.equal(subscriptions.length, 1);
    assert.equal(subscriptions[0].event, 'loader/volatile-update');

    // 宿主热提交 cell 值 → 事件触发 → onChange；source 读到新值
    entry.advisor[Symbol.for('cosmokit.volatile.write')]({ provider: 'p2', model: 'm2' });
    assert.deepEqual(bridge.source(), { advisor: { provider: 'p2', model: 'm2' } });
    subscriptions[0].handler();
    assert.deepEqual(fired, ['change']);

    // 额外回调注册 + 监听注册失败不致命（try/catch 降级读时求值）
    const extra = [];
    bridge.onChange(() => extra.push('extra'));
    subscriptions[0].handler();
    assert.deepEqual(extra, ['extra']);
    const resilient = installAdvisorFlowSettings(
        { on: () => { throw new Error('no event seam'); } },
        {},
        { logger: { warn() {} } },
    );
    assert.deepEqual(resilient.source(), {});
});

test('R-01-010 SettingsForms schema 登记 secondaryAdvisor 顶层键（编辑面判定与写缝投影承接）', () => {
    const dict = AdvisorFlowConfigSchema.dict ?? {};
    assert.equal(dict.secondaryAdvisor?.meta?.volatile, true, 'secondaryAdvisor 必须 volatile（可编辑顶层键）');
    // 写缝投影：secondaryAdvisor 进补丁、未知顶层键被剥离
    const projected = projectSchemaKeys(AdvisorFlowConfigSchema, {
        advisor: { provider: 'p', model: 'm' },
        secondaryAdvisor: { provider: 'p2', model: 'm2' },
        junkKey: 1,
    });
    assert.deepEqual(Object.keys(projected).sort(), ['advisor', 'secondaryAdvisor']);
    assert.deepEqual(projected.secondaryAdvisor, { provider: 'p2', model: 'm2' });
    // resolve 装载契约：secondaryAdvisor 整值 cell 化、零校验（垃圾值不炸行装载）
    const { value } = AdvisorFlowConfigSchema['~standard'].validate({ secondaryAdvisor: 42 });
    assert.equal(value.secondaryAdvisor.get(), 42);
});
