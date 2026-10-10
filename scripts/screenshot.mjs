#!/usr/bin/env node
// 演示截图工具（T-025）：在隔离环境（内联 mock LLM + 临时 $DSH_HOME +
// `dsh web --port 0`）中驱动真实插件链路，产出 README / screenshots.json
// 使用的截图资产。全部画面内容均为本脚本编排的合成演示数据，不含任何真实
// 项目信息。
//
// 用法：
//   node scripts/screenshot.mjs smoke   # 冒烟：驱动 /advisor-manual 并断言链路（无截图）
//   node scripts/screenshot.mjs shots   # 全量截图到 assets/（含冒烟断言）
//   node scripts/screenshot.mjs keep    # 启动环境后保持（调试用，Ctrl+C 清理）
//
// 引导配方对齐 dsh-activity-pane e2e/boot.mjs（隔离 $DSH_HOME、link 装入、
// 完整鉴权链就绪轮询）；playwright 为 devDependency（浏览器复用
// ~/.cache/ms-playwright 既有安装）。

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const ASSETS_DIR = join(repoRoot, 'assets');
const BOOT_TIMEOUT_MS = 90_000;
const VIEWPORT = { width: 1440, height: 900 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等待 fn 返回真值；超时抛出带 label 的错误。 */
async function until(label, fn, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
        try {
            last = await fn();
            if (last) return last;
        } catch (error) {
            last = error;
        }
        if (Date.now() > deadline) {
            throw new Error(`等待超时（${label}）：${String(last instanceof Error ? last.message : last ?? '')}`);
        }
        await sleep(300);
    }
}

/* ------------------------------------------------------------------ *
 * mock LLM：OpenAI 兼容 /chat/completions SSE。
 * 剧本判定：
 *   - 消息文本含 `Targeted focus:` → 顾问咨询请求（素材契约的聚焦行），
 *     流式返回固定评审意见（首行 Verdict: sound 协议约定）；
 *   - 存在 tool 消息 → 执行者在工具结果后续轮：短文本 stop 收口；
 *   - 末条用户消息含 `重试` → 执行者首轮：发起 ask_advisor 工具调用；
 *   - 其余 → fast 收口。
 * ------------------------------------------------------------------ */

const ADVICE_TOOL = `Verdict: sound

## 方案评审：导出重试策略

**总体判断**：方向正确。指数退避 + 幂等键是标准组合，可以继续。

**建议**
1. 重试上限改为配置项（默认 3），不要与调用方硬编码耦合。
2. 幂等键应包含目标路径与内容哈希，避免并发导出互踩。
3. 退避基数 500ms 起步、上限 8s，防止长尾放大。

**风险**：单次请求超时与整体超时需分开度量，否则退避会被整体超时截断。`;

const ADVICE_MANUAL = `Verdict: sound

## 评审：回滚策略充分性

**总体判断**：回滚策略基本充分，但缺少两处边界。

**建议**
1. 回滚前先快照当前导出目录，避免回滚本身不可逆。
2. 部分成功的批次应记录断点，回滚后可从断点续传而非全量重来。

**风险**：回滚与重试共享幂等键时，需明确回滚后键是否失效。`;

function messageText(msg) {
    if (typeof msg?.content === 'string') return msg.content;
    if (Array.isArray(msg?.content)) {
        return msg.content
            .filter((part) => part?.type === 'text' || part?.kind === 'text')
            .map((part) => part.text ?? '')
            .join('\n');
    }
    return '';
}

