/**
 * Web settings card — DOM renderer over the pure controller
 * ({@link ../card-state.js}). 视觉与结构对齐 dsh-advisor 的 advisor-card
 * （T-006：东家四点视觉反馈）：
 * - CSS-module 风格 `<style data-plugin-css>` 注入 + 去重守卫，类名前缀
 *   `advisorflow_`，令牌 --dsw-alias-*（明暗主题适配）；
 * - 默认折叠（error 强制展开）；折叠态无提示行；
 * - chevron 为内联 SVG（同款路径旋转切换两态）；
 * - 表单层级：checkboxRow（启用）→ field 竖排（label 在上、控件在下，
 *   gap 6px）→ fieldset（四门无 legend——门名在 checkbox 文字；隐私带
 *   legend，T-007 起组标题 14px 高于选项标题 13px）→ numberFields 网格
 *   （阈值）→ footer 右对齐（放弃修改/保存）+ notice/savedNotice/error
 *   文案；
 * - 文案统一中文规范名 + 每字段一句说明 hint（T-007：东家四点可读性
 *   反馈；下拉选项「中文（原值）」双写）；
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
.advisorflow_disabledGroup{opacity:.5}
/* 拨动开关：官方基元 Switch 逐项复刻（button[role=switch] 36×20、
   选中 brand-primary、thumb 16×16 translate(16px)、.12s ease）——
   与宿主 Subagent 卡同一视觉（东家要求完全对齐）。 */
.advisorflow_switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:10px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer}
.advisorflow_switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.advisorflow_switch:disabled{cursor:default;opacity:.5}
.advisorflow_switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.advisorflow_thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s ease}
.advisorflow_switch[aria-checked=true] .advisorflow_thumb{transform:translate(16px)}
/* toggleRow：label 左、控件右（宿主 Subagent 卡同款布局行）。 */
.advisorflow_toggleRow{justify-content:space-between;align-items:center;gap:16px;display:flex}
.advisorflow_toggleLabel{color:var(--dsw-alias-label-primary);flex:1;min-width:0;font-size:13px;line-height:1.5}
.advisorflow_fieldset{border:none;flex-direction:column;gap:12px;margin:0;padding:0;display:flex}
.advisorflow_legend{color:var(--dsw-alias-label-secondary);font-size:14px;font-weight:600;line-height:20px}
.advisorflow_field{flex-direction:column;gap:6px;display:flex}
.advisorflow_fieldLabel{color:var(--dsw-alias-label-secondary);align-items:center;gap:10px;font-size:12px;font-weight:500;line-height:18px;display:inline-flex}
.advisorflow_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:14px;line-height:22px}
select.advisorflow_input{cursor:pointer}
.advisorflow_input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.advisorflow_input::placeholder{color:var(--dsw-alias-label-dimmed)}
.advisorflow_input:disabled{opacity:.6;cursor:default}
select.advisorflow_selectInput{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-position:right 12px center;background-repeat:no-repeat;background-size:12px 12px;padding-right:32px}
.advisorflow_numberFields{grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;display:grid}
.advisorflow_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
.advisorflow_notice{color:var(--dsw-alias-state-warn-label);margin:12px 0 0;font-size:12px;line-height:18px}
.advisorflow_savedNotice{color:var(--dsw-alias-state-success-primary);margin:12px 0 0;font-size:12px;line-height:18px}
.advisorflow_error{color:var(--dsw-alias-state-error-primary);margin:12px 0 0;font-size:12px;line-height:18px}
.advisorflow_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;margin-top:12px;padding:12px 0 4px;display:flex}
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

/**
 * 拨动开关（官方基元 Switch 逐项复刻）：`button[role=switch] > span.thumb`，
 * 视觉与宿主 Subagent 卡完全一致；点击翻转，disabled 时不动作。
 */
