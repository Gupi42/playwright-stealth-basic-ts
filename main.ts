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
    console.error('⛔ ОШИБКА: Переменная API_SECRET не задана!');
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
  page: any;
  browser: any;
  timestamp: number;
  timer: NodeJS.Timeout;
}

const activeFlows: Map<string, ActiveFlow> = new Map();

// ===== ФУНКЦИЯ ОЧИСТКИ АКТИВНОГО ПОТОКА =====
async function cleanupFlow(login: string) {
  const flow = activeFlows.get(login);
  if (flow) {
    console.log(`🧹 Очистка ресурсов для ${login}`);
    clearTimeout(flow.timer);
    try {
      if (flow.browser && flow.browser.isConnected()) {
        await flow.browser.close();
        console.log(`✅ Браузер для ${login} закрыт`);
      }
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

// УЛУЧШЕННАЯ ФУНКЦИЯ ЛОГАУТА
async function performLogout(page: any, login: string): Promise<void> {
  try {
    console.log(`🚪 Выполняется логаут для ${login}...`);
    await page.goto('https://my.drom.ru/logout?return=https%3A%2F%2Fauto.drom.ru%2Favtoline38%2F%3Ftcb%3D1766397803', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await new Promise(r => setTimeout(r, 2000));

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

// ===== ФУНКЦИЯ СОХРАНЕНИЯ И ЗАКРЫТИЯ БРАУЗЕРА =====
async function saveStateAndClose(login: string, page: any, browser: any) {
  try {
    if (!page.isClosed()) {
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
        login: login,
        timestamp: Date.now()
      };

      fs.writeFileSync(getSessionPath(login), JSON.stringify(state, null, 2));
      console.log(`💾 Сессия сохранена для ${login}`);
    }
  } catch (e) {
    console.error('Ошибка сохранения сессии:', e);
  }

  // Закрываем браузер полностью
  try {
    if (browser && browser.isConnected()) {
      await browser.close();
      console.log(`✅ Браузер закрыт для ${login}`);
    }
  } catch (e) {
    console.error('Ошибка закрытия браузера:', e);
  }
}

async function completeLoginFlow(login: string, code: string) {
  const flow = activeFlows.get(login);
  if (!flow) throw new Error('Сессия не найдена или истекла. Повторите запрос.');

  console.log(`✍️ Вводим код для ${login}...`);
  const { page, browser } = flow;

  try {
    const codeInputSelector = 'input[name="code"]';
    await page.waitForSelector(codeInputSelector, { visible: true, timeout: 5000 });
    await page.type(codeInputSelector, code, { delay: 100 });
    await new Promise(r => setTimeout(r, Math.random() * 500 + 200));

    const [confirmBtn] = await page.$$("xpath/.//button[contains(., 'Подтвердить') or contains(., 'Войти')]");
    if (confirmBtn) {
      await confirmBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForFunction(() => window.location.href.includes('/personal'), { timeout: 30000 });
    console.log('🎉 Успешный вход!');

    clearTimeout(flow.timer);
    activeFlows.delete(login);

    return { success: true, page, browser };
  } catch (error) {
    await page.screenshot({ path: path.join(DEBUG_DIR, `error_code_${Date.now()}.png`) }).catch(() => {});
    throw new Error('Неверный код или ошибка сайта');
  }
}

// ===== ФУНКЦИЯ СОЗДАНИЯ СКРИНШОТОВ =====
async function takeDebugScreenshot(page: any, login: string, step: string, forceScreenshot: boolean = false) {
  const importantSteps = ['error', 'critical', 'recaptcha', 'verification'];
  const shouldTakeScreenshot = forceScreenshot || importantSteps.some(s => step.toLowerCase().includes(s));

  if (!shouldTakeScreenshot) {
    return null;
  }

  try {
    const timestamp = Date.now();
    const sanitizedLogin = login.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `${sanitizedLogin}_${step}_${timestamp}.png`;
    const filepath = path.join(DEBUG_DIR, filename);

    await page.screenshot({
      path: filepath,
      fullPage: false
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
      return;
    } catch (error: any) {
      console.error(`❌ Попытка ${attempt} не удалась:`, error.message);
      if (attempt === maxRetries) {
        throw error;
      }
      const delay = attempt * 3000;
      console.log(`⏳ Ожидание ${delay/1000} секунд перед повтором...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ===== ANTICAPTCHA INTEGRATION =====
const anticaptcha = require("@antiadmin/anticaptchaofficial");

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
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });

    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters: any) => (
      parameters.name === 'notifications' ?
      Promise.resolve({ state: Notification.permission } as PermissionStatus) :
      originalQuery(parameters)
    );

    (window as any).chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {}
    };

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

    Object.defineProperty(navigator, 'languages', {
      get: () => ['ru-RU', 'ru', 'en-US', 'en'],
    });

    delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Array;
    delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Promise;
    delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Symbol;

    Object.defineProperty(navigator, 'vendor', {
      get: () => 'Google Inc.',
    });
  });
}

// ===== ФУНКЦИЯ СОЗДАНИЯ БРАУЗЕРА =====
async function getBrowserInstance(proxyServer?: string): Promise<any> {
  console.log('🚀 Запуск браузера...');
  const launchOptions: any = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--single-process',
      '--window-size=1366,768',
    ],
    ignoreHTTPSErrors: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    protocolTimeout: 180000,
  };

  if (proxyServer) {
    launchOptions.args.push(`--proxy-server=${proxyServer}`);
  }

  const browser = await puppeteer.launch(launchOptions);
  console.log('✅ Браузер запущен');

  return browser;
}

// ===== ГЛАВНАЯ ФУНКЦИЯ ВХОДА =====
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

  try {
    await setupAntiDetection(page);

    if (proxyConfig && proxyConfig.username && proxyConfig.password) {
      console.log('🔑 Авторизация на прокси...');
      await page.authenticate({
        username: proxyConfig.username,
        password: proxyConfig.password
      });
    }

    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

    // 1. Попытка восстановить сессию
    const sessionPath = getSessionPath(login);
    if (fs.existsSync(sessionPath)) {
      try {
        const state = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        const stats = fs.statSync(sessionPath);

        if (Date.now() - stats.mtimeMs < 30 * 24 * 60 * 60 * 1000) {
          if (state.cookies && Array.isArray(state.cookies)) {
            await page.setCookie(...state.cookies);
          }

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
              return { success: true, page, browser };
            }
          } catch(e) {
            console.log('⚠️ Ошибка при переходе с куками:', e);
          }

          console.log('⚠️ Сессия устарела или невалидна, нужен ре-логин');
        }
      } catch (e) {
        console.error('Ошибка чтения сессии', e);
      }
    }

    // 2. Если сессии нет или она не работает - делаем вход
    console.log('🔐 Выполняется вход...');
    await loadPageWithRetry(page, 'https://my.drom.ru/sign', { waitUntil: 'networkidle0' });

    // Проверка на captcha
    let captchaAttempts = 0;
    const maxCaptchaAttempts = 3;

    while (captchaAttempts < maxCaptchaAttempts) {
      const recaptchaFrame = await page.$('iframe[src*="recaptcha"]');

      if (recaptchaFrame) {
        console.log(`🔍 Обнаружена reCAPTCHA (попытка ${captchaAttempts + 1}/${maxCaptchaAttempts})`);
        await takeDebugScreenshot(page, login, `${captchaAttempts + 1}_recaptcha_detected`, true);

        const sitekey = await page.evaluate(() => {
          const iframe = document.querySelector('iframe[src*="recaptcha"]');
          if (!iframe) return null;
          const src = iframe.getAttribute('src');
          const match = src?.match(/k=([^&]+)/);
          return match ? match[1] : null;
        });

        if (!sitekey) {
          throw new Error('Не удалось извлечь sitekey для reCAPTCHA');
        }

        console.log(`🔑 Sitekey: ${sitekey}`);

        try {
          const gresponse = await solveRecaptchaV2(page.url(), sitekey);

          await page.evaluate((token: string) => {
            const textarea = document.getElementById('g-recaptcha-response') as HTMLTextAreaElement;
            if (textarea) {
              textarea.value = token;
              textarea.style.display = 'block';
            }

            if ((window as any).___grecaptcha_cfg && (window as any).___grecaptcha_cfg.clients) {
              Object.keys((window as any).___grecaptcha_cfg.clients).forEach((key: string) => {
                const client = (window as any).___grecaptcha_cfg.clients[key];
                if (client && client.callback) {
                  client.callback(token);
                }
              });
            }
          }, gresponse);

          console.log('✅ reCAPTCHA токен установлен');
          await takeDebugScreenshot(page, login, `${captchaAttempts + 1}_recaptcha_solved`, true);
          await new Promise(r => setTimeout(r, 2000));

          const stillHasCaptcha = await page.$('iframe[src*="recaptcha"]');
          if (!stillHasCaptcha) {
            console.log('✅ reCAPTCHA исчезла, продолжаем');
            break;
          }

        } catch (captchaError: any) {
          console.error(`❌ Ошибка решения reCAPTCHA:`, captchaError.message);
          await takeDebugScreenshot(page, login, `${captchaAttempts + 1}_captcha_error`, true);
        }

        captchaAttempts++;

        if (captchaAttempts >= maxCaptchaAttempts) {
          throw new Error('Превышено максимальное количество попыток решения reCAPTCHA');
        }

        await new Promise(r => setTimeout(r, 3000));
      } else {
        console.log('✅ reCAPTCHA не обнаружена или уже решена');
        break;
      }
    }

    // 3. Ввод логина и пароля
    const phoneInputSelector = 'input[name="login"]';
    await page.waitForSelector(phoneInputSelector, { visible: true, timeout: 10000 });

    console.log('📝 Ввод логина...');
    await page.type(phoneInputSelector, login, { delay: 150 });
    await humanDelay(500, 1500);

    const passwordInputSelector = 'input[name="password"]';
    await page.waitForSelector(passwordInputSelector, { visible: true, timeout: 5000 });

    console.log('🔒 Ввод пароля...');
    await page.type(passwordInputSelector, password, { delay: 150 });
    await humanDelay(800, 2000);

    console.log('🖱️ Клик на кнопку входа...');
    await page.click('button[type="submit"]');

    await new Promise(r => setTimeout(r, 5000));

    // 4. Проверка результата входа
    const currentUrl = page.url();
    console.log(`📍 URL после входа: ${currentUrl}`);

    // Проверка на ошибки входа
    const errorVisible = await page.evaluate(() => {
      const errorBlock = document.querySelector('.form__error, .error-message, [class*="error"]');
      return errorBlock ? errorBlock.textContent : null;
    });

    if (errorVisible && errorVisible.includes('Неверн')) {
      await takeDebugScreenshot(page, login, 'login_input_error', true);
      throw new Error('Неверный логин или пароль');
    }

    // Проверка на 2FA
    const has2FA = await page.$('input[name="code"]');
    if (has2FA) {
      console.log('🔐 Требуется код подтверждения (2FA)');
      await takeDebugScreenshot(page, login, 'verification_required', true);

      const smsButtonExists = await page.$('button:has-text("Отправить код в СМС")') || 
                               await page.$$eval('button', (buttons: any[]) => 
                                 buttons.some(b => b.textContent.includes('СМС'))
                               );

      if (smsButtonExists) {
        try {
          console.log('📱 Запрос SMS кода...');
          const smsButtons = await page.$$('button');
          for (const btn of smsButtons) {
            const text = await page.evaluate((el: any) => el.textContent, btn);
            if (text && text.includes('СМС')) {
              await btn.click();
              console.log('✅ SMS код запрошен');
              await new Promise(r => setTimeout(r, 2000));
              await takeDebugScreenshot(page, login, 'sms_requested', true);
              break;
            }
          }
        } catch (smsError) {
          console.log('⚠️ Не удалось запросить SMS, но продолжаем');
        }
      }

      activeFlows.set(login, {
        page,
        browser,
        timestamp: Date.now(),
        timer: setTimeout(() => cleanupFlow(login), 300 * 1000)
      });

      return {
        success: false,
        needsVerification: true,
        message: 'Введите код подтверждения, отправленный на ваш телефон'
      };
    }

    // Успешный вход
    if (currentUrl.includes('/personal')) {
      console.log('✅ Успешный вход!');
      return { success: true, page, browser };
    }

    // Если не на /personal и нет 2FA - что-то пошло не так
    await takeDebugScreenshot(page, login, 'unexpected_page', true);
    throw new Error(`Неожиданная страница после входа: ${currentUrl}`);

  } catch (error: any) {
    console.error('❌ Ошибка в startLoginFlow:', error.message);
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

// ===== ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ДЛЯ КЛИКА =====
async function humanClick(page: any, selector: string) {
  await page.waitForSelector(selector, { visible: true, timeout: 10000 });
  await page.evaluate((sel: string) => {
    const element = document.querySelector(sel) as HTMLElement;
    if (element) element.click();
  }, selector);
  await new Promise(r => setTimeout(r, Math.random() * 500 + 300));
}

// ==================== ЭНДПОИНТЫ ====================

// 1. ПОЛУЧЕНИЕ СООБЩЕНИЙ
app.post('/drom/get-messages', async (req: Request, res: Response) => {
  const { login, password, verificationCode, proxy } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Login/password required' });

  let page: any = null;
  let browser: any = null;

  try {
    if (verificationCode) {
      const browserData = await completeLoginFlow(login, verificationCode);
      page = browserData.page;
      browser = browserData.browser;
    } else {
      const result: any = await startLoginFlow(login, password, proxy);
      if (result.needsVerification) return res.status(202).json(result);
      page = result.page;
      browser = result.browser;
    }

    console.log('💬 Загрузка списка диалогов...');
    await page.goto('https://my.drom.ru/personal/messaging-modal?switchPosition=dialogs', {
      waitUntil: 'networkidle0',
      timeout: 60000
    });

    await new Promise(r => setTimeout(r, 3000));

    const currentUrl = page.url();
    console.log(`📍 Текущий URL: ${currentUrl}`);

    if (currentUrl.includes('/sign')) {
      console.log('⚠️ Сессия истекла, требуется повторный вход');
      await saveStateAndClose(login, page, browser);
      return res.status(401).json({
        success: false,
        error: 'Session expired, please login again'
      });
    }

    try {
      await page.waitForSelector('.dialog-list__li', { timeout: 10000 });
      console.log('✅ Список диалогов загружен');
    } catch {
      console.log('📭 Диалогов нет');
      await saveStateAndClose(login, page, browser);
      return res.json({ success: true, count: 0, dialogs: [] });
    }

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
      await saveStateAndClose(login, page, browser);
      return res.status(500).json({
        success: false,
        error: 'Failed to extract dialog list: ' + e.message
      });
    }

    if (!dialogsList || dialogsList.length === 0) {
      console.log('📭 Список диалогов пуст');
      await saveStateAndClose(login, page, browser);
      return res.json({ success: true, count: 0, dialogs: [] });
    }

    const limit = Math.min(dialogsList.length, 10);
    console.log(`📋 Обработка ${limit} из ${dialogsList.length} диалогов...`);
    const detailedDialogs = [];

    for (let i = 0; i < limit; i++) {
      const dItem: any = dialogsList[i];
      try {
        console.log(`🔄 Обработка диалога ${i + 1}/${limit} (ID: ${dItem.dialogId})...`);

        await page.goto(`https://my.drom.ru/personal/messaging/view?dialogId=${dItem.dialogId}`, {
          waitUntil: 'networkidle0',
          timeout: 30000
        });

        await new Promise(r => setTimeout(r, 1500));

        if (page.url().includes('/sign')) {
          console.log('⚠️ Сессия истекла во время обработки диалога');
          break;
        }

        try {
          await page.waitForSelector('.bzr-dialog__inner', { timeout: 8000 });
        } catch(e) {
          console.log(`⚠️ Диалог ${dItem.dialogId} не загрузился, пропускаем`);
          continue;
        }

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
        } catch (e: any) {
          console.error(`❌ Ошибка при извлечении данных диалога ${dItem.dialogId}:`, e.message);
          if (e.message.includes('Execution context was destroyed')) {
            console.log('⚠️ Context destroyed, возможно произошел редирект');
            break;
          }
          continue;
        }

        if (details && details.lastIncomingText) {
          detailedDialogs.push({
            dialogId: dItem.dialogId,
            ...details
          });
          console.log(`✅ Диалог ${dItem.dialogId} обработан`);
        } else {
          console.log(`⚠️ Диалог ${dItem.dialogId} пуст, пропускаем`);
        }

        await new Promise(r => setTimeout(r, Math.random() * 1500 + 1000));
      } catch (e: any) {
        console.error(`❌ Критическая ошибка при обработке диалога ${dItem.dialogId}:`, e.message);
        continue;
      }
    }

    console.log(`✅ Успешно собрано диалогов: ${detailedDialogs.length} из ${limit}`);

    await saveStateAndClose(login, page, browser);

    res.json({
      success: true,
      count: detailedDialogs.length,
      dialogs: detailedDialogs
    });

  } catch (err: any) {
    console.error('🚨 CRITICAL ERROR в /drom/get-messages:', err.message);
    console.error('Stack:', err.stack);

    if (browser) {
      await browser.close().catch(() => {});
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

  let page: any = null;
  let browser: any = null;

  try {
    const result: any = await startLoginFlow(login, password, proxy);
    if (result.needsVerification) return res.status(202).json(result);
    page = result.page;
    browser = result.browser;

    console.log(`📤 Отправка в диалог ${dialogId}...`);
    await page.goto(`https://my.drom.ru/personal/messaging/view?dialogId=${dialogId}`, { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });

    const textAreaSelector = 'textarea[name="message"]';
    await page.waitForSelector(textAreaSelector, { visible: true, timeout: 10000 });
    await page.type(textAreaSelector, message, { delay: 100 });
    await new Promise(r => setTimeout(r, 500));
    await page.click('button[name="post"]');
    await new Promise(r => setTimeout(r, 2000));

    console.log('✅ Отправлено');
    await saveStateAndClose(login, page, browser);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Send error:', err.message);
    if (browser) {
      await browser.close().catch(() => {});
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. ПОЛУЧЕНИЕ ИЗБРАННОГО
app.post('/drom/get-bookmarks', async (req: Request, res: Response) => {
  const { login, password, verificationCode, proxy } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Login/pass required' });

  let page: any = null;
  let browser: any = null;

  try {
    if (verificationCode) {
      const browserData = await completeLoginFlow(login, verificationCode);
      page = browserData.page;
      browser = browserData.browser;
    } else {
      const result: any = await startLoginFlow(login, password, proxy);
      if (result.needsVerification) return res.status(202).json(result);
      page = result.page;
      browser = result.browser;
    }

    console.log('⭐ Переход в избранное...');
    await page.goto('https://my.drom.ru/personal/bookmark', { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });

    try {
      await page.waitForSelector('.bull-item', { timeout: 8000 });
    } catch (e) {
      console.log('Избранное пусто');
      await saveStateAndClose(login, page, browser);
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
    await saveStateAndClose(login, page, browser);
    res.json({ success: true, count: bookmarks.length, bookmarks });
  } catch (error: any) {
    console.error('Error bookmarks:', error.message);
    if (browser) {
      await browser.close().catch(() => {});
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. ОТПРАВКА ОФФЕРА
app.post('/drom/send-offer', async (req: Request, res: Response) => {
  const { login, password, verificationCode, proxy, url, message } = req.body;
  if (!login || !password || !url || !message) {
    return res.status(400).json({ error: 'Login, password, url and message required' });
  }

  let page: any = null;
  let browser: any = null;

  try {
    if (verificationCode) {
      const browserData = await completeLoginFlow(login, verificationCode);
      page = browserData.page;
      browser = browserData.browser;
    } else {
      const result: any = await startLoginFlow(login, password, proxy);
      if (result.needsVerification) return res.status(202).json(result);
      page = result.page;
      browser = result.browser;
    }

    console.log(`🚗 Переход к объявлению: ${url}`);
    await page.goto(url, { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });
    await humanDelay(1000, 3000);

    const openModalBtnSelector = 'button[data-ga-stats-name="ask_question"]';
    try {
      await humanClick(page, openModalBtnSelector);
    } catch(e) {
      throw new Error('Кнопка "Написать" не найдена');
    }

    await humanDelay(1500, 3000);

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
    await saveStateAndClose(login, page, browser);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Offer error:', error.message);
    if (browser) {
      await browser.close().catch(() => {});
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. ЯВНЫЙ ЛОГАУТ
app.post('/drom/logout', async (req: Request, res: Response) => {
  const { login, password, proxy } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Login/password required' });

  let page: any = null;
  let browser: any = null;

  try {
    const result: any = await startLoginFlow(login, password, proxy);
    if (result.needsVerification) return res.status(202).json(result);
    page = result.page;
    browser = result.browser;

    await performLogout(page, login);

    const sessionPath = getSessionPath(login);
    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
      console.log(`🗑️ Сессия удалена для ${login}`);
    }

    await browser.close();
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err: any) {
    console.error('Logout error:', err.message);
    if (browser) {
      await browser.close().catch(() => {});
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. HEALTH CHECK
app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    activeSessions: activeFlows.size
  });
});

// 7. DEBUG - СПИСОК СКРИНШОТОВ
app.get('/debug/screenshots', (req: Request, res: Response) => {
  try {
    const files = fs.readdirSync(DEBUG_DIR)
      .filter(f => f.endsWith('.png'))
      .map(f => ({
        filename: f,
        size: fs.statSync(path.join(DEBUG_DIR, f)).size,
        created: fs.statSync(path.join(DEBUG_DIR, f)).mtime
      }))
      .sort((a, b) => b.created.getTime() - a.created.getTime());

    res.json({ count: files.length, screenshots: files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 8. DEBUG - СКАЧАТЬ СКРИНШОТ
app.get('/debug/screenshot/:filename', (req: Request, res: Response) => {
  const { filename } = req.params;
  const filepath = path.join(DEBUG_DIR, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Screenshot not found' });
  }

  res.sendFile(filepath);
});

// Запуск сервера
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM получен, закрываем активные сессии...');
  for (const [login, flow] of activeFlows.entries()) {
    try {
      await flow.browser.close();
    } catch (e) {}
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT получен, закрываем активные сессии...');
  for (const [login, flow] of activeFlows.entries()) {
    try {
      await flow.browser.close();
    } catch (e) {}
  }
  process.exit(0);
});
