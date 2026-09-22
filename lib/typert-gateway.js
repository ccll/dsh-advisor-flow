/**
 * Host-side `advisor-flow` config gateway — the TypertRemoteService adapter
 * (the ONLY module importing the typert peer; everything else stays pure so
 * unit tests run without the peer installed — peers resolve at plugin
 * install time from the profile node_modules).
 *
 * Mirrors dsh-advisor's AdvisorConfigGateway pattern (T-005 实测对照):
 * - the service extends cordis `Service` via TypertRemoteService; the
 *   constructor registers the service under the key `advisor-flow`, and the
 *   wire namespace defaults to that key → the host typertGateway derives
 *   `/api/advisor-flow/get|set` (prefix rule: `/api/<namespace>/<method>`);
 * - method payloads follow the gateway contract: one plain `args` object
 *   whose keys are the method parameter names (`get()` → `{ args: {} }`,
 *   `set(patch)` → `{ args: { patch } }`);
 * - endpoint CLAIM does not rely on @Remote SRC markers (the marker table is
 *   module-private and locally-linked plugins never share it) — the typert
 *   invocation contribution is registered EXPLICITLY through
 *   `ctx.typert.register(...)` (see advisorFlowTypertContribution in
 *   ./gateway.js);
 * - results pass through the wire-boundary normalizer: undefined values are
 *   stripped (the result validator rejects undefined).
 *
 * 联调验证项（T-002 清单）：服务注册与贡献声明在真实宿主上的时序与去重语义。
 *
 * @module dsh-advisor-flow/typert-gateway
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { advisorFlowTypertContribution, toWireJson } from './gateway.js';

/** The cordis service key — also the default wire namespace. */
export const GATEWAY_SERVICE_KEY = 'advisor-flow';

/**
 * The gateway service: `get`/`set` delegate to the pure handlers (which own
 * validation, live re-apply, persistence and degradation semantics) and
 * normalize results onto the typertGateway wire boundary.
 */
export class AdvisorFlowConfigGateway extends TypertRemoteService {
    handlers;
    /**
     * @param {object} ctx owning cordis context (the plugin fiber's ctx)
     * @param {object} handlers the `{ 'advisor-flow/get', 'advisor-flow/set' }` map
     *   from `createConfigGateway`
     */
    constructor(ctx, handlers) {
        super(ctx, GATEWAY_SERVICE_KEY);
        this.handlers = handlers;
    }

    /** `/api/advisor-flow/get` — readback for the web settings card. */
    async get() {
        return toWireJson(await this.handlers['advisor-flow/get']({ args: {} }));
    }

    /**
     * `/api/advisor-flow/set` — validate + apply + persist a config patch.
     * @param {object} patch any subset of the namespace keys
     */
    async set(patch) {
        return toWireJson(await this.handlers['advisor-flow/set']({ args: { patch } }));
    }
}

/**
 * Register the gateway service + the typert invocation contribution.
 *
 * @param {object} ctx the plugin fiber context
 * @param {object} handlers the `{ 'advisor-flow/get', 'advisor-flow/set' }` map
 * @param {{ info?, warn?, error? }} [options.logger]
 * @returns {{ disposer: Function, gateway: object }}
 */
export function registerAdvisorFlowGateway(ctx, handlers, logger = console) {
    let gateway;
    try {
        gateway = new AdvisorFlowConfigGateway(ctx, handlers);
    } catch (error) {
        // Multi-fiber dedupe (dsh-advisor 实测): the cordis Service registration
        // fails loud on a duplicate key — a later fiber falls back to no gateway
        // instead of crashing the load.
        if (!(error instanceof Error) || !error.message.includes('has been registered')) {
            throw error;
        }
        logger.warn?.('advisor-flow: gateway 服务已注册（多 fiber 去重）——本 fiber 不再注册');
        return { disposer: () => {}, gateway: undefined };
    }
    // The typert contribution rides a conditional inject child (the typert
    // service is optional in headless compositions). Duplicate registration
    // degrades visibly instead of crashing the load.
    ctx.inject(['typert'], (typertCtx) => {
        const typert = typertCtx?.typert ?? typertCtx;
        if (typeof typert?.register !== 'function') {
            logger.warn?.('advisor-flow: typert.register 形态不符——gateway 端点未声明（联调验证项 T-002）');
            return;
        }
        try {
            typert.register(advisorFlowTypertContribution());
            logger.info?.('advisor-flow: gateway 端点已声明（/api/advisor-flow/get|set）');
        } catch (error) {
            logger.warn?.(`advisor-flow: gateway 端点声明失败（可能已注册）——web 设置卡可能不可用: ${String(error)}`);
        }
    });
    return {
        disposer: () => {},
        gateway,
    };
}
