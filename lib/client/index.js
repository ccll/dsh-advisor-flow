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
/** Client-side services the card consumes (connection RPC + host slots seam). */
export const inject = ['slots', 'connection'];

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
    const logger = typeof ctx?.logger === 'function' ? ctx.logger('advisor-flow') : console;
    const controller = createSettingsCardController({
        rpc: ctx?.connection?.rpc,
        logger,
    });

    // react lives only in the host loader module table (no npm dep here); the
    // esbuild build marks it external so the factory's require answers it.
    const React = typeof require === 'function' ? require('react') : undefined;
    if (typeof React?.createElement !== 'function' || typeof ctx?.slots?.inject !== 'function') {
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

    // keyed 槽注册（宿主契约模板）：thunk 返回 register(...) 的 promise。
    ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: ROW_CONFIG_KEY,
    }, AdvisorFlowCard));

    return { controller, refresh: () => controller.load() };
}

export { createSettingsCardController, renderSettingsCard };
export default { name, inject, apply };
