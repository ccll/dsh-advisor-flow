import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigGateway, mergeAdvisorFlowConfig, registerConfigGateway } from '../lib/gateway.js';

const BASE = {
    enabled: true,
    advisor: { provider: 'p', model: 'm', maxTokens: 4096 },
    gates: { plan: { enabled: true, policy: 'review' }, loop: { enabled: true, policy: 'ask', threshold: 5 } },
};

function makeGateway(raw = structuredClone(BASE)) {
    const applied = [];
    const logs = { warn: [], error: [] };
    const gateway = createConfigGateway({
        getRawConfig: () => raw,
        applyResolved: (resolved, nextRaw) => {
            applied.push({ resolved, nextRaw });
            raw = nextRaw; // 与宿主 wiring 相同：合法保存同时更新 raw 与 resolved
        },
        logger: { warn: (m) => logs.warn.push(m), error: (m) => logs.error.push(m) },
    });
    return { gateway, applied, logs, getRaw: () => raw };
}

test('R-02-001/AC-01 gateway get/set 往返：合法 patch 即时生效于运行时配置', async () => {
    const { gateway, applied, getRaw } = makeGateway();
    const got = await gateway['advisor-flow/get']();
    assert.equal(got.config.enabled, true);
    assert.equal(got.resolved.enabled, true);

    const result = await gateway['advisor-flow/set']({ args: { patch: { advisor: { model: 'm2' } } } });
    assert.equal(result.ok, true);
    assert.equal(result.config.advisor.model, 'm2');
    assert.equal(result.config.advisor.provider, 'p'); // 兄弟键保留
    assert.equal(applied.length, 1);
    assert.equal(applied[0].resolved.advisor.model, 'm2');
    assert.equal(getRaw().advisor.model, 'm2'); // raw 真相同步更新
    // 再 get 反映新值（卡片刷新所见）
    const reread = await gateway['advisor-flow/get']();
    assert.equal(reread.config.advisor.model, 'm2');
});

test('R-02-001/AC-02 gateway set 未知键警告并保留透传，不阻断其他配置生效', async () => {
    const { gateway, logs, getRaw, applied } = makeGateway();
    const result = await gateway['advisor-flow/set']({ args: { patch: { futureOption: { a: 1 }, advisor: { model: 'm3' } } } });
    assert.equal(result.ok, true);
    assert.ok(result.warnings.includes('futureOption'));
    assert.ok(logs.warn.some((message) => message.includes('futureOption')));
    // merged raw 保留未知键（透传）且已知键生效
    assert.equal(applied[0].nextRaw.futureOption, getRaw().futureOption);
    assert.equal(applied[0].nextRaw.advisor.model, 'm3');
});

test('R-02-001/AC-02 gateway set 非法值被拒绝并返回解析器错误消息', async () => {
    const { gateway, applied, getRaw } = makeGateway();
    const result = await gateway['advisor-flow/set']({ args: { patch: { advisor: { maxTokens: 'many' } } } });
    assert.equal(result.ok, false);
    assert.match(result.error, /maxTokens/);
    assert.equal(applied.length, 0); // 拒绝即不应用
    assert.equal(getRaw().advisor.maxTokens, 4096); // raw 不变
});

test('R-02-001/AC-03 enabled 但缺 provider/model 的保存被阻断并给出原因', async () => {
    const { gateway, applied } = makeGateway();
    // 非法值路径：model: '' 未通过非空字符串校验
    const invalid = await gateway['advisor-flow/set']({ args: { patch: { advisor: { model: '' } } } });
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /advisor\.model/);

    // 阻断路径：raw 已是 enabled+缺 model 的形态，set 尝试只改无关键也被阻断
    const bare = makeGateway({ enabled: true, advisor: { provider: 'p' } });
    const blocked = await bare.gateway['advisor-flow/set']({ args: { patch: { budget: { maxPerSession: 3 } } } });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /缺少 advisor\.model/);
    assert.equal(bare.applied.length, 0); // 阻断即不应用
});

test('R-02-001/AC-02 mergeAdvisorFlowConfig：section 按键合并、gates 按门合并，不抹兄弟键', () => {
    const merged = mergeAdvisorFlowConfig(structuredClone(BASE), {
        advisor: { model: 'x' },
        gates: { plan: { policy: 'block' }, completion: { enabled: true, policy: 'ask' } },
        privacy: { history: 'off' },
    });
    assert.equal(merged.advisor.provider, 'p'); // 兄弟键保留
    assert.equal(merged.advisor.model, 'x');
    assert.equal(merged.gates.plan.enabled, true); // plan 只改 policy
    assert.equal(merged.gates.plan.policy, 'block');
    assert.equal(merged.gates.loop.threshold, 5); // 未触碰的 gate 原样
    assert.equal(merged.gates.completion.enabled, true); // 新 gate 键按门合并
    assert.equal(merged.privacy.history, 'off');
});

