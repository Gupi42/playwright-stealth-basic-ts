import express, { Request, Response } from 'express';
// @ts-ignore
import puppeteer from 'puppeteer-extra';
// @ts-ignore
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

// 1. Активируем скрытность
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());
// --- КОНФИГУРАЦИЯ ---
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const DEBUG_DIR = path.join(DATA_DIR, 'debug');
app.use('/screenshots', express.static(DEBUG_DIR));
// === 🛡️ ЗАЩИТА (MIDDLEWARE) ===
app.use((req, res, next) => {
    if (req.path === '/health' || req.path.startsWith('/screenshots')) {
        return next();
    }

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

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

// Глобальный прокси (резервный)
const GLOBAL_PROXY_URL = process.env.PROXY_URL;

// --- ХЕЛПЕРЫ ---
function getSessionPath(login: string): string {
    const sanitized = login.replace(/[^a-zA-Z0-9]/g, '_');
    return path.join(SESSIONS_DIR, `state_${sanitized}.json`);
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface ActiveFlow {
    browser: any;
    page: any;
    timestamp: number;
    timer: NodeJS.Timeout;
}
async function performHardLogout(page: any, login: string) {
    console.log(`[${login}] Начинаем глубокую очистку аккаунта...`);

    // 1. Удаляем файл сессии с диска
    const sessionPath = getSessionPath(login);
    if (fs.existsSync(sessionPath)) {
        try {
            fs.unlinkSync(sessionPath);
            console.log(`[${login}] Файл сессии удален с диска.`);
        } catch (e) {
            console.error(` Ошибка удаления файла:`, e);
        }
    }

    try {
        // 2. Переход на страницу выхода (сброс сессии на стороне сервера Drom)
        // Используем try/catch на случай, если страница не загрузится
        await page.goto('https://my.drom.ru/logout', { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});

        // 3. Команда Chrome DevTools Protocol для полной очистки куки и кэша
        const client = await page.target().createCDPSession();
        await client.send('Network.clearBrowserCookies');
        await client.send('Network.clearBrowserCache');

        // 4. Очистка LocalStorage, SessionStorage и IndexedDB внутри браузера
        await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
            // Чистим IndexedDB (иногда Drom хранит там токены)
            window.indexedDB.databases().then(dbs => {
                dbs.forEach(db => {
                    if (db.name) window.indexedDB.deleteDatabase(db.name);
                });
            });
        });
        
        console.log(`[${login}] Браузер полностью очищен.`);
    } catch (error) {
        console.error(`[${login}] Ошибка при очистке внутри браузера:`, error);
    }
}
const activeFlows: Map<string, ActiveFlow> = new Map();

async function cleanupFlow(login: string) {
    const flow = activeFlows.get(login);
    if (flow) {
        console.log(`🧹 Очистка ресурсов для ${login}`);
        clearTimeout(flow.timer);
        try {
            await flow.browser.close();
        } catch (e) {}
        activeFlows.delete(login);
    }
}

async function humanClick(page: any, selector: string) {
    try {
        await page.waitForSelector(selector, { visible: true, timeout: 5000 });
        const element = await page.$(selector);
        
        if (element) {
            const box = await element.boundingBox();
            if (box) {
                await page.mouse.move(
                    box.x + box.width / 2 + (Math.random() - 0.5) * 10,
                    box.y + box.height / 2 + (Math.random() - 0.5) * 10,
                    { steps: 10 }
                );
                await new Promise(r => setTimeout(r, Math.random() * 200 + 100));
                await element.click();
                return true;
            }
        }
    } catch (e) {
        // Element not found or not visible
    }
    return false;
}

// Хелпер для парсинга прокси
function parseProxy(proxyUrl: string) {
    try {
        const url = new URL(proxyUrl);
        return {
            server: `${url.protocol}//${url.hostname}:${url.port}`,
            username: url.username,
            password: url.password
        };
    } catch (e) {
        return null;
    }
}

// --- ОСНОВНАЯ ЛОГИКА БРАУЗЕРА ---

async function getBrowserInstance(proxyServer?: string) {
    const launchOptions: any = {
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--window-size=1366,768'
        ],
        ignoreHTTPSErrors: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
    };

    if (proxyServer) {
        launchOptions.args.push(`--proxy-server=${proxyServer}`);
    }

    return await puppeteer.launch(launchOptions);
}

