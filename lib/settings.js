/**
 * `advisor-flow` settings 适配层（R-02-001；T-028 dsh 0.2.0 SettingsForms 适配）。
 *
 * 0.2.0 settings 服务重构为 SettingsForms：`installSection` 已移除，配置面
 * 改为「插件模块导出 schemastery `Config` schema + entry config volatile
 * cell」——宿主经 `entry.fiber.runtime.Config` 发现 schema（dsh-settings
 * lib/index.js 的 schema(entry)），describe/update 由此自证，插件侧无需
 * 注册动作。
 *
 * 本模块职责：
 * - `AdvisorFlowConfigSchema`：设置面形态。成员一律宽松（z.any）+ 每顶层键
 *   `.volatile()`。volatile 标记承担编辑面职责（volatileForm 投影 +
 *   isVolatilePath 写路径判定）；宽松形态使 `Schema.resolve` 零校验、零
 *   default 填充——0.2.0 中 Config 同时是 entry config 的装载契约
 *   （cordis resolveConfig 走 `Config["~standard"].validate`），严格类型会把
 *   坏值变成整行装载失败、越过 config.js 解析器的容忍语义（如派生启用）。
 *   校验语义单点仍在本插件 lib/config.js（双清单纪律：本 schema
 *   只承载「可编辑顶层键清单」）。
 * - `unwrapVolatileConfig`：cordis 对 volatile 节点 resolve 后包 cosmokit
 *   createVolatile cell（frozen `{get,[write]}`，非透传 proxy，读值必须
 *   `.get()`）——entry config 的读取统一经此解包。
 * - `projectSchemaKeys`：写缝侧补丁投影。宿主 write() 的 validatePaths 拒绝
 *   补丁中的任何 schema 外顶层键（`Config field "x" is not volatile`）；
 *   未知键须留在文档层（strip+mergeLayers 保留未提交键）而非进补丁。
 * - live re-apply 事件：宿主 volatile-only 热更新对本 fiber emit
 *   `loader/volatile-update`（plugin loader `_commitVolatile`），桥监听之并
 *   触发 onChange。事件缝的可达性由 staging 实测裁决；读时求值点始终兜底。
 *
 * @module dsh-advisor-flow/settings
 */

import z from '@deepseek-ai/schemastery';

import { isRecord } from './util.js';

/** cosmokit createVolatile 的写记号（`Symbol.for` 全局注册表，跨模块稳定）。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/**
 * 设置面 schema。每个顶层键 `z.any().volatile()`：
 * - 声明键 = 可编辑键清单（0.2.0 describe/update 的 volatile 路径判定依据）；
 * - resolve 时整值 cell 化、未知键照常透传（cordis object resolver 对
 *   schema 外键 merge 保留）、无类型校验与 default 填充（校验单点在
 *   lib/config.js）。
 */
export const AdvisorFlowConfigSchema = z.object({
    advisor: z.any().volatile(),
    secondaryAdvisor: z.any().volatile(),
    gates: z.any().volatile(),
    failureMode: z.any().volatile(),
    presentation: z.any().volatile(),
    mode: z.any().volatile(),
    privacy: z.any().volatile(),
    budget: z.any().volatile(),
    scout: z.any().volatile(),
    contextMaxChars: z.any().volatile(),
    gitContextMaxChars: z.any().volatile(),
    customInvocation: z.any().volatile(),
    modelWhitelist: z.any().volatile(),
    turnReviewExemptPatterns: z.any().volatile(),
    blockOnBlocked: z.any().volatile(),
    toolPolicies: z.any().volatile(),
    outcomeLogging: z.any().volatile(),
});

/**
 * 判定一个值是否 cosmokit volatile cell（`isVolatile` 的宿主同义实现：对象
 * 持有 `Symbol.for('cosmokit.volatile.write')` 键）。
 */
function isVolatileCell(value) {
    return value !== null && typeof value === 'object'
        && typeof value.get === 'function'
        && VOLATILE_WRITE in value;
}

/**
 * 解包 cordis volatile cell 为普通值（递归；cell 是 frozen `{get,[write]}`，
 * 读值必须 `.get()`）。顶层 undefined 值丢弃（空文档 resolve 产出全键
 * undefined cell——按 authored 形态还原，保持「空段不覆盖」语义）。
 */
export function unwrapVolatileConfig(config) {
    if (!isRecord(config)) {
        return config;
    }
    const plain = {};
    for (const [key, value] of Object.entries(config)) {
        const unwrapped = unwrapVolatileValue(value);
        if (unwrapped !== undefined) {
            plain[key] = unwrapped;
        }
    }
    return plain;
}

function unwrapVolatileValue(value) {
    if (isVolatileCell(value)) {
        return unwrapVolatileValue(value.get());
    }
    if (isRecord(value)) {
        return unwrapVolatileConfig(value);
    }
    return value;
}

/**
 * 按 schema 顶层声明键投影补丁（镜像宿主 projectForm 的第一层）：只保留
 * schema 声明的顶层键。嵌套不递归过滤——volatile 祖先使嵌套路径全部可编辑
 * （宿主 isVolatilePath 在首个 volatile 节点短路），嵌套未知键由 write()
 * 放行，仅未知顶层键会被 validatePaths 拒绝。
 */
export function projectSchemaKeys(schema, value) {
    if (!isRecord(value)) {
        return value;
    }
    const dict = schema?.dict;
    if (!isRecord(dict)) {
        return value;
    }
    const projected = {};
    for (const [key, item] of Object.entries(value)) {
        if (dict[key] !== undefined) {
            projected[key] = item;
        }
    }
    return projected;
}

/**
 * 安装 settings 桥（0.2.0 SettingsForms 模型，T-028）。
 *
 * describe/update 由插件模块的 `Config` 导出驱动（index.js re-export），本
 * 函数只承担两件事：
 * - `source`：每次调用解包 entry config 的 volatile cell（live 值）；
 * - 事件：宿主热更新（`loader/volatile-update`）触发 onChange，供顶层
 *   applyFromSource 读时求值。监听注册失败不致命——读时求值点兜底。
 *
 * 不再依赖 settings 服务在场（0.2.0 无需注册动作），也不需要条件子上下文。
 *
 * @param {object} ctx the plugin fiber context
 * @param {object} entry the plugin-row config（可含 volatile cell）
 * @param {object} [options]
 * @param {{ info?, warn?, debug? }} [options.logger]
 * @param {() => void} [options.onChange] 配置热更新时回调（live re-apply）
 * @returns {{ source: () => object, onChange: (cb: Function) => void }}
 */
export function installAdvisorFlowSettings(ctx, entry, { logger = console, onChange } = {}) {
    const listeners = new Set();
    if (typeof onChange === 'function') {
        listeners.add(onChange);
    }
    const notify = () => {
        for (const listener of [...listeners]) {
            listener();
        }
    };
    try {
        // 宿主热更新事件：plugin loader 对本 fiber emit（volatile-only 变更
        // 不重建 fiber，ref 热提交后 emit）。监听失败不致命——读时求值兜底。
        ctx?.on?.('loader/volatile-update', notify);
    } catch (error) {
        logger.warn?.(`advisor-flow: volatile 热更新监听未挂上——live re-apply 退化为读时求值: ${String(error)}`);
    }
    return {
        /** 读时求值原语：每次调用解包 entry config 的当前 cell 值。 */
        source: () => unwrapVolatileConfig(entry),
        /** 注册额外的配置热更新回调（0.2.0 事件缝）。 */
        onChange: (callback) => {
            if (typeof callback === 'function') {
                listeners.add(callback);
            }
        },
    };
}
