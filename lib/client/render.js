/**
 * Web settings card — DOM renderer over the pure controller
 * ({@link ../card-state.js}). 视觉与结构对齐 dsh-advisor 的 advisor-card
 * （T-006：东家四点视觉反馈）：
 * - CSS-module 风格 `<style data-plugin-css>` 注入 + 去重守卫，类名前缀
 *   `advisorflow_`，令牌 --dsw-alias-*（明暗主题适配）；
 * - 默认折叠（error 强制展开）；折叠态无提示行；
 * - chevron 为内联 SVG（同款路径旋转切换两态）；
 * - 表单层级：checkboxRow（启用）→ field 竖排（label 在上、控件在下，
 *   gap 6px）→ fieldset（四门/隐私，无 legend——门名在 checkbox 文字）→
 *   numberFields 网格（阈值）→ footer 右对齐（放弃修改/保存）+
 *   notice/savedNotice/error 文案；
 * - 逻辑层（catalog 联动、null 语义、三态回执、unwrap）零改动。
 *
 * @module dsh-advisor-flow/client/render
 */

import { isRecord } from '../util.js';

const CARD_TITLE = 'Advisor Flow';
const CARD_DESCRIPTION = '每次关键动作前由独立顾问模型评审并注入建议';

/** CSS-module 风格样式表（类名前缀 advisorflow_；令牌 --dsw-alias-*）。 */
const CSS = `
.advisorflow_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.advisorflow_card:hover{border-color:var(--dsw-alias-label-dimmed)}
.advisorflow_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.advisorflow_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.advisorflow_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.advisorflow_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.advisorflow_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.advisorflow_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.advisorflow_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s;display:flex}
.advisorflow_chevronOpen{transform:rotate(180deg)}
.advisorflow_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.advisorflow_form{flex-direction:column;gap:12px;padding:12px 0 0;display:flex}
.advisorflow_checkboxRow{align-items:center;gap:8px;display:flex}
.advisorflow_disabledGroup{opacity:.5}
.advisorflow_switchCheckbox{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}
.advisorflow_switchCheckbox:focus-visible + .advisorflow_switchTrack{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.advisorflow_switchTrack{width:40px;height:22px;border-radius:999px;background:var(--dsw-alias-border-l3);position:relative;transition:background .16s;flex:none;display:inline-block}
.advisorflow_switchCheckbox:checked + .advisorflow_switchTrack{background:var(--dsw-alias-brand-primary)}
.advisorflow_switchThumb{width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);position:absolute;top:2px;left:2px;transition:transform .16s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.advisorflow_switchCheckbox:checked + .advisorflow_switchTrack .advisorflow_switchThumb{transform:translateX(18px)}
.advisorflow_checkLabel{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.advisorflow_checkbox{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0}
.advisorflow_checkbox:disabled{opacity:.4;cursor:default}
.advisorflow_checkbox:focus-visible{outline:2px solid var(--dsw-alias-border-l3);outline-offset:2px}
.advisorflow_fieldset{border:none;flex-direction:column;gap:12px;margin:0;padding:0;display:flex}
.advisorflow_legend{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:18px}
.advisorflow_field{flex-direction:column;gap:6px;display:flex}
.advisorflow_fieldLabel{color:var(--dsw-alias-label-secondary);align-items:center;gap:10px;font-size:12px;font-weight:500;line-height:18px;display:inline-flex}
.advisorflow_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:14px;line-height:22px}
select.advisorflow_input{cursor:pointer;max-width:240px}
.advisorflow_input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.advisorflow_input::placeholder{color:var(--dsw-alias-label-dimmed)}
.advisorflow_input:disabled{opacity:.6;cursor:default}
select.advisorflow_selectInput{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-position:right 12px center;background-repeat:no-repeat;background-size:12px 12px;padding-right:32px}
.advisorflow_numberFields{grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;display:grid}
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

/** 折叠/展开 chevron（内联 SVG，官方 IconChevronDownOutline14 同款：14 系实心 fill；CSS 旋转切换两态）。 */
function chevronIcon(document) {
    const create = typeof document.createElementNS === 'function'
        ? (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag)
        : (tag) => document.createElement(tag); // 测试桩回退（结构断言仍可用）
    const svg = create('svg');
    svg.setAttribute('viewBox', '0 0 14 14');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const path = create('path');
    // 官方 ic_ds_chevron_down_outline_14 路径（dsh-client-ui-primitives IconChevronDownOutline14）
    path.setAttribute('d', 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z');
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
}

function checkboxRow(document, { id, checked, onChange, label, disabled }) {
    return el(document, 'div', { class: 'advisorflow_checkboxRow' }, [
        el(document, 'label', { class: 'advisorflow_checkLabel', for: id, text: label }),
        el(document, 'input', {
            type: 'checkbox',
            id,
            class: 'advisorflow_checkbox',
            ...(checked ? { checked: 'checked' } : {}),
            ...(disabled ? { disabled: 'disabled' } : {}),
            onChange: (event) => onChange(event.target.checked),
        }),
    ]);
}

function field(document, { id, label, control, hint, warnHint }) {
    return el(document, 'div', { class: 'advisorflow_field' }, [
        el(document, 'label', { class: 'advisorflow_fieldLabel', for: id, text: label }),
        control,
        ...(hint ? [el(document, 'p', { class: 'advisorflow_hint', text: hint })] : []),
        ...(warnHint ? [el(document, 'p', { class: 'advisorflow_warnHint', text: warnHint })] : []),
    ]);
}

function selectControl(document, { id, value, options, onChange, disabled, ariaLabel }) {
    const select = el(document, 'select', {
        id,
        class: 'advisorflow_input advisorflow_selectInput',
        'aria-label': ariaLabel ?? label(),
        ...(disabled ? { disabled: 'disabled' } : {}),
        onChange: (event) => onChange(event.target.value),
    });
    function label() {
        return ariaLabel ?? id;
    }
    for (const option of options) {
        const entry = typeof option === 'string' ? { value: option, label: option } : option;
        const node = el(document, 'option', { value: entry.value, text: entry.label });
        if (entry.value === value) {
            node.setAttribute('selected', 'selected');
        }
        select.appendChild(node);
    }
    return select;
}

function numberControl(document, { id, value, min, onChange, disabled, ariaLabel, placeholder }) {
    return el(document, 'input', {
        type: 'number',
        id,
        class: 'advisorflow_input',
        'aria-label': ariaLabel,
        ...(min !== undefined ? { min: String(min) } : {}),
        ...(placeholder !== undefined ? { placeholder } : {}),
        ...(value === undefined ? {} : { value: String(value) }),
        ...(disabled ? { disabled: 'disabled' } : {}),
        onChange: (event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            if (Number.isInteger(parsed) && parsed > 0) {
                onChange(parsed);
            }
        },
    });
}

const GATE_LABELS = { plan: 'Plan', failure: 'Failure', loop: 'Loop', completion: 'Completion' };
function gateBlock(document, kind, gate, controller, disabled) {
    const children = [
        // 门名只在 checkbox 文字出现一次（T-006 目验 ②：fieldLabel 双写删除）
        checkboxRow(document, {
            id: `advisor-gate-${kind}-enabled`,
            checked: gate.enabled === true,
            label: `启用 ${GATE_LABELS[kind] ?? kind} 门`,
            disabled,
            onChange: (value) => controller.setField(`gates.${kind}.enabled`, value),
        }),
    ];
    const rowFields = el(document, 'div', { class: 'advisorflow_numberFields' }, [
        field(document, {
            id: `advisor-gate-${kind}-policy`,
            label: '策略',
            control: selectControl(document, {
                id: `advisor-gate-${kind}-policy`,
                value: gate.policy ?? 'review',
                options: kind === 'failure' ? ['review', 'ask', 'block', 'block-session'] : ['review', 'ask', 'block'],
                onChange: (value) => controller.setField(`gates.${kind}.policy`, value),
                disabled,
                ariaLabel: `${kind} 门策略`,
            }),
        }),
        ...(['failure', 'loop'].includes(kind)
            ? [field(document, {
                id: `advisor-gate-${kind}-threshold`,
                label: '阈值',
                control: numberControl(document, {
                    id: `advisor-gate-${kind}-threshold`,
                    value: gate.threshold,
                    min: 1,
                    placeholder: '默认 3', // 空值 = 用默认阈值，消除歧义（T-006 目验 ③）
                    onChange: (value) => controller.setField(`gates.${kind}.threshold`, value),
                    disabled,
                    ariaLabel: `${kind} 门阈值`,
                }),
            })]
            : []),
    ]);
    children.push(rowFields);
    // fieldset 无 legend（T-006 目验 ①：门名已在 checkbox 文字，legend 冗余；
    // dsh-advisor 本体 fieldset 亦无 legend——去掉即对齐）。
    return el(document, 'fieldset', { class: 'advisorflow_fieldset', 'data-gate': kind }, children);
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
    // 展开态持久化在 controller state（T-006 实测：render 闭包/宿主 slot
    // 重挂都会丢展开态）——header 点击经 controller.setExpanded 翻转，
    // setField/emit 触发的重绘保留当前展开态；error 强制展开（渲染期判定）。
    const root = document.createElement('div');
    root.setAttribute('class', 'advisorflow_card');
    container.appendChild(root);

    function refresh() {
        const state = controller.getState();
        // Rebuild in place: the card is small enough that diffing costs more
        // than replacing children.
        while (root.firstChild) {
            root.removeChild(root.firstChild);
        }
        const hasError = state.status === 'error' || Boolean(state.error);
        const open = state.expanded === true || hasError;
        root.setAttribute('class', open ? 'advisorflow_card advisorflow_cardOpen' : 'advisorflow_card');

        // 可折叠 header：name/description/chevron（同款 SVG 旋转切换两态）
        root.appendChild(el(document, 'button', {
            type: 'button',
            class: 'advisorflow_header',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': `${open ? '收起' : '展开'}：${CARD_TITLE}`,
            onClick: () => {
                controller.setExpanded(!open); // 翻转持久化展开态
                refresh();
            },
        }, [
            el(document, 'span', { class: 'advisorflow_headText' }, [
                el(document, 'span', { class: 'advisorflow_name', text: CARD_TITLE }),
                el(document, 'span', { class: 'advisorflow_description', text: CARD_DESCRIPTION }),
            ]),
            el(document, 'span', {
                class: open ? 'advisorflow_chevron advisorflow_chevronOpen' : 'advisorflow_chevron',
            }, [chevronIcon(document)]),
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
            // 折叠态：无提示行（T-006 ②）——body 整体不渲染
            return;
        }

        const config = state.effectiveConfig ?? {};
        const advisor = isRecord(config.advisor) ? config.advisor : {};
        const form = el(document, 'div', { class: 'advisorflow_form' }, []);

        // 启用开关（拨动开关样式，对照宿主 Subagent 卡：深色圆角轨道 + 圆形
        // 滑块；checkbox 本体保留视觉隐藏——语义与可访问性不变）。
        // 注意：:checked 兄弟选择器要求 input 在轨道之前（真实 DOM 生效）。
        const disabled = config.enabled !== true;
        form.appendChild(el(document, 'div', { class: 'advisorflow_checkboxRow' }, [
            el(document, 'label', { class: 'advisorflow_checkLabel', for: 'advisor-enabled', text: '启用 Advisor Flow' }),
            el(document, 'input', {
                type: 'checkbox',
                id: 'advisor-enabled',
                class: 'advisorflow_switchCheckbox',
                'aria-label': 'advisor-enabled',
                ...(config.enabled === true ? { checked: 'checked' } : {}),
                onChange: (event) => controller.setField('enabled', event.target.checked),
            }),
            el(document, 'span', { class: 'advisorflow_switchTrack', 'aria-hidden': 'true' }, [
                el(document, 'span', { class: 'advisorflow_switchThumb' }),
            ]),
        ]));

        // 三级联动（东家要求，目录实测契约）：provider/model/effort 从 dsh
        // 已配置目录动态下拉；目录不可用时回退现状自由文本/硬编码档位
        // （degradations.catalog 已由 controller 显性化）。
        const providerOptions = controller.providerOptions();
        const providerControl = Array.isArray(providerOptions)
            ? selectControl(document, {
                id: 'advisor-provider',
                value: advisor.provider ?? '',
                options: [{ value: '', label: '— 选择 provider —' }, ...providerOptions],
                onChange: (value) => controller.setField('advisor.provider', value === '' ? null : value),
                disabled,
                ariaLabel: 'Advisor provider',
            })
            : el(document, 'input', {
                type: 'text',
                id: 'advisor-provider',
                class: 'advisorflow_input',
                value: advisor.provider ?? '',
                'aria-label': 'Advisor provider',
                disabled,
                onChange: (event) => controller.setField('advisor.provider', event.target.value),
            });
        const providerStale = Array.isArray(providerOptions)
            && Boolean(advisor.provider)
            && !providerOptions.some((option) => option.value === advisor.provider);
        form.appendChild(field(document, {
            id: 'advisor-provider',
            label: 'Advisor provider',
            control: providerControl,
            disabled,
            hint: providerStale ? `当前值 ${advisor.provider} 不在目录中（保留透传）` : undefined,
        }));

        const modelOptions = controller.modelsFor(advisor.provider);
        const modelControl = Array.isArray(modelOptions)
            ? selectControl(document, {
                id: 'advisor-model',
                value: advisor.model ?? '',
                options: modelOptions,
                onChange: (value) => controller.setField('advisor.model', value === '' ? null : value),
                disabled,
                ariaLabel: 'Advisor model',
            })
            : el(document, 'input', {
                type: 'text',
                id: 'advisor-model',
                class: 'advisorflow_input',
                value: advisor.model ?? '',
                'aria-label': 'Advisor model',
                disabled,
                onChange: (event) => controller.setField('advisor.model', event.target.value),
            });
        const modelStale = Array.isArray(modelOptions)
            && Boolean(advisor.model)
            && !modelOptions.some((option) => option.value === advisor.model);
        form.appendChild(field(document, {
            id: 'advisor-model',
            label: 'Advisor model',
            control: modelControl,
            disabled,
            hint: modelStale ? `当前值 ${advisor.model} 不在目录中（保留透传）` : undefined,
        }));

        // reasoningEffort（R-02-001/AC-01 GUI 面）：目录模式下选项来自所选
        // 模型声明的 reasoning.efforts，空值 = 跟随模型默认（标注
        // defaultEffort）；模型不支持的档位由调用前的能力门控回退默认。
        const effortOptions = controller.effortOptions(advisor.model);
        const effortControl = Array.isArray(effortOptions)
            ? selectControl(document, {
                id: 'advisor-reasoning-effort',
                value: advisor.reasoningEffort ?? '',
                options: effortOptions,
                onChange: (value) => controller.setField('advisor.reasoningEffort', value === '' ? null : value),
                ariaLabel: 'advisor reasoningEffort',
            })
            : selectControl(document, {
                id: 'advisor-reasoning-effort',
                value: advisor.reasoningEffort ?? '',
                options: [
                    { value: '', label: '不指定（跟随模型默认）' },
                    { value: 'low', label: '低 (low)' },
                    { value: 'high', label: '高 (high)' },
                    { value: 'max', label: '最大 (max)' },
                    { value: 'off', label: '关闭 (off)' },
                ],
                onChange: (value) => controller.setField('advisor.reasoningEffort', value === '' ? null : value),
                ariaLabel: 'advisor reasoningEffort',
            });
        form.appendChild(field(document, {
            id: 'advisor-reasoning-effort',
            label: 'advisor reasoningEffort',
            control: effortControl,
            hint: '模型不支持的档位将回退模型默认',
        }));

        // 四门 fieldset（legend 已删——门名在 checkbox 文字；T-006 目验 ①）
        const gates = isRecord(config.gates) ? config.gates : {};
        const gatesFieldset = el(document, 'fieldset', { class: 'advisorflow_fieldset' }, []);
        for (const kind of ['plan', 'failure', 'loop', 'completion']) {
            const gateNode = gateBlock(document, kind, gates[kind] ?? {}, controller, disabled);
            if (disabled) {
                gateNode.setAttribute('class', `${gateNode.attrs.class ?? ''} advisorflow_disabledGroup`.trim());
            }
            gatesFieldset.appendChild(gateNode);
        }
        form.appendChild(gatesFieldset);

        // 隐私档位 fieldset+legend
        const privacy = isRecord(config.privacy) ? config.privacy : {};
        const privacyNode = el(document, 'fieldset', { class: 'advisorflow_fieldset' }, [
            el(document, 'legend', { class: 'advisorflow_legend', text: '隐私档位' }),
            field(document, {
                id: 'advisor-privacy-history',
                label: 'History 档位',
                control: selectControl(document, {
                    id: 'advisor-privacy-history',
                    value: privacy.history ?? 'window',
                    options: ['off', 'delta', 'window'],
                    onChange: (value) => controller.setField('privacy.history', value),
                    disabled,
                    ariaLabel: 'History 档位',
                }),
            }),
            field(document, {
                id: 'advisor-privacy-repo-context',
                label: 'RepoContext 档位',
                control: selectControl(document, {
                    id: 'advisor-privacy-repo-context',
                    value: privacy.repoContext ?? 'summary',
                    options: ['none', 'summary', 'patch'],
                    onChange: (value) => controller.setField('privacy.repoContext', value),
                    disabled,
                    ariaLabel: 'RepoContext 档位',
                }),
            }),
            checkboxRow(document, {
                id: 'advisor-privacy-redact-secrets',
                checked: privacy.redactSecrets !== false,
                label: '密钥脱敏',
                disabled,
                onChange: (value) => controller.setField('privacy.redactSecrets', value),
            }),
        ]);
        if (disabled) {
            privacyNode.setAttribute('class', `${privacyNode.attrs.class ?? ''} advisorflow_disabledGroup`.trim());
        }
        form.appendChild(privacyNode);

        const body = el(document, 'div', { class: 'advisorflow_body' }, [form]);

        // 回执/错误/降级文案（form 与 footer 之间）
        const degraded = state.degradations ?? {};
        const degradedKeys = Object.keys(degraded);
        if (degradedKeys.length > 0) {
            body.appendChild(el(document, 'p', {
                class: 'advisorflow_notice',
                text: `降级：${degradedKeys.map((key) => `${key}=${degraded[key]}`).join('；')}`,
            }));
        }
        if (state.savedNotice) {
            body.appendChild(el(document, 'p', {
                class: 'advisorflow_savedNotice advisor-flow-notice',
                text: state.savedNotice,
            }));
        }
        if (state.validationError || state.error) {
            body.appendChild(el(document, 'p', {
                class: 'advisorflow_error advisor-flow-error',
                text: state.validationError ?? state.error,
            }));
        }

        // footer：右对齐按钮组（放弃修改/保存）
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