async function startLoginFlow(login: string, password: string, proxyUrl?: string) {
    await cleanupFlow(login);

    let proxyConfig = null;
    let proxyServerArg = undefined;
    const proxyToUse = proxyUrl || GLOBAL_PROXY_URL;
    if (proxyToUse) {
        proxyConfig = parseProxy(proxyToUse);
        if (proxyConfig) proxyServerArg = proxyConfig.server;
    }

    const browser = await getBrowserInstance(proxyServerArg);
    const page = await browser.newPage();

    // ВЫЗЫВАЕМ ОЧИСТКУ ПЕРЕД ВХОДОМ
    await performHardLogout(page, login);
    
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

    // === ШАГ 0: ГЛУБОКАЯ ОЧИСТКА ===
    console.log(`[${login}] Выполняем логаут и очистку данных...`);
    try {
        // 1. Прямой переход на логаут (быстрее чем искать кнопку)
        await page.goto('https://my.drom.ru/logout', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        
        // 2. Очистка через системные команды Chrome
        const client = await page.target().createCDPSession();
        await client.send('Network.clearBrowserCookies');
        await client.send('Network.clearBrowserCache');
        
        // 3. Очистка локального хранилища
        await page.goto('https://my.drom.ru/', { waitUntil: 'domcontentloaded' });
        await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
        });
    } catch (e) {
        console.log('Ошибка при логауте (возможно, уже разлогинен)');
    }

    // Блокировка ресурсов
    await page.setRequestInterception(true);
    page.on('request', (req: any) => {
        if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType())) req.abort();
        else req.continue();
    });

    // 1. Попытка восстановить сессию именно для этого логина
    const sessionPath = getSessionPath(login);
    if (fs.existsSync(sessionPath)) {
        try {
            const state = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
            if (state.cookies) await page.setCookie(...state.cookies);
            if (state.localStorage) {
                // Восстанавливаем localStorage перед заходом
                await page.evaluateOnNewDocument((data: any) => {
                    localStorage.clear();
                    data.forEach((item: any) => localStorage.setItem(item.name, item.value));
                }, state.localStorage);
            }

            console.log(`🔄 Пробуем восстановить сессию для ${login}...`);
            await page.goto('https://my.drom.ru/personal/', { waitUntil: 'networkidle2', timeout: 60000 });
            
            if (!page.url().includes('sign')) {
                console.log('✅ Сессия восстановлена');
                return { success: true, browser, page };
            }
        } catch (e) { console.log('Сессия не подошла'); }
    }

    // 2. Если сессии нет — идем на логин
    console.log(`🔐 Входим по паролю в аккаунт: ${login}`);
    await page.goto('https://my.drom.ru/sign', { waitUntil: 'networkidle2', timeout: 60000 });

    try {
        await page.waitForSelector('input[name="sign"]', { visible: true, timeout: 15000 });
        await page.type('input[name="sign"]', login, { delay: 100 });
        await page.type('input[type="password"]', password, { delay: 100 });

        // Ищем кнопку "Войти с паролем"
        const [button] = await page.$$("xpath/.//button[contains(., 'Войти с паролем')]");
        
        // Используем Promise.all для предотвращения ошибки "Execution context destroyed"
        if (button) {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
                button.click()
            ]);
        } else {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
                page.click('button[type="submit"]')
            ]);
        }
        
        await delay(3000); // Даем время на обработку редиректов
        
    } catch (e: any) {
        console.error("Ошибка ввода данных:", e.message);
        await browser.close();
        throw e;
    }

    // 3. Проверка 2FA
    const codeInput = await page.$('input[name="code"]');
    if (codeInput) { 
        console.log('📱 Drom запрашивает код подтверждения');
        activeFlows.set(login, {
            browser, page, timestamp: Date.now(),
            timer: setTimeout(() => cleanupFlow(login), 300 * 1000)
        });

        return {
            success: false,
            needsVerification: true,
            message: 'Требуется код подтверждения.'
        };
    }

    return { success: true, browser, page };
}