function chunk(model, delta, finishReason = null) {
    return {
        id: 'shot-mock',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
}

function usageChunk(model, outputTokens) {
    return {
        id: 'shot-mock',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [],
        usage: { prompt_tokens: 256, completion_tokens: outputTokens },
    };
}

function send(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** 流式吐出文本：按 ~48 字符切块，块间 60ms，结束发 usage + stop + [DONE]。 */
async function playStream(res, model, text, { delayMs = 60 } = {}) {
    const pieces = text.match(/[\s\S]{1,48}/g) ?? [];
    for (let i = 0; i < pieces.length; i += 1) {
        if (res.destroyed || res.writableEnded) return;
        send(res, chunk(model, { role: i === 0 ? 'assistant' : undefined, content: pieces[i] }));
        await sleep(delayMs);
    }
    if (res.destroyed || res.writableEnded) return;
    send(res, chunk(model, {}, 'stop'));
    send(res, usageChunk(model, Math.ceil(text.length / 3)));
    res.write('data: [DONE]\n\n');
    res.end();
}

/** 执行者首轮剧本：先说一句，再发起 ask_advisor 工具调用（带问题与草稿）。 */
async function playConsult(res, model) {
    send(res, chunk(model, { role: 'assistant', content: '这个改动影响导出可靠性，先请顾问评审草稿。\n' }));
    const args = JSON.stringify({
        question: '评审以下重试策略草稿的边界条件与失败模式',
        draft: '失败后自动重试，最多 3 次，间隔 1s/2s/4s 指数退避；以导出任务 ID 作为幂等键。',
    });
    const deltas = [
        { index: 0, id: 'call_shot_advisor', type: 'function', function: { name: 'ask_advisor', arguments: args.slice(0, 60) } },
        { index: 0, function: { arguments: args.slice(60) } },
    ];
    for (const delta of deltas) {
        send(res, chunk(model, { tool_calls: [delta] }));
        await sleep(30);
    }
    send(res, chunk(model, {}, 'tool_calls'));
    send(res, usageChunk(model, 32));
    res.write('data: [DONE]\n\n');
    res.end();
}

function pickScenario(body) {
    const messages = body.messages ?? [];
    const all = messages.map(messageText).join('\n');
    // 顾问请求统一携带素材契约的聚焦行（六区装配产物）；宿主可能在用户正文
    // 之后追加上下文注入消息，因此按全消息扫描关键词而非只看末条。
    if (all.includes('Targeted focus:')) {
        return all.includes('回滚') ? 'advisor-manual' : 'advisor-tool';
    }
    if (messages.some((m) => m?.role === 'tool')) return 'fast';
    const userTexts = messages.filter((m) => m?.role === 'user').map(messageText);
    for (let i = userTexts.length - 1; i >= 0; i -= 1) {
        if (userTexts[i].includes('重试')) return 'consult';
    }
    return 'fast';
}

const FINAL_REPLY = '已采纳顾问意见：重试上限改为配置项（默认 3），幂等键加入目标路径与内容哈希，退避上限 8s。方案已按评审结论更新。';

function startMockLlm() {
    const scenarioLog = [];
    const server = http.createServer((req, res) => {
        if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
            res.writeHead(404).end('not found');
            return;
        }
        let raw = '';
        req.on('data', (data) => (raw += data));
        req.on('end', async () => {
            let body;
            try {
                body = JSON.parse(raw);
            } catch {
                res.writeHead(400).end('bad json');
                return;
            }
            const scenario = pickScenario(body);
            scenarioLog.push({ scenario, at: Date.now() });
            const model = body.model ?? 'shot-mock';
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
            });
            try {
                if (scenario === 'advisor-tool' || scenario === 'advisor-manual') {
                    await playStream(res, model, scenario === 'advisor-manual' ? ADVICE_MANUAL : ADVICE_TOOL);
                } else if (scenario === 'consult') await playConsult(res, model);
                else await playStream(res, model, FINAL_REPLY, { delayMs: 20 });
            } catch {
                res.end();
            }
        });
    });
    return new Promise((resolvePromise) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolvePromise({
                port,
                url: `http://127.0.0.1:${port}/v1`,
                scenarioLog,
                advisorHits: () => scenarioLog.filter((e) => e.scenario === 'advisor-tool' || e.scenario === 'advisor-manual').length,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

/* ------------------------------------------------------------------ *
 * 隔离环境引导
 * ------------------------------------------------------------------ */

async function seedWorkspace(home) {
    const id = 'shot-workspace';
    const path = join(home, 'workspace');
    await mkdir(path, { recursive: true });
    const now = new Date().toISOString();
    const storage = {
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: [id], archivedSessionIds: [] },
        tables: { workspaces: { [id]: { path, title: 'demo-project', sessionIds: [], createdAt: now, updatedAt: now } } },
    };
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify(storage));
}

function settingsYaml(mockUrl) {
    return [
        'llm-deepseek:',
        `  baseURL: ${mockUrl}`,
        '  apiKeyEnv: SHOT_MOCK_KEY',
        'agent-default-model:',
        '  provider: deepseek-official',
        '  model: deepseek-v4-flash',
        // 预置欢迎内测声明确认（dsh 0.1.5 宿主 OnboardingModal）：不预置会弹遮罩拦操作。
        'ui-onboarding:',
        '  welcomeNoticeVersion: "2026-08-13.1"',
        'advisor-flow:',
        '  advisor:',
        '    provider: deepseek-official',
        '    model: deepseek-v4-flash',
        '  enabled: true',
        '  failureMode: block-tool',
        '  gates:',
        '    plan:',
        '      enabled: true',
        '    failure:',
        '      enabled: true',
        '    loop:',
        '      enabled: true',
        '    completion:',
        '      enabled: true',
        '  privacy:',
        '    redactSecrets: true',
        '    repoContext: summary',
        '  mode: soft',
        '  presentation: subagent',
        '',
    ].join('\n');
}

export async function bootShotEnv() {
    const mock = await startMockLlm();
    const home = await mkdtemp(join(tmpdir(), 'dsh-shot-'));
    await writeFile(join(home, 'settings.yaml'), settingsYaml(mock.url));
    await seedWorkspace(home);

    const env = { ...process.env, DSH_HOME: home, SHOT_MOCK_KEY: 'shot-mock-key' };
    let web;
    let url;
    let webStderr = [];
    let webStdout = [];
    const killWebGroup = (signal) => {
        if (!web || web.exitCode !== null) return;
        try {
            process.kill(-web.pid, signal);
        } catch {
            web.kill(signal);
        }
    };
    const cleanup = async () => {
        if (web && web.exitCode === null) {
            killWebGroup('SIGTERM');
            await new Promise((resolvePromise) => {
                const timer = setTimeout(() => {
                    killWebGroup('SIGKILL');
                    resolvePromise();
                }, 5_000);
                web.once('exit', () => {
                    clearTimeout(timer);
                    resolvePromise();
                });
            });
        }
        await mock.close();
        await rm(home, { recursive: true, force: true });
    };

    try {
        await execFileAsync('dsh', ['plugin', '--profile', 'web', 'add', repoRoot], { env });
        web = spawn('dsh', ['web', '--port', '0', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        web.stderr.on('data', (data) => {
            webStderr.push(String(data));
            if (webStderr.length > 200) webStderr.shift();
        });
        web.stdout.on('data', (data) => {
            webStdout.push(String(data));
            if (webStdout.length > 400) webStdout.shift();
        });
        url = await new Promise((resolvePromise, reject) => {
            let buffer = '';
            const timer = setTimeout(() => reject(new Error(`dsh web 启动超时，输出：${buffer.slice(-500)}`)), BOOT_TIMEOUT_MS);
            web.stdout.on('data', (data) => {
                buffer += data;
                const match = buffer.match(/dsh web: (http:\/\/\S+)/);
                if (match) {
                    clearTimeout(timer);
                    resolvePromise(match[1]);
                }
            });
            web.once('exit', (code) => {
                clearTimeout(timer);
                reject(new Error(`dsh web 提前退出（code=${code}），输出：${buffer.slice(-500)}`));
            });
        });

        // 就绪轮询：token→303→Set-Cookie→带 cookie 的 / 返回 200（完整鉴权链）。
        const fetchProbe = (target, init = {}) => fetch(target, { ...init, signal: AbortSignal.timeout(5_000) });
        const deadline = Date.now() + BOOT_TIMEOUT_MS;
        for (;;) {
            try {
                const bootstrap = await fetchProbe(url, { redirect: 'manual' });
                if (bootstrap.ok) break;
                if (bootstrap.status === 303) {
                    const setCookies = typeof bootstrap.headers.getSetCookie === 'function' ? bootstrap.headers.getSetCookie() : [bootstrap.headers.get('set-cookie')].filter(Boolean);
                    const pair = setCookies[0]?.split(';')[0] ?? '';
                    if (pair.includes('=')) {
                        const index = await fetchProbe(new URL('/', url), { headers: { cookie: pair } });
                        if (index.ok) break;
                    }
                }
            } catch {
                // 尚未就绪，继续轮询
            }
            if (Date.now() > deadline) throw new Error(`dsh web 就绪轮询超时：${url}`);
            await sleep(250);
        }
    } catch (error) {
        await cleanup();
        throw error;
    }

    return {
        home,
        url,
        mock,
        cleanup,
        getWebStderr: () => webStderr.join('\n'),
        getWebStdout: () => webStdout.join('\n'),
        advisorLogs: () => [...webStdout, ...webStderr].join('').split('\n').filter((line) => line.includes('advisor')).join('\n'),
    };
}

/* ------------------------------------------------------------------ *
 * 浏览器驱动
 * ------------------------------------------------------------------ */

const HERO_PLACEHOLDER = 'Describe what you want to build';
const COMPOSER_PLACEHOLDER = 'Message or run a task';

async function dismissNotice(page) {    await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent.trim() === 'Continue');
        if (button && !button.disabled) button.click();
    });
}

