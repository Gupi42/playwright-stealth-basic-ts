import express, { Request, Response } from 'express';
// @ts-ignore
import puppeteer from 'puppeteer-extra';
// @ts-ignore
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

// === 🛡️ ЗАЩИТА (MIDDLEWARE) ===
app.use((req, res, next) => {
    if (req.path === '/health') return next();

    const clientKey = req.headers['x-api-key'];
    const serverKey = process.env.API_SECRET;

    if (!serverKey) {
        console.error('⛔ ОШИБКА: Переменная API_SECRET не задана в Railway!');
        return res.status(500).json({ error: 'Server security configuration missing' });
    }

    if (clientKey !== serverKey) {
        console.log(`⛔ Несанкционированный доступ с IP: ${req.ip}`);
        return res.status(403).json({ error: 'Access denied: Invalid API Key' });
    }
    next();
});

// --- КОНФИГУРАЦИЯ ---
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const DEBUG_DIR = path.join(DATA_DIR, 'debug');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

const GLOBAL_PROXY_URL = process.env.PROXY_URL;

// --- ХЕЛПЕРЫ ---
function getSessionPath(login: string): string {
    const sanitized = login.replace(/[^a-zA-Z0-9]/g, '_');
    return path.join(SESSIONS_DIR, `state_${sanitized}.json`);
}

interface ActiveFlow {
    browser: any;
    page: any;
    timestamp: number;
    timer: NodeJS.Timeout;
}

const activeFlows: Map<string, ActiveFlow> = new Map();

async function cleanupFlow(login: string) {
    const flow = activeFlows.get(login);
    if (flow) {
        console.log(`🧹 Очистка ресурсов для ${login}`);
        clearTimeout(flow.timer);
        try {
            await flow.browser.close();
        } catch (e) {
            console.error('Ошибка при закрытии браузера:', e);
        }
        activeFlows.delete(login);
    }
}

// 🆕 УЛУЧШЕННАЯ ФУНКЦИЯ ЛОГАУТА
async function performLogout(page: any, login: string): Promise<void> {
    try {
        console.log(`🚪 Выполняется логаут для ${login}...`);

        // Переходим на страницу логаута
        await page.goto('https://my.drom.ru/logout?return=https%3A%2F%2Fauto.drom.ru%2Favtoline38%2F%3Ftcb%3D1766397803', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        await new Promise(r => setTimeout(r, 2000));

        // Очищаем cookies и localStorage
        const cookies = await page.cookies();
        if (cookies.length > 0) {
            await page.deleteCookie(...cookies);
        }

        await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
        });

        console.log(`✅ Логаут выполнен для ${login}`);
    } catch (error: any) {
        console.error(`⚠️ Ошибка при логауте для ${login}:`, error.message);
        // Даже если логаут не удался, очищаем локальные данные
        try {
            const cookies = await page.cookies();
            if (cookies.length > 0) {
                await page.deleteCookie(...cookies);
            }
            await page.evaluate(() => {
                localStorage.clear();
                sessionStorage.clear();
            });
        } catch (e) {
            console.error('Критическая ошибка очистки:', e);
        }
    }
}

// 🆕 УЛУЧШЕННАЯ ФУНКЦИЯ СОХРАНЕНИЯ СОСТОЯНИЯ
async function saveStateAndClose(login: string, browser: any, page: any, skipLogout: boolean = false) {
    try {
        const cookies = await page.cookies();
        const localStorageData = await page.evaluate(() => {
            const data: any[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key) data.push({ name: key, value: localStorage.getItem(key) });
            }
            return data;
        });

        const state = { 
            cookies, 
            localStorage: localStorageData,
            login: login, // 🆕 Сохраняем логин для проверки
            timestamp: Date.now() // 🆕 Время последнего сохранения
        };
        fs.writeFileSync(getSessionPath(login), JSON.stringify(state, null, 2));
        console.log(`💾 Сессия сохранена для ${login}`);
    } catch (e) {
        console.error('Ошибка сохранения сессии:', e);
    } finally {
        if (!skipLogout) {
            await browser.close().catch(() => {});
        }
    }
}

