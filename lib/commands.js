/**
 * Slash commands (R-01-002, R-02-003/AC-02; SOLUTION.md#命令面).
 *
 * Two registrations through an injectable command-registry seam (the dsh
 * `CommandService`, or a fake in tests — same contract as dsh-advisor's
 * `registerAdvisorCommands`):
 *
 * - `/advisor-manual [focus]` — start one manual consultation NOW. The
 *   handler returns IMMEDIATELY (non-blocking) reporting the in-flight
 *   state; the advice is delivered into the session when it completes.
 *   In-flight consultations are cancellable via `/advisor cancel`, and a
 *   cancel leaves no usage side effects.
 * - `/advisor [on|off|toggle|status|gates|cancel]` — per-session switch,
 *   status surface, gate readback, in-flight cancel.
 *
 * `/advisor on|off|toggle` are SESSION-SCOPED and EPHEMERAL: they drive a
 * per-session override consulted by the consultation engine
 * (`sessionGate`); the persisted config is NEVER modified.
 *
 * Cordis-free: pure parse + render + registration contract, unit-testable
 * with a fake registry and a fake controller; the binding into the plugin
 * lives in `lib/index.js`.
 *
 * @module dsh-advisor-flow/commands
 */

import { TOKEN_FIELDS } from './usage.js';
import { isRecord, sessionOf } from './util.js';

/**
 * Parse the text following `/advisor` (the host's command split already
 * yields the raw input including leading whitespace). Subcommands match
 * after trimming; anything else is a usage error.
 *
 * @returns {{ kind: 'toggle'|'on'|'off'|'status'|'gates'|'cancel'|'usage' }}
 */
export function parseAdvisorCommand(rawInput) {
    const argument = typeof rawInput === 'string' ? rawInput.trim() : '';
    if (argument === '') {
        return { kind: 'toggle' };
    }
    if (argument === 'on') {
        return { kind: 'on' };
    }
    if (argument === 'off') {
        return { kind: 'off' };
    }
    if (argument === 'status') {
        return { kind: 'status' };
    }
    if (argument === 'gates') {
        return { kind: 'gates' };
    }
    if (argument === 'cancel') {
        return { kind: 'cancel' };
    }
    return { kind: 'usage' };
}

export const ADVISOR_USAGE = [
    '用法: /advisor [on|off|toggle|status|gates|cancel]',
    '  /advisor on        本会话临时启用 advisor（不写持久配置）',
    '  /advisor off       本会话临时停用 advisor（不写持久配置）',
    '  /advisor toggle    本会话 advisor 开关切换',
    '  /advisor status    状态：启用态/路由/门状态/待处理/最近活动/用量/降级项',
    '  /advisor gates     门配置与阈值只读回读',
    '  /advisor cancel    取消进行中的手动咨询（无用量副作用）',
].join('\n');

/**
 * Create the command controller: the stateful bridge between the command
 * faces and the consultation engine/status/delivery services.
 *
 * @param {object} options
 * @param {object} options.engine the consultation engine
 * @param {object} options.statusProvider the status provider (snapshot)
 * @param {object} options.delivery the advice delivery router
 * @param {() => object} options.getConfig the live resolved config
 * @param {() => number} [options.clock] injectable epoch-ms clock (tests)
 * @param {{ info?, warn?, error? }} [options.logger]
 */
