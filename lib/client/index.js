/**
 * dsh-advisor-flow — client bundle entry (web 设置卡, T-028 0.2.0 挂点).
 *
 * The card edits the `advisor-flow` namespace through the plugin's OWN
 * gateway RPC (`advisor-flow/get|set` over `/api`); it does NOT go through
 * the host `settings.describe` exposure channel (客户端 configForms 面).
 *
 * Mount point（0.2.0 插件管理页契约，dsh-cordis-client-runner slots 目录）：
 * keyed slot `plugins.row.config`，key = `<包名>#<patch 行 id>` = 本插件
 * bundle patch 的 advisor-flow 行。ownerProps `{view:'summary'|'page',
 * form?}`——`summary` 渲染一行摘要；`page` 渲染整卡（自有 DOM，不走宿主
 * describe 表单）。旧 `settings.plugin.item` 槽在 0.2.0 已不存在（全宿主
 * 零引用——0.1.5 卡片消失的根因）。
 *
 * @module dsh-advisor-flow/client
 */

import { createSettingsCardController } from './card-state.js';
import { renderSettingsCard } from './render.js';

export const name = 'dsh-advisor-flow-client';
/** Client-side services the card consumes (RPC + slots seam + timer 重试缝). */
export const inject = ['slots', 'connection', 'timer'];

/** 行配置键：<包名>#<cordis.patch.yml 行 id>（宿主契约 plugins.row.config）。 */
const ROW_CONFIG_KEY = 'dsh-advisor-flow#advisor-flow';

/**
 * Client bundle entry.
 *
 * @param {object} ctx the client plugin context (`ctx.connection.rpc` is the
 *   generic RPC caller; the card mounts through the host `slots` seam keyed
 *   slot `plugins.row.config`)
 */
export function apply(ctx) {
    return applyInner(ctx);
}

function applyInner(ctx) {
    const logger = typeof ctx?.logger === 'function' ? ctx.logger('advisor-flow') : console;
    const controller = createSettingsCardController({
        rpc: ctx?.connection?.rpc,
        logger,
    });

    // react lives only in the host loader module table (no npm dep here); the
    // esbuild build marks it external so the factory's require answers it.
    const React = typeof require === 'function' ? require('react') : undefined;
    if (typeof React?.createElement !== 'function' || typeof ctx?.slots?.register !== 'function') {
        logger.warn?.('advisor-flow client: slots/react 缝缺失——卡片未渲染（联调验证项 T-028）');
        return { controller, refresh: () => controller.load() };
    }

    // 契约 ownerProps：view='summary'（行内一行摘要，纯文本节点）|'page'
    // （配置页主体，整卡 DOM 由 renderSettingsCard 托管、卸载清空）。宿主
    // form 为 describe 表单——本卡走自有 gateway 通道，不消费。
    const AdvisorFlowCard = ({ view } = {}) => {
        const containerRef = React.useRef(null);
        React.useEffect(() => {
            if (view === 'summary') {
                return undefined;
            }
            const container = containerRef.current;
            if (!container) {
                return undefined;
            }
            renderSettingsCard({ document: container.ownerDocument, container, controller });
            return () => { container.textContent = ''; };
        }, [view]);
        if (view === 'summary') {
            return React.createElement(React.Fragment, null, 'Advisor Flow——顾问咨询与评审门');
        }
        return React.createElement('div', { ref: containerRef });
    };

    // keyed 槽注册（宿主契约）：与 fiber 激活解耦——apply 内直注一次；槽
    // 未声明（`slot "x" is not declared`）则经 timer 短轮询重试（≤10s）。
    // 背景（生产手机端实测）：经 slots.inject 等声明会 park 激活，慢设备上
    // 插件管理页的声明提交晚于 boot 门审计 → fiber 被判 failed → 整页
    // 「1 entry did not activate」。直注在声明未提交时同步抛。卡片是 UI
    // 增强：任何时序下不得阻塞宿主启动，重试耗尽只降级告警。
    let registerAttempts = 0;
    const registerRetryLimit = 50; // 50 × 200ms = 10s 上限
    const retryOrDegrade = (error) => {
        const message = String(error?.message ?? error);
        if (registerAttempts >= registerRetryLimit || !message.includes('not declared')) {
            logger.warn?.(`advisor-flow client: 行配置卡注册未完成——${message}`);
            return;
        }
        ctx.setTimeout(() => { registerRowCard(); }, 200);
    };
    const registerRowCard = () => {
        registerAttempts += 1;
        try {
            const outcome = ctx.slots.register({
                name: 'plugins.row.config',
                key: ROW_CONFIG_KEY,
            }, AdvisorFlowCard);
            if (outcome && typeof outcome.then === 'function') {
                outcome.then(
                    (dispose) => { logger.debug?.('advisor-flow client: 行配置卡已注册'); return dispose; },
                    (error) => { retryOrDegrade(error); },
                );
            } else {
                logger.debug?.('advisor-flow client: 行配置卡已注册');
            }
        } catch (error) {
            retryOrDegrade(error);
        }
    };
    registerRowCard();

    return { controller, refresh: () => controller.load() };
}

export { createSettingsCardController, renderSettingsCard };
export default { name, inject, apply };
