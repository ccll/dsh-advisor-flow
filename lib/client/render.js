/**
 * Web settings card — thin DOM renderer over the pure controller
 * ({@link ../card-state.js}). Framework-free on purpose: the plugin keeps
 * zero runtime dependencies, and the card is a flat form (toggle, route
 * fields, four gate rows, privacy tiers, redaction switch, degraded markers,
 * save/discard). The `document` is injected so tests can drive it with a
 * micro DOM stub — no jsdom, no testing-library.
 *
 * @module dsh-advisor-flow/client/render
 */

import { isRecord } from '../util.js';

function el(document, tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined) {
            continue; // never stringify `undefined` into an attribute
        }
        if (key === 'text') {
            node.textContent = value;
        } else if (key === 'onChange') {
            node.addEventListener('change', value);
        } else if (key === 'onClick') {
            node.addEventListener('click', value);
        } else {
            node.setAttribute(key, value);
        }
    }
    for (const child of children) {
        if (child !== undefined && child !== null) {
            node.appendChild(child);
        }
    }
    return node;
}

function checkbox(document, { checked, onChange, label, disabled }) {
    const box = el(document, 'input', {
        type: 'checkbox',
        ...(checked ? { checked: 'checked' } : {}),
        ...(disabled ? { disabled: 'disabled' } : {}),
        onChange: (event) => onChange(event.target.checked),
    });
    return el(document, 'label', {}, [
        box,
        el(document, 'span', { text: label }),
    ]);
}

function textField(document, { value, onChange, label, disabled }) {
    return el(document, 'label', {}, [
        el(document, 'span', { text: label }),
        el(document, 'input', {
            type: 'text',
            value: value ?? '',
            ...(disabled ? { disabled: 'disabled' } : {}),
            onChange: (event) => onChange(event.target.value),
        }),
    ]);
}

function selectField(document, { value, options, onChange, label, hint }) {
    const select = el(document, 'select', {
        onChange: (event) => onChange(event.target.value),
    });
    for (const option of options) {
        // Options may be plain strings or { value, label } pairs (e.g. an
        // empty-valued "follow the model default" entry with a real label).
        const entry = typeof option === 'string' ? { value: option, label: option } : option;
        const node = el(document, 'option', { value: entry.value, text: entry.label });
        if (entry.value === value) {
            node.setAttribute('selected', 'selected');
        }
        select.appendChild(node);
    }
    return el(document, 'label', {}, [
        el(document, 'span', { text: label }),
        select,
        ...(hint ? [el(document, 'span', { class: 'advisor-flow-hint', text: hint })] : []),
    ]);
}

function numberField(document, { value, onChange, label }) {
    return el(document, 'label', {}, [
        el(document, 'span', { text: label }),
        el(document, 'input', {
            type: 'number',
            value: value === undefined ? '' : String(value),
            onChange: (event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                if (Number.isInteger(parsed) && parsed > 0) {
                    onChange(parsed);
                }
            },
        }),
    ]);
}

function gateRow(document, kind, gate, controller) {
    return el(document, 'div', { class: 'advisor-flow-gate', 'data-gate': kind }, [
        checkbox(document, {
            checked: gate.enabled === true,
            label: `${kind} 门`,
            onChange: (value) => controller.setField(`gates.${kind}.enabled`, value),
        }),
        selectField(document, {
            value: gate.policy ?? 'review',
            options: kind === 'failure' ? ['review', 'ask', 'block', 'block-session'] : ['review', 'ask', 'block'],
            label: '策略',
            onChange: (value) => controller.setField(`gates.${kind}.policy`, value),
        }),
        ...(kind === 'failure' || kind === 'loop'
            ? [numberField(document, {
                value: gate.threshold,
                label: '阈值',
                onChange: (value) => controller.setField(`gates.${kind}.threshold`, value),
            })]
            : []),
    ]);
}

/**
 * Render the Advisor Flow settings card into `container`.
 *
 * @param {object} options
 * @param {object} options.document a DOM document (window.document in the
 *   bundle; a micro stub in tests)
 * @param {object} options.container the mount element
 * @param {object} options.controller a {@link createSettingsCardController} instance
 * @returns {{ refresh: () => void }} re-render after controller updates
 */