async function completeLoginFlow(login: string, code: string) {
    const flow = activeFlows.get(login);
    if (!flow) throw new Error('Сессия не найдена или истекла. Повторите запрос.');

    console.log(`✍️ Вводим код для ${login}...`);
    const { page } = flow;

    try {
        const codeInputSelector = 'input[name="code"]';
        await page.waitForSelector(codeInputSelector, { visible: true, timeout: 5000 });
        await page.type(codeInputSelector, code, { delay: 100 });
        
        await new Promise(r => setTimeout(r, Math.random() * 500 + 200));

        // Нажимаем подтвердить
        const [confirmBtn] = await page.$$("xpath/.//button[contains(., 'Подтвердить') or contains(., 'Войти')]");
        if (confirmBtn) {
            await confirmBtn.click();
        } else {
            await page.keyboard.press('Enter');
        }

        // Ждем перехода
        await page.waitForFunction(() => window.location.href.includes('/personal'), { timeout: 15000 });

        console.log('🎉 Успешный вход!');
        clearTimeout(flow.timer);
        activeFlows.delete(login);

        return { success: true, browser: flow.browser, page: flow.page };

    } catch (error) {
        await page.screenshot({ path: path.join(DEBUG_DIR, `error_code_${Date.now()}.png`) });
        throw new Error('Неверный код или ошибка сайта');
    }
}

async function saveStateAndClose(login: string, browser: any, page: any) {
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

        const state = { cookies, localStorage: localStorageData };
        fs.writeFileSync(getSessionPath(login), JSON.stringify(state, null, 2));
        console.log(`💾 Сессия сохранена для ${login}`);
    } catch (e) {
        console.error('Ошибка сохранения сессии:', e);
    } finally {
        await browser.close().catch(() => {});
    }
}