async function openApp(page, url) {
    await page.goto(url, { waitUntil: 'networkidle' });
    await dismissNotice(page);
    await until('应用就绪（composer 可见）', async () => {
        await dismissNotice(page);
        const count = await page.locator(`[data-placeholder^="${HERO_PLACEHOLDER}"]`).count()
            + await page.locator(`[data-placeholder^="${COMPOSER_PLACEHOLDER}"]`).count();
        return count > 0 ? true : null;
    }, 30_000);
}

async function sendHeroMessage(page, text) {
    const hero = page.locator(`[data-placeholder^="${HERO_PLACEHOLDER}"]`);
    await until(`发送首条消息「${text.slice(0, 18)}…」`, async () => {
        await dismissNotice(page);
        await hero.fill(text).catch(() => {});
        await page.waitForTimeout(300);
        if ((await hero.textContent().catch(() => '')) !== text) return null;
        await page.keyboard.press('Enter');
        await page.waitForTimeout(800);
        return (await hero.count()) === 0 ? true : null;
    }, 30_000);
}

async function sendSessionMessage(page, text) {
    const composer = page.locator(`[data-placeholder^="${COMPOSER_PLACEHOLDER}"]`);
    await until(`发送会话消息「${text.slice(0, 18)}…」`, async () => {
        await composer.fill(text).catch(() => {});
        await page.waitForTimeout(300);
        const current = (await composer.textContent().catch(() => '')) ?? '';
        if (!current.includes(text)) return null;
        await page.keyboard.press('Enter');
        await page.waitForTimeout(600);
        return true;
    }, 20_000);
}

