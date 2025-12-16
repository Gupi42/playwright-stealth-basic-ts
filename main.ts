import express, { Request, Response } from 'express';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config'; // Для локальной разработки

// 1. Активируем скрытность
chromium.use(StealthPlugin());

const app = express();
app.use(express.json());

// === 🛡️ ЗАЩИТА (MIDDLEWARE) ===
app.use((req, res, next) => {
    // 1. Разрешаем доступ к /health без пароля (чтобы Railway знал, что мы живы)
    if (req.path === '/health') return next();

    // 2. Получаем ключ из заголовков запроса
    const clientKey = req.headers['x-api-key'];
    const serverKey = process.env.API_SECRET;

    // 3. Если ключ на сервере не настроен — паникуем (для безопасности)
    if (!serverKey) {
        console.error('⛔ ОШИБКА: Переменная API_SECRET не задана в Railway!');
        return res.status(500).json({ error: 'Server security configuration missing' });
    }

    // 4. Сравниваем ключи
    if (clientKey !== serverKey) {
        console.log(`⛔ Несанкционированный доступ с IP: ${req.ip}`);
        return res.status(403).json({ error: 'Access denied: Invalid API Key' });
    }

    // 5. Если всё ок — пропускаем дальше
    next();
});

// --- КОНФИГУРАЦИЯ ДЛЯ RAILWAY ---
// В Railway нужно создать Volume и примонтировать его, например, в /app/data
// Если мы локально, используем папку data в проекте
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const DEBUG_DIR = path.join(DATA_DIR, 'debug');

// Создаем папки при старте
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

// --- ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ (Proxy) ---
// Формат PROXY_URL: http://user:pass@ip:port
const PROXY_URL = process.env.PROXY_URL; 

// --- ХЕЛПЕРЫ ---

function getSessionPath(login: string): string {
    const sanitized = login.replace(/[^a-zA-Z0-9]/g, '_');
    return path.join(SESSIONS_DIR, `state_${sanitized}.json`);
}

// Хранилище для ожидающих 2FA процессов
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

