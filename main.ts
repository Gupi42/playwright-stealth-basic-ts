import express, { Request, Response } from 'express';
// @ts-ignore
import puppeteer from 'puppeteer-extra';
// @ts-ignore
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createCursor, GhostCursor } from 'ghost-cursor';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

// --- ИНИЦИАЛИЗАЦИЯ ---
puppeteer.use(StealthPlugin());
const app = express();
app.use(express.json());

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const DEBUG_DIR = path.join(DATA_DIR, 'debug');

[SESSIONS_DIR, DEBUG_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- ТИПЫ ---
interface ActiveFlow {
    browser: any;
    page: any;
    cursor: GhostCursor;
    timer: NodeJS.Timeout;
}
const activeFlows: Map<string, ActiveFlow> = new Map();

// --- Вспомогательные функции ---
function parseProxy(proxyUrl?: string) {
    if (!proxyUrl) return null;
    try {
        const u = new URL(proxyUrl);
        return { server: `${u.protocol}//${u.hostname}:${u.port}`, username: u.username, password: u.password };
    } catch { return null; }
}

const getSessionPath = (service: string, login: string) => 
    path.join(SESSIONS_DIR, `${service}_${login.replace(/[^a-z0-9]/gi, '_')}.json`);

async function cleanupFlow(login: string) {
    const flow = activeFlows.get(login);
    if (flow) {
        clearTimeout(flow.timer);
        await flow.browser.close().catch(() => {});
        activeFlows.delete(login);
    }
}

// --- ЯДРО БРАУЗЕРА ---
async function getBrowserAndPage(service: string, login: string, proxyUrl?: string) {
    const proxyConfig = parseProxy(proxyUrl || process.env.PROXY_URL);
    const args = ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1366,768', '--disable-blink-features=AutomationControlled'];
    if (proxyConfig?.server) args.push(`--proxy-server=${proxyConfig.server}`);

    const browser = await puppeteer.launch({ headless: "new", args, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH });
    const page = await browser.newPage();
    const cursor = createCursor(page);

    if (proxyConfig?.username) await page.authenticate({ username: proxyConfig.username, password: proxyConfig.password });
    
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    await page.setRequestInterception(true);
    page.on('request', (req: any) => {
        if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
        else req.continue();
    });

    const sessionPath = getSessionPath(service, login);
    if (fs.existsSync(sessionPath)) {
        const state = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        if (Date.now() - state.ts < 1000 * 60 * 60 * 24 * 14) {
            await page.setCookie(...state.cookies);
            await page.evaluateOnNewDocument((s: any) => {
                s.forEach((item: any) => localStorage.setItem(item.name, item.value));
            }, state.localStorage);
        }
    }
    return { browser, page, cursor };
}

async function saveStateAndClose(service: string, login: string, browser: any, page: any) {
    try {
        const cookies = await page.cookies();
        const localStorageData = await page.evaluate(() => Object.keys(localStorage).map(k => ({ name: k, value: localStorage.getItem(k) })));
        fs.writeFileSync(getSessionPath(service, login), JSON.stringify({ cookies, localStorage: localStorageData, ts: Date.now() }));
    } finally { await browser.close().catch(() => {}); }
}

// --- MIDDLEWARE БЕЗОПАСНОСТИ ---
app.use((req, res, next) => {
    if (req.path === '/health') return next();
    if (req.headers['x-api-key'] !== process.env.API_SECRET) return res.status(403).json({ error: 'Forbidden' });
    next();
});

// --- РОУТЫ DROM ---

app.post('/drom/get-messages', async (req: Request, res: Response) => {
    const { login, password, proxy } = req.body;
    const { browser, page, cursor } = await getBrowserAndPage('drom', login, proxy);
    try {
        await page.goto('https://my.drom.ru/personal/messaging', { waitUntil: 'domcontentloaded' });
        if (page.url().includes('sign')) {
            await page.type('input[name="sign"]', login, { delay: 50 });
            await page.type('input[type="password"]', password, { delay: 50 });
            await cursor.click('button[type="submit"]');
            await page.waitForTimeout(3000);
            if (await page.$('input[name="code"]')) {
                activeFlows.set(login, { browser, page, cursor, timer: setTimeout(() => cleanupFlow(login), 300000) });
                return res.status(202).json({ needsVerification: true });
            }
        }
        await page.waitForSelector('.dialog-list__li', { timeout: 10000 }).catch(() => {});
        const dialogIds = await page.evaluate(() => Array.from(document.querySelectorAll('.dialog-list__li')).map(el => el.querySelector('a[href*="dialogId="]')?.getAttribute('href')?.match(/dialogId=([^&]+)/)?.[1]).filter(Boolean));
        
        const detailedDialogs = [];
        for (const id of dialogIds.slice(0, 10)) {
            await page.goto(`https://my.drom.ru/personal/messaging/view?dialogId=${id}`, { waitUntil: 'domcontentloaded' });
            const details = await page.evaluate(() => {
                const msgs = Array.from(document.querySelectorAll('.bzr-dialog__message'));
                let lastIn = '', lastOut = '', lastTime = '';
                for (let i = msgs.length - 1; i >= 0; i--) {
                    const text = msgs[i].querySelector('.bzr-dialog__text')?.textContent?.trim() || '';
                    if (msgs[i].classList.contains('bzr-dialog__message_in') && !lastIn) { lastIn = text; lastTime = msgs[i].querySelector('.bzr-dialog__message-dt')?.textContent?.trim() || ''; }
                    if (msgs[i].classList.contains('bzr-dialog__message_out') && !lastOut) { lastOut = text; }
                }
                const link = document.querySelector('.bzr-dialog-header__sub-title a');
                return { carTitle: link?.textContent?.trim(), carUrl: link?.getAttribute('href'), lastIncomingText: lastIn, lastIncomingTime: lastTime, lastOutgoingText: lastOut };
            });
            detailedDialogs.push({ dialogId: id, ...details });
        }
        await saveStateAndClose('drom', login, browser, page);
        res.json({ success: true, dialogs: detailedDialogs });
    } catch (e: any) { await browser.close(); res.status(500).json({ error: e.message }); }
});

app.post('/drom/get-bookmarks', async (req: Request, res: Response) => {
    const { login, password, proxy } = req.body;
    const { browser, page, cursor } = await getBrowserAndPage('drom', login, proxy);
    try {
        await page.goto('https://my.drom.ru/personal/bookmark', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.bull-item', { timeout: 10000 }).catch(() => {});
        const bookmarks = await page.evaluate(() => Array.from(document.querySelectorAll('.bull-item')).slice(0, 10).map(el => ({
            id: el.getAttribute('data-bulletin-id'),
            title: el.querySelector('a.bulletinLink')?.textContent?.trim(),
            url: el.querySelector('a.bulletinLink')?.getAttribute('href'),
            price: parseInt(el.querySelector('.price-block__price')?.textContent?.replace(/\D/g, '') || '0'),
            specs: el.querySelector('.bull-item__annotation-row')?.textContent?.trim()
        })));
        await saveStateAndClose('drom', login, browser, page);
        res.json({ success: true, bookmarks });
    } catch (e: any) { await browser.close(); res.status(500).json({ error: e.message }); }
});

app.post('/drom/send-offer', async (req: Request, res: Response) => {
    const { login, password, url, message, proxy } = req.body;
    const { browser, page, cursor } = await getBrowserAndPage('drom', login, proxy);
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const btn = 'button[data-ga-stats-name="ask_question"]';
        await page.waitForSelector(btn, { visible: true, timeout: 10000 });
        await cursor.click(btn);
        await page.waitForSelector('textarea', { visible: true });
        await page.type('textarea', message, { delay: 50 });
        await cursor.click('button[data-ga-stats-name="send_question"]');
        await page.waitForTimeout(3000);
        await saveStateAndClose('drom', login, browser, page);
        res.json({ success: true });
    } catch (e: any) { await browser.close(); res.status(500).json({ error: e.message }); }
});

app.post('/drom/send-message', async (req: Request, res: Response) => {
    const { login, password, dialogId, message, proxy } = req.body;
    const { browser, page, cursor } = await getBrowserAndPage('drom', login, proxy);
    try {
        await page.goto(`https://my.drom.ru/personal/messaging/view?dialogId=${dialogId}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('textarea[name="message"]', { visible: true });
        await page.type('textarea[name="message"]', message, { delay: 30 });
        await cursor.click('button[name="post"]');
        await page.waitForTimeout(2000);
        await saveStateAndClose('drom', login, browser, page);
        res.json({ success: true });
    } catch (e: any) { await browser.close(); res.status(500).json({ error: e.message }); }
});

// --- РОУТЫ AVITO ---

app.post('/avito/login', async (req: Request, res: Response) => {
    const { login, password, proxy } = req.body;
    const { browser, page, cursor } = await getBrowserAndPage('avito', login, proxy);
    try {
        await page.goto('https://www.avito.ru/#login', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('input[data-marker="login-form/login/input"]', { timeout: 10000 });
        await page.type('input[data-marker="login-form/login/input"]', login, { delay: 60 });
        await page.type('input[data-marker="login-form/password/input"]', password, { delay: 60 });
        await cursor.click('button[data-marker="login-form/submit"]');
        await page.waitForTimeout(5000);
        if (await page.$('[data-marker="phone-confirm-wrapper"]')) {
            activeFlows.set(login, { browser, page, cursor, timer: setTimeout(() => cleanupFlow(login), 300000) });
            return res.status(202).json({ needsVerification: true });
        }
        await saveStateAndClose('avito', login, browser, page);
        res.json({ success: true });
    } catch (e: any) { await browser.close(); res.status(500).json({ error: e.message }); }
});

// --- ОБЩИЙ ВЕРИФИКАТОР ---

app.post('/verify-code', async (req: Request, res: Response) => {
    const { login, code, service } = req.body;
    const flow = activeFlows.get(login);
    if (!flow) return res.status(404).json({ error: 'Flow not found' });
    try {
        const { page, cursor, browser } = flow;
        if (service === 'avito') {
            await page.type('input[data-marker="phone-confirm/code-input/input"]', code, { delay: 100 });
            await cursor.click('button[data-marker="phone-confirm/confirm"]');
        } else {
            await page.type('input[name="code"]', code, { delay: 100 });
            await page.keyboard.press('Enter');
        }
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        await saveStateAndClose(service, login, browser, page);
        activeFlows.delete(login);
        res.json({ success: true });
    } catch (e: any) { await cleanupFlow(login); res.status(500).json({ error: e.message }); }
});

app.get('/health', (_, res) => res.send('OK'));
app.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => console.log(`🚀 Server ready`));
