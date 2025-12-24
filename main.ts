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
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
async function humanDelay(min: number = 1000, max: number = 3000) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise(r => setTimeout(r, delay));
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
        await page.waitForFunction(() => window.location.href.includes('/personal'), { timeout: 30000 });

        console.log('🎉 Успешный вход!');
        clearTimeout(flow.timer);
        activeFlows.delete(login);

        return { success: true, browser: flow.browser, page: flow.page };

    } catch (error) {
        await page.screenshot({ path: path.join(DEBUG_DIR, `error_code_${Date.now()}.png`) });
        throw new Error('Неверный код или ошибка сайта');
    }
}
// ===== ВЫНЕСИТЕ ЭТУ ФУНКЦИЮ ЗА ПРЕДЕЛЫ startLoginFlow =====
// Разместите её ПЕРЕД функцией startLoginFlow на уровне модуля
async function takeDebugScreenshot(page: any, login: string, step: string) {
    try {
        const timestamp = Date.now();
        const sanitizedLogin = login.replace(/[^a-zA-Z0-9]/g, '_');
        const filename = `${sanitizedLogin}_${step}_${timestamp}.png`;
        const filepath = path.join(DEBUG_DIR, filename);

        await page.screenshot({ 
            path: filepath, 
            fullPage: true 
        });

        console.log(`📸 Скриншот сохранен: ${filename}`);
        return filename;
    } catch (e) {
        console.error(`⚠️ Ошибка создания скриншота на этапе ${step}:`, e);
        return null;
    }
}