// --- РОУТЫ ---
app.post('/drom/logout', async (req: Request, res: Response) => {
    const { login, proxy } = req.body;
    if (!login) return res.status(400).json({ error: 'Login required' });

    const browser = await getBrowserInstance(); // Запускаем без прокси или с ним
    const page = await browser.newPage();

    try {
        await performHardLogout(page, login);
        res.json({ success: true, message: `Account ${login} logged out and cleared.` });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    } finally {
        await browser.close();
    }
});
// 1. ПОЛУЧЕНИЕ СООБЩЕНИЙ
app.post('/drom/get-messages', async (req: Request, res: Response) => {
    const { login, password, verificationCode, proxy } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Login/password required' });

    let browserData: any;
    const timestamp = Date.now();
    const makeDebugUrl = (name: string) => `${req.protocol}://${req.get('host')}/screenshots/${name}`;

    try {
        console.log(`[Debug] [${login}] Начинаем получение сообщений...`);

        // 1. Авторизация
        if (verificationCode) {
            console.log(`[Debug] [${login}] Завершаем вход по коду...`);
            browserData = await completeLoginFlow(login, verificationCode);
        } else {
            console.log(`[Debug] [${login}] Запускаем стандартный вход...`);
            const result: any = await startLoginFlow(login, password, proxy);
            if (result.needsVerification) {
                console.log(`[Debug] [${login}] Требуется 2FA код`);
                return res.status(202).json(result);
            }
            browserData = result;
        }

        const { page, browser } = browserData;

        // 2. Переход к списку диалогов
        console.log(`[Debug] [${login}] Переход к списку диалогов...`);
        await page.goto('https://my.drom.ru/personal/messaging-modal?switchPosition=dialogs', { 
            waitUntil: 'networkidle2', 
            timeout: 60000 
        });

        // Скриншот списка диалогов
        const listImgName = `list_${login}_${timestamp}.png`;
        await page.screenshot({ path: path.join(DEBUG_DIR, listImgName), fullPage: true });
        console.log(`[Debug] [${login}] Скриншот списка сохранен: ${makeDebugUrl(listImgName)}`);

        // 3. Ожидание списка
        try {
            await page.waitForSelector('.dialog-list__li', { timeout: 15000 });
            console.log(`[Debug] [${login}] Селектор .dialog-list__li найден`);
        } catch (e) {
            console.log(`[Debug] [${login}] Диалогов не найдено или страница не прогрузилась`);
            const emptyImgName = `empty_${login}_${timestamp}.png`;
            await page.screenshot({ path: path.join(DEBUG_DIR, emptyImgName) });
            await saveStateAndClose(login, browser, page);
            return res.json({ 
                success: true, 
                count: 0, 
                dialogs: [], 
                debug_screenshot: makeDebugUrl(emptyImgName) 
            });
        }

        // 4. Парсинг ID диалогов
        const dialogsList = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.dialog-list__li'))
                .map(el => {
                    const href = el.querySelector('a[href*="/messaging/view"]')?.getAttribute('href');
                    const match = href?.match(/dialogId=([^&]+)/);
                    return match ? { dialogId: match[1] } : null;
                })
                .filter(Boolean);
        });

        console.log(`[Debug] [${login}] Найдено ID диалогов: ${dialogsList.length}`);

        const limit = Math.min(dialogsList.length, 10);
        const detailedDialogs = [];

        // 5. Цикл по деталям диалогов
        for (let i = 0; i < limit; i++) {
            const dItem: any = dialogsList[i];
            try {
                console.log(`[Debug] [${login}] Парсим диалог ${dItem.dialogId} (${i + 1}/${limit})...`);
                await page.goto(`https://my.drom.ru/personal/messaging/view?dialogId=${dItem.dialogId}`, { 
                    waitUntil: 'networkidle2',
                    timeout: 30000 
                });
                
                await page.waitForSelector('.bzr-dialog__inner', { timeout: 10000 });

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
                        if (msg.classList.contains('bzr-dialog__message_out')) break;
                        
                        if (msg.classList.contains('bzr-dialog__message_in')) {
                            const text = msg.querySelector('.bzr-dialog__text')?.textContent?.trim() || '';
                            if (text) buffer.unshift(text);
                            if (!lastTime) {
                                lastTime = msg.querySelector('.bzr-dialog__message-dt')?.textContent?.trim() || '';
                            }
                        }
                    }

                    return {
                        carTitle,
                        carUrl,
                        lastIncomingText: buffer.join('\n'),
                        lastIncomingTime: lastTime
                    };
                });

                if (details.lastIncomingText) {
                    detailedDialogs.push({ dialogId: dItem.dialogId, ...details });
                }

                // Небольшая задержка между диалогами
                await new Promise(r => setTimeout(r, 1000));

            } catch (e: any) {
                console.error(`[Error] Ошибка парсинга диалога ${dItem.dialogId}:`, e.message);
            }
        }

        console.log(`[Debug] [${login}] Сбор завершен. Успешно: ${detailedDialogs.length}`);
        await saveStateAndClose(login, browser, page);
        
        res.json({ 
            success: true, 
            count: detailedDialogs.length, 
            dialogs: detailedDialogs,
            debug_screenshot: makeDebugUrl(listImgName)
        });

    } catch (err: any) {
        console.error('[CRITICAL ERROR]:', err.message);
        const errImgName = `critical_err_${login}_${timestamp}.png`;
        if (browserData?.page) {
            await browserData.page.screenshot({ path: path.join(DEBUG_DIR, errImgName) }).catch(() => {});
        }
        if (browserData?.browser) await browserData.browser.close().catch(() => {});
        
        res.status(500).json({ 
            success: false, 
            error: err.message, 
            debug_screenshot: makeDebugUrl(errImgName) 
        });
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