/** 页面正文是否包含指定文字（含 shadow DOM 探测的兜底主文档扫描）。 */
async function bodyHasText(page, text) {
    return page.evaluate((needle) => document.body?.innerText?.includes(needle) ?? false, text);
}

/** 主题抓取：返回 documentElement 的 class 与 data 主题属性，供深浅判定。 */
async function themeInfo(page) {
    return page.evaluate(() => ({
        cls: document.documentElement.className,
        dataTheme: document.documentElement.getAttribute('data-theme'),
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
    }));
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function usage(message) {
    console.error(`[shot] ${message}`);
}

async function main() {
    const mode = process.argv[2] ?? 'shots';
    if (!['smoke', 'shots', 'keep', 'settings'].includes(mode)) {
        console.error('用法: node scripts/screenshot.mjs smoke|shots|keep|settings');
        process.exit(2);
    }
    const env = await bootShotEnv();
    console.error(`[step] 环境就绪 ${env.url}`);
    const keepAlive = mode === 'keep';
    let browser;
    try {
        const { chromium } = await import('playwright');
        // channel 'chromium'：用完整 chromium 的新无头模式（默认 headless shell
        // 需要单独下载另一份浏览器，本机缓存里它迟迟未就绪）。
        browser = await chromium.launch({ channel: 'chromium' });
        console.error('[step] 浏览器已启动');
        const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'light' });
        const page = await context.newPage();
        await openApp(page, env.url);
        console.error('[step] 应用已打开');

        // 设置卡截图助手（settings 独立模式与 shots 全量模式共用）。
        // Settings 入口与设置卡用中英文双标签匹配（宿主语言随 locale）；
        // 两个主题使用同一加高视口，保证成图构图一致。
        const SETTINGS_TALL = { width: VIEWPORT.width, height: 1500 };
        const openSettingsCard = async (targetPage) => {
            const entered = await targetPage.evaluate(() => {
                const link = [...document.querySelectorAll('a,button')].find((candidate) => ['settings', '设置'].includes(candidate.textContent.trim().toLowerCase()));
                if (link) {
                    link.click();
                    return true;
                }
                return false;
            });
            if (!entered) throw new Error('未找到 Settings 入口');
            // 设置是模态框；Advisor Flow 卡挂在 Plugins 分区下，先切到该分区。
            await until('Plugins 分区可见', async () => {
                const clicked = await targetPage.evaluate(() => {
                    const nav = [...document.querySelectorAll('a,button')].find((candidate) => ['plugins', '插件'].includes(candidate.textContent.trim().toLowerCase()));
                    if (nav) {
                        nav.click();
                        return true;
                    }
                    return false;
                });
                return clicked ? true : null;
            }, 10_000);
            await until('Advisor Flow 卡可见', () => (bodyHasText(targetPage, 'Advisor Flow') ? true : null), 20_000);
            await targetPage.evaluate(() => {
                const header = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent.includes('Advisor Flow') && candidate.textContent.includes('每次关键动作前'));
                header?.click();
            });
            await until('设置卡表单展开', async () => (bodyHasText(targetPage, '启用 Advisor Flow') ? true : null), 10_000);
            await targetPage.waitForTimeout(500);
        };
        const shotSettingsCard = async (colorScheme, filename, { scrollBottom = false } = {}) => {
            const shot = await browser.newContext({ viewport: SETTINGS_TALL, deviceScaleFactor: 2, colorScheme });
            const shotPage = await shot.newPage();
            try {
                await shotPage.goto(env.url, { waitUntil: 'networkidle' });
                await dismissNotice(shotPage);
                await shotPage.waitForTimeout(1200);
                await openSettingsCard(shotPage);
                if (scrollBottom) {
                    // 模态框自身限高：锚定第一类门块滚入视口，使守则门与隐私档位同框；
                    // 锚点缺失时退回滚动到底。
                    await shotPage.evaluate(() => {
                        const anchor = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.textContent.trim() === '启用计划守则' && el.getBoundingClientRect().height > 0);
                        if (anchor) {
                            anchor.scrollIntoView({ block: 'start' });
                            return;
                        }
                        const scrollers = [...document.querySelectorAll('*')].filter((el) => el.scrollHeight > el.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(el).overflowY));
                        for (const scroller of scrollers) scroller.scrollTop = scroller.scrollHeight;
                    });
                    await shotPage.waitForTimeout(500);
                }
                await shotPage.screenshot({ path: join(ASSETS_DIR, filename) });
            } finally {
                await shot.close();
            }
        };
        if (mode === 'settings') {
            const fsSettings = await import('node:fs/promises');
            await fsSettings.mkdir(ASSETS_DIR, { recursive: true });
            await shotSettingsCard('light', 'screenshot-settings-light.png');
            await shotSettingsCard('dark', 'screenshot-settings-dark.png');
            await shotSettingsCard('light', 'screenshot-settings-privacy-light.png', { scrollBottom: true });
            await shotSettingsCard('dark', 'screenshot-settings-privacy-dark.png', { scrollBottom: true });
            console.log('settings shots done → assets/');
            await context.close();
            await browser.close();
            await env.cleanup();
            return;
        }

        // —— 会话演示：按需咨询（执行者发起 ask_advisor，顾问子会话呈现）——
        const taskText = '给导出功能加失败重试：同一导出任务失败后自动重试，最多 3 次，间隔递增。先给我一个方案草稿。';
        await sendHeroMessage(page, taskText);
        console.error('[step] 首条消息已发送');

        // 冒烟断言 ①：顾问请求命中 mock（Targeted focus 素材契约）。
        await until('顾问请求命中 mock', () => (env.mock.advisorHits() >= 1 ? true : null), 30_000);
        // 冒烟断言 ②：意见内容可见（子会话流式或工具结果送达会话界面）。
        await until('意见文本呈现', () => (bodyHasText(page, '幂等键应包含目标路径与内容哈希') ? true : null), 30_000);
        // 等执行者收尾轮完成。
        await until('执行者收尾', () => (bodyHasText(page, '方案已按评审结论更新') ? true : null), 30_000);

        // 手动咨询：/advisor-manual。
        await sendSessionMessage(page, '/advisor-manual 评审当前方案的回滚策略是否充分');
        await until('手动咨询意见送达', () => (bodyHasText(page, '回滚前先快照当前导出目录') ? true : null), 30_000);
        console.error('[step] 手动咨询意见已送达');
        // 等子会话结算与 steer 意见消息渲染进会话时间线（mock 流式 ~1s + 结算）。
        await page.waitForTimeout(8000);

        if (mode === 'smoke') {
            console.log(JSON.stringify({ ok: true, advisorHits: env.mock.advisorHits(), url: env.url }, null, 2));
            await context.close();
            await browser.close();
            await env.cleanup();
            return;
        }
        if (mode === 'keep') {
            console.log(JSON.stringify({ url: env.url, home: env.home, mockUrl: env.mock.url }, null, 2));
            const shutdown = async () => {
                await context.close().catch(() => {});
                await browser.close().catch(() => {});
                await env.cleanup();
                process.exit(0);
            };
            process.on('SIGINT', shutdown);
            process.on('SIGTERM', shutdown);
            return;
        }

        // —— 截图 ——（shots 模式从这里开始）
        const fs = await import('node:fs/promises');
        await fs.mkdir(ASSETS_DIR, { recursive: true });

        // 会话截图构图准备：展开外层披露行与工具调用行（ask_advisor 调用与
        // 意见回执可见），清除点击焦点环，并把会话滚动到底部。
        const prepareConversationShot = async (targetPage) => {
            await targetPage.evaluate(() => {
                const clickables = [];
                const leafMatch = (pattern) => [...document.querySelectorAll('button,[role="button"],div,span')]
                    .filter((el) => el.children.length === 0 && pattern.test(el.textContent) && el.getBoundingClientRect().height > 0);
                // 外层披露行（"N tool call · N message"）与工具调用行（含意见回执）。
                for (const row of [...leafMatch(/\btool call/), ...leafMatch(/Tool call/)]) {
                    (row.closest('button') ?? row).click();
                }
                document.activeElement?.blur?.();
            });
            await targetPage.waitForTimeout(700);
            await targetPage.evaluate(() => {
                const scrollers = [...document.querySelectorAll('*')].filter((el) => el.scrollHeight > el.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(el).overflowY));
                for (const scroller of scrollers) scroller.scrollTop = scroller.scrollHeight;
            });
            await targetPage.waitForTimeout(500);
        };

        // 新开浏览器上下文不继承会话视图：进入应用后点击侧栏会话条目回到会话页。
        // 侧栏条目不一定是 a/button/[role=button]，按全元素最小子树匹配后点击。
        const openSessionIn = async (targetPage, titlePrefix) => {
            await until('侧栏会话条目可见', async () => {
                const clicked = await targetPage.evaluate((prefix) => {
                    const candidates = [...document.querySelectorAll('body *')]
                        .filter((el) => el.textContent.trim().startsWith(prefix)
                            && el.getBoundingClientRect().height > 0
                            && el.getBoundingClientRect().width > 0);
                    candidates.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
                    const item = candidates[0];
                    if (item) {
                        item.click();
                        return true;
                    }
                    return false;
                }, titlePrefix);
                return clicked ? true : null;
            }, 15_000);
            await until('会话页就绪', () => (bodyHasText(targetPage, 'Message or run a task') ? true : null), 20_000);
            await targetPage.waitForTimeout(800);
        };

        // ①/② 会话演示（浅色 / 深色）：按需咨询 + 手动咨询 + 展开的意见回执。
        await prepareConversationShot(page);
        await page.screenshot({ path: join(ASSETS_DIR, 'screenshot-consultation-light.png') });
        let dark = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'dark' });
        let darkPage = await dark.newPage();
        await darkPage.goto(page.url(), { waitUntil: 'networkidle' });
        await dismissNotice(darkPage);
        await darkPage.waitForTimeout(1500);
        await openSessionIn(darkPage, '给导出功能加失败重试');
        await prepareConversationShot(darkPage);
        await darkPage.screenshot({ path: join(ASSETS_DIR, 'screenshot-consultation-dark.png') });
        await dark.close();

        // ③ /advisor status（浅色）：展示模型路由、门决策统计与逐次用量。
        await sendSessionMessage(page, '/advisor status');
        await until('status 输出可见', async () => (bodyHasText(page, 'Advisor') && (await bodyHasText(page, '门决策'))) ? true : null, 20_000).catch(() => {});
        // status 回执默认折叠为单行：点开行本体展示完整读数。
        await page.evaluate(() => {
            const rows = [...document.querySelectorAll('button,[role="button"],div,span')]
                .filter((el) => el.children.length === 0 && /Advisor: enabled/.test(el.textContent) && el.getBoundingClientRect().height > 0);
            for (const row of rows) (row.closest('button') ?? row).click();
            document.activeElement?.blur?.();
        });
        await page.waitForTimeout(700);
        await prepareConversationShot(page);
        await page.screenshot({ path: join(ASSETS_DIR, 'screenshot-status-light.png') });

        // ④/⑤ 设置卡（浅色 / 深色）：进入 Settings → Plugins，展开 Advisor Flow 卡；
        // 另拍一组滚动到底的守则/隐私档位区。
        await shotSettingsCard('light', 'screenshot-settings-light.png');
        await shotSettingsCard('dark', 'screenshot-settings-dark.png');
        await shotSettingsCard('light', 'screenshot-settings-privacy-light.png', { scrollBottom: true });
        await shotSettingsCard('dark', 'screenshot-settings-privacy-dark.png', { scrollBottom: true });

        console.log('shots done → assets/');
        console.error(`[advisor 日志]\n${env.advisorLogs().slice(-3000) || '（无 advisor 相关日志）'}`);
        await context.close();
        await browser.close();
    } catch (error) {
        console.error(`[screenshot 失败] ${error?.stack ?? error}`);
        console.error(`[mock scenarioLog] ${JSON.stringify(env.mock.scenarioLog.slice(-30))}`);
        console.error(`[advisor 日志]\n${env.advisorLogs().slice(-3000) || '（无 advisor 相关日志）'}`);
        console.error(`[web stderr 尾部]\n${env.getWebStderr().slice(-2000)}`);
        try {
            if (browser) {
                const pages = browser.contexts().flatMap((context) => context.pages());
                for (const [index, failedPage] of pages.entries()) {
                    await failedPage.screenshot({ path: `/tmp/shot-fail-${Date.now()}-${index}.png` }).catch(() => {});
                    const text = await failedPage.evaluate(() => document.body?.innerText ?? '').catch(() => '');
                    console.error(`[page ${index} innerText]\n${text.slice(0, 3000)}`);
                }
            }
        } catch {}
        if (!keepAlive && browser) {
            await browser.close().catch(() => {});
        }
        process.exitCode = 1;
    } finally {
        if (keepAlive) {
            // keep：保留现场供排查；信号触发时清理退出。
            console.error(`[keep] url=${env.url} home=${env.home} mock=${env.mock.url}`);
            process.on('SIGINT', async () => {
                await env.cleanup();
                process.exit(0);
            });
            process.on('SIGTERM', async () => {
                await env.cleanup();
                process.exit(0);
            });
            await new Promise(() => {}); // 挂起保活
        }
        await env.cleanup();
    }
}

await main();