async function loadPageWithRetry(page: any, url: string, options: any = {}, maxRetries: number = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`🔄 Попытка ${attempt}/${maxRetries} загрузить ${url}`);

            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
                ...options
            });

            console.log(`✅ Страница загружена с попытки ${attempt}`);
            return; // Успех

        } catch (error: any) {
            console.error(`❌ Попытка ${attempt} не удалась:`, error.message);

            if (attempt === maxRetries) {
                throw error; // Исчерпаны попытки
            }

            const delay = attempt * 3000;
            console.log(`⏳ Ожидание ${delay/1000} секунд перед повтором...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// ===== ANTICAPTCHA INTEGRATION =====

const anticaptcha = require("@antiadmin/anticaptchaofficial");

// Настройка AntiCaptcha (вызовите один раз при старте)
if (process.env.ANTICAPTCHA_API_KEY) {
    anticaptcha.setAPIKey(process.env.ANTICAPTCHA_API_KEY);
    console.log('✅ AntiCaptcha API key configured');
} else {
    console.warn('⚠️ ANTICAPTCHA_API_KEY not set in environment variables');
}

async function solveRecaptchaV2(pageUrl: string, sitekey: string): Promise<string> {
    console.log('🤖 Отправляем reCAPTCHA v2 на решение через AntiCaptcha...');
    console.log(`📍 URL: ${pageUrl}`);
    console.log(`🔑 Sitekey: ${sitekey}`);

    try {
        const gresponse = await anticaptcha.solveRecaptchaV2Proxyless(pageUrl, sitekey);

        console.log('✅ reCAPTCHA решена!');
        console.log(`🎫 g-response: ${gresponse.substring(0, 50)}...`);

        // Получаем cookies от AntiCaptcha (если есть)
        const cookies = anticaptcha.getCookies();
        if (cookies && cookies.length > 0) {
            console.log('🍪 Получены cookies от AntiCaptcha');
        }

        return gresponse;

    } catch (error: any) {
        console.error('❌ Ошибка решения reCAPTCHA:', error);
        throw new Error(`AntiCaptcha failed: ${error}`);
    }
}

async function setupAntiDetection(page: any) {
    await page.evaluateOnNewDocument(() => {
        // 1. Удаляем webdriver
        Object.defineProperty(navigator, 'webdriver', {
            get: () => false,
        });

        // 2. Переопределяем permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters: any) => (
            parameters.name === 'notifications' ?
                Promise.resolve({ state: Notification.permission } as PermissionStatus) :
                originalQuery(parameters)
        );

        // 3. Chrome object
        (window as any).chrome = {
            runtime: {},
            loadTimes: function() {},
            csi: function() {},
            app: {}
        };

        // 4. Plugins
        Object.defineProperty(navigator, 'plugins', {
            get: () => [
                {
                    0: { type: "application/x-google-chrome-pdf" },
                    description: "Portable Document Format",
                    filename: "internal-pdf-viewer",
                    length: 1,
                    name: "Chrome PDF Plugin"
                }
            ],
        });

        // 5. Languages
        Object.defineProperty(navigator, 'languages', {
            get: () => ['ru-RU', 'ru', 'en-US', 'en'],
        });

        // 6. Скрываем automation tokens
        delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Array;
        delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Promise;
        delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Symbol;

        // 7. Vendor
        Object.defineProperty(navigator, 'vendor', {
            get: () => 'Google Inc.',
        });
    });
}

// ===== MAIN LOGIN FLOW WITH ANTICAPTCHA =====

async function startLoginFlow(login: string, password: string, proxyUrl?: string) {
    await cleanupFlow(login);

    let proxyConfig = null;
    let proxyServerArg = undefined;

    const proxyToUse = proxyUrl || GLOBAL_PROXY_URL;
    if (proxyToUse) {
        proxyConfig = parseProxy(proxyToUse);
        if (proxyConfig) {
            proxyServerArg = proxyConfig.server;
            console.log(`🌐 Прокси: ${proxyServerArg}`);
        }
    }

    const browser = await getBrowserInstance(proxyServerArg);
    const page = await browser.newPage();

    // Применяем anti-detection
    await setupAntiDetection(page);

    // Авторизация на прокси
    if (proxyConfig && proxyConfig.username && proxyConfig.password) {
        console.log('🔑 Авторизация на прокси...');
        await page.authenticate({
            username: proxyConfig.username,
            password: proxyConfig.password
        });
    }

    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

    // Очистка данных перед входом (CDP Session для чистоты аккаунтов)
    const client = await page.target().createCDPSession();
    await client.send('Network.clearBrowserCookies');
    await client.send('Network.clearBrowserCache');

    await takeDebugScreenshot(page, login, '01_initialized');

    // 1. Попытка восстановить сессию
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

            console.log(`🔄 Пробуем восстановить сессию для ${login}...`);
            try {
                await loadPageWithRetry(page, 'https://my.drom.ru/personal/');
                if (!page.url().includes('sign')) {
                    console.log('✅ Сессия восстановлена');
                    return { success: true, browser, page };
                }
            } catch (e) { console.log('⚠️ Сессия не подошла'); }
        } catch (e) { console.error('Ошибка чтения сессии', e); }
    }

    // 2. Вход с паролем + reCAPTCHA
    console.log('🔐 Переход на страницу логина...');
    try {
        await loadPageWithRetry(page, 'https://my.drom.ru/sign');
        await delay(5000); // Ждем подгрузку капчи

        const recaptchaFrame = await page.$('iframe[src*="recaptcha/api2"]');
        if (recaptchaFrame) {
            console.log('🔒 Обнаружена reCAPTCHA v2. Решаем...');
            const sitekey = await page.evaluate(() => {
                const iframe = document.querySelector('iframe[src*="recaptcha/api2"]') as HTMLIFrameElement;
                return iframe?.getAttribute('src')?.match(/[?&]k=([^&]+)/)?.[1];
            });

            if (sitekey && process.env.ANTICAPTCHA_API_KEY) {
                const gresponse = await solveRecaptchaV2(page.url(), sitekey);
                await page.evaluate((token: string) => {
                    const ta = document.querySelector('textarea[name="g-recaptcha-response"]') as any;
                    if (ta) { ta.innerHTML = token; ta.value = token; }
                    // Пытаемся вызвать callback если он есть
                    if ((window as any).grecaptcha) {
                        const cfg = (window as any).___grecaptcha_cfg?.clients?.[0];
                        if (cfg?.callback) cfg.callback(token);
                    }
                }, gresponse);
                console.log('✅ Капча решена');
                await delay(2000);
            }
        }

        // Ввод данных
        await page.waitForSelector('input[name="sign"]', { visible: true, timeout: 15000 });
        await page.type('input[name="sign"]', login, { delay: 100 });
        await page.type('input[type="password"]', password, { delay: 100 });

        console.log('🔘 Нажимаем кнопку входа...');
        const [submitBtn] = await page.$$("xpath/.//button[contains(., 'Войти')] | //input[@id='signbutton']");
        
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
            submitBtn ? submitBtn.click() : page.keyboard.press('Enter')
        ]);

        await takeDebugScreenshot(page, login, '07_after_login_click');

    } catch (e: any) {
        console.error('❌ Ошибка на этапе логина:', e.message);
        await browser.close();
        throw e;
    }

    // 3. Обработка 2FA (УЛУЧШЕННАЯ)
    await delay(4000);
    console.log(`📍 Текущий URL: ${page.url()}`);
    
    // --- ДЕБАГ ТАБЛИЦА ---
    const elements = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button, a, div[role="button"], input[type="button"]'))
            .map(el => ({
                tag: el.tagName,
                text: el.textContent?.trim() || (el as HTMLInputElement).value || '',
                visible: (el as HTMLElement).offsetWidth > 0
            })).filter(el => el.text.length > 2);
    });
    console.log('🔍 Элементы на странице 2FA:');
    console.table(elements);

    // Проверка, появилось ли поле сразу
    let codeInput = await page.$('input[name="code"]');

    if (!codeInput) {
        console.log('📱 Поле кода не найдено. Пробуем активировать кнопки...');

        const clickResult = await page.evaluate(() => {
            const targets = ['получить смс-код', 'отправить код', 'код на телефон', 'sms'];
            const buttons = Array.from(document.querySelectorAll('button, a, div, input'));
            const found = buttons.find(el => {
                const content = (el.textContent || (el as HTMLInputElement).value || '').toLowerCase();
                return targets.some(t => content.includes(t)) && (el as HTMLElement).offsetWidth > 0;
            });
            if (found) {
                (found as HTMLElement).click();
                return found.textContent?.trim() || (found as HTMLInputElement).value;
            }
            return null;
        });

        if (clickResult) {
            console.log(`🔘 Нажато: "${clickResult}". Ожидаем поле кода...`);
            await page.waitForSelector('input[name="code"]', { timeout: 15000 }).catch(() => {});
        }
    }

    await delay(2000);
    codeInput = await page.$('input[name="code"]');

    if (codeInput) {
        console.log('✅ Поле ввода кода появилось!');
        await takeDebugScreenshot(page, login, '09_ready_for_code');
        activeFlows.set(login, {
            browser, page, timestamp: Date.now(),
            timer: setTimeout(() => cleanupFlow(login), 300 * 1000)
        });
        return { success: false, needsVerification: true, message: 'Введите код из СМС' };
    }

    // Если зашли в личный кабинет напрямую
    if (page.url().includes('/personal')) {
        console.log('🎉 Вход выполнен (2FA пропущено)');
        return { success: true, browser, page };
    }

    // Проверка ошибок блокировки
    const errorText = await page.evaluate(() => document.body.innerText);
    if (errorText.includes('попробуйте позже') || errorText.includes('много попыток')) {
        throw new Error('Drom заблокировал отправку СМС (лимит попыток).');
    }

    await takeDebugScreenshot(page, login, '10_failed');
    throw new Error('Не удалось дойти до этапа ввода СМС. См. лог таблицы элементов.');
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
async function getBrowserInstance(proxyServer?: string) {
    const launchOptions: any = {
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--window-size=1366,768',
            '--disable-blink-features=AutomationControlled',  // 🆕 КРИТИЧЕСКИ ВАЖНО!
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-web-security',
        ],
        ignoreHTTPSErrors: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
    };

    if (proxyServer) {
        launchOptions.args.push(`--proxy-server=${proxyServer}`);
    }

    return await puppeteer.launch(launchOptions);
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
        await setupAntiDetection(page);
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
// 1. ПОЛУЧЕНИЕ СООБЩЕНИЙ
app.post('/drom/get-messages', async (req: Request, res: Response) => {
    const { login, password, verificationCode, proxy } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Login/password required' });

    let browserData;
    try {
        // Вход или завершение 2FA
        if (verificationCode) {
            browserData = await completeLoginFlow(login, verificationCode);
        } else {
            const result: any = await startLoginFlow(login, password, proxy);
            if (result.needsVerification) return res.status(202).json(result);
            browserData = result;
        }

        const { page, browser } = browserData;
        console.log('💬 Загрузка списка диалогов...');

        // Переход на страницу диалогов с более надежным ожиданием
        await page.goto('https://my.drom.ru/personal/messaging-modal?switchPosition=dialogs', { 
            waitUntil: 'networkidle0',  // Ждем полной загрузки без активных запросов
            timeout: 60000 
        });

        // Ждем стабилизации страницы
        await new Promise(r => setTimeout(r, 3000));

        // Проверяем, не произошел ли редирект на страницу входа
        const currentUrl = page.url();
        console.log(`📍 Текущий URL: ${currentUrl}`);

        if (currentUrl.includes('/sign')) {
            console.log('⚠️ Сессия истекла, требуется повторный вход');
            await takeDebugScreenshot(page, login, 'session_expired_dialogs');
            await browser.close();
            return res.status(401).json({ 
                success: false, 
                error: 'Session expired, please login again' 
            });
        }

        // Ждем появления списка диалогов
        try {
            await page.waitForSelector('.dialog-list__li', { timeout: 10000 });
            console.log('✅ Список диалогов загружен');
        } catch {
            console.log('📭 Диалогов нет');
            await takeDebugScreenshot(page, login, 'no_dialogs');
            await saveStateAndClose(login, browser, page);
            return res.json({ success: true, count: 0, dialogs: [] });
        }

        // Извлекаем список dialogId с защитой от ошибок context
        let dialogsList;
        try {
            dialogsList = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.dialog-list__li'))
                    .map(el => {
                        const href = el.querySelector('a[href*="/messaging/view"]')?.getAttribute('href');
                        const match = href?.match(/dialogId=([^&]+)/);
                        return match ? { dialogId: match[1] } : null;
                    })
                    .filter(Boolean);
            });
            console.log(`📋 Найдено диалогов: ${dialogsList.length}`);
        } catch (e: any) {
            console.error('❌ Ошибка при извлечении списка диалогов:', e.message);
            await takeDebugScreenshot(page, login, 'error_extract_dialogs');
            await browser.close();
            return res.status(500).json({ 
                success: false, 
                error: 'Failed to extract dialog list: ' + e.message 
            });
        }

        if (!dialogsList || dialogsList.length === 0) {
            console.log('📭 Список диалогов пуст');
            await saveStateAndClose(login, browser, page);
            return res.json({ success: true, count: 0, dialogs: [] });
        }

        const limit = Math.min(dialogsList.length, 10);
        console.log(`📋 Обработка ${limit} из ${dialogsList.length} диалогов...`);
        const detailedDialogs = [];

        // Обрабатываем каждый диалог
        for (let i = 0; i < limit; i++) {
            const dItem: any = dialogsList[i];

            try {
                console.log(`🔄 Обработка диалога ${i + 1}/${limit} (ID: ${dItem.dialogId})...`);

                // Переход на страницу конкретного диалога
                await page.goto(`https://my.drom.ru/personal/messaging/view?dialogId=${dItem.dialogId}`, { 
                    waitUntil: 'networkidle0',
                    timeout: 30000 
                });

                // Небольшая задержка для стабилизации
                await new Promise(r => setTimeout(r, 1500));

                // Проверяем редирект
                if (page.url().includes('/sign')) {
                    console.log('⚠️ Сессия истекла во время обработки диалога');
                    break;
                }

                // Ждем загрузки контента диалога
                try {
                    await page.waitForSelector('.bzr-dialog__inner', { timeout: 8000 });
                } catch(e) { 
                    console.log(`⚠️ Диалог ${dItem.dialogId} не загрузился, пропускаем`);
                    continue; 
                }

                // Извлекаем детали диалога с защитой
                let details;
                try {
                    details = await page.evaluate(() => {
                        const carLink = document.querySelector('.bzr-dialog-header__sub-title a');
                        const carTitle = carLink?.textContent?.trim() || '';
                        let carUrl = carLink?.getAttribute('href') || '';
                        if (carUrl && carUrl.startsWith('//')) carUrl = 'https:' + carUrl;

                        const allMessages = Array.from(document.querySelectorAll('.bzr-dialog__message'));
                        const buffer: string[] = [];
                        let lastTime = '';

                        // Собираем последние входящие сообщения (до первого исходящего)
                        for (let j = allMessages.length - 1; j >= 0; j--) {
                            const msg = allMessages[j];

                            // Если встретили исходящее - останавливаемся
                            if (msg.classList.contains('bzr-dialog__message_out')) {
                                break;
                            }

                            // Собираем входящие
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
                } catch (e: any) {
                    console.error(`❌ Ошибка при извлечении данных диалога ${dItem.dialogId}:`, e.message);
                    if (e.message.includes('Execution context was destroyed')) {
                        console.log('⚠️ Context destroyed, возможно произошел редирект');
                        await takeDebugScreenshot(page, login, `dialog_${dItem.dialogId}_context_error`);
                        break; // Прерываем цикл
                    }
                    continue; // Пропускаем этот диалог
                }

                // Добавляем в результат только если есть текст
                if (details && details.lastIncomingText) {
                    detailedDialogs.push({ 
                        dialogId: dItem.dialogId, 
                        ...details 
                    });
                    console.log(`✅ Диалог ${dItem.dialogId} обработан`);
                } else {
                    console.log(`⚠️ Диалог ${dItem.dialogId} пуст, пропускаем`);
                }

                // Случайная задержка между диалогами (имитация человека)
                await new Promise(r => setTimeout(r, Math.random() * 1500 + 1000));

            } catch (e: any) {
                console.error(`❌ Критическая ошибка при обработке диалога ${dItem.dialogId}:`, e.message);
                await takeDebugScreenshot(page, login, `dialog_${dItem.dialogId}_critical_error`);
                // Продолжаем со следующим диалогом
                continue;
            }
        }

        console.log(`✅ Успешно собрано диалогов: ${detailedDialogs.length} из ${limit}`);

        // Сохраняем сессию и закрываем браузер
        await saveStateAndClose(login, browser, page);

        res.json({ 
            success: true, 
            count: detailedDialogs.length, 
            dialogs: detailedDialogs 
        });

    } catch (err: any) {
        console.error('🚨 CRITICAL ERROR в /drom/get-messages:', err.message);
        console.error('Stack:', err.stack);

        // Делаем скриншот при критической ошибке
        if (browserData?.page) {
            try {
                await takeDebugScreenshot(browserData.page, login, 'critical_error_get_messages');
            } catch {}
        }

        // Закрываем браузер
        if (browserData?.browser) {
            await browserData.browser.close().catch(() => {});
        }

        res.status(500).json({ 
            success: false, 
            error: err.message,
            details: 'Check server logs for full error details'
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
// Список всех скриншотов
app.get('/debug/screenshots', async (req: Request, res: Response) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.API_SECRET) {
        return res.status(403).json({ error: 'Access denied' });
    }

    try {
        const files = fs.readdirSync(DEBUG_DIR);
        const screenshots = files
            .filter(f => f.endsWith('.png'))
            .map(f => {
                const stats = fs.statSync(path.join(DEBUG_DIR, f));
                return {
                    filename: f,
                    size: stats.size,
                    created: stats.birthtime
                };
            })
            .sort((a, b) => b.created.getTime() - a.created.getTime());
        
        res.json({ screenshots });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// Скачать конкретный скриншот
app.get('/debug/screenshot/:filename', async (req: Request, res: Response) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.API_SECRET) {
        return res.status(403).json({ error: 'Access denied' });
    }

    try {
        const filename = req.params.filename;
        const filepath = path.join(DEBUG_DIR, filename);
        
        if (!fs.existsSync(filepath)) {
            return res.status(404).send('File not found');
        }
        
        res.sendFile(filepath);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on port ${PORT}`));
