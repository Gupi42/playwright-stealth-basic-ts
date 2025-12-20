import express, { Request, Response } from 'express';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config'; 

// 1. Активируем скрытность
// chromium.use(StealthPlugin());
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

// Глобальный прокси (резервный)
const GLOBAL_PROXY_URL = process.env.PROXY_URL; 

// --- ХЕЛПЕРЫ ---

function getSessionPath(login: string): string {
    const sanitized = login.replace(/[^a-zA-Z0-9]/g, '_');
    return path.join(SESSIONS_DIR, `state_${sanitized}.json`);
}

interface ActiveFlow {
    browser: any;
    context: any;
    page: any;
    timestamp: number;
    timer: NodeJS.Timeout;
}
const activeFlows: Map<string, ActiveFlow> = new Map();

function cleanupFlow(login: string) {
    const flow = activeFlows.get(login);
    if (flow) {
        console.log(`🧹 Очистка ресурсов для ${login}`);
        clearTimeout(flow.timer);
        flow.browser.close().catch(() => {});
        activeFlows.delete(login);
    }
}

async function humanClick(page: any, selector: string) {
    const el = page.locator(selector).first();
    if (await el.isVisible()) {
        const box = await el.boundingBox();
        if (box) {
            await page.mouse.move(
                box.x + box.width / 2 + (Math.random() - 0.5) * 10,
                box.y + box.height / 2 + (Math.random() - 0.5) * 10,
                { steps: 5 }
            );
            await page.waitForTimeout(Math.random() * 200 + 100);
            await el.click();
            return true;
        }
    }
    return false;
}

// --- ОСНОВНАЯ ЛОГИКА БРАУЗЕРА ---

// 🛠️ FIX: Добавили аргумент customProxy
async function getBrowserInstance(customProxy?: string) {
    const launchOptions: any = {
        headless: "new", // Используйте новый режим headless, он меньше палится
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            // УБРАЛ '--disable-blink-features=AutomationControlled' — доверьтесь плагину
        ],
        // Важно: игнорируем ошибки сертификатов для прокси
        ignoreHTTPSErrors: true 
    };

    // Приоритет: Прокси из запроса -> Прокси из ENV -> Без прокси
    const proxyToUse = customProxy || GLOBAL_PROXY_URL;

    if (proxyToUse) {
        console.log(`🌐 Используем прокси: ${proxyToUse.replace(/:[^:]*@/, ':***@')}`); // Логируем без пароля
        launchOptions.proxy = { server: proxyToUse };
    } else {
        console.warn('⚠️ ВНИМАНИЕ: Запуск без прокси! (Используется IP сервера)');
    }

    return await puppeteer.launch(launchOptions); 
}

