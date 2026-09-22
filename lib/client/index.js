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
/** Client-side services the card consumes (connection RPC + host slots seam). */
export const inject = ['slots', 'connection'];

/**
 * Client bundle entry.
 *
 * @param {object} ctx the client plugin context (`ctx.connection.rpc` is the
 *   generic RPC caller; settings cards mount through the host `slots` seam —
 *   `settings.plugin.item` keyed by the settings namespace, mirroring
 *   dsh-advisor's card registration; the invented `ctx.settingsPlugins`
 *   surface does not exist and an apply-time throw there kills the whole
 *   combined plugin bundle)
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
        logger.warn?.('advisor-flow client: slots/react 缝缺失——卡片未渲染（联调验证项 T-002）');
        return { controller, refresh: () => controller.load() };
    }

    // Framework-free DOM card mounted through a minimal React host component:
    // the settings.plugin.item slot consumer renders React components, so the
    // card hands its renderer a real DOM container and tears it down on unmount.
    const AdvisorFlowCard = () => {
        const containerRef = React.useRef(null);
        React.useEffect(() => {
            const container = containerRef.current;
            if (!container) return undefined;
            renderSettingsCard({ document: container.ownerDocument, container, controller });
            return () => { container.textContent = ''; };
        }, []);
        return React.createElement('div', { ref: containerRef });
    };

    ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register({
            name: 'settings.plugin.item',
            key: 'advisor-flow',
        }, AdvisorFlowCard);
    });

    return { controller, refresh: () => controller.load() };
}

export { createSettingsCardController, renderSettingsCard };
export default { name, inject, apply };