function switchControl(document, { id, checked, onChange, label, disabled }) {
    const button = el(document, 'button', {
        type: 'button',
        role: 'switch',
        class: 'advisorflow_switch',
        id,
        'aria-checked': checked === true ? 'true' : 'false',
        'aria-label': label,
        ...(disabled ? { disabled: 'disabled' } : {}),
        onClick: () => {
            if (!disabled) {
                onChange(!(checked === true));
            }
        },
    }, [
        el(document, 'span', { class: 'advisorflow_thumb' }),
    ]);
    // mousedown preventDefault：抑制点击时浏览器的聚焦滚动（Chrome 在
    // mousedown 聚焦时可触发滚动重定位——东家目验「切换开关引起页面滚动
    // 位置变化」）。键盘 Tab 聚焦与 click 语义不受影响（可访问性保留）。
    if (typeof button.addEventListener === 'function') {
        button.addEventListener('mousedown', (event) => event.preventDefault());
    }
    return button;
}

/** toggleRow：label 左、控件右（宿主 Subagent 卡同款布局行）。 */
function toggleRow(document, { label, control }) {
    return el(document, 'div', { class: 'advisorflow_toggleRow' }, [
        el(document, 'span', { class: 'advisorflow_toggleLabel', text: label }),
        control,
    ]);
}

/** hint 段落（field() 内部与独立的说明行共用同一段落形态）。 */
function hintParagraph(document, text) {
    return el(document, 'p', { class: 'advisorflow_hint', text });
}

