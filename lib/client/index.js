/**
 * dsh-advisor-flow — client bundle entry (web 配置页, T-030 configForms 范式).
 *
 * The card rides the host configForms pipeline exactly like dsh-context:
 * `ctx.inject(['configForms'])` 条件子上下文 → `configForms.get(ns)` 控制器
 * （describe mirror 驱动、revision 栅栏）→ 读经快照订阅、写经
 * `form.mutate(ops)`（宿主正规写缝：settings.mutate → volatile write →
 * profile patch → volatile-update live re-apply）。自有 gateway RPC 只保留
 * 模型目录（`llm/listProviders`、`session/modelCatalog`）。
 *
 * Mount point（dsh-context 同构，0.2.0 插件管理页契约）：keyed slot
 * `plugins.bundle.config`，key = 包名 = `dsh-advisor-flow`；组件渲染于插件
 * bundle 详情页 `detailSections`（`{view:'page'}`）。注册整体活在
 * `ctx.effect` 内：apply 同步帧绝不触碰 slots（T-029 教训——帧内注册在槽
 * 声明未提交时抛/等待都会拖垮 fiber 激活，手机端整页
 * 「1 entry did not activate」）；`whileServed` 只在本命名空间被宿主
 * settings 服务在描述时挂卡，未服务即无卡（宿主官方门控语义）。
 *
 * @module dsh-advisor-flow/client
 */

import { createSettingsCardController } from './card-state.js';
import { renderSettingsCard } from './render.js';

export const name = 'dsh-advisor-flow-client';
/** Client-side services the card consumes (slots seam + connection RPC 目录缝). */
export const inject = ['slots', 'connection'];

/** settings 命名空间（= cordis.patch.yml 行 id，宿主 configForms 以它取控制器）。 */
const SETTINGS_NAMESPACE = 'advisor-flow';
/** bundle 级配置卡键 = 包名（宿主契约 plugins.bundle.config，dsh-context 同构）。 */
const BUNDLE_CONFIG_KEY = 'dsh-advisor-flow';

/**
 * Client bundle entry.
 *
 * @param {object} ctx the client plugin context（`ctx.inject`/`ctx.effect`
 *   为 runner 门面；卡片数据面来自宿主 `configForms`）
 */
export function apply(ctx) {
    const logger = typeof ctx?.logger === 'function' ? ctx.logger('advisor-flow') : console;

    // react lives only in the host loader module table (no npm dep here); the
    // esbuild build marks it external so the factory's require answers it.
    const React = typeof require === 'function' ? require('react') : undefined;
    if (typeof React?.createElement !== 'function' || typeof ctx?.slots?.register !== 'function') {
        logger.warn?.('advisor-flow client: slots/react 缝缺失——配置卡不渲染（降级，不阻塞启动）');
        return { controller: undefined, refresh: () => {} };
    }

    let cardController;
    let disposeController = () => {};
    /**
     * 契约 ownerProps：view='page'（配置页主体，整卡 DOM 由
     * renderSettingsCard 托管、卸载清空）。宿主注入的 hooks/set 不消费——
     * 卡片自持 ConfigFormController 快照与 mutate 通道。
     */
    const AdvisorFlowCard = () => {
        const containerRef = React.useRef(null);
        React.useEffect(() => {
            const container = containerRef.current;
            if (!container) {
                return undefined;
            }
            renderSettingsCard({ document: container.ownerDocument, container, controller: cardController });
            return () => { container.textContent = ''; };
        }, []);
        return React.createElement('div', { ref: containerRef });
    };

    // configForms 条件子上下文（dsh-context 同构）：缝缺失 = 卡片不挂载，
    // 主 fiber 不受累。
    ctx.inject(['configForms'], (services) => {
        const configForms = services?.configForms;
        if (configForms === undefined || typeof configForms.get !== 'function' || typeof configForms.whileServed !== 'function') {
            logger.warn?.('advisor-flow client: configForms 缝不可用——配置卡不挂载');
            return;
        }
        if (typeof ctx.effect !== 'function') {
            // effect 门面缺失会掩盖注册门控被跳过的事实——显性降级不静默。
            logger.warn?.('advisor-flow client: effect 缝缺失——配置卡不挂载');
            return;
        }
        // 挂载门控（dsh-context 同构）：控制器取用与槽注册都在 whileServed
        // 回调内（命名空间被服务即挂、失去服务即卸）；apply 时刻镜像尚未
        // 服务本命名空间的窄窗由门控兜底，不绕过 whileServed。
        ctx.effect(() => configForms.whileServed([SETTINGS_NAMESPACE], () => {
            const form = configForms.get(SETTINGS_NAMESPACE);
            if (!form) {
                logger.warn?.('advisor-flow client: configForms 未提供 advisor-flow 控制器——配置卡不挂载');
                return () => {};
            }
            disposeController(); // 服务重跑会重造控制器——旧快照订阅先解绑
            cardController = createSettingsCardController({ form, rpc: ctx?.connection?.rpc, logger });
            disposeController = () => cardController?.dispose?.();
            return ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
                name: 'plugins.bundle.config',
                key: BUNDLE_CONFIG_KEY,
            }, AdvisorFlowCard));
        }), 'advisor-flow: plugins-page card');
    });

    return { get controller() { return cardController; }, refresh: () => cardController?.load() };
}

export { createSettingsCardController, renderSettingsCard };
export default { name, inject, apply };
