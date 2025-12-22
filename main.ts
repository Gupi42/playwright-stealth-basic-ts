import express, { Request, Response } from 'express';
// @ts-ignore
import puppeteer from 'puppeteer-extra';
// @ts-ignore
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

// --- КОНФИГУРАЦИЯ ПУТЕЙ ---
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const DEBUG_DIR = path.join(DATA_DIR, 'debug');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

// 1. Активируем скрытность
puppeteer.use(StealthPlugin());
const app = express();
app.use(express.json());

// Раздача скриншотов (статические файлы)
app.use('/screenshots', express.static(DEBUG_DIR));

// === 🛡️ ЗАЩИТА (MIDDLEWARE) ===
app.use((req, res, next) => {
    if (req.path === '/health' || req.path.startsWith('/screenshots')) return next();
    const clientKey = req.headers['x-api-key'];
    const serverKey = process.env.API_SECRET;
    if (!serverKey || clientKey !== serverKey) return res.status(403).json({ error: 'Access denied' });
    next();
});

// --- ХЕЛПЕРЫ ---
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const GLOBAL_PROXY_URL = process.env.PROXY_URL;

function getSessionPath(login: string): string {
    const sanitized = login.replace(/[^a-zA-Z0-9]/g, '_');
    return path.join(SESSIONS_DIR, `state_${sanitized}.json`);
}

interface ActiveFlow {
    browser: any; page: any; timestamp: number; timer: NodeJS.Timeout;
}
const activeFlows: Map<string, ActiveFlow> = new Map();

async function cleanupFlow(login: string) {
    const flow = activeFlows.get(login);
    if (flow) {
        clearTimeout(flow.timer);
        try { await flow.browser.close(); } catch (e) {}
        activeFlows.delete(login);
    }
}

function parseProxy(proxyUrl: string) {
    try {
        const url = new URL(proxyUrl);
        return { server: `${url.protocol}//${url.hostname}:${url.port}`, username: url.username, password: url.password };
    } catch (e) { return null; }
}

async function getBrowserInstance(proxyServer?: string) {
    return await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1366,768'],
        ignoreHTTPSErrors: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
    });
}

// --- ОСНОВНАЯ ЛОГИКА ВХОДА И ОЧИСТКИ ---
async function startLoginFlow(login: string, password: string, proxyUrl?: string) {
    await cleanupFlow(login);
    const proxyToUse = proxyUrl || GLOBAL_PROXY_URL;
    const proxyConfig = proxyToUse ? parseProxy(proxyToUse) : null;

    const browser = await getBrowserInstance(proxyConfig?.server);
    const page = await browser.newPage();

    if (proxyConfig?.username) {
        await page.authenticate({ username: proxyConfig.username, password: proxyConfig.password });
    }
    
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

    // === ЖЕСТКАЯ ОЧИСТКА ДЛЯ СМЕНЫ АККАУНТОВ ===
    const client = await page.target().createCDPSession();
    await client.send('Network.clearBrowserCookies');
    await client.send('Network.clearBrowserCache');

    await page.setRequestInterception(true);
    page.on('request', (req: any) => {
        if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType())) req.abort();
        else req.continue();
    });

    const sessionPath = getSessionPath(login);
    if (fs.existsSync(sessionPath)) {
        try {
            const state = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
            if (state.cookies) await page.setCookie(...state.cookies);
            if (state.localStorage) {
                await page.evaluateOnNewDocument((data: any) => {
                    localStorage.clear();
                    data.forEach((item: any) => localStorage.setItem(item.name, item.value));
                }, state.localStorage);
            }
            await page.goto('https://my.drom.ru/personal/', { waitUntil: 'networkidle2', timeout: 40000 });
            if (!page.url().includes('sign')) return { success: true, browser, page };
        } catch (e) {}
    }

    console.log(`🔐 [${login}] Вход по паролю...`);
    await page.goto('https://my.drom.ru/sign', { waitUntil: 'networkidle2', timeout: 40000 });

    try {
        await page.waitForSelector('input[name="sign"]', { visible: true, timeout: 15000 });
        await page.type('input[name="sign"]', login, { delay: 50 });
        await page.type('input[type="password"]', password, { delay: 50 });

        const [button] = await page.$$("xpath/.//button[contains(., 'Войти с паролем')]");
        if (button) {
            await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}), button.click()]);
        } else {
            await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}), page.click('button[type="submit"]')]);
        }
        await delay(3000);
    } catch (e: any) { await browser.close(); throw e; }

    if (await page.$('input[name="code"]')) {
        activeFlows.set(login, { browser, page, timestamp: Date.now(), timer: setTimeout(() => cleanupFlow(login), 300 * 1000) });
        return { success: false, needsVerification: true, message: 'Нужен код СМС' };
    }
    return { success: true, browser, page };
}

