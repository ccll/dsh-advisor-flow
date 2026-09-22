/**
 * Web settings card — DOM renderer over the pure controller
 * ({@link ../card-state.js}). Visual language mirrors dsh-advisor's card
 * (T-005 实测第五发现：宿主契约是「插件自带整卡含样式」——无样式的裸卡会在
 * 设置页裸奔)：
 * - CSS-module 风格 `<style data-plugin-css>` 注入 + 去重守卫，类名前缀
 *   `advisorflow_`，颜色/间距全部走 `--dsw-alias-*` 设计令牌（明暗主题适配）；
 * - 可折叠卡壳：header（name/description/chevron，点击折叠）+ body
 *   （form/fields/footer）；error 强制展开；
 * - 框架无关 DOM（document 注入），逻辑层（catalog 联动、null 语义、三态
 *   回执、unwrap）全部在 controller，本文件只动 DOM 结构与样式层。
 *
 * @module dsh-advisor-flow/client/render
 */

import { isRecord } from '../util.js';

const CARD_TITLE = 'Advisor Flow';
const CARD_DESCRIPTION = '每次关键动作前由独立顾问模型评审并注入建议';

/** CSS-module 风格样式表（类名前缀 advisorflow_；令牌 --dsw-alias-*）。 */
const CSS = `
.advisorflow_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.advisorflow_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.advisorflow_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.advisorflow_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.advisorflow_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.advisorflow_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.advisorflow_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.advisorflow_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.advisorflow_chevronOpen{transform:rotate(180deg)}
.advisorflow_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.advisorflow_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}
.advisorflow_form{flex-direction:column;gap:12px;padding:12px 0 0;display:flex}
.advisorflow_fieldset{border:none;flex-direction:column;gap:12px;margin:0;padding:0;display:flex}
.advisorflow_legend{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:18px}
.advisorflow_field{flex-direction:column;gap:6px;display:flex}
.advisorflow_fieldLabel{color:var(--dsw-alias-label-secondary);align-items:center;gap:10px;font-size:12px;font-weight:500;line-height:18px;display:inline-flex}
.advisorflow_checkboxRow{align-items:center;gap:8px;display:flex}
.advisorflow_checkLabel{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.advisorflow_checkbox{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0}
.advisorflow_checkbox:disabled{opacity:.4;cursor:default}
.advisorflow_checkbox:focus-visible{outline:2px solid var(--dsw-alias-border-l3);outline-offset:2px}
.advisorflow_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:14px;line-height:22px}
select.advisorflow_input{cursor:pointer;max-width:240px}
.advisorflow_input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.advisorflow_input::placeholder{color:var(--dsw-alias-label-dimmed)}
.advisorflow_input:disabled{opacity:.6;cursor:default}
select.advisorflow_selectInput{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-position:right 12px center;background-repeat:no-repeat;background-size:12px 12px;padding-right:32px}
.advisorflow_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
.advisorflow_notice{color:var(--dsw-alias-state-warn-label);margin:12px 0 0;font-size:12px;line-height:18px}
.advisorflow_savedNotice{color:var(--dsw-alias-state-success-primary);margin:12px 0 0;font-size:12px;line-height:18px}
.advisorflow_error{color:var(--dsw-alias-state-error-primary);margin:12px 0 0;font-size:12px;line-height:18px}
.advisorflow_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.advisorflow_discard,.advisorflow_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.advisorflow_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.advisorflow_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.advisorflow_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.advisorflow_discard:disabled,.advisorflow_save:disabled{opacity:.4;cursor:default}
.advisorflow_discard:focus-visible,.advisorflow_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
`;

const STYLE_TAG_ID = 'dsh-advisor-flow/advisor-card.module.css';

/** 样式注入 + 去重守卫（照抄 dsh-advisor 的 data-plugin-css 形态）。 */
function injectStyles(document) {
    if (typeof document?.querySelector !== 'function' || !document?.head) {
        return; // 测试桩/非浏览器环境：样式层跳过（DOM 结构仍可断言）
    }
    if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) {
        return;
    }
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-advisor-flow';
    tag.dataset.pluginCss = STYLE_TAG_ID;
    tag.textContent = CSS;
    document.head.appendChild(tag);
}

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
        class: 'advisorflow_checkbox',
        ...(checked ? { checked: 'checked' } : {}),
        ...(disabled ? { disabled: 'disabled' } : {}),
        onChange: (event) => onChange(event.target.checked),
    });
    return el(document, 'label', { class: 'advisorflow_checkLabel' }, [
        box,
        el(document, 'span', { text: label }),
    ]);
}