test('R-02-001/AC-01 gateway 注册与卸载：经注入缝 register 两个端点', () => {
    const registered = [];
    const unregistered = [];
    const seam = {
        register: (name, handler) => registered.push({ name, handler }),
        unregister: (name) => unregistered.push(name),
    };
    const handlers = { 'advisor-flow/get': async () => ({}), 'advisor-flow/set': async () => ({}) };
    const dispose = registerConfigGateway(seam, handlers);
    assert.deepEqual(registered.map((entry) => entry.name), ['advisor-flow/get', 'advisor-flow/set']);
    assert.equal(typeof registered[0].handler, 'function');
    dispose();
    assert.deepEqual(unregistered, ['advisor-flow/get', 'advisor-flow/set']);
});

test('R-02-001/AC-02 gateway set 缺 patch 或异常载荷返回结构化错误，不抛出', async () => {
    const { gateway } = makeGateway();
    const noPatch = await gateway['advisor-flow/set']({ args: {} });
    assert.equal(noPatch.ok, false);
    assert.match(noPatch.error, /缺少 patch/);
    const junk = await gateway['advisor-flow/set'](null);
    assert.equal(junk.ok, false);
});

test('R-02-001/AC-01 持久写：set 成功时经写缝落 settings.yaml（merge 语义，仅写 advisor-flow 键）', async () => {
    // 内存桩模拟 settings.yaml 文档：writer 只动 advisor-flow 顶层键
    const doc = { other: { keep: true }, 'advisor-flow': structuredClone(BASE) };
    const writes = [];
    const { gateway } = makeGateway();
    const withPersist = createConfigGateway({
        getRawConfig: () => structuredClone(BASE),
        applyResolved: () => {},
        persist: async (raw) => {
            writes.push(JSON.parse(JSON.stringify(raw)));
            doc['advisor-flow'] = raw; // merge 语义：只覆盖本命名空间键
        },
    });
    const result = await withPersist['advisor-flow/set']({ args: { patch: { advisor: { model: 'm2' } } } });
    assert.equal(result.ok, true);
    assert.equal(result.persisted, true);
    assert.equal(result.notice, '已保存并持久化到 settings.yaml。');
    // 写回内容 = 合并后的 RAW 命名空间（JSON 序列化断言）
    assert.equal(writes.length, 1);
    assert.equal(writes[0].advisor.model, 'm2');
    assert.equal(writes[0].advisor.provider, 'p');
    assert.equal(writes[0].gates.plan.policy, 'review');
    // 其他顶层键未被触碰（merge 语义由缝承载）
    assert.equal(doc.other.keep, true);
});

test('R-02-001/AC-01 持久写缝缺失：保存保持运行时态，一次性显性化 + degradations 标注', async () => {
    const degradations = [];
    const { gateway } = createGatewayFixture({ persist: undefined, onPersistenceFailure: (reason) => degradations.push(reason) });
    const result = await gateway['advisor-flow/set']({ args: { patch: { advisor: { model: 'm9' } } } });
    assert.equal(result.ok, true); // 运行时应用成功
    assert.equal(result.persisted, false);
    assert.equal(result.notice, '已保存到当前运行时；持久化尚未启用，重启后修改会丢失。');
    assert.deepEqual(degradations, ['settings-writer-seam-missing']);
});

test('R-02-001/AC-01 持久写抛错：运行时保存不回滚，失败显性化并标注 degradations', async () => {
    const degradations = [];
    const { gateway } = createGatewayFixture({
        persist: async () => {
            throw new Error('yaml write failed');
        },
        onPersistenceFailure: (reason) => degradations.push(reason),
    });
    const result = await gateway['advisor-flow/set']({ args: { patch: { advisor: { model: 'm9' } } } });
    assert.equal(result.ok, true);
    assert.equal(result.persisted, false);
    assert.match(result.persistError, /yaml write failed/);
    assert.deepEqual(degradations, ['persist-write-failed']);
});

test('R-02-001/AC-01 非法 patch 不触发持久写', async () => {
    const writes = [];
    const { gateway } = createGatewayFixture({
        persist: async (raw) => writes.push(raw),
    });
    const result = await gateway['advisor-flow/set']({ args: { patch: { advisor: { maxTokens: 'bad' } } } });
    assert.equal(result.ok, false);
    assert.equal(writes.length, 0);
});

