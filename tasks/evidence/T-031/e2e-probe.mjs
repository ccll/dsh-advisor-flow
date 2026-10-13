// T-031 staging E2E：af-home 3087 插件详情页——平铺常开 + 派生禁用横幅。
// 断言：① 无需点击即见表单字段（折叠交互退役）；② 未配置路由 → advisor 未启用横幅；
// ③ 保存链（改 model → 保存 → 回执 → reload 回显）；④ sticky footer 在位。
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
const consoleWarns = [];
page.on('console', (msg) => {
    if (msg.type() === 'warning' || msg.type() === 'error') consoleWarns.push(`${msg.type()}: ${msg.text().slice(0, 200)}`);
});
// 首启弹窗（API key/welcome）可能以 mask 拦截点击：Escape + 常见主按钮
// 文案逐个关闭直至可交互（每次整页加载都会重现，goto 与 reload 后都调用）。
async function dismissDialogs() {
    for (const label of ['Continue', '继续', '开始使用', '知道了', '确定', '关闭', 'Configure later', '稍后配置']) {
        const button = page.getByRole('button').filter({ hasText: label }).first();
        if (await button.count()) {
            await button.click({ force: true }).catch(() => {});
            await page.waitForTimeout(400);
        }
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
}
await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'load' });
await page.waitForTimeout(3500);
await page.screenshot({ path: '.staging/t031-af-home-initial.png' });
await dismissDialogs();
await page.getByText('Plugins', { exact: true }).click();
await page.waitForTimeout(1500);
await page.getByRole('button').filter({ hasText: 'dsh-advisor-flow' }).first().click();
await page.waitForTimeout(2500);

// ① 平铺常开：字段直接可见（无 aria-expanded 头、fieldset 在位）
const fieldsetCount = await page.locator('fieldset.advisorflow_fieldset').count();
const headerText = await page.locator('.advisorflow_header').first().innerText().catch(() => '(no header)');
const ariaExpandedCount = await page.locator('[aria-expanded]').count();
console.log(`① fieldset=${fieldsetCount} aria-expanded 节点=${ariaExpandedCount}`);
console.log(`  header=${headerText.replace(/\n/g, ' | ').slice(0, 120)}`);

// ② 派生禁用横幅（af-home 未配置 advisor 路由）
const banner = await page.locator('.advisorflow_banner').first().innerText().catch(() => '(no banner)');
console.log(`② banner=${banner}`);

// ③ 保存链：选顾问提供方/模型（目录可达时为下拉，回退时为文本框）→ 保存 → 回执
const providerCtl = page.locator('#advisor-provider');
if (await providerCtl.count()) {
    const tag = await providerCtl.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'select') {
        const optionCount = await providerCtl.locator('option').count();
        if (optionCount > 1) await providerCtl.selectOption({ index: 1 });
        console.log(`③ provider=select(${optionCount} 项)`);
    } else {
        await providerCtl.fill('p-staging');
        console.log('③ provider=input（目录回退）');
    }
    await page.waitForTimeout(600); // 联动刷新 model 下拉
}
const modelInput = page.locator('#advisor-model');
const modelTag = await modelInput.evaluate((el) => el.tagName.toLowerCase());
if (modelTag === 'select') {
    const optionCount = await modelInput.locator('option').count();
    if (optionCount > 1) await modelInput.selectOption({ index: 1 });
    console.log(`③ model=select(${optionCount} 项)`);
} else {
    await modelInput.fill('glm-5.3-t031');
    console.log('③ model=input（目录回退）');
}
const save = page.locator('button.advisor-flow-save');
await save.click();
await page.waitForTimeout(1200);
const noticeText = await page.locator('.advisor-flow-notice').first().innerText().catch(() => '(no notice)');
console.log(`  保存回执=${noticeText}`);
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(3000);
// reload 后回到根视图且首启弹窗重现：先关弹窗再进插件详情断言回显
await dismissDialogs();
await page.getByText('Plugins', { exact: true }).click();
await page.waitForTimeout(1500);
await page.getByRole('button').filter({ hasText: 'dsh-advisor-flow' }).first().click();
await page.waitForTimeout(2500);
const banner2 = await page.locator('.advisorflow_banner').count();
const modelValue = await page.locator('#advisor-model').inputValue().catch(() => '(gone)');
console.log(`  reload 后 model=${modelValue} banner 数=${banner2}（路由齐备横幅应消失）`);
await page.screenshot({ path: '.staging/t031-af-home-expanded.png', fullPage: false });

// ④ sticky footer
const sticky = await page.evaluate(() => {
    const footer = document.querySelector('.advisorflow_footer');
    return footer ? getComputedStyle(footer).position : '(no footer)';
});
console.log(`④ footer position=${sticky}`);
console.log(`pageerror=${pageErrors.length} ${pageErrors.slice(0, 3).join(' | ')}`);
console.log(`console 警告/错误=${consoleWarns.length}`);
for (const line of consoleWarns.slice(0, 5)) console.log(`  ${line}`);
await browser.close();