function textField(document, { value, onChange, label, disabled }) {
    return el(document, 'label', { class: 'advisorflow_field' }, [
        el(document, 'span', { class: 'advisorflow_fieldLabel', text: label }),
        el(document, 'input', {
            type: 'text',
            class: 'advisorflow_input',
            value: value ?? '',
            ...(disabled ? { disabled: 'disabled' } : {}),
            onChange: (event) => onChange(event.target.value),
        }),
    ]);
}

function selectField(document, { value, options, onChange, label, hint }) {
    const select = el(document, 'select', {
        class: 'advisorflow_input advisorflow_selectInput',
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
    return el(document, 'label', { class: 'advisorflow_field' }, [
        el(document, 'span', { class: 'advisorflow_fieldLabel', text: label }),
        select,
        ...(hint ? [el(document, 'span', { class: 'advisorflow_hint', text: hint })] : []),
    ]);
}

function numberField(document, { value, onChange, label }) {
    return el(document, 'label', { class: 'advisorflow_field' }, [
        el(document, 'span', { class: 'advisorflow_fieldLabel', text: label }),
        el(document, 'input', {
            type: 'number',
            class: 'advisorflow_input',
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
    return el(document, 'div', { class: 'advisorflow_field advisor-flow-gate', 'data-gate': kind }, [
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
    injectStyles(document);
    let expanded = true; // 折叠态：header 点击切换；error 强制展开
    const root = document.createElement('div');
    root.setAttribute('class', 'advisorflow_card advisorflow_cardOpen');
    container.appendChild(root);

    function refresh() {
        const state = controller.getState();
        // Rebuild in place: the card is small enough that diffing costs more
        // than replacing children.
        while (root.firstChild) {
            root.removeChild(root.firstChild);
        }
        const hasError = state.status === 'error' || Boolean(state.error);
        const open = expanded || hasError;
        root.setAttribute('class', open ? 'advisorflow_card advisorflow_cardOpen' : 'advisorflow_card');

        // 可折叠 header：name/description/chevron（对照 dsh-advisor advisor-card）
        root.appendChild(el(document, 'button', {
            type: 'button',
            class: 'advisorflow_header',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': `${open ? '收起' : '展开'}：${CARD_TITLE}`,
            onClick: () => {
                expanded = !expanded;
                refresh();
            },
        }, [
            el(document, 'span', { class: 'advisorflow_headText' }, [
                el(document, 'span', { class: 'advisorflow_name', text: CARD_TITLE }),
                el(document, 'span', { class: 'advisorflow_description', text: CARD_DESCRIPTION }),
            ]),
            el(document, 'span', {
                class: open ? 'advisorflow_chevron advisorflow_chevronOpen' : 'advisorflow_chevron',
                text: '▾',
            }),
        ]));

        if (state.status === 'idle') {
            void controller.load();
            return;
        }
        if (state.status === 'error') {
            root.appendChild(el(document, 'p', {
                class: 'advisorflow_error advisor-flow-error',
                text: state.error ?? '配置加载失败',
            }));
            return;
        }
        if (!open) {
            root.appendChild(el(document, 'p', {
                class: 'advisorflow_readOnly',
                text: '已折叠——点击头部展开配置',
            }));
            return;
        }

        const config = state.effectiveConfig ?? {};
        const form = el(document, 'div', { class: 'advisorflow_form' }, []);
        form.appendChild(checkbox(document, {
            checked: config.enabled === true,
            label: '启用 Advisor Flow',
            onChange: (value) => controller.setField('enabled', value),
        }));

        // 三级联动（东家要求，目录实测契约）：provider/model/effort 从 dsh
        // 已配置目录动态下拉；目录不可用时回退现状自由文本/硬编码档位
        // （degradations.catalog 已由 controller 显性化）。
        const advisor = isRecord(config.advisor) ? config.advisor : {};
        const providerOptions = controller.providerOptions();
        if (Array.isArray(providerOptions)) {
            form.appendChild(selectField(document, {
                value: advisor.provider ?? '',
                options: providerOptions,
                label: 'advisor provider',
                onChange: (value) => controller.setField('advisor.provider', value),
            }));
        } else {
            form.appendChild(textField(document, {
                value: advisor.provider,
                label: 'advisor provider',
                onChange: (value) => controller.setField('advisor.provider', value),
            }));
        }
        const modelOptions = controller.modelsFor(advisor.provider);
        if (Array.isArray(modelOptions)) {
            form.appendChild(selectField(document, {
                value: advisor.model ?? '',
                options: modelOptions,
                label: 'advisor model',
                // 空选（占位「— 选择模型 —」）映射 null：校验阻断保存直至补齐
                onChange: (value) => controller.setField('advisor.model', value === '' ? null : value),
            }));
        } else {
            form.appendChild(textField(document, {
                value: advisor.model,
                label: 'advisor model',
                onChange: (value) => controller.setField('advisor.model', value),
            }));
        }
        // reasoningEffort（R-02-001/AC-01 GUI 面）：目录模式下选项来自所选
        // 模型声明的 reasoning.efforts，空值 = 跟随模型默认（标注
        // defaultEffort）；模型不支持的档位由调用前的能力门控回退默认。
        const effortOptions = controller.effortOptions(advisor.model);
        if (Array.isArray(effortOptions)) {
            form.appendChild(selectField(document, {
                value: advisor.reasoningEffort ?? '',
                options: effortOptions,
                label: 'advisor reasoningEffort',
                hint: '模型不支持的档位将回退模型默认',
                onChange: (value) => controller.setField('advisor.reasoningEffort', value === '' ? null : value),
            }));
        } else {
            form.appendChild(selectField(document, {
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
        }

        // 四门 fieldset
        const gates = isRecord(config.gates) ? config.gates : {};
        const gatesFieldset = el(document, 'fieldset', { class: 'advisorflow_fieldset' }, [
            el(document, 'legend', { class: 'advisorflow_legend', text: '评审门' }),
        ]);
        for (const kind of ['plan', 'failure', 'loop', 'completion']) {
            gatesFieldset.appendChild(gateRow(document, kind, gates[kind] ?? {}, controller));
        }
        form.appendChild(gatesFieldset);

        // 隐私档位 fieldset
        const privacy = isRecord(config.privacy) ? config.privacy : {};
        form.appendChild(el(document, 'fieldset', { class: 'advisorflow_fieldset' }, [
            el(document, 'legend', { class: 'advisorflow_legend', text: '隐私档位' }),
            selectField(document, {
                value: privacy.history ?? 'window',
                options: ['off', 'delta', 'window'],
                label: 'history 档位',
                onChange: (value) => controller.setField('privacy.history', value),
            }),
            selectField(document, {
                value: privacy.repoContext ?? 'summary',
                options: ['none', 'summary', 'patch'],
                label: 'repoContext 档位',
                onChange: (value) => controller.setField('privacy.repoContext', value),
            }),
            checkbox(document, {
                checked: privacy.redactSecrets !== false,
                label: '密钥脱敏',
                onChange: (value) => controller.setField('privacy.redactSecrets', value),
            }),
        ]));

        const body = el(document, 'div', { class: 'advisorflow_body' }, [form]);

        // footer：回执/错误/降级文案 + 放弃修改/保存
        const degraded = state.degradations ?? {};
        const degradedKeys = Object.keys(degraded);
        if (degradedKeys.length > 0) {
            body.appendChild(el(document, 'p', {
                class: 'advisorflow_notice',
                text: `降级：${degradedKeys.map((key) => `${key}=${degraded[key]}`).join('；')}`,
            }));
        }
        if (state.validationError) {
            body.appendChild(el(document, 'p', {
                class: 'advisorflow_error advisor-flow-error',
                text: state.validationError,
            }));
        }
        if (state.savedNotice) {
            // 保存成功回执：持久化态或运行时态（由宿主裁决，见 card-state）
            body.appendChild(el(document, 'p', {
                class: 'advisorflow_savedNotice advisor-flow-notice',
                text: state.savedNotice,
            }));
        }
        if (state.error) {
            body.appendChild(el(document, 'p', {
                class: 'advisorflow_error advisor-flow-error',
                text: state.error,
            }));
        }
        const save = el(document, 'button', {
            type: 'button',
            class: 'advisorflow_save advisor-flow-save',
            text: '保存',
            disabled: state.saving || state.validationError ? 'disabled' : undefined,
            onClick: async () => {
                await controller.save();
                refresh();
            },
        });
        body.appendChild(el(document, 'div', { class: 'advisorflow_footer' }, [
            el(document, 'button', {
                type: 'button',
                class: 'advisorflow_discard advisor-flow-discard',
                text: '放弃修改',
                onClick: () => {
                    controller.discard();
                    refresh();
                },
            }),
            save,
        ]));

        root.appendChild(body);
    }

    controller.subscribe(refresh);
    refresh();
    return { refresh };
}
