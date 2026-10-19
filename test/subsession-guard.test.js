import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createSubsessionExecutionGuard,
    SUBSESSION_TOOL_DENIED_CODE,
    SUBSESSION_TOOL_DENIED_REASON,
} from '../lib/subsession-guard.js';

/**
 * 子会话执行面守卫（T-035；R-02-007/AC-05、NG-1；C-034）：
 * - 宿主把委派工具注册进被 spawn 子会话的 own 工具层，toolFilter 剥不掉
 *   （真机实证顾问据此委派子代理）——执行边界对已登记顾问子会话内的一切
 *   工具调用否决（deny-all）。
 * - 否决契约与 tools/pre-execute 一致：{ kind:'deny', reason }（code 只作
 *   日志/统计标识，不进载体）。
 * - fail-open 纪律对齐 C-025：仅阳性判定（登记表命中）否决；判定面异常
 *   放行——误伤正常会话的代价高于放过宿主侧缺陷。
 * - scope 纪律：只认本插件呈现登记表（isAdvisorSubsession），外来审核类
 *   子会话不在此守卫管辖（它们合法持有工具，误伤代价不可接受）。
 */

const quietLogger = { info() {}, warn() {}, error() {} };

/** 否决日志捕获夹具。 */
function makeGuard({ isAdvisorSubsession } = {}) {
    const logs = { info: [], warn: [] };
    const logger = {
        info: (message, fields) => logs.info.push({ message, fields }),
        warn: (message, fields) => logs.warn.push({ message, fields }),
    };
    const guard = createSubsessionExecutionGuard({
        isAdvisorSubsession: isAdvisorSubsession ?? ((sessionId) => sessionId === 'advisor-child-1'),
        logger,
    });
    return { guard, logs };
}

const execOf = (name, sessionId, extra = {}) => ({
    token: 't1',
    callId: 'c1',
    name,
    arguments: {},
    agent: { id: sessionId },
    ...extra,
});

test('R-02-007/AC-05 已登记顾问子会话内的工具调用被否决（deny 形状 + 三点式 reason）', () => {
    const { guard, logs } = makeGuard({});
    const result = guard.check(execOf('subagent', 'advisor-child-1'));
    assert.deepEqual(Object.keys(result).sort(), ['kind', 'reason']);
    assert.equal(result.kind, 'deny');
    assert.equal(result.reason, SUBSESSION_TOOL_DENIED_REASON);
    // reason 三点：禁令与理由 / 属预期勿重试 / 替代路径（模型面英文）。
    assert.ok(result.reason.includes('Tool execution is disabled'));
    assert.ok(result.reason.includes('This refusal is expected'));
    assert.ok(result.reason.includes('return your advice as your final message'));
    assert.ok(logs.info.some((row) => row.message.includes('SUBSESSION_TOOL_DENIED')
        && row.fields?.tool === 'subagent' && row.fields.session === 'advisor-child-1'));
});

test('R-02-007/AC-05 会话标识取 exec.agent（dsh-tools 载体契约，agent.id===session.id）', () => {
    const { guard } = makeGuard({});
    assert.deepEqual(guard.check({ name: 'subagent', arguments: {}, agent: { id: 'advisor-child-1' } }), {
        kind: 'deny',
        reason: SUBSESSION_TOOL_DENIED_REASON,
    });
});

test('R-02-007/AC-05 未登记会话与执行类子会话放行（判定面收敛，不外溢）', () => {
    const { guard } = makeGuard({});
    assert.equal(guard.check(execOf('bash', 'main-1')), undefined);
    assert.equal(guard.check(execOf('subagent', 'worker-1')), undefined); // 深层执行类子会话合法用工具
    assert.equal(guard.check(execOf('bash', undefined)), undefined); // 无会话标识
});

test('R-02-007/AC-05 deny-all 范围：委派对与非委派工具同否决（NG-1 全称）', () => {
    const { guard } = makeGuard({});
    for (const name of ['subagent', 'list_subagent_models', 'bash', 'write', 'read']) {
        const denial = guard.check(execOf(name, 'advisor-child-1'));
        assert.equal(denial?.kind, 'deny');
    }
});

test('畸形载体透传（守卫不加新语义）：非记录/无名/标识缺失', () => {
    const { guard } = makeGuard({});
    assert.equal(guard.check(undefined), undefined);
    assert.equal(guard.check({ name: 42 }), undefined);
    assert.equal(guard.check({}), undefined);
});

test('isAdvisorSubsession 访问器抛错 fail-open 放行并留痕（防线纵深不绊倒主回路）', () => {
    const logs = { info: [], warn: [] };
    const guard = createSubsessionExecutionGuard({
        isAdvisorSubsession: () => { throw new Error('registry boom'); },
        logger: {
            info: (message, fields) => logs.info.push({ message, fields }),
            warn: (message, fields) => logs.warn.push({ message, fields }),
        },
    });
    assert.equal(guard.check(execOf('subagent', 'advisor-child-1')), undefined);
    assert.ok(logs.warn.some((row) => row.message.includes('fail-open')));
});

test('否决计数按工具名累计且快照为拷贝（denialStats）', () => {
    const { guard } = makeGuard({});
    guard.check(execOf('subagent', 'advisor-child-1'));
    guard.check(execOf('subagent', 'advisor-child-1'));
    guard.check(execOf('list_subagent_models', 'advisor-child-1'));
    guard.check(execOf('bash', 'main-1')); // 不计入（未登记会话）
    const stats = guard.denialStats();
    assert.equal(stats.denied, 3);
    assert.deepEqual(stats.byTool, { subagent: 2, list_subagent_models: 1 });
    // 快照拷贝：外部改写不污染内部计数。
    stats.byTool.subagent = 99;
    assert.equal(guard.denialStats().byTool.subagent, 2);
});
