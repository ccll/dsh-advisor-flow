const { chromium } = require('/home/cailei/.npm-global/lib/node_modules/agent-browser/node_modules/playwright-core');

const BASE = 'http://127.0.0.1:3460/?token=xZbsKDhPWmo-E8AW7wZuadWqPXQu4ri4KBi90V7hlZw';
const OUT = '/tmp/af-sticky';

function rectVisible(rect, viewportH) {
    return rect.bottom > 0 && rect.top < viewportH && rect.height > 0;
}

(async () => {
    const browser = await chromium.launch({ executablePath: '/home/cailei/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const failures = [];
    const check = (name, ok, detail = '') => {
        console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
        if (!ok) failures.push(name);
    };

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // 1. 进入设置页 → Plugins 分区
    await page.getByText('Settings', { exact: true }).first().click();
    await page.waitForTimeout(1500);
    await page.getByText('Plugins', { exact: true }).first().click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/01-settings.png` });

    // 2. 找 Advisor Flow 卡片并展开
    const header = page.locator('button.advisorflow_header, button[class*=advisorflow_header]').first();
    await header.waitFor({ state: 'visible', timeout: 10000 });
    await header.click(); // 展开
    await page.waitForTimeout(800);
    check('卡片存在且可展开', true);

    // 找滚动容器（卡片的可滚动祖先）
    const scrollInfo = await page.evaluate(() => {
        const card = document.querySelector('.advisorflow_card');
        let node = card?.parentElement;
        while (node) {
            if (node.scrollHeight > node.clientHeight + 40) {
                return { found: true, scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
            }
            node = node.parentElement;
        }
        return { found: false };
    });
    check('存在可滚动容器', scrollInfo.found, JSON.stringify(scrollInfo));

    const saveBtn = page.locator('button.advisorflow_save').first();
    await saveBtn.waitFor({ state: 'visible', timeout: 5000 });

    // 3. 展开态顶部：保存按钮应可见（表单或视口内）
    const vp = page.viewportSize();
    let rect = await saveBtn.boundingBox();
    check('展开态顶部保存按钮可见', rect && rect.y + rect.height <= vp.height && rect.y >= 0, JSON.stringify(rect));

    // 4. 滚动到表单中部：sticky footer 仍应可见（核心验收）
    const scrolledTo = await page.evaluate(() => {
        const card = document.querySelector('.advisorflow_card');
        let node = card?.parentElement;
        while (node) {
            if (node.scrollHeight > node.clientHeight + 40) {
                node.scrollTop = Math.floor((node.scrollHeight - node.clientHeight) / 2); // 滚到中部
                return node.scrollTop;
            }
            node = node.parentElement;
        }
        return -1;
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/02-scrolled-middle.png` });
    rect = await saveBtn.boundingBox();
    check('表单中部滚动后保存按钮仍在视口内（sticky 生效）', scrolledTo >= 0 && rect && rect.y + rect.height <= vp.height + 1 && rect.y >= -1,
        `scrollTop=${scrolledTo} rect=${JSON.stringify(rect)}`);

    // 滚回顶部再验证一次
    await page.evaluate(() => {
        const card = document.querySelector('.advisorflow_card');
        let node = card?.parentElement;
        while (node) {
            if (node.scrollHeight > node.clientHeight + 40) { node.scrollTop = 0; return; }
            node = node.parentElement;
        }
    });
    await page.waitForTimeout(400);
    rect = await saveBtn.boundingBox();
    check('滚回顶部后保存按钮可见', rect && rect.y + rect.height <= vp.height && rect.y >= 0, JSON.stringify(rect));

    // 5. 编辑触发 dirty 徽标
    const badge = page.locator('.advisorflow_dirtyBadge');
    check('初始无未保存徽标', await badge.count() === 0);
    // 切换「密钥脱敏」开关（footer 上方的隐私档位区）
    const redactSwitch = page.locator('#advisor-privacy-redact-secrets');
    await redactSwitch.click();
    await page.waitForTimeout(500);
    check('编辑后头部出现未保存徽标', await badge.count() === 1 && await badge.first().textContent() === '未保存');
    await page.screenshot({ path: `${OUT}/03-dirty-expanded.png` });

    // 6. 折叠后徽标保留
    await header.click(); // 折叠
    await page.waitForTimeout(500);
    check('折叠态未保存徽标保留', await badge.count() === 1);
    await page.screenshot({ path: `${OUT}/04-collapsed-badge.png` });

    // 7. 重新展开 → 放弃修改 → 徽标消失
    await header.click();
    await page.waitForTimeout(500);
    const discard = page.locator('button.advisorflow_discard').first();
    await discard.click();
    await page.waitForTimeout(500);
    check('放弃修改后徽标消失', await badge.count() === 0);

    // 8. 再编辑 → 保存成功 → 徽标消失 + 回执可见
    await redactSwitch.click();
    await page.waitForTimeout(300);
    check('再编辑后徽标重现', await badge.count() === 1);
    await saveBtn.click();
    await page.waitForTimeout(1500);
    check('保存成功后徽标消失', await badge.count() === 0);
    const notice = await page.locator('.advisorflow_savedNotice').count();
    check('保存回执可见', notice >= 1);
    await page.screenshot({ path: `${OUT}/05-saved.png` });

    // 9. 未超高边界（R-02-001/AC-09）：视口足够高、表单无滚动时，footer 维持自然原位（不被钉到视口底缘）
    const page2 = await browser.newPage({ viewport: { width: 1280, height: 2400 } });
    await page2.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page2.waitForTimeout(3000);
    await page2.getByText('Settings', { exact: true }).first().click();
    await page2.waitForTimeout(1200);
    await page2.getByText('Plugins', { exact: true }).first().click();
    await page2.waitForTimeout(1200);
    await page2.locator('button[class*=advisorflow_header]').first().click(); // 展开
    await page2.waitForTimeout(800);
    const save2 = page2.locator('button.advisorflow_save').first();
    const rect2 = await save2.boundingBox();
    // 可观察断言：视口足够高（表单尾部远离视口底缘）时 footer 不被钉住，维持表单自然原位
    check('未超高时 footer 维持自然原位（未被钉到视口底缘）', rect2 && rect2.y + rect2.height < 2400 - 150, JSON.stringify(rect2));
    await page2.screenshot({ path: `${OUT}/06-no-overflow.png` });
    await page2.close();

    console.log(failures.length === 0 ? 'ALL PASS' : `FAILURES: ${failures.length}`);
    await browser.close();
    process.exit(failures.length === 0 ? 0 : 1);
})().catch((error) => { console.error('FATAL', error); process.exit(1); });
