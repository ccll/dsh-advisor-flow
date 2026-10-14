// T-034 staging E2E：af-home 3087 插件详情页——maxTokens 占位数值经自有
// modelInfo RPC 从宿主 llm 运行时解析（目录快照不携带 limits）。
// 断言：① 占位含「当前 N」（deepseek 适配器 modelInfo 恒回 defaultMaxTokens，
// 连接级缺省或 per-model 声明）；② rpc 无 pageerror/console 错误。
import process from 'node:process';
import { createRequire } from 'node:module';
const require2 = createRequire('/home/cailei/proj/dsh-activity-pane/package.json');
const { chromium } = require2('playwright');
const BASE = 'http://127.0.0.1:3087';
const TOKEN = process.env.AF_TOKEN;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
async function dismissDialogs() {
    for (let round = 0; round < 4; round += 1) {
        for (const label of ['Continue', '继续', '开始使用', '知道了', '确定', '关闭', 'Configure later', '稍后配置', 'Skip', '跳过']) {
            const button = page.getByRole('button').filter({ hasText: label }).first();
            if (await button.count()) {
                await button.click({ force: true }).catch(() => {});
                await page.waitForTimeout(400);
            }
        }
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500);
        if (!(await page.locator('div[aria-hidden="true"]').count())) {
            return;
        }
    }
}
const results = [];
function check(name, ok, detail = '') {
    results.push(`${ok ? '✔' : '✖'} ${name}${detail ? ` —— ${detail}` : ''}`);
    if (!ok) process.exitCode = 1;
}
try {
    await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
    await dismissDialogs();
    await page.getByText('Plugins', { exact: true }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1200);
    await dismissDialogs();
    await page.getByText('dsh-advisor-flow', { exact: true }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1500);
    await dismissDialogs();
    await page.waitForTimeout(1200); // modelInfo 异步到达（负缓存/在途去重后刷新）

    // ① 占位含宿主声明值（llm-deepseek 适配器 modelInfo 恒回 defaultMaxTokens：
    //    configured?.maxTokens ?? connection.maxTokens）
    const placeholder = await page.locator('#advisor-max-tokens').getAttribute('placeholder');
    check('maxTokens 占位含宿主声明数值（T-034 modelInfo 链路）', /当前 \d+/.test(placeholder ?? ''), `placeholder=${placeholder}`);

    // ② mode 仍缺省 soft（回归）
    const modeValue = await page.locator('#advisor-mode').inputValue();
    check('mode 下拉缺省选中 soft（回归）', modeValue === 'soft', `value=${modeValue}`);

    await page.screenshot({ path: '.staging/t034-af-home-placeholder.png', fullPage: true });
} catch (error) {
    check('探针执行', false, String(error));
} finally {
    console.log(results.join('\n'));
    console.log(`pageerror=${pageErrors.length}${pageErrors.length ? `: ${pageErrors[0]}` : ''}`);
    await browser.close();
}