// Функция "человеческого" клика
async function humanClick(page: any, selector: string) {
    const el = page.locator(selector).first();
    if (await el.isVisible()) {
        const box = await el.boundingBox();
        if (box) {
            // Двигаем мышь с небольшой случайностью
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

async function getBrowserInstance() {
    const launchOptions: any = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Важно для Docker/Railway (память)
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled' // Скрытие автоматизации
        ]
    };

    if (PROXY_URL) {
        console.log('🌐 Используем прокси');
        launchOptions.proxy = { server: PROXY_URL };
    }

    return await chromium.launch(launchOptions);
}

async function startLoginFlow(login: string, password: string) {
    cleanupFlow(login);

    const browser = await getBrowserInstance();

    // Настраиваем контекст (User Agent, Locale, Timezone)
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 }, // Стандартный экран ноутбука
        locale: 'ru-RU',
        timezoneId: 'Asia/Yekaterinburg',
        ignoreHTTPSErrors: true
    });

    const page = await context.newPage();

    // ⚡ ОПТИМИЗАЦИЯ: Блокируем картинки, шрифты и медиа
    await page.route('**/*', (route: any) => {
        const type = route.request().resourceType();
        if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
            return route.abort();
        }
        return route.continue();
    });

    // 1. Попытка восстановить сессию (Cookies + LocalStorage)
    const sessionPath = getSessionPath(login);
    if (fs.existsSync(sessionPath)) {
        try {
            // Загружаем состояние хранилища
            const state = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
            // Проверка "свежести" файла (например, не старше 30 дней)
            const stats = fs.statSync(sessionPath);
            if (Date.now() - stats.mtimeMs < 30 * 24 * 60 * 60 * 1000) {
                 await context.addCookies(state.cookies);
                 // LocalStorage восстанавливается через initScript
                 await page.addInitScript((storage: any) => {
                    if (window.location.hostname.includes('drom.ru')) {
                        storage.forEach((item: any) => localStorage.setItem(item.name, item.value));
                    }
                 }, state.origins?.[0]?.localStorage || []);

                 console.log(`🔄 Пробуем восстановить сессию для ${login}...`);
                 await page.goto('https://my.drom.ru/personal/', { waitUntil: 'domcontentloaded' });
                 
                 // Проверка авторизации
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
    await page.goto('https://my.drom.ru/sign', { waitUntil: 'domcontentloaded' });

    const loginInput = page.locator('input[name="sign"]');
    await loginInput.waitFor({ state: 'visible', timeout: 10000 });
    await loginInput.fill(login);
    await page.waitForTimeout(300);
    
    await page.locator('input[type="password"]').fill(password);
    await page.waitForTimeout(500);
    
    // Клик "Войти"
    await humanClick(page, 'button:has-text("Войти с паролем")');
    
    // Ждем реакции сайта
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
            timer: setTimeout(() => cleanupFlow(login), 300 * 1000) // 5 мин ожидание
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
        // Сохраняем полный state (Cookies + LocalStorage)
        const storageState = await context.storageState({ path: getSessionPath(login) });
        console.log(`💾 Сессия сохранена для ${login}`);
    } catch (e) {
        console.error('Ошибка сохранения сессии:', e);
    }
    await browser.close().catch(() => {});
}

// --- РОУТЫ ---

app.post('/drom/get-messages', async (req: Request, res: Response) => {
    const { login, password, verificationCode } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Login/password required' });

    let browserData;
    try {
        if (verificationCode) {
            browserData = await completeLoginFlow(login, verificationCode);
        } else {
            const result: any = await startLoginFlow(login, password);
            if (result.needsVerification) return res.status(202).json(result);
            browserData = result;
        }

        const { page, context, browser } = browserData;

        // 1. Идем к списку диалогов
        console.log('💬 Загрузка списка диалогов...');
        // Используем goto, так как начальная точка
        await page.goto('https://my.drom.ru/personal/messaging-modal?switchPosition=dialogs', { waitUntil: 'domcontentloaded' });
        
        try {
            await page.waitForSelector('.dialog-list__li', { timeout: 6000 });
        } catch {
            console.log('Диалогов нет');
            await saveStateAndClose(login, browser, context);
            return res.json({ success: true, count: 0, dialogs: [] });
        }

        // 2. Получаем список ID (быстро)
        const dialogsList = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.dialog-list__li'))
                .map(el => {
                    const href = el.querySelector('a[href*="/messaging/view"]')?.getAttribute('href');
                    const match = href?.match(/dialogId=([^&]+)/);
                    return match ? { dialogId: match[1] } : null;
                })
                .filter(Boolean);
        });

        // 3. Обработка деталей (Лимит 10, чтобы не палиться)
        const limit = Math.min(dialogsList.length, 10);
        console.log(`📋 Обработка ${limit} диалогов...`);
        
        const detailedDialogs = [];

        for (let i = 0; i < limit; i++) {
            const dItem: any = dialogsList[i];
            try {
                // ПОПЫТКА КЛИКА (Human Behavior)
                const linkSelector = `a[href*="dialogId=${dItem.dialogId}"]`;
                const clicked = await humanClick(page, linkSelector);

                if (!clicked) {
                    // Если клик не прошел (элемента нет), переходим прямо
                    await page.goto(`https://my.drom.ru/personal/messaging/view?dialogId=${dItem.dialogId}`, { waitUntil: 'domcontentloaded' });
                }

                // Ждем контент
                await page.waitForSelector('.bzr-dialog__inner', { timeout: 5000 }).catch(() => {});

                // Парсинг
                const details = await page.evaluate(() => {
                    const carLink = document.querySelector('.bzr-dialog-header__sub-title a');
                    const carTitle = carLink?.textContent?.trim() || '';
                    let carUrl = carLink?.getAttribute('href') || '';
                    if (carUrl && carUrl.startsWith('//')) carUrl = 'https:' + carUrl;

                    // Последнее ВХОДЯЩЕЕ сообщение
                    const incoming = Array.from(document.querySelectorAll('.bzr-dialog__message_in')).pop();
                    
                    return {
                        carTitle,
                        carUrl,
                        lastIncomingText: incoming?.querySelector('.bzr-dialog__text')?.textContent?.trim() || '',
                        lastIncomingTime: incoming?.querySelector('.bzr-dialog__message-dt')?.textContent?.trim() || ''
                    };
                });

                detailedDialogs.push({ dialogId: dItem.dialogId, ...details });

                // Возвращаемся назад, если кликали (чтобы сохранить состояние списка)
                if (clicked) {
                    await page.goBack();
                    // Рандомная пауза "на чтение заголовков"
                    await page.waitForTimeout(Math.random() * 1500 + 500);
                } else {
                    // Если переходили через URL, можно сразу следующий URL, но лучше паузу
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

app.post('/drom/send-message', async (req: Request, res: Response) => {
    const { login, password, dialogId, message } = req.body;
    if (!login || !password || !dialogId || !message) return res.status(400).json({ error: 'Data missing' });

    let browserData;
    try {
        // Логинимся
        const result: any = await startLoginFlow(login, password);
        if (result.needsVerification) return res.status(202).json(result);
        browserData = result;
        const { page, context, browser } = browserData;

        console.log(`📤 Отправка в диалог ${dialogId}...`);
        await page.goto(`https://my.drom.ru/personal/messaging/view?dialogId=${dialogId}`, { waitUntil: 'domcontentloaded' });

        const textArea = page.locator('textarea[name="message"]');
        await textArea.waitFor({ state: 'visible', timeout: 10000 });
        
        // Имитация печати
        await textArea.focus();
        await page.keyboard.type(message, { delay: 100 }); // Печатаем с задержкой 100мс

        await page.waitForTimeout(500);
        
        // Клик отправить
        await humanClick(page, 'button[name="post"], button[data-action="submit-message"]');
        
        // Ждем подтверждения (например, исчезновения текста или перезагрузки)
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
// --- РОУТ 3: ПОЛУЧЕНИЕ ИЗБРАННОГО (ТОП-10) ---

app.post('/drom/get-bookmarks', async (req: Request, res: Response) => {
    const { login, password, verificationCode, proxy } = req.body;
    
    // Передаем прокси в функцию логина (если вы добавили поддержку прокси в startLoginFlow, как обсуждали ранее)
    // Если нет, просто удалите аргумент proxy
    if (!login || !password) return res.status(400).json({ error: 'Login/pass required' });

    let browserData;

    try {
        // 1. Логика входа (используем существующие функции)
        if (verificationCode) {
            browserData = await completeLoginFlow(login, verificationCode);
        } else {
            // Важно: убедитесь, что startLoginFlow поддерживает прокси, если вы это внедрили
            const result: any = await startLoginFlow(login, password); 
            
            if (result.needsVerification) {
                return res.status(202).json(result);
            }
            browserData = result;
        }

        const { page, context, browser } = browserData;

        console.log('⭐ Переход в избранное...');
        
        // 2. Переход на страницу закладок
        await page.goto('https://my.drom.ru/personal/bookmark', { waitUntil: 'domcontentloaded' });

        // 3. Ждем появления объявлений (или сообщения что пусто)
        try {
            await page.waitForSelector('.bull-item', { timeout: 8000 });
        } catch (e) {
            console.log('Избранное пусто или не загрузилось');
            await saveStateAndClose(login, browser, context);
            return res.json({ success: true, count: 0, bookmarks: [] });
        }

        // 4. Парсинг данных (Top 10)
        const bookmarks = await page.evaluate(() => {
            // Находим все карточки объявлений
            const items = Array.from(document.querySelectorAll('.bull-item'));
            
            // Берем только первые 10
            return items.slice(0, 10).map(el => {
                // Вспомогательная функция для безопасного получения текста
                const getText = (selector: string) => {
                    const node = el.querySelector(selector);
                    return node ? node.textContent?.trim().replace(/\s+/g, ' ') : '';
                };

                // Получение ссылки и заголовка
                const linkNode = el.querySelector('a.bulletinLink');
                const title = linkNode ? linkNode.textContent?.trim() : '';
                const href = linkNode ? linkNode.getAttribute('href') : '';
                const url = href ? (href.startsWith('//') ? 'https:' + href : href) : '';

                // ID объявления
                const id = el.getAttribute('data-bulletin-id') || '';

                // Цена (чистим от символов валюты и пробелов)
                const priceRaw = getText('.price-block__price'); // "850 000 ₽"
                const price = priceRaw ? priceRaw.replace(/[^\d]/g, '') : '';

                // Город
                const city = getText('.bull-delivery__city');

                // Описание (год, двигатель, пробег и т.д.)
                const specs = getText('.bull-item__annotation-row');

                // Дата добавления/обновления
                const date = getText('.date');

                return {
                    id,
                    title,
                    url,
                    price: parseInt(price) || 0,
                    city,
                    specs,
                    date
                };
            });
        });

        console.log(`✅ Собрано ${bookmarks.length} объявлений из избранного`);

        // 5. Сохраняем сессию и закрываем
        await saveStateAndClose(login, browser, context);
        
        res.json({ 
            success: true, 
            count: bookmarks.length, 
            bookmarks 
        });

    } catch (error: any) {
        console.error('❌ Ошибка при сборе избранного:', error.message);
        if (browserData?.browser) await browserData.browser.close().catch(() => {});
        res.status(500).json({ success: false, error: error.message });
    }
});
app.get('/health', (_, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