// 🛠️ FIX: Добавили аргумент proxyUrl
async function startLoginFlow(login: string, password: string, proxyUrl?: string) {
    cleanupFlow(login);

    // Передаем прокси дальше
    const browser = await getBrowserInstance(proxyUrl);

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'ru-RU',
        timezoneId: 'Asia/Yekaterinburg',
        ignoreHTTPSErrors: true
    });

    const page = await context.newPage();

    await page.route('**/*', (route: any) => {
        const type = route.request().resourceType();
        if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
            return route.abort();
        }
        return route.continue();
    });

    // 1. Попытка восстановить сессию
    const sessionPath = getSessionPath(login);
    if (fs.existsSync(sessionPath)) {
        try {
            const state = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
            const stats = fs.statSync(sessionPath);
            if (Date.now() - stats.mtimeMs < 30 * 24 * 60 * 60 * 1000) {
                 await context.addCookies(state.cookies);
                 await page.addInitScript((storage: any) => {
                    if (window.location.hostname.includes('drom.ru')) {
                        storage.forEach((item: any) => localStorage.setItem(item.name, item.value));
                    }
                 }, state.origins?.[0]?.localStorage || []);

                 console.log(`🔄 Пробуем восстановить сессию для ${login}...`);
                 await page.goto('https://my.drom.ru/personal/', { waitUntil: 'domcontentloaded' });
                 
                 try {
                    await page.waitForURL(/personal/, { timeout: 3000 });
                    if (!page.url().includes('sign')) {
                        console.log('✅ Сессия восстановлена');
                        return { success: true, browser, context, page };
                    }
                 } catch(e) {}
                 console.log('⚠️ Сессия устарела, нужен ре-логин');
            }
        } catch (e) { console.error('Ошибка чтения сессии', e); }
    }

    // 2. Вход с паролем
    console.log('🔐 Входим по логину/паролю...');
    await page.goto('https://my.drom.ru/sign', { waitUntil: 'domcontentloaded',timeout: 60000 });

    const loginInput = page.locator('input[name="sign"]');
    await loginInput.waitFor({ state: 'visible', timeout: 10000 });
    await loginInput.fill(login);
    await page.waitForTimeout(300);
    
    await page.locator('input[type="password"]').fill(password);
    await page.waitForTimeout(500);
    
    await humanClick(page, 'button:has-text("Войти с паролем")');
    await page.waitForTimeout(3000);

    // 3. Проверка 2FA
    const currentUrl = page.url();
    const bodyText = await page.innerText('body');
    const isVerification = bodyText.includes('Подтверждение') || bodyText.includes('код') || currentUrl.includes('/sign');

    if (isVerification && !currentUrl.includes('/personal')) {
        console.log('📱 Drom запрашивает код подтверждения');
        
        const sendBtn = page.locator('text=Отправить код').first();
        if (await sendBtn.isVisible()) {
             await sendBtn.click();
             console.log('SMS запрошена');
        }

        activeFlows.set(login, {
            browser, context, page,
            timestamp: Date.now(),
            timer: setTimeout(() => cleanupFlow(login), 300 * 1000)
        });

        return { 
            success: false, 
            needsVerification: true, 
            message: 'Требуется код подтверждения. Отправьте его в следующем запросе.' 
        };
    }

    return { success: true, browser, context, page };
}

async function completeLoginFlow(login: string, code: string) {
    const flow = activeFlows.get(login);
    if (!flow) throw new Error('Сессия не найдена или истекла. Повторите запрос.');

    console.log(`✍️ Вводим код для ${login}...`);
    const { page } = flow;

    try {
        const codeInput = page.locator('input[name="code"]');
        await codeInput.waitFor({ state: 'visible', timeout: 5000 });
        await codeInput.fill(code);
        await page.waitForTimeout(Math.random() * 500 + 200);

        const confirmBtn = page.locator('button:has-text("Подтвердить"), button:has-text("Войти")').first();
        if (await confirmBtn.isVisible()) {
            await confirmBtn.click();
        } else {
            await page.keyboard.press('Enter');
        }

        await page.waitForURL(/\/personal/, { timeout: 15000 });
        console.log('🎉 Успешный вход!');

        clearTimeout(flow.timer);
        activeFlows.delete(login);
        
        return { success: true, browser: flow.browser, context: flow.context, page: flow.page };
    } catch (error) {
        await page.screenshot({ path: path.join(DEBUG_DIR, `error_code_${Date.now()}.png`) });
        throw new Error('Неверный код или ошибка сайта');
    }
}

async function saveStateAndClose(login: string, browser: any, context: any) {
    try {
        const storageState = await context.storageState({ path: getSessionPath(login) });
        console.log(`💾 Сессия сохранена для ${login}`);
    } catch (e) {
        console.error('Ошибка сохранения сессии:', e);
    }
    await browser.close().catch(() => {});
}

// --- РОУТЫ ---

