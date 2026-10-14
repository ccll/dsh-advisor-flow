/**
 * Web settings card — DOM renderer over the pure controller
 * ({@link ../card-state.js}). 视觉与结构对齐 dsh-advisor 的 advisor-card
 * （T-006：东家四点视觉反馈）：
 * - CSS-module 风格 `<style data-plugin-css>` 注入 + 去重守卫，类名前缀
 *   `advisorflow_`，令牌 --dsw-alias-*（明暗主题适配）；
 * - 卡片平铺常开（C-030/T-031：0.2.0 插件详情页为每插件独享配置面，无
 *   折叠交互）；header 为静态标题行（标题/描述/未保存徽标，不可点），
 *   表单常开；
 * - 表单层级：未配置横幅（advisor.provider/model 缺失时提示——启用状态
 *   由配置派生，R-02-001/AC-03/AC-13，C-030）→ field 竖排（label 在上、
 *   控件在下，gap 6px）→ fieldset（四门无 legend——门名在 checkbox 文字；
 *   隐私带 legend，T-007 起组标题 14px 高于选项标题 13px）→ numberFields
 *   网格（阈值）→ footer 右对齐（放弃修改/保存）+ notice/savedNotice/
 *   error 文案；
 * - 保存控件常驻（T-024，C-024）：footer sticky 固定于滚动视口底部，
 *   长表单滚动时保存/放弃修改可见（R-02-001/AC-09）；钉位线按宿主滚
 *   动容器 padding-bottom 运行期补偿，防底部条带泄漏；dirty（patch 非
 *   空）时头部渲染「未保存」徽标（R-02-001/AC-10），保存或放弃后消失
 *   （R-02-001/AC-12）；
 * - 文案统一中文规范名 + 每字段一句说明 hint（T-007：东家四点可读性
 *   反馈；下拉选项「中文（原值）」双写）；
 * - 值流经 configForms 快照订阅（读）与保存时一次 settings.mutate（写）；
 *   宿主把表单置只读（writable=false）时保存钮禁用并提示。
 *
 * @module dsh-advisor-flow/client/render
 */

import { isRecord } from '../util.js';
// 默认值绑定权威常量而非字面量：未配置时下拉选中档位即向会话主展示生效默认（T-018）。
import { DEFAULT_FAILURE_MODE, DEFAULT_INTERVENTION_MODE, DEFAULT_TURN_REVIEW_EXEMPT_PATTERNS } from '../config.js';

const CARD_TITLE = 'Advisor Flow';
const CARD_DESCRIPTION = '每次关键动作前由独立顾问模型评审并注入建议';