function field(document, { id, label, control, hint, warnHint }) {
    return el(document, 'div', { class: 'advisorflow_field' }, [
        el(document, 'label', { class: 'advisorflow_fieldLabel', for: id, text: label }),
        control,
        ...(hint ? [hintParagraph(document, hint)] : []),
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

/* 守则与硬门文案（C-007 对齐 lib/guidelines.js 与 lib/config.js）：
   计划/失败/收尾三类关键节点由执行者守则约束（软约束，布尔开关）；循环门是
   唯一硬门（Decision 三值决策）；blocked 决策与咨询失败按全局阻断模式
   failureMode 统一处置（warn-and-continue 放行 / block-tool 拦截该次 /
   block-session 封锁会话）。 */
const GATE_LABELS = { plan: '计划守则', failure: '失败守则', loop: '循环门', completion: '完成守则' };
const GATE_HINTS = {
    plan: '启用后，执行者在制定有实质影响的计划前先调用 ask_advisor 并附上草稿（命名拟议工作、验证方式与剩余风险）',
    failure: '启用后，等价尝试连续失败或无可测进展时先咨询，咨询之前不再做实质等价的尝试',
    loop: '启用后，等价工具调用重复达到阈值的那次调用，执行前先经顾问评审（Decision 三值决策）',
    completion: '启用后，执行者在宣告完成前先调用 ask_advisor 并附上命名已变更工作、验证方式与剩余风险的草稿',
};
const THRESHOLD_HINT = '等价工具调用重复达到该次数的那次调用即受审；留空用默认 3';
const FAILURE_MODE_OPTIONS = [
    { value: 'warn-and-continue', label: '警告并放行（warn-and-continue）' },
    { value: 'block-tool', label: '拦截本次调用（block-tool）' },
    { value: 'block-session', label: '封锁会话（block-session）' },
];
const FAILURE_MODE_HINT = '循环门 blocked 决策与咨询失败的统一处置档位';

/* 守则门块：开关 + 触发时机说明（软约束，无策略/阈值控件）。 */
function guidelineGateBlock(document, kind, gate, controller, disabled) {
    return el(document, 'fieldset', { class: 'advisorflow_fieldset', 'data-gate': kind }, [
        toggleRow(document, {
            label: `启用${GATE_LABELS[kind] ?? kind}`,
            control: switchControl(document, {
                id: `advisor-gate-${kind}-enabled`,
                checked: gate.enabled === true,
                label: `启用${GATE_LABELS[kind] ?? kind}`,
                disabled,
                onChange: (value) => controller.setField(`gates.${kind}.enabled`, value),
            }),
        }),
        hintParagraph(document, GATE_HINTS[kind]),
    ]);
}

/* 循环门块 = 开关 + 触发时机说明 + 阈值输入（唯一硬门，Decision 协议）。 */
function loopGateBlock(document, gate, controller, disabled) {
    // 阈值随门开关联动禁用：总开关关 OR 循环门关 → 阈值变灰（东家目验语义）。
    const gateDisabled = disabled || gate.enabled !== true;
    return el(document, 'fieldset', { class: 'advisorflow_fieldset', 'data-gate': 'loop' }, [
        toggleRow(document, {
            label: '启用循环门',
            control: switchControl(document, {
                id: 'advisor-gate-loop-enabled',
                checked: gate.enabled === true,
                label: '启用循环门',
                disabled,
                onChange: (value) => controller.setField('gates.loop.enabled', value),
            }),
        }),
        hintParagraph(document, GATE_HINTS.loop),
        field(document, {
            id: 'advisor-gate-loop-threshold',
            label: '阈值',
            control: numberControl(document, {
                id: 'advisor-gate-loop-threshold',
                value: gate.threshold,
                min: 1,
                placeholder: '默认 3', // 空值 = 用默认阈值，消除歧义（T-006 目验 ③）
                onChange: (value) => controller.setField('gates.loop.threshold', value),
                disabled: gateDisabled,
                ariaLabel: '循环门阈值',
            }),
            hint: THRESHOLD_HINT,
        }),
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
    // 展开态持久化在 controller state（T-006 实测：render 闭包/宿主 slot
    // 重挂都会丢展开态）——header 点击经 controller.setExpanded 翻转，
    // setField/emit 触发的重绘保留当前展开态；error 强制展开（渲染期判定）。
    const root = document.createElement('div');
    root.setAttribute('class', 'advisorflow_card');
    container.appendChild(root);

    function refresh() {
        const state = controller.getState();
        // 原子重建 + 焦点还原（东家目验：切换开关引起页面滚动位置变化）：
        // 旧实现「先清空 root 再逐个 append」在点击获焦开关时会移除焦点
        // 元素并产生中间塌缩态，浏览器随之重新锚定滚动位置。现在先在旁路
        // 收集整棵新树、再一次 replaceChildren 替换，并还原重建前的焦点。
        const focusedId = typeof document.activeElement?.id === 'string' && document.activeElement.id
            ? document.activeElement.id
            : null;
        const nodes = [];
        const hasError = state.status === 'error' || Boolean(state.error);
        const open = state.expanded === true || hasError;
        root.setAttribute('class', open ? 'advisorflow_card advisorflow_cardOpen' : 'advisorflow_card');
        const mount = () => {
            if (typeof root.replaceChildren === 'function') {
                root.replaceChildren(...nodes);
            } else {
                // 测试桩无 replaceChildren 时的回退路径（行为等价，仅非原子）。
                while (root.firstChild) {
                    root.removeChild(root.firstChild);
                }
                for (const node of nodes) {
                    root.appendChild(node);
                }
            }
            // 焦点还原：id 由本模块生成（字符集安全），无需 CSS.escape。
            // preventScroll：焦点元素本就在视口内，默认滚动归位反而引起
            // 滚动跳动（本次修复的对象）。
            if (focusedId && typeof root.querySelector === 'function') {
                root.querySelector(`#${focusedId}`)?.focus?.({ preventScroll: true });
            }
        };

        // 可折叠 header：name/description/chevron（同款 SVG 旋转切换两态）
        nodes.push(el(document, 'button', {
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
            mount();
            void controller.load();
            return;
        }
        if (state.status === 'error') {
            nodes.push(el(document, 'p', {
                class: 'advisorflow_error advisor-flow-error',
                text: state.error ?? '配置加载失败',
            }));
            // error 态必须可自愈（dsh-advisor 同款 retry）：load 失败是瞬态
            // 可能（宿主忙/端点短暂缺失），无恢复手段则表单永久消失——东家
            // 目验的「卡片内容消失、无法再展开」即此形态。
            nodes.push(el(document, 'button', {
                type: 'button',
                class: 'advisorflow_discard advisor-flow-discard',
                text: '重试',
                onClick: () => {
                    // 重试成功后 error 消除 → hasError 失效，open 会塌回
                    // expanded——必须先置展开态，否则表单在恢复瞬间再次消失
                    // （与 T-006 展开态丢失同型）。
                    controller.setExpanded(true);
                    void controller.load();
                },
            }));
            mount();
            return;
        }
        if (!open) {
            // 折叠态：无提示行（T-006 ②）——body 整体不渲染
            mount();
            return;
        }

        const config = state.effectiveConfig ?? {};
        const advisor = isRecord(config.advisor) ? config.advisor : {};
        const form = el(document, 'div', { class: 'advisorflow_form' }, []);

        // 启用开关（官方 Switch 复刻 + Subagent 卡同款 toggleRow：label 左、
        // 开关右）。主开关始终可操作——disabled 变量语义是「其余控件随启用
        // 态禁用」，不是本开关本身。
        const disabled = config.enabled !== true;
        form.appendChild(toggleRow(document, {
            label: '启用 Advisor Flow',
            control: switchControl(document, {
                id: 'advisor-enabled',
                checked: config.enabled === true,
                label: '启用 Advisor Flow',
                onChange: (value) => controller.setField('enabled', value),
            }),
        }));
        form.appendChild(hintParagraph(document, '关闭后 ask_advisor 工具与四类门控一并停用（已填配置保留）'));

        // 三级联动（东家要求，目录实测契约）：provider/model/effort 从 dsh
        // 已配置目录动态下拉；目录不可用时回退现状自由文本/硬编码档位
        // （degradations.catalog 已由 controller 显性化）。
        const providerOptions = controller.providerOptions();
        const providerControl = Array.isArray(providerOptions)
            ? selectControl(document, {
                id: 'advisor-provider',
                value: advisor.provider ?? '',
                options: [{ value: '', label: '— 选择提供方 —' }, ...providerOptions],
                onChange: (value) => controller.setField('advisor.provider', value === '' ? null : value),
                disabled,
                ariaLabel: '顾问提供方',
            })
            : el(document, 'input', {
                type: 'text',
                id: 'advisor-provider',
                class: 'advisorflow_input',
                value: advisor.provider ?? '',
                'aria-label': '顾问提供方',
                disabled,
                onChange: (event) => controller.setField('advisor.provider', event.target.value),
            });
        const providerStale = Array.isArray(providerOptions)
            && Boolean(advisor.provider)
            && !providerOptions.some((option) => option.value === advisor.provider);
        form.appendChild(field(document, {
            id: 'advisor-provider',
            label: '顾问提供方',
            control: providerControl,
            disabled,
            hint: providerStale
                ? `当前值 ${advisor.provider} 不在目录中（保留透传）`
                : '顾问模型的路由提供方；选项来自本机已配置的模型目录',
        }));

        const modelOptions = controller.modelsFor(advisor.provider);
        const modelControl = Array.isArray(modelOptions)
            ? selectControl(document, {
                id: 'advisor-model',
                value: advisor.model ?? '',
                options: modelOptions,
                onChange: (value) => controller.setField('advisor.model', value === '' ? null : value),
                disabled,
                ariaLabel: '顾问模型',
            })
            : el(document, 'input', {
                type: 'text',
                id: 'advisor-model',
                class: 'advisorflow_input',
                value: advisor.model ?? '',
                'aria-label': '顾问模型',
                disabled,
                onChange: (event) => controller.setField('advisor.model', event.target.value),
            });
        const modelStale = Array.isArray(modelOptions)
            && Boolean(advisor.model)
            && !modelOptions.some((option) => option.value === advisor.model);
        form.appendChild(field(document, {
            id: 'advisor-model',
            label: '顾问模型',
            control: modelControl,
            disabled,
            hint: modelStale
                ? `当前值 ${advisor.model} 不在目录中（保留透传）`
                : '提供第二意见的顾问模型；候选随所选提供方联动',
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
                disabled,
                ariaLabel: '推理档位',
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
                disabled,
                ariaLabel: '推理档位',
            });
        form.appendChild(field(document, {
            id: 'advisor-reasoning-effort',
            label: '推理档位',
            control: effortControl,
            hint: '顾问模型的推理力度；留空跟随模型默认，模型不支持的档位自动回退默认',
        }));

        // 门 fieldset（legend 已删——门名在开关文字；T-006 目验 ①）：
        // 计划/失败/收尾三类独立守则开关（软约束）+ 循环门（唯一硬门，开关 +
        // 阈值输入）；阻断模式 failureMode 为全局统一处置档位下拉。
        const gates = isRecord(config.gates) ? config.gates : {};
        const gatesFieldset = el(document, 'fieldset', { class: 'advisorflow_fieldset' }, []);
        for (const kind of ['plan', 'failure', 'completion']) {
            const gateNode = guidelineGateBlock(document, kind, gates[kind] ?? {}, controller, disabled);
            if (disabled) {
                gateNode.setAttribute('class', `${gateNode.getAttribute('class') ?? ''} advisorflow_disabledGroup`.trim());
            }
            gatesFieldset.appendChild(gateNode);
        }
        const loopNode = loopGateBlock(document, gates.loop ?? {}, controller, disabled);
        if (disabled) {
            loopNode.setAttribute('class', `${loopNode.getAttribute('class') ?? ''} advisorflow_disabledGroup`.trim());
        }
        gatesFieldset.appendChild(loopNode);
        form.appendChild(gatesFieldset);

        // 阻断模式 failureMode（全局统一处置档位，中文双写下拉）。
        form.appendChild(field(document, {
            id: 'advisor-failure-mode',
            label: '阻断模式',
            control: selectControl(document, {
                id: 'advisor-failure-mode',
                value: config.failureMode ?? 'warn-and-continue',
                options: FAILURE_MODE_OPTIONS,
                onChange: (value) => controller.setField('failureMode', value),
                disabled,
                ariaLabel: '阻断模式',
            }),
            hint: FAILURE_MODE_HINT,
        }));

        // 隐私档位 fieldset+legend（T-007：legend 14px 高于选项标题 13px，
        // 组标题/选项两级可辨；档位说明对齐 lib/git-context.js 截断语义）。
        const privacy = isRecord(config.privacy) ? config.privacy : {};
        const privacyNode = el(document, 'fieldset', { class: 'advisorflow_fieldset' }, [
            el(document, 'legend', { class: 'advisorflow_legend', text: '隐私档位' }),
            field(document, {
                id: 'advisor-privacy-history',
                label: '会话历史档位',
                control: selectControl(document, {
                    id: 'advisor-privacy-history',
                    value: privacy.history ?? 'window',
                    options: [
                        { value: 'off', label: '不发送（off）' },
                        { value: 'delta', label: '最近切片（delta）' },
                        { value: 'window', label: '最近窗口（window）' },
                    ],
                    onChange: (value) => controller.setField('privacy.history', value),
                    disabled,
                    ariaLabel: '会话历史档位',
                }),
                hint: '随咨询发送的会话历史范围：off 不发送；delta 最近约 8k 字符；window 最近约 24k 字符',
            }),
            field(document, {
                id: 'advisor-privacy-repo-context',
                label: '仓库上下文档位',
                control: selectControl(document, {
                    id: 'advisor-privacy-repo-context',
                    value: privacy.repoContext ?? 'summary',
                    options: [
                        { value: 'none', label: '不发送（none）' },
                        { value: 'summary', label: '仅结构摘要（summary）' },
                        { value: 'patch', label: '含变更补丁（patch）' },
                    ],
                    onChange: (value) => controller.setField('privacy.repoContext', value),
                    disabled,
                    ariaLabel: '仓库上下文档位',
                }),
                hint: '随咨询发送的仓库信息范围：none 不发送（顾问会被告知无仓库访问）；summary 仅结构摘要；patch 含当前变更补丁（受字节上限）',
            }),
            toggleRow(document, {
                label: '密钥脱敏',
                control: switchControl(document, {
                    id: 'advisor-privacy-redact-secrets',
                    checked: privacy.redactSecrets !== false,
                    label: '密钥脱敏',
                    disabled,
                    onChange: (value) => controller.setField('privacy.redactSecrets', value),
                }),
            }),
            hintParagraph(document, '开启后，密钥形状的值在发送给顾问前替换为占位符'),
        ]);
        if (disabled) {
            privacyNode.setAttribute('class', `${privacyNode.getAttribute('class') ?? ''} advisorflow_disabledGroup`.trim());
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

        nodes.push(body);
        mount();
    }

    controller.subscribe(refresh);
    refresh();
    return { refresh };
}