/** gateway fixture with explicit persist/persistence-callback injection. */
function createGatewayFixture({ persist, onPersistenceFailure, onPersistenceRecovered } = {}) {
    let raw = structuredClone(BASE);
    const applied = [];
    const gateway = createConfigGateway({
        getRawConfig: () => raw,
        applyResolved: (resolved, nextRaw) => {
            applied.push(nextRaw);
            raw = nextRaw;
        },
        persist,
        onPersistenceFailure,
        onPersistenceRecovered,
        logger: { warn() {}, error() {}, info() {} },
    });
    return { gateway, applied };
}

test('R-02-001/AC-01 持久化失败→恢复→再失败全链：降级标注随恢复清除，再失败再次显性', async () => {
    let shouldThrow = true;
    const failures = [];
    const recoveries = [];
    const { gateway } = createGatewayFixture({
        persist: async () => {
            if (shouldThrow) {
                throw new Error('yaml write failed');
            }
        },
        onPersistenceFailure: (reason) => failures.push(reason),
        onPersistenceRecovered: () => recoveries.push(1),
    });
    // 第一次保存：写失败 → 失败专属回执 + 降级
    const failed = await gateway['advisor-flow/set']({ args: { patch: { advisor: { model: 'm2' } } } });
    assert.equal(failed.persisted, false);
    assert.equal(failed.notice, '已保存到运行时；写入 settings.yaml 失败，重启即失（原因见详情）。');
    assert.deepEqual(failures, ['persist-write-failed']);
    assert.equal(recoveries.length, 0);

    // 恢复：写缝修好 → 持久化成功 → 回执升级、恢复回调触发
    shouldThrow = false;
    const recovered = await gateway['advisor-flow/set']({ args: { patch: { advisor: { model: 'm3' } } } });
    assert.equal(recovered.persisted, true);
    assert.equal(recovered.notice, '已保存并持久化到 settings.yaml。');
    assert.equal(recoveries.length, 1);
    assert.deepEqual(failures, ['persist-write-failed']); // 失败计数未虚增

    // 再失败：必须再次显性（恢复不得静默后续失败）
    shouldThrow = true;
    const failedAgain = await gateway['advisor-flow/set']({ args: { patch: { advisor: { model: 'm4' } } } });
    assert.equal(failedAgain.persisted, false);
    assert.deepEqual(failures, ['persist-write-failed', 'persist-write-failed']);
    assert.equal(recoveries.length, 1);
});

test('R-02-001/AC-01 回执三态：persisted / 写失败专属文案 / 缺失场景运行时态', async () => {
    let shouldThrow = false;
    const notices = [];
    const { gateway } = createGatewayFixture({
        persist: async () => {
            if (shouldThrow) {
                throw new Error('disk full');
            }
        },
    });
    // 三态之一：持久化
    notices.push((await gateway['advisor-flow/set']({ args: { patch: { advisor: { model: 'm2' } } } })).notice);
    // 三态之二：写失败专属文案（非 EPHEMERAL，不误读为功能缺失）
    shouldThrow = true;
    const failed = await gateway['advisor-flow/set']({ args: { patch: { advisor: { model: 'm3' } } } });
    notices.push(failed.notice);
    assert.equal(failed.notice, '已保存到运行时；写入 settings.yaml 失败，重启即失（原因见详情）。');
    // 三态之三：缝缺失 → 运行时态
    const missingSeam = createConfigGateway({
        getRawConfig: () => structuredClone(BASE),
        applyResolved: () => {},
    });
    notices.push((await missingSeam['advisor-flow/set']({ args: { patch: { advisor: { model: 'm4' } } } })).notice);
    assert.deepEqual(
        [...new Set(notices)],
        ['已保存并持久化到 settings.yaml。', '已保存到运行时；写入 settings.yaml 失败，重启即失（原因见详情）。', '已保存到当前运行时；持久化尚未启用，重启后修改会丢失。'],
    );
});

test('R-02-001/AC-01 persistError 字段随失败回执透出（卡片原因摘要的载体）', async () => {
    const { gateway } = createGatewayFixture({
        persist: async () => {
            throw new Error('yaml write failed');
        },
    });
    const failed = await gateway['advisor-flow/set']({ args: { patch: { advisor: { model: 'm2' } } } });
    assert.match(failed.persistError, /yaml write failed/);
    const recovered = createGatewayFixture({});
    const ok = await recovered.gateway['advisor-flow/set']({ args: { patch: { advisor: { model: 'm2' } } } });
    assert.equal(ok.persistError, undefined); // 成功回执不带原因字段
});
