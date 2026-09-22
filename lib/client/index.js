/**
 * dsh-advisor-flow — client bundle entry (web settings card).
 *
 * The card edits the `advisor-flow` namespace through the plugin's OWN
 * gateway RPC (`advisor-flow/get|set` over `/api`); it does NOT go through
 * the `settings.describe` exposure channel, which the host filters with a
 * hardcoded namespace allowlist (handoff). The client-side wiring seam
 * (mount point inside the settings page) is 联调验证项 — T-002 清单; this
 * entry keeps the pieces injectable and degrades loudly when the seam is
 * absent.
 *
 * @module dsh-advisor-flow/client
 */

import { createSettingsCardController } from './card-state.js';
import { renderSettingsCard } from './render.js';

export const name = 'dsh-advisor-flow-client';
/** Client-side services the card consumes (connection RPC + settings slots). */
export const inject = ['connection'];

/**
 * Client bundle entry.
 *
 * @param {object} ctx the client plugin context (`ctx.connection.rpc` is the
 *   generic RPC caller; `ctx.settingsPlugins` is the settings-page mount
 *   area — 联调验证项)
 */
export function apply(ctx) {
    const logger = typeof ctx?.logger === 'function' ? ctx.logger('advisor-flow') : console;
    const controller = createSettingsCardController({
        rpc: ctx?.connection?.rpc,
        logger,
    });

    // Mount point probe: the real settings-plugins slot shape is a 联调验证项
    // (T-002 清单). Without a mount seam the card cannot render — degrade
    // loudly rather than silently vanish from the settings page.
    const mount = ctx?.settingsPlugins?.registerCard ?? ctx?.settingsPlugins?.add;
    if (typeof mount === 'function') {
        mount.call(ctx.settingsPlugins, {
            id: 'advisor-flow',
            title: 'Advisor Flow',
            render: (container) => renderSettingsCard({ document: ctx.document, container, controller }),
        });
    } else {
        logger.warn?.('advisor-flow client: 设置卡挂载缝缺失（ctx.settingsPlugins）——卡片未渲染（联调验证项 T-002）');
    }

    return { controller, refresh: () => controller.load() };
}

export { createSettingsCardController, renderSettingsCard };
export default { name, inject, apply };