/** CSS-module 风格样式表（类名前缀 advisorflow_；令牌 --dsw-alias-*）。 */
const CSS = `
.advisorflow_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.advisorflow_card:hover{border-color:var(--dsw-alias-label-dimmed)}
.advisorflow_header{width:100%;font:inherit;color:inherit;text-align:left;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.advisorflow_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.advisorflow_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.advisorflow_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.advisorflow_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.advisorflow_form{flex-direction:column;gap:12px;padding:12px 0 0;display:flex}
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
.advisorflow_banner{color:var(--dsw-alias-state-warn-label);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;margin:12px 16px 0;padding:10px 12px;font-size:12px;line-height:18px}
.advisorflow_footer{position:sticky;bottom:0;z-index:1;border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;margin:12px -16px 0;padding:12px 16px 12px;display:flex;background:var(--dsw-alias-bg-layer-2);border-radius:0 0 12px 12px}
.advisorflow_discard,.advisorflow_retry,.advisorflow_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.advisorflow_discard,.advisorflow_retry{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.advisorflow_discard:hover:not(:disabled),.advisorflow_retry:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.advisorflow_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.advisorflow_discard:disabled,.advisorflow_retry:disabled,.advisorflow_save:disabled{opacity:.4;cursor:default}
.advisorflow_discard:focus-visible,.advisorflow_retry:focus-visible,.advisorflow_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.advisorflow_dirtyBadge{flex:none;color:var(--dsw-alias-state-warn-label);border:1px solid currentColor;border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px}
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

/**
 * Sticky footer 钉位线补偿（T-024 东家目验缺陷修正，R-02-001/AC-09）。
 *
 * 宿主滚动容器的 padding-bottom 使 `bottom: 0` 钉在其内容缘而非可视
 * 缘，条带内滚过的表单内容可见（789×794 实测：条带 24px，泄漏带内
 * elementFromPoint 命中表单字段）。运行期量取最近滚动祖先的
 * padding-bottom，以等值负 inset 下移钉位线，使 footer 底缘贴合可视
 * 缘、自身背景覆盖条带；无滚动祖先（测试桩/表单未超高）保持 0，
 * sticky 未钉住时负 inset 无副作用（自然原位不受影响）。
 */
function applyStickyBottomInset(root, document) {
    const footer = typeof root?.querySelector === 'function' ? root.querySelector('.advisorflow_footer') : null;
    if (!footer || !footer.style || typeof footer.style.setProperty !== 'function') {
        return; // 测试桩节点无 style 通道：跳过（样式断言走 CSS 文本，行为走浏览器实测）
    }
    if (typeof getComputedStyle !== 'function') {
        return; // 非浏览器环境：无可量取的宿主布局
    }
    let node = footer.parentElement;
    while (node && node !== document.documentElement) {
        const style = getComputedStyle(node);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
            const inset = Number.parseFloat(style.paddingBottom) || 0;
            footer.style.bottom = inset > 0 ? `${-inset}px` : '0px';
            return;
        }
        node = node.parentElement;
    }
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
        // null = 未配置（回归缺省）——渲染为空输入框，与占位文案一致。
        ...(value === undefined || value === null ? {} : { value: String(value) }),
        ...(disabled ? { disabled: 'disabled' } : {}),
        onChange: (event) => {
            // 清空 = 回归缺省（T-016）：显式上送 null，使「留空用默认」
            // 的占位承诺成为真实行为（此前清空不触发 onChange，旧值滞留）。
            if (event.target.value === '') {
                onChange(null);
                return;
            }
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
const MODE_OPTIONS = [
    { value: 'soft', label: '软模式：守则建议（soft）' },
    { value: 'hard', label: '硬模式：回合收口强制评审（hard）' },
];
const MODE_HINT = '软模式只以守则建议；硬模式在每次回合收口前强制发起一次顾问评审（Decision 三值裁决）';

/* 守则门块：开关 + 触发时机说明（软约束，无策略/阈值控件）。 */
function guidelineGateBlock(document, kind, gate, controller) {
    return el(document, 'fieldset', { class: 'advisorflow_fieldset', 'data-gate': kind }, [
        toggleRow(document, {
            label: `启用${GATE_LABELS[kind] ?? kind}`,
            control: switchControl(document, {
                id: `advisor-gate-${kind}-enabled`,
                checked: gate.enabled === true,
                label: `启用${GATE_LABELS[kind] ?? kind}`,
                onChange: (value) => controller.setField(`gates.${kind}.enabled`, value),
            }),
        }),
        hintParagraph(document, GATE_HINTS[kind]),
    ]);
}

/* 循环门块 = 开关 + 触发时机说明 + 阈值输入（唯一硬门，Decision 协议）。 */
function loopGateBlock(document, gate, controller) {
    // 阈值随门开关联动禁用：循环门关 → 阈值变灰（东家目验语义）。
    const gateDisabled = gate.enabled !== true;
    return el(document, 'fieldset', { class: 'advisorflow_fieldset', 'data-gate': 'loop' }, [
        toggleRow(document, {
            label: '启用循环门',
            control: switchControl(document, {
                id: 'advisor-gate-loop-enabled',
                checked: gate.enabled === true,
                label: '启用循环门',
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
    const root = document.createElement('div');
    root.setAttribute('class', 'advisorflow_card');
    container.appendChild(root);

    // 保存/放弃按钮的按下-抬起委托（T-028 staging 实测缺陷修复）：输入域
    // blur 触发的 setField→重绘发生在「按下-抬起」之间并整体换树，真实浏
    // 览器中被替换的旧按钮不再派发 click，首次保存点击被吞。改为 root 级
    // mousedown 记录意图、mouseup 落点与意图同角色才执行：重绘后抬起落在
    // 同位新按钮仍命中；拖出按钮（落点非同角色）不动作，保留按下-抬起确
    // 认语义。switch 的 mousedown preventDefault（滚动修复遗留）已使其免
    // 疫 blur 重绘，本委托只补 footer 两按钮缺口。
    //
    // 键盘激活（Enter/Space）走另一条路：合成 click 的 detail 为 0，没有
    // 按下-抬起序列，不能等 mousedown/mouseup——root 级 click 监听按角色
    // 直接执行；鼠标 click 的 detail≥1 由按下-抬起委托处理，此处不重入。
    const footerRole = (node) => {
        if (node && typeof node.closest === 'function') {
            if (node.closest('.advisorflow_save')) {
                return 'save';
            }
            if (node.closest('.advisorflow_discard')) {
                return 'discard';
            }
            return null;
        }
        // 测试桩无 closest：按 target 本身的 class 判定（按钮为直接落点）。
        const cls = typeof node?.getAttribute === 'function' ? node.getAttribute('class') : '';
        if (typeof cls === 'string') {
            if (cls.includes('advisorflow_save')) {
                return 'save';
            }
            if (cls.includes('advisorflow_discard')) {
                return 'discard';
            }
        }
        return null;
    };
    let pressIntent = null;
    // 动作执行统一入口：保存门控（saving/校验错误）与放弃语义只此一份。
    const executeFooterAction = (role) => {
        if (role === 'save') {
            const state = controller.getState();
            if (state.saving === true || Boolean(state.validationError) || state.writable === false) {
                return; // 与 disabled 语义一致
            }
            void (async () => {
                await controller.save();
                refresh();
            })();
            return;
        }
        controller.discard();
        refresh();
    };
    root.addEventListener('mousedown', (event) => {
        pressIntent = footerRole(event?.target);
    }, true);
    root.addEventListener('mouseup', (event) => {
        const role = footerRole(event?.target);
        const intent = pressIntent;
        pressIntent = null;
        if (!intent || role !== intent) {
            return;
        }
        executeFooterAction(role);
    }, true);
    root.addEventListener('click', (event) => {
        if (event?.detail !== 0) {
            return; // 鼠标 click 由按下-抬起委托处理
        }
        const role = footerRole(event?.target);
        if (!role) {
            return;
        }
        executeFooterAction(role);
    }, true);

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
        root.setAttribute('class', 'advisorflow_card');
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
            applyStickyBottomInset(root, document);
        };

        // 静态标题行（C-030：详情页独享配置面，无折叠交互）：name/description
        // + 未保存徽标；不可点。
        nodes.push(el(document, 'div', { class: 'advisorflow_header' }, [
            el(document, 'span', { class: 'advisorflow_headText' }, [
                el(document, 'span', { class: 'advisorflow_name', text: CARD_TITLE }),
                el(document, 'span', { class: 'advisorflow_description', text: CARD_DESCRIPTION }),
            ]),
            // 未保存徽标（R-02-001/AC-10，C-024）：dirty 时头部常显；纯标识
            // 不可点，保存动作由 sticky footer 承担（保存或放弃后徽标消失，
            // R-02-001/AC-12）。
            ...(state.dirty ? [el(document, 'span', { class: 'advisorflow_dirtyBadge', text: '未保存' })] : []),
        ]));

        // 派生禁用横幅（R-02-001/AC-03/AC-13，C-030）：ready 态下配置派生
        // 未启用时整卡置顶提示——不出手的原因可查询，字段照常可编辑；
        // 横幅按控制器派生位（effectiveConfig 草稿叠加经服务端同源解析器
        // 求值，card-state.deriveEnabled）显隐，补齐 provider/model 即时
        // 消失，保存与否不影响其显隐。
        const disabledReason = state.disabledReason;
        if (disabledReason) {
            nodes.push(el(document, 'div', {
                class: 'advisorflow_banner',
                text: disabledReason === 'missing-advisor-model'
                    ? 'advisor 未启用：缺少顾问提供方或模型——在下方补齐后保存即可启用'
                    : `advisor 未启用（${disabledReason}）`,
            }));
        }

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
                // 角色类与样式类分离：advisorflow_* 前缀是委托的角色命名空间
                // （footerRole 匹配 .advisorflow_discard 会触发放弃语义），
                // 重试按钮只借样式，用独立角色类 advisorflow_retry——否则
                // 键盘/按下-抬起委托会把重试误判为放弃。
                class: 'advisorflow_retry advisor-flow-discard',
                text: '重试',
                onClick: () => {
                    void controller.retry();
                },
            }));
            mount();
            return;
        }

        const config = state.effectiveConfig ?? {};
        const advisor = isRecord(config.advisor) ? config.advisor : {};
        const form = el(document, 'div', { class: 'advisorflow_form' }, []);

        // 介入强度 mode（表单首位，高于其余选项；软/硬模式中文双写下拉，C-022）。
        form.appendChild(field(document, {
            id: 'advisor-mode',
            label: '介入强度',
            control: selectControl(document, {
                id: 'advisor-mode',
                value: config.mode ?? DEFAULT_INTERVENTION_MODE,
                options: MODE_OPTIONS,
                onChange: (value) => controller.setField('mode', value),
                ariaLabel: '介入强度',
            }),
            hint: MODE_HINT,
        }));

        // 收口评审豁免关键词（R-02-001；T-023/C-023）：审核类子会话收口
        // 豁免的关键词清单，逗号/换行分隔（子串匹配，大小写不敏感）；
        // 清空保存 = 空数组 = 豁免关闭（照常评审）。
        const patternsValue = Array.isArray(config.turnReviewExemptPatterns)
            ? config.turnReviewExemptPatterns
            : DEFAULT_TURN_REVIEW_EXEMPT_PATTERNS;
        form.appendChild(field(document, {
            id: 'advisor-turn-review-exempt-patterns',
            label: '收口评审豁免关键词',
            control: el(document, 'input', {
                type: 'text',
                id: 'advisor-turn-review-exempt-patterns',
                value: patternsValue.join(', '),
                class: 'advisorflow_input',
                ariaLabel: '收口评审豁免关键词',
                onChange: (event) => {
                    const list = String(event.target.value ?? '')
                        .split(/[,，\n]/)
                        .map((item) => item.trim())
                        .filter((item) => item.length > 0);
                    controller.setField('turnReviewExemptPatterns', list);
                },
            }),
            hint: '审核类子会话收口豁免的关键词（子串匹配，大小写不敏感），逗号分隔；清空保存 = 关闭豁免（照常评审）',
        }));

        // 三级联动（东家要求，目录实测契约）：provider/model/effort 从 dsh
        // 已配置目录动态下拉；目录不可用时回退现状自由文本/硬编码档位
        // （degradations.catalog 已由 controller 显性化）。
        // 下拉可用性判定：选项里存在真实值才算可用。目录外 provider 或该
        // provider 无模型声明时 modelsFor 只返回占位项——若仍渲染下拉，用户
        // 无任何可选项（东家生产环境报障：provider=gpu 后 model 永远补不上，
        // 横幅永挂），此时回退自由文本输入，保证 provider/model 始终可补齐。
        const hasRealOption = (options) => Array.isArray(options)
            && options.some((option) => isRecord(option) && option.value !== '');

        const providerOptions = controller.providerOptions();
        const providerControl = hasRealOption(providerOptions)
            ? selectControl(document, {
                id: 'advisor-provider',
                value: advisor.provider ?? '',
                options: [{ value: '', label: '— 选择提供方 —' }, ...providerOptions],
                onChange: (value) => controller.setField('advisor.provider', value === '' ? null : value),
                ariaLabel: '顾问提供方',
            })
            : el(document, 'input', {
                type: 'text',
                id: 'advisor-provider',
                class: 'advisorflow_input',
                value: advisor.provider ?? '',
                'aria-label': '顾问提供方',
                onChange: (event) => controller.setField('advisor.provider', event.target.value),
            });
        const providerStale = Array.isArray(providerOptions)
            && Boolean(advisor.provider)
            && !providerOptions.some((option) => option.value === advisor.provider);
        form.appendChild(field(document, {
            id: 'advisor-provider',
            label: '顾问提供方',
            control: providerControl,
            hint: providerStale
                ? `当前值 ${advisor.provider} 不在目录中（保留透传）`
                : '顾问模型的路由提供方；选项来自本机已配置的模型目录',
        }));

        const modelOptions = controller.modelsFor(advisor.provider);
        const modelControl = hasRealOption(modelOptions)
            ? selectControl(document, {
                id: 'advisor-model',
                value: advisor.model ?? '',
                // 占位项必须有：空值未选择时 <select> 会把第一个真实选项
                // 显示成已选中（幽灵回显，东家生产报障：看起来已配置，
                // 实际存储为空、保存发不出 model 操作、横幅按真实状态常挂）。
                options: [{ value: '', label: '— 选择模型 —' }, ...modelOptions],
                onChange: (value) => controller.setField('advisor.model', value === '' ? null : value),
                ariaLabel: '顾问模型',
            })
            : el(document, 'input', {
                type: 'text',
                id: 'advisor-model',
                class: 'advisorflow_input',
                value: advisor.model ?? '',
                'aria-label': '顾问模型',
                onChange: (event) => controller.setField('advisor.model', event.target.value),
            });
        const modelStale = Array.isArray(modelOptions)
            && Boolean(advisor.model)
            && !modelOptions.some((option) => option.value === advisor.model);
        form.appendChild(field(document, {
            id: 'advisor-model',
            label: '顾问模型',
            control: modelControl,
            hint: modelStale
                ? `当前值 ${advisor.model} 不在目录中（保留透传）`
                : (Array.isArray(modelOptions) && !hasRealOption(modelOptions)
                    ? '目录中该提供方暂无模型声明——直接输入模型 ID 即可'
                    : '提供第二意见的顾问模型；候选随所选提供方联动'),
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
                ariaLabel: '推理档位',
            });
        form.appendChild(field(document, {
            id: 'advisor-reasoning-effort',
            label: '推理档位',
            control: effortControl,
            hint: '顾问模型的推理力度；留空跟随模型默认，模型不支持的档位自动回退默认',
        }));

        // 输出上限（R-02-001/AC-07/AC-08，C-015）：留空 = 跟随所选模型在
        // dsh provider 配置中声明的 maxTokens；填写则覆盖（单次咨询输出上限）。
        // 占位显示声明值（T-032/T-034）：声明值经自有 modelInfo RPC 从宿主
        // 运行时解析（目录快照不携带 limits），模型已声明就把数字追加到
        // 「跟随所选模型配置」后，用户不进 provider 设置也能看到当前生效值；
        // 未声明或通道不可用时回退原文，不猜测。
        const declaredMaxTokens = controller.modelMaxTokens?.(advisor.provider, advisor.model);
        form.appendChild(field(document, {
            id: 'advisor-max-tokens',
            label: '输出上限（maxTokens）',
            control: numberControl(document, {
                id: 'advisor-max-tokens',
                value: advisor.maxTokens,
                min: 1,
                placeholder: declaredMaxTokens !== undefined
                    ? `跟随所选模型配置（当前 ${declaredMaxTokens}）`
                    : '跟随所选模型配置',
                onChange: (value) => controller.setField('advisor.maxTokens', value),
                ariaLabel: '输出上限',
            }),
            hint: '单次咨询的输出 token 上限；留空跟随所选模型在提供方配置中声明的 maxTokens，填写则覆盖',
        }));

        // 整体超时（R-02-001/AC-06/AC-08，C-015）：单次咨询 deadline，同时
        // 约束循环门内联同步等待上限；留空用默认 600000（10 分钟）。
        form.appendChild(field(document, {
            id: 'advisor-call-timeout-ms',
            label: '咨询超时（callTimeoutMs）',
            control: numberControl(document, {
                id: 'advisor-call-timeout-ms',
                value: advisor.callTimeoutMs,
                min: 1,
                placeholder: '默认 600000（10 分钟）',
                onChange: (value) => controller.setField('advisor.callTimeoutMs', value),
                ariaLabel: '咨询超时',
            }),
            hint: '单次咨询的整体超时上限（毫秒），循环门内联等待同受此限；留空用默认 600000（10 分钟）',
        }));

        // 门 fieldset（legend 已删——门名在开关文字；T-006 目验 ①）：
        // 计划/失败/收尾三类独立守则开关（软约束）+ 循环门（唯一硬门，开关 +
        // 阈值输入）；阻断模式 failureMode 为全局统一处置档位下拉。
        // 门显示走解析后真值（T-032）：服务端缺省门全开——raw 未写键时开关
        // 也必须显示开启，否则「显示关、运行时开」显示与行为相反。
        const display = isRecord(state.displayConfig) ? state.displayConfig : config;
        const gates = isRecord(display.gates) ? display.gates : {};
        const gatesFieldset = el(document, 'fieldset', { class: 'advisorflow_fieldset' }, []);
        for (const kind of ['plan', 'failure', 'completion']) {
            gatesFieldset.appendChild(guidelineGateBlock(document, kind, gates[kind] ?? {}, controller));
        }
        gatesFieldset.appendChild(loopGateBlock(document, gates.loop ?? {}, controller));
        form.appendChild(gatesFieldset);

        // 阻断模式 failureMode（全局统一处置档位，中文双写下拉）。
        form.appendChild(field(document, {
            id: 'advisor-failure-mode',
            label: '阻断模式',
            control: selectControl(document, {
                id: 'advisor-failure-mode',
                value: config.failureMode ?? DEFAULT_FAILURE_MODE,
                options: FAILURE_MODE_OPTIONS,
                onChange: (value) => controller.setField('failureMode', value),
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
                    onChange: (value) => controller.setField('privacy.redactSecrets', value),
                }),
            }),
            hintParagraph(document, '开启后，密钥形状的值在发送给顾问前替换为占位符'),
        ]);
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
        if (state.writable === false) {
            // 宿主把表单置只读（describe 镜像 writable=false）时保存钮禁用，
            // 避免用户点保存后误读为 revision 冲突。
            body.appendChild(el(document, 'p', {
                class: 'advisorflow_notice',
                text: '当前配置为只读，修改暂不可保存。',
            }));
        }

        // footer：右对齐按钮组（放弃修改/保存）。动作经 root 级按下-抬起委
        // 托执行（见 renderSettingsCard 头部注释），按钮只承载外观与 disabled。
        body.appendChild(el(document, 'div', { class: 'advisorflow_footer' }, [
            el(document, 'button', {
                type: 'button',
                class: 'advisorflow_discard advisor-flow-discard',
                text: '放弃修改',
            }),
            el(document, 'button', {
                type: 'button',
                class: 'advisorflow_save advisor-flow-save',
                text: '保存',
                disabled: state.saving || state.validationError || state.writable === false ? 'disabled' : undefined,
            }),
        ]));

        nodes.push(body);
        mount();
    }

    controller.subscribe(refresh);
    refresh();
    return { refresh };
}