// 🆕 УЛУЧШЕННАЯ ФУНКЦИЯ ОЧИСТКИ КОНТЕКСТА ПЕРЕД ЗАГРУЗКОЙ НОВОЙ СЕССИИ
async function clearBrowserContext(page: any): Promise<void> {
    try {
        console.log('🧹 Очистка контекста браузера...');

        // Удаляем все cookies
        const cookies = await page.cookies();
        if (cookies.length > 0) {
            await page.deleteCookie(...cookies);
        }

        // Очищаем localStorage и sessionStorage
        await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
        });

        console.log('✅ Контекст браузера очищен');
    } catch (error) {
        console.error('⚠️ Ошибка при очистке контекста:', error);
    }
}

// 🆕 УЛУЧШЕННАЯ ФУНКЦИЯ ЗАГРУЗКИ СЕССИИ С ПРОВЕРКОЙ
async function loadSessionIfExists(login: string, page: any): Promise<boolean> {
    const sessionPath = getSessionPath(login);

    if (!fs.existsSync(sessionPath)) {
        console.log(`📭 Сессия для ${login} не найдена`);
        return false;
    }

    try {
        const state = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));

        // 🆕 Проверяем, что сессия принадлежит нужному логину
        if (state.login && state.login !== login) {
            console.log(`⚠️ Сессия принадлежит другому логину (${state.login}), очищаем...`);
            await clearBrowserContext(page);
            return false;
        }

        // 🆕 Проверяем возраст сессии (опционально, можно добавить лимит)
        const sessionAge = Date.now() - (state.timestamp || 0);
        const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 дней
        if (sessionAge > maxAge) {
            console.log(`⚠️ Сессия устарела (${Math.round(sessionAge / 86400000)} дней), требуется повторный вход`);
            fs.unlinkSync(sessionPath);
            return false;
        }

        // Очищаем контекст перед загрузкой новой сессии
        await clearBrowserContext(page);

        // Загружаем cookies
        if (state.cookies && state.cookies.length > 0) {
            await page.setCookie(...state.cookies);
            console.log(`🍪 Загружено ${state.cookies.length} cookies`);
        }

        // Загружаем localStorage
        if (state.localStorage && state.localStorage.length > 0) {
            await page.evaluateOnNewDocument((data: any[]) => {
                data.forEach(item => {
                    if (item.name && item.value) {
                        localStorage.setItem(item.name, item.value);
                    }
                });
            }, state.localStorage);
            console.log(`📦 Загружено ${state.localStorage.length} записей localStorage`);
        }

        console.log(`✅ Сессия успешно загружена для ${login}`);
        return true;
    } catch (error) {
        console.error(`⚠️ Ошибка загрузки сессии для ${login}:`, error);
        return false;
    }
}