export function createCommandController({ engine, statusProvider, delivery, getConfig, clock = () => Date.now(), logger = console } = {}) {
    const manualClock = typeof clock === 'function' ? clock : () => Date.now();
    /** session id → { abort: AbortController, startedAt: number, focus } */
    const manual = new Map();

    return {
        /** Manual consultation in flight for the session? */
        manualRunning(sessionId) {
            return manual.has(sessionId);
        },

        /**
         * Start one manual consultation (`/advisor-manual [focus]`). The
         * handler replies immediately; the advice is delivered into the
         * session on completion (delivered via the wiring's steerAdvice
         * router). The returned promise resolves with the consultation
         * result for the wiring/tests, never rejects.
         */
        startManual(sessionId, focus) {
            // R-01-002/AC-04：进行中又有新请求 → 中止并替换在飞请求；被替换方
            // 以取消终态收敛（abort 置位后其完成路径不再通知，不误报失败）。
            const previous = manual.get(sessionId);
            if (previous) {
                manual.delete(sessionId);
                previous.abort.abort(new Error('manual consultation replaced'));
            }
            const controller = new AbortController();
            const record = { abort: controller, startedAt: manualClock(), focus };
            manual.set(sessionId, record);
            const promise = engine
                .consult({ entry: 'manual', session: sessionId, question: focus, signal: controller.signal })
                .then((result) => {
                    if (manual.get(sessionId) === record) {
                        manual.delete(sessionId);
                    }
                    if (isRecord(result) && result.ok) {
                        // `delivery` is the wiring's contained deliver callback.
                        delivery?.(sessionId, {
                            adviceId: result.adviceId,
                            text: result.text,
                        });
                    } else if (!record.abort.signal.aborted) {
                        // R-01-002/AC-03：失败通告经唤醒式消息含原因送达
                        // （pi manual-consultation.ts:142 文案逐字）；被替换/
                        // 主动取消的请求以取消终态收敛，不误报失败。
                        const failureMessage = isRecord(result) && typeof result.reason === 'string' ? result.reason : 'unknown';
                        delivery?.(sessionId, `Manual Advisor consultation failed: ${failureMessage}`);
                        logger.info?.('advisor-flow: manual consultation ended without advice', {
                            session: sessionId,
                            code: result?.code ?? 'UNKNOWN',
                            reason: result?.reason ?? 'unknown',
                        });
                    }
                    return result;
                })
                .catch((error) => {
                    // consult() never rejects; containment is defense in depth.
                    manual.delete(sessionId);
                    logger.error?.('advisor-flow: manual consultation failed — contained', { session: sessionId, error: String(error) });
                    return { ok: false, code: 'ADVISOR_FAILED', reason: String(error) };
                });
            record.promise = promise;
            return { started: true, promise };
        },

        /** Cancel the in-flight manual consultation; `false` when none. */
        cancelManual(sessionId) {
            const record = manual.get(sessionId);
            if (!record) {
                return false;
            }
            manual.delete(sessionId);
            record.abort.abort(new Error('manual consultation cancelled'));
            return true;
        },

        /** Session-level override switch (ephemeral; never persists). */
        setSessionEnabled(sessionId, enabled) {
            engine.setSessionEnabled?.(sessionId, enabled);
            return this.snapshotFor(sessionId);
        },

        /** Per-session status for the command renderer (with ephemeral bits). */
        snapshotFor(sessionId) {
            const snapshot = statusProvider.snapshot();
            return {
                ...snapshot,
                session: sessionId,
                sessionEnabled: engine.sessionEnabled?.(sessionId),
                manualRunning: manual.has(sessionId),
                manualFocus: manual.get(sessionId)?.focus,
            };
        },
    };
}

/**
 * Render the `/advisor status` surface (R-02-003/AC-02): enabled state (with
 * the disabled reason), model route, gate states, per-session rows (pending,
 * last activity), usage summary, and degraded markers.
 */
export function advisorStatusText(status) {
    const lines = [];
    lines.push(status.enabled ? 'Advisor: enabled' : 'Advisor: disabled');
    if (status.reason) {
        lines.push(`原因: ${status.reason}`);
    }
    if (status.advisor?.provider && status.advisor?.model) {
        lines.push(`模型: ${status.advisor.provider}/${status.advisor.model}`);
    }
    const gateKinds = Object.keys(status.gates ?? {});
    if (gateKinds.length > 0) {
        lines.push(`门: ${gateKinds.map((kind) => formatGateEntry(kind, status.gates[kind] ?? {})).join(' ')}`);
    }
    lines.push(`待处理: ${status.pending ?? 0}`);
    lines.push(`最近活动: ${typeof status.lastActivity === 'number' ? new Date(status.lastActivity).toISOString() : '无'}`);
    const usage = status.usage?.total;
    if (usage) {
        const parts = [`calls=${usage.calls}`];
        for (const field of [...TOKEN_FIELDS, 'cost']) { // 字段集单点维护于 usage.js（宿主 TokenUsage 契约）
            parts.push(`${field}=${usage[field]}`);
        }
        lines.push(`用量累计: ${parts.join(' ')}`); // 缺失项呈现 unavailable 而非零
    }
    const degradations = status.degradations ?? {};
    const degradedKeys = Object.keys(degradations);
    if (degradedKeys.length > 0) {
        lines.push(`降级: ${degradedKeys.map((key) => `${key}=${degradations[key]}`).join(' ')}`);
    }
    if (status.manualRunning) {
        lines.push(`手动咨询: 进行中${status.manualFocus ? `（${status.manualFocus}）` : ''}，可用 /advisor cancel 取消`);
    }
    if (status.sessionEnabled !== undefined) {
        lines.push(`本会话开关: ${status.sessionEnabled ? 'on' : 'off'}（临时覆盖，不写持久配置）`);
    }
    return lines.join('\n');
}