// 1. ПОЛУЧЕНИЕ СООБЩЕНИЙ (С БУФЕРОМ)
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

        const { page, context, browser } = browserData;

        console.log('💬 Загрузка списка диалогов...');
        await page.goto('https://my.drom.ru/personal/messaging-modal?switchPosition=dialogs', { waitUntil: 'domcontentloaded' });
        
        try {
            await page.waitForSelector('.dialog-list__li', { timeout: 6000 });
        } catch {
            console.log('Диалогов нет');
            await saveStateAndClose(login, browser, context);
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
                const linkSelector = `a[href*="dialogId=${dItem.dialogId}"]`;
                const clicked = await humanClick(page, linkSelector);

                if (!clicked) {
                    await page.goto(`https://my.drom.ru/personal/messaging/view?dialogId=${dItem.dialogId}`, { waitUntil: 'domcontentloaded' });
                }

                await page.waitForSelector('.bzr-dialog__inner', { timeout: 5000 }).catch(() => {});

                // 🔥 ОБНОВЛЕННАЯ ЛОГИКА ПАРСИНГА (БУФЕР) 🔥
                const details = await page.evaluate(() => {
                    const carLink = document.querySelector('.bzr-dialog-header__sub-title a');
                    const carTitle = carLink?.textContent?.trim() || '';
                    let carUrl = carLink?.getAttribute('href') || '';
                    if (carUrl && carUrl.startsWith('//')) carUrl = 'https:' + carUrl;

                    // Находим ВСЕ сообщения в чате
                    const allMessages = Array.from(document.querySelectorAll('.bzr-dialog__message'));
                    
                    const buffer: string[] = [];
                    let lastTime = '';

                    // Идем с конца (от новых к старым)
                    for (let j = allMessages.length - 1; j >= 0; j--) {
                        const msg = allMessages[j];
                        
                        // Если встретили ИСХОДЯЩЕЕ (наше) сообщение — останавливаемся
                        if (msg.classList.contains('bzr-dialog__message_out')) {
                            break; 
                        }

                        // Если сообщение ВХОДЯЩЕЕ — добавляем в буфер
                        if (msg.classList.contains('bzr-dialog__message_in')) {
                            const text = msg.querySelector('.bzr-dialog__text')?.textContent?.trim() || '';
                            if (text) buffer.unshift(text); // Добавляем в начало массива, чтобы сохранить порядок
                            
                            // Запоминаем время самого последнего сообщения
                            if (!lastTime) {
                                lastTime = msg.querySelector('.bzr-dialog__message-dt')?.textContent?.trim() || '';
                            }
                        }
                    }

                    // Склеиваем сообщения через перенос строки
                    const combinedText = buffer.join('\n');

                    return {
                        carTitle,
                        carUrl,
                        lastIncomingText: combinedText, // Теперь тут "Привет\nОбмен?\nСсылка"
                        lastIncomingTime: lastTime
                    };
                });

                // Добавляем, только если есть текст от клиента (чтобы не парсить пустые/наши диалоги)
                if (details.lastIncomingText) {
                    detailedDialogs.push({ dialogId: dItem.dialogId, ...details });
                }

                if (clicked) {
                    await page.goBack();
                    await page.waitForTimeout(Math.random() * 1500 + 500);
                } else {
                    await page.waitForTimeout(Math.random() * 1000 + 200);
                }

            } catch (e) {
                console.error(`Error dialog ${dItem.dialogId}`, e);
            }
        }

        await saveStateAndClose(login, browser, context);
        res.json({ success: true, count: detailedDialogs.length, dialogs: detailedDialogs });

    } catch (err: any) {
        console.error('CRITICAL ERROR:', err.message);
        if (browserData?.browser) await browserData.browser.close().catch(() => {});
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. ОТПРАВКА СООБЩЕНИЯ (В ДИАЛОГ)
app.post('/drom/send-message', async (req: Request, res: Response) => {
    // 🛠️ FIX: Извлекаем proxy
    const { login, password, dialogId, message, proxy } = req.body;
    if (!login || !password || !dialogId || !message) return res.status(400).json({ error: 'Data missing' });

    let browserData;
    try {
        // 🛠️ FIX: Передаем proxy
        const result: any = await startLoginFlow(login, password, proxy);
        if (result.needsVerification) return res.status(202).json(result);
        browserData = result;
        const { page, context, browser } = browserData;

        console.log(`📤 Отправка в диалог ${dialogId}...`);
        await page.goto(`https://my.drom.ru/personal/messaging/view?dialogId=${dialogId}`, { waitUntil: 'domcontentloaded' });

        const textArea = page.locator('textarea[name="message"]');
        await textArea.waitFor({ state: 'visible', timeout: 10000 });
        
        await textArea.focus();
        await page.keyboard.type(message, { delay: 100 }); 

        await page.waitForTimeout(500);
        await humanClick(page, 'button[name="post"], button[data-action="submit-message"]');
        await page.waitForTimeout(2000);

        console.log('✅ Отправлено');
        await saveStateAndClose(login, browser, context);
        res.json({ success: true });

    } catch (err: any) {
        console.error('Send error:', err.message);
        if (browserData?.browser) await browserData.browser.close().catch(() => {});
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. ПОЛУЧЕНИЕ ИЗБРАННОГО
app.post('/drom/get-bookmarks', async (req: Request, res: Response) => {
    // 🛠️ FIX: Извлекаем proxy
    const { login, password, verificationCode, proxy } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Login/pass required' });

    let browserData;
    try {
        if (verificationCode) {
            browserData = await completeLoginFlow(login, verificationCode);
        } else {
            // 🛠️ FIX: Передаем proxy
            const result: any = await startLoginFlow(login, password, proxy); 
            if (result.needsVerification) return res.status(202).json(result);
            browserData = result;
        }

        const { page, context, browser } = browserData;

        console.log('⭐ Переход в избранное...');
        await page.goto('https://my.drom.ru/personal/bookmark', { waitUntil: 'domcontentloaded' });

        try {
            await page.waitForSelector('.bull-item', { timeout: 8000 });
        } catch (e) {
            console.log('Избранное пусто');
            await saveStateAndClose(login, browser, context);
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
        await saveStateAndClose(login, browser, context);
        res.json({ success: true, count: bookmarks.length, bookmarks });

    } catch (error: any) {
        console.error('Error bookmarks:', error.message);
        if (browserData?.browser) await browserData.browser.close().catch(() => {});
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. ПЕРВОЕ КАСАНИЕ (ОТПРАВКА ОФФЕРА)
app.post('/drom/send-offer', async (req: Request, res: Response) => {
    // 🛠️ FIX: Извлекаем proxy
    const { login, password, verificationCode, proxy, url, message } = req.body;

    if (!login || !password || !url || !message) {
        return res.status(400).json({ error: 'Login, password, url and message required' });
    }

    let browserData;
    try {
        if (verificationCode) {
            browserData = await completeLoginFlow(login, verificationCode);
        } else {
            // 🛠️ FIX: Передаем proxy
            const result: any = await startLoginFlow(login, password, proxy);
            if (result.needsVerification) return res.status(202).json(result);
            browserData = result;
        }

        const { page, context, browser } = browserData;

        console.log(`🚗 Переход к объявлению: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        const openModalBtnSelector = 'button[data-ga-stats-name="ask_question"]';
        try {
            await page.waitForSelector(openModalBtnSelector, { timeout: 10000 });
        } catch (e) {
            throw new Error('Кнопка "Написать" не найдена. Возможно, это ваше авто.');
        }

        console.log('💬 Открываем модалку...');
        await humanClick(page, openModalBtnSelector);

        const modalSelector = 'div[data-ftid="component_modal_content"]';
        await page.waitForSelector(modalSelector, { timeout: 5000 });

        const textareaSelector = `${modalSelector} textarea`;
        await page.locator(textareaSelector).waitFor({ state: 'visible' });
        
        await page.focus(textareaSelector);
        await page.keyboard.type(message, { delay: 100 });
        
        await page.waitForTimeout(Math.random() * 500 + 500);

        const sendBtnSelector = 'button[data-ga-stats-name="send_question"]';
        console.log('✉️ Отправляем...');
        await humanClick(page, sendBtnSelector);

        await page.waitForTimeout(3000);

        console.log('✅ Отправлено!');
        await saveStateAndClose(login, browser, context);
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