async function saveStateAndClose(login: string, browser: any, page: any) {
    try {
        const cookies = await page.cookies();
        const localStorageData = await page.evaluate(() => Object.keys(localStorage).map(k => ({ name: k, value: localStorage.getItem(k) })));
        fs.writeFileSync(getSessionPath(login), JSON.stringify({ cookies, localStorage: localStorageData }));
    } finally { await browser.close().catch(() => {}); }
}

// --- РОУТЫ ---

app.post('/drom/get-messages', async (req: Request, res: Response) => {
    const { login, password, verificationCode, proxy } = req.body;
    let browserData: any;
    try {
        if (verificationCode) {
            const flow = activeFlows.get(login);
            if (!flow) throw new Error('Сессия истекла');
            await flow.page.type('input[name="code"]', verificationCode);
            await Promise.all([flow.page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}), flow.page.keyboard.press('Enter')]);
            activeFlows.delete(login);
            browserData = { browser: flow.browser, page: flow.page };
        } else {
            browserData = await startLoginFlow(login, password, proxy);
            if (browserData.needsVerification) return res.status(202).json(browserData);
        }

        const { page, browser } = browserData;
        await page.goto('https://my.drom.ru/personal/messaging-modal?switchPosition=dialogs', { waitUntil: 'networkidle2' });
        
        const dialogs = await page.evaluate(() => Array.from(document.querySelectorAll('.dialog-list__li')).map(el => el.querySelector('a[href*="/messaging/view"]')?.getAttribute('href')?.match(/dialogId=([^&]+)/)?.[1]).filter(Boolean));
        
        const detailed = [];
        for (const id of dialogs.slice(0, 10)) {
            await page.goto(`https://my.drom.ru/personal/messaging/view?dialogId=${id}`, { waitUntil: 'networkidle2' });
            const data = await page.evaluate(() => {
                const link = document.querySelector('.bzr-dialog-header__sub-title a');
                const msgs = Array.from(document.querySelectorAll('.bzr-dialog__message'));
                let lastIn = '', lastOut = '', lastTime = '';
                for (let j = msgs.length - 1; j >= 0; j--) {
                    const text = msgs[j].querySelector('.bzr-dialog__text')?.textContent?.trim() || '';
                    if (msgs[j].classList.contains('bzr-dialog__message_in') && !lastIn) { lastIn = text; lastTime = msgs[j].querySelector('.bzr-dialog__message-dt')?.textContent?.trim() || ''; }
                    if (msgs[j].classList.contains('bzr-dialog__message_out') && !lastOut) { lastOut = text; }
                }
                return { carTitle: link?.textContent?.trim(), carUrl: link?.getAttribute('href'), lastIncomingText: lastIn, lastIncomingTime: lastTime, lastOutgoingText: lastOut };
            });
            detailed.push({ dialogId: id, ...data });
        }
        await saveStateAndClose(login, browser, page);
        res.json({ success: true, count: detailed.length, dialogs: detailed });
    } catch (e: any) { if (browserData?.browser) await browserData.browser.close(); res.status(500).json({ error: e.message }); }
});