/**
 * One gate's status rendering — the SINGLE formatting used by both the
 * `/advisor status` 门行 and the `/advisor gates` readback (no parallel
 * renderers to drift).
 */
export function formatGateEntry(kind, gate) {
    const parts = [`${kind}=${gate?.enabled ? 'on' : 'off'}`];
    if (gate?.threshold !== undefined) {
        parts.push(`threshold=${gate.threshold}`);
    }
    return parts.join(' ');
}

/** Render the `/advisor gates` readback（守则开关、循环门阈值与阻断模式）. */
export function advisorGatesText(gates, failureMode) {
    const lines = ['门配置（只读回读）:'];
    for (const kind of ['plan', 'failure', 'loop', 'completion']) {
        lines.push(`  ${formatGateEntry(kind, gates?.[kind] ?? {})}`);
    }
    lines.push(`  failureMode=${failureMode ?? 'warn-and-continue'}`);
    return lines.join('\n');
}

/** `/advisor` subcommand handler bound to one controller. */
export function createAdvisorCommandHandler(controller) {
    return (invocation) => {
        const sessionId = sessionOf(invocation?.agent ?? invocation);
        const parsed = parseAdvisorCommand(invocation?.rawInput);
        switch (parsed.kind) {
            case 'toggle': {
                const before = controller.snapshotFor(sessionId);
                const next = !(before.sessionEnabled ?? before.enabled);
                const after = controller.setSessionEnabled(sessionId, next);
                return { kind: 'success', text: next ? advisorOnText(after) : 'advisor 已在本会话临时关闭。' };
            }
            case 'on': {
                const after = controller.setSessionEnabled(sessionId, true);
                return {
                    kind: 'success',
                    text: after.enabled
                        ? 'advisor 已在本会话临时启用（不写持久配置）。'
                        : `advisor 已对本会话开启，但无法发起咨询：${after.reason ?? 'advisor 模型未配置'}`,
                };
            }
            case 'off': {
                controller.setSessionEnabled(sessionId, false);
                return { kind: 'success', text: 'advisor 已在本会话临时关闭（不写持久配置）。' };
            }
            case 'status':
                return { kind: 'success', text: advisorStatusText(controller.snapshotFor(sessionId)) };
            case 'gates': {
                const snapshot = controller.snapshotFor(sessionId);
                return { kind: 'success', text: advisorGatesText(snapshot.gates, snapshot.failureMode) };
            }
            case 'cancel':
                return controller.cancelManual(sessionId)
                    ? { kind: 'success', text: '手动咨询已取消（无用量副作用）。' }
                    : { kind: 'success', text: '当前没有进行中的手动咨询。' };
            default:
                return { kind: 'success', text: ADVISOR_USAGE };
        }
    };
}

/** Register both commands on an injectable registry seam; returns the disposer. */
export function registerAdvisorFlowCommands(registry, controller) {
    const disposers = [];
    disposers.push(registry.register({
        name: 'advisor-manual',
        description: '立即向顾问发起一次手动咨询（可携带聚焦词；进行中可取消）',
        input: { hint: '[聚焦词]' },
        handler: (invocation) => {
            const sessionId = sessionOf(invocation?.agent ?? invocation);
            const focus = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : '';
            const snapshot = controller.snapshotFor(sessionId);
            if (snapshot.sessionEnabled === false) {
                // Session-level `/advisor off` wins over the persisted switch.
                return { kind: 'error', text: 'advisor 已在本会话临时关闭（/advisor on 恢复）' };
            }
            if (snapshot.enabled !== true) {
                // Disabled-with-reason surfaces verbatim (R-02-001/AC-03): the
                // command explains WHY no consultation can start.
                return {
                    kind: 'error',
                    text: snapshot.reason
                        ? `advisor 未启用：${snapshot.reason}`
                        : 'advisor 未启用（settings.yaml 的 advisor-flow.enabled，或 /advisor on 临时开启）',
                };
            }
            const started = controller.startManual(sessionId, focus || undefined);
            if (!started.started) {
                return { kind: 'error', text: started.reason };
            }
            return {
                kind: 'success',
                text: '手动咨询已发起，进行中（/advisor status 查看；/advisor cancel 取消）。意见完成后将送入会话。',
            };
        },
    }));
    disposers.push(registry.register({
        name: 'advisor',
        description: 'advisor 会话级开关与状态查询',
        input: { hint: '[on|off|toggle|status|gates|cancel]' },
        handler: createAdvisorCommandHandler(controller),
    }));
    return () => {
        for (const dispose of disposers) {
            dispose?.();
        }
    };
}