// 🆕 НОВЫЙ ENDPOINT ДЛЯ ЯВНОГО ЛОГАУТА
app.post('/drom/logout', async (req: Request, res: Response) => {
    const { login } = req.body;

    if (!login) {
        return res.status(400).json({ error: 'Login required' });
    }

    let browser;
    try {
        console.log(`🚀 Запуск логаута для ${login}...`);

        const launchOptions: any = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled'
            ]
        };

        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();

        // Загружаем сессию если есть
        await loadSessionIfExists(login, page);

        // Выполняем логаут
        await performLogout(page, login);

        // Удаляем файл сессии
        const sessionPath = getSessionPath(login);
        if (fs.existsSync(sessionPath)) {
            fs.unlinkSync(sessionPath);
            console.log(`🗑️ Файл сессии удален для ${login}`);
        }

        await browser.close();

        res.json({ 
            success: true, 
            message: `Logout successful for ${login}` 
        });

    } catch (error: any) {
        console.error('Logout error:', error.message);
        if (browser) await browser.close().catch(() => {});
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// --- РОУТЫ ---

// 1. ПОЛУЧЕНИЕ СООБЩЕНИЙ
app.post('/drom/get-messages', async (req: Request, res: Response) => {
    const { login, password, verificationCode, proxy } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Login/password required' });

    let browserData;
    try {
        if (verificationCode) {
            browserData = await completeLoginFlow(login, verificationCode);
        } else {
            const result: any = await startLoginFlow(login, password, proxy);
            if (result.needsVerification) return res.status(202).json(result);
            browserData = result;
        }

        const { page, browser } = browserData;
        console.log('💬 Загрузка списка диалогов...');
        
        await page.goto('https://my.drom.ru/personal/messaging-modal?switchPosition=dialogs', { waitUntil: 'domcontentloaded', timeout: 60000 });

        try {
            await page.waitForSelector('.dialog-list__li', { timeout: 10000 });
        } catch {
            console.log('Диалогов нет');
            await saveStateAndClose(login, browser, page);
            return res.json({ success: true, count: 0, dialogs: [] });
        }

        const dialogsList = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.dialog-list__li'))
                .map(el => {
                    const href = el.querySelector('a[href*="/messaging/view"]')?.getAttribute('href');
                    const match = href?.match(/dialogId=([^&]+)/);
                    return match ? { dialogId: match[1] } : null;
                })
                .filter(Boolean);
        });

        const limit = Math.min(dialogsList.length, 10);
        console.log(`📋 Обработка ${limit} диалогов...`);
        const detailedDialogs = [];

        for (let i = 0; i < limit; i++) {
            const dItem: any = dialogsList[i];
            try {
                // В Puppeteer сложнее кликнуть по конкретному элементу из списка, проще перейти по URL
                await page.goto(`https://my.drom.ru/personal/messaging/view?dialogId=${dItem.dialogId}`, { waitUntil: 'domcontentloaded' });
                
                try {
                     await page.waitForSelector('.bzr-dialog__inner', { timeout: 8000 });
                } catch(e) { continue; }

                const details = await page.evaluate(() => {
                    const carLink = document.querySelector('.bzr-dialog-header__sub-title a');
                    const carTitle = carLink?.textContent?.trim() || '';
                    let carUrl = carLink?.getAttribute('href') || '';
                    if (carUrl && carUrl.startsWith('//')) carUrl = 'https:' + carUrl;

                    const allMessages = Array.from(document.querySelectorAll('.bzr-dialog__message'));
                    const buffer: string[] = [];
                    let lastTime = '';

                    for (let j = allMessages.length - 1; j >= 0; j--) {
                        const msg = allMessages[j];
                        if (msg.classList.contains('bzr-dialog__message_out')) {
                            break;
                        }
                        if (msg.classList.contains('bzr-dialog__message_in')) {
                            const text = msg.querySelector('.bzr-dialog__text')?.textContent?.trim() || '';
                            if (text) buffer.unshift(text);
                            if (!lastTime) {
                                lastTime = msg.querySelector('.bzr-dialog__message-dt')?.textContent?.trim() || '';
                            }
                        }
                    }

                    const combinedText = buffer.join('\n');
                    return {
                        carTitle,
                        carUrl,
                        lastIncomingText: combinedText,
                        lastIncomingTime: lastTime
                    };
                });

                if (details.lastIncomingText) {
                    detailedDialogs.push({ dialogId: dItem.dialogId, ...details });
                }

                await new Promise(r => setTimeout(r, Math.random() * 1000 + 500));

            } catch (e) {
                console.error(`Error dialog ${dItem.dialogId}`, e);
            }
        }

        console.log(`✅ Собрано ${detailedDialogs.length}`);
        await saveStateAndClose(login, browser, page);
        res.json({ success: true, count: detailedDialogs.length, dialogs: detailedDialogs });

    } catch (err: any) {
        console.error('CRITICAL ERROR:', err.message);
        if (browserData?.browser) await browserData.browser.close().catch(() => {});
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. ОТПРАВКА СООБЩЕНИЯ
app.post('/drom/send-message', async (req: Request, res: Response) => {
    const { login, password, dialogId, message, proxy } = req.body;
    if (!login || !password || !dialogId || !message) return res.status(400).json({ error: 'Data missing' });

    let browserData;
    try {
        const result: any = await startLoginFlow(login, password, proxy);
        if (result.needsVerification) return res.status(202).json(result);
        browserData = result;

        const { page, browser } = browserData;
        console.log(`📤 Отправка в диалог ${dialogId}...`);
        
        await page.goto(`https://my.drom.ru/personal/messaging/view?dialogId=${dialogId}`, { waitUntil: 'domcontentloaded' });

        const textAreaSelector = 'textarea[name="message"]';
        await page.waitForSelector(textAreaSelector, { visible: true, timeout: 10000 });
        await page.type(textAreaSelector, message, { delay: 100 });
        
        await new Promise(r => setTimeout(r, 500));
        await page.click('button[name="post"]');
        
        await new Promise(r => setTimeout(r, 2000));
        console.log('✅ Отправлено');
        
        await saveStateAndClose(login, browser, page);
        res.json({ success: true });

    } catch (err: any) {
        console.error('Send error:', err.message);
        if (browserData?.browser) await browserData.browser.close().catch(() => {});
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. ПОЛУЧЕНИЕ ИЗБРАННОГО
app.post('/drom/get-bookmarks', async (req: Request, res: Response) => {
    const { login, password, verificationCode, proxy } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Login/pass required' });

    let browserData;
    try {
        if (verificationCode) {
            browserData = await completeLoginFlow(login, verificationCode);
        } else {
            const result: any = await startLoginFlow(login, password, proxy);
            if (result.needsVerification) return res.status(202).json(result);
            browserData = result;
        }

        const { page, browser } = browserData;
        console.log('⭐ Переход в избранное...');
        await page.goto('https://my.drom.ru/personal/bookmark', { waitUntil: 'domcontentloaded' });

        try {
            await page.waitForSelector('.bull-item', { timeout: 8000 });
        } catch (e) {
            console.log('Избранное пусто');
            await saveStateAndClose(login, browser, page);
            return res.json({ success: true, count: 0, bookmarks: [] });
        }

        const bookmarks = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.bull-item'));
            return items.slice(0, 10).map(el => {
                const getText = (selector: string) => el.querySelector(selector)?.textContent?.trim().replace(/\s+/g, ' ') || '';
                const linkNode = el.querySelector('a.bulletinLink');
                const href = linkNode ? linkNode.getAttribute('href') : '';
                const url = href ? (href.startsWith('//') ? 'https:' + href : href) : '';
                const id = el.getAttribute('data-bulletin-id') || '';
                const priceRaw = getText('.price-block__price');
                const price = priceRaw ? priceRaw.replace(/[^\d]/g, '') : '';

                return {
                    id,
                    title: linkNode?.textContent?.trim() || '',
                    url,
                    price: parseInt(price) || 0,
                    city: getText('.bull-delivery__city'),
                    specs: getText('.bull-item__annotation-row'),
                    date: getText('.date')
                };
            });
        });

        console.log(`✅ Собрано ${bookmarks.length}`);
        await saveStateAndClose(login, browser, page);
        res.json({ success: true, count: bookmarks.length, bookmarks });

    } catch (error: any) {
        console.error('Error bookmarks:', error.message);
        if (browserData?.browser) await browserData.browser.close().catch(() => {});
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. ОТПРАВКА ОФФЕРА
app.post('/drom/send-offer', async (req: Request, res: Response) => {
    const { login, password, verificationCode, proxy, url, message } = req.body;
    if (!login || !password || !url || !message) {
        return res.status(400).json({ error: 'Login, password, url and message required' });
    }

    let browserData;
    try {
        if (verificationCode) {
            browserData = await completeLoginFlow(login, verificationCode);
        } else {
            const result: any = await startLoginFlow(login, password, proxy);
            if (result.needsVerification) return res.status(202).json(result);
            browserData = result;
        }

        const { page, browser } = browserData;
        console.log(`🚗 Переход к объявлению: ${url}`);
        
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        
        // Кнопка "Написать"
        const openModalBtnSelector = 'button[data-ga-stats-name="ask_question"]';
        try {
            await humanClick(page, openModalBtnSelector);
        } catch(e) {
             throw new Error('Кнопка "Написать" не найдена');
        }

        const modalSelector = 'div[data-ftid="component_modal_content"]';
        await page.waitForSelector(modalSelector, { visible: true, timeout: 5000 });
        
        const textareaSelector = `${modalSelector} textarea`;
        await page.waitForSelector(textareaSelector, { visible: true });
        await page.type(textareaSelector, message, { delay: 100 });
        
        await new Promise(r => setTimeout(r, 1000));
        
        const sendBtnSelector = 'button[data-ga-stats-name="send_question"]';
        console.log('✉️ Отправляем...');
        await humanClick(page, sendBtnSelector);
        
        await new Promise(r => setTimeout(r, 3000));
        console.log('✅ Отправлено!');
        
        await saveStateAndClose(login, browser, page);
        res.json({ success: true });

    } catch (error: any) {
        console.error('Offer error:', error.message);
        if (browserData?.browser) await browserData.browser.close().catch(() => {});
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/health', (_, res) => res.send('OK'));

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on port ${PORT}`));