app.post('/drom/get-bookmarks', async (req: Request, res: Response) => {
    const { login, password, proxy } = req.body;
    let browserData = await startLoginFlow(login, password, proxy);
    if (browserData.needsVerification) return res.status(202).json(browserData);
    try {
        const { page, browser } = browserData;
        await page.goto('https://my.drom.ru/personal/bookmark', { waitUntil: 'networkidle2' });
        const bkmImg = `bookmarks_${login}_${Date.now()}.png`;
        await page.screenshot({ path: path.join(DEBUG_DIR, bkmImg), fullPage: true });

        const bookmarks = await page.evaluate(() => Array.from(document.querySelectorAll('.bull-item')).slice(0, 10).map(el => ({
            id: el.getAttribute('data-bulletin-id'),
            title: el.querySelector('a.bulletinLink')?.textContent?.trim(),
            url: el.querySelector('a.bulletinLink')?.getAttribute('href'),
            price: parseInt(el.querySelector('.price-block__price')?.textContent?.replace(/\D/g, '') || '0'),
            city: el.querySelector('.bull-delivery__city')?.textContent?.trim(),
            specs: el.querySelector('.bull-item__annotation-row')?.textContent?.trim()
        })));

        await saveStateAndClose(login, browser, page);
        res.json({ success: true, bookmarks, debug_screenshot: `${req.protocol}://${req.get('host')}/screenshots/${bkmImg}` });
    } catch (e: any) { if (browserData?.browser) await browserData.browser.close(); res.status(500).json({ error: e.message }); }
});

app.post('/drom/send-offer', async (req: Request, res: Response) => {
    const { login, password, url, message, proxy } = req.body;
    let browserData = await startLoginFlow(login, password, proxy);
    if (browserData.needsVerification) return res.status(202).json(browserData);
    try {
        const { page, browser } = browserData;
        await page.goto(url, { waitUntil: 'networkidle2' });
        const btn = 'button[data-ga-stats-name="ask_question"]';
        await page.waitForSelector(btn, { visible: true, timeout: 10000 });
        await page.click(btn);
        await page.waitForSelector('textarea', { visible: true });
        await page.type('textarea', message, { delay: 50 });
        await page.click('button[data-ga-stats-name="send_question"]');
        await delay(3000);
        await saveStateAndClose(login, browser, page);
        res.json({ success: true });
    } catch (e: any) { if (browserData?.browser) await browserData.browser.close(); res.status(500).json({ error: e.message }); }
});

app.post('/drom/send-message', async (req: Request, res: Response) => {
    const { login, password, dialogId, message, proxy } = req.body;
    let browserData = await startLoginFlow(login, password, proxy);
    if (browserData.needsVerification) return res.status(202).json(browserData);
    try {
        const { page, browser } = browserData;
        await page.goto(`https://my.drom.ru/personal/messaging/view?dialogId=${dialogId}`, { waitUntil: 'networkidle2' });
        await page.waitForSelector('textarea[name="message"]', { visible: true });
        await page.type('textarea[name="message"]', message, { delay: 30 });
        await page.click('button[name="post"]');
        await delay(2000);
        await saveStateAndClose(login, browser, page);
        res.json({ success: true });
    } catch (e: any) { if (browserData?.browser) await browserData.browser.close(); res.status(500).json({ error: e.message }); }
});

app.post('/auth/reset', async (req: Request, res: Response) => {
    const { login } = req.body;
    const sessionPath = getSessionPath(login);
    if (fs.existsSync(sessionPath)) { fs.unlinkSync(sessionPath); res.json({ success: true }); }
    else res.json({ success: false, error: 'Not found' });
});

app.get('/health', (_, res) => res.send('OK'));
app.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => console.log('🚀 Server started'));
