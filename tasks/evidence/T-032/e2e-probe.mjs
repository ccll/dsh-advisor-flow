// T-032 staging E2E：af-home 3087 插件详情页——缺省显示面（raw 未写键）。
// 断言：① mode 下拉缺省选中 soft（C-032）；② 四门开关缺省 aria-checked=true（门禁默认全开）；
// ③ maxTokens 占位回退原文（af-home mock 目录无 maxTokens 声明）；④ 无 pageerror。
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
    // 首启弹窗在视图切换后也会重现（T-031 教训的延伸）：多轮关闭直至 mask 消失。
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

    // ① mode 缺省选中 soft
    const modeValue = await page.locator('#advisor-mode').inputValue();
    check('mode 下拉缺省选中 soft（C-032）', modeValue === 'soft', `value=${modeValue}`);

    // ② 四门开关缺省开启
    for (const kind of ['plan', 'failure', 'loop', 'completion']) {
        const checked = await page.locator(`#advisor-gate-${kind}-enabled`).getAttribute('aria-checked');
        check(`${kind} 门开关缺省开启`, checked === 'true', `aria-checked=${checked}`);
    }

    // ③ maxTokens 占位回退原文（mock 目录模型未声明 maxTokens）
    const placeholder = await page.locator('#advisor-max-tokens').getAttribute('placeholder');
    check('maxTokens 占位回退原文', placeholder === '跟随所选模型配置', `placeholder=${placeholder}`);

    await page.screenshot({ path: '.staging/t032-af-home-defaults.png', fullPage: true });
    check('pageerror=0', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));
} finally {
    await browser.close();
}
console.log(results.join('\n'));