export function renderSettingsCard({ document, container, controller }) {
    const root = document.createElement('div');
    root.setAttribute('class', 'advisor-flow-card');
    container.appendChild(root);

    function refresh() {
        const state = controller.getState();
        // Rebuild in place: the card is small enough that diffing costs more
        // than replacing children.
        while (root.firstChild) {
            root.removeChild(root.firstChild);
        }
        root.appendChild(el(document, 'h3', { text: 'Advisor Flow' }));
        if (state.status === 'idle') {
            void controller.load();
            return;
        }
        if (state.status === 'error') {
            root.appendChild(el(document, 'p', { class: 'advisor-flow-error', text: state.error ?? '配置加载失败' }));
            return;
        }
        const config = state.effectiveConfig ?? {};
        root.appendChild(checkbox(document, {
            checked: config.enabled === true,
            label: '启用 Advisor Flow',
            onChange: (value) => controller.setField('enabled', value),
        }));
        const advisor = isRecord(config.advisor) ? config.advisor : {};
        root.appendChild(textField(document, {
            value: advisor.provider,
            label: 'advisor provider',
            onChange: (value) => controller.setField('advisor.provider', value),
        }));
        root.appendChild(textField(document, {
            value: advisor.model,
            label: 'advisor model',
            onChange: (value) => controller.setField('advisor.model', value),
        }));
        // reasoningEffort 选择器（R-02-001/AC-01 GUI 面）：空值 = 不指定，
        // 交由模型路由默认；模型不支持的档位由调用前的能力门控回退默认。
        root.appendChild(selectField(document, {
            value: advisor.reasoningEffort ?? '',
            options: [
                { value: '', label: '不指定（跟随模型默认）' },
                { value: 'low', label: '低 (low)' },
                { value: 'high', label: '高 (high)' },
                { value: 'max', label: '最大 (max)' },
                { value: 'off', label: '关闭 (off)' },
            ],
            label: 'advisor reasoningEffort',
            hint: '模型不支持的档位将回退模型默认',
            // 空选映射为 null 而非 undefined：真实 JSON 通道会丢弃 undefined
            // 键，merge 就会保留 raw 旧档位（卡片与持久真相分歧）；null 可穿
            // 越序列化，且解析器对 null 同样按「未配置=跟随默认」处理。
            onChange: (value) => controller.setField('advisor.reasoningEffort', value === '' ? null : value),
        }));
        const gates = isRecord(config.gates) ? config.gates : {};
        for (const kind of ['plan', 'failure', 'loop', 'completion']) {
            root.appendChild(gateRow(document, kind, gates[kind] ?? {}, controller));
        }
        const privacy = isRecord(config.privacy) ? config.privacy : {};
        root.appendChild(selectField(document, {
            value: privacy.history ?? 'window',
            options: ['off', 'delta', 'window'],
            label: 'history 档位',
            onChange: (value) => controller.setField('privacy.history', value),
        }));
        root.appendChild(selectField(document, {
            value: privacy.repoContext ?? 'summary',
            options: ['none', 'summary', 'patch'],
            label: 'repoContext 档位',
            onChange: (value) => controller.setField('privacy.repoContext', value),
        }));
        root.appendChild(checkbox(document, {
            checked: privacy.redactSecrets !== false,
            label: '密钥脱敏',
            onChange: (value) => controller.setField('privacy.redactSecrets', value),
        }));
        const degraded = state.degradations ?? {};
        const degradedKeys = Object.keys(degraded);
        if (degradedKeys.length > 0) {
            root.appendChild(el(document, 'p', {
                class: 'advisor-flow-degraded',
                text: `降级：${degradedKeys.map((key) => `${key}=${degraded[key]}`).join('；')}`,
            }));
        }
        if (state.validationError) {
            root.appendChild(el(document, 'p', { class: 'advisor-flow-error', text: state.validationError }));
        }
        if (state.savedNotice) {
            // 保存成功回执：运行时态、重启即失（持久写归后续任务）
            root.appendChild(el(document, 'p', { class: 'advisor-flow-notice', text: state.savedNotice }));
        }
        if (state.error) {
            root.appendChild(el(document, 'p', { class: 'advisor-flow-error', text: state.error }));
        }
        const save = el(document, 'button', {
            type: 'button',
            class: 'advisor-flow-save',
            text: '保存',
            disabled: state.saving || state.validationError ? 'disabled' : undefined,
            onClick: async () => {
                await controller.save();
                refresh();
            },
        });
        root.appendChild(el(document, 'div', { class: 'advisor-flow-actions' }, [
            el(document, 'button', {
                type: 'button',
                class: 'advisor-flow-discard',
                text: '放弃修改',
                onClick: () => {
                    controller.discard();
                    refresh();
                },
            }),
            save,
        ]));
    }

    controller.subscribe(refresh);
    refresh();
    return { refresh };
}
