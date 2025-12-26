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

// ===== ГЛОБАЛЬНЫЙ ЭКЗЕМПЛЯР БРАУЗЕРА (КРИТИЧНО!) =====
let globalBrowser: any = null;
let browserLaunchInProgress = false;

// ===== ФУНКЦИЯ ПОЛУЧЕНИЯ ИЛИ СОЗДАНИЯ БРАУЗЕРА =====
async function getBrowserInstance(proxyServer?: string): Promise<any> {
  // Если браузер существует и подключен - возвращаем его
  if (globalBrowser && globalBrowser.isConnected()) {
    console.log('♻️ Переиспользуем существующий браузер');
    return globalBrowser;
  }

  // Если запуск уже в процессе - ждем
  while (browserLaunchInProgress) {
    await new Promise(r => setTimeout(r, 100));
  }

  // Если браузер появился пока ждали - возвращаем его
  if (globalBrowser && globalBrowser.isConnected()) {
    return globalBrowser;
  }

  // Запускаем новый браузер
  browserLaunchInProgress = true;
  try {
    console.log('🚀 Запуск нового глобального браузера...');
    const launchOptions: any = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // КРИТИЧНО для Docker
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--single-process', // Уменьшает количество процессов
        '--window-size=1366,768',
      ],
      ignoreHTTPSErrors: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      // Увеличиваем таймаут протокола
      protocolTimeout: 180000, // 3 минуты вместо стандартных 30 секунд
    };

    if (proxyServer) {
      launchOptions.args.push(`--proxy-server=${proxyServer}`);
    }

    globalBrowser = await puppeteer.launch(launchOptions);
    console.log('✅ Глобальный браузер запущен');
    
    // Обработчик закрытия браузера
    globalBrowser.on('disconnected', () => {
      console.log('⚠️ Браузер отключился');
      globalBrowser = null;
    });

    return globalBrowser;
  } finally {
    browserLaunchInProgress = false;
  }
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
  timestamp: number;
  timer: NodeJS.Timeout;
}

const activeFlows: Map<string, ActiveFlow> = new Map();

// ===== ИСПРАВЛЕНА ФУНКЦИЯ cleanupFlow =====
async function cleanupFlow(login: string) {
  const flow = activeFlows.get(login);
  if (flow) {
    console.log(`🧹 Очистка ресурсов для ${login}`);
    clearTimeout(flow.timer);
    try {
      // КРИТИЧНО: Закрываем только страницу, НЕ браузер!
      await flow.page.close();
      console.log(`✅ Страница для ${login} закрыта`);
    } catch (e) {
      console.error('Ошибка при закрытии страницы:', e);
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

// ===== ИСПРАВЛЕНА ФУНКЦИЯ saveStateAndClose =====
async function saveStateAndClose(login: string, page: any, skipLogout: boolean = false) {
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
      login: login,
      timestamp: Date.now()
    };
    
    fs.writeFileSync(getSessionPath(login), JSON.stringify(state, null, 2));
    console.log(`💾 Сессия сохранена для ${login}`);
  } catch (e) {
    console.error('Ошибка сохранения сессии:', e);
  } finally {
    // КРИТИЧНО: Закрываем только страницу, НЕ браузер!
    try {
      await page.close();
      console.log(`✅ Страница для ${login} закрыта`);
    } catch (e) {
      console.error('Ошибка закрытия страницы:', e);
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
    
    return { success: true, page: flow.page };
  } catch (error) {
    // ТОЛЬКО ПРИ ОШИБКЕ делаем скриншот
    await page.screenshot({ path: path.join(DEBUG_DIR, `error_code_${Date.now()}.png`) }).catch(() => {});
    throw new Error('Неверный код или ошибка сайта');
  }
}

// ===== ИСПРАВЛЕНА ФУНКЦИЯ takeDebugScreenshot =====
// Делаем скриншоты ТОЛЬКО при ошибках или критических этапах
async function takeDebugScreenshot(page: any, login: string, step: string, forceScreenshot: boolean = false) {
  // Скриншоты только для важных этапов или ошибок
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
      fullPage: false // Не делаем fullPage для экономии ресурсов
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

// ===== ИСПРАВЛЕНА ФУНКЦИЯ startLoginFlow =====
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
  const page = await browser.newPage(); // ✅ Создаем НОВУЮ страницу
  
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
    
    // Минимум скриншотов - только критические
    // await takeDebugScreenshot(page, login, '01_initialized'); // УБРАЛИ
    
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
            // await takeDebugScreenshot(page, login, '02_session_restore_attempt'); // УБРАЛИ
            
            if (!page.url().includes('sign')) {
              console.log('✅ Сессия восстановлена');
              return { success: true, page };
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
    
    // 2. Вход с паролем
    console.log('🔐 Входим по логину/паролю...');
    await loadPageWithRetry(page, 'https://my.drom.ru/sign');
    
    const content = await page.content();
    console.log(`📄 Размер загруженной страницы: ${content.length} байт`);
    
    if (content.length < 10000) {
      console.warn(`⚠️ Подозрительно маленькая страница: ${content.length} байт`);
      await takeDebugScreenshot(page, login, 'suspicious_small_page', true);
      throw new Error('Прокси вернул неполную страницу');
    }
    
    // Ожидание загрузки страницы
    console.log('🔍 Ожидание полной загрузки страницы...');
    await new Promise(r => setTimeout(r, 5000));
    
    await Promise.race([
      page.waitForSelector('input[name="sign"]', { timeout: 10000 }).catch(() => null),
      page.waitForSelector('iframe[src*="recaptcha"]', { timeout: 10000 }).catch(() => null),
      new Promise(r => setTimeout(r, 10000))
    ]);
    
    // Проверка reCAPTCHA
    const recaptchaFrame = await page.$('iframe[src*="recaptcha/api2"]');
    if (recaptchaFrame) {
      console.log('🔒 Обнаружена reCAPTCHA v2!');
      await takeDebugScreenshot(page, login, 'recaptcha_detected', true);
      
      const sitekey = await page.evaluate(() => {
        const iframe = document.querySelector('iframe[src*="recaptcha/api2"]') as HTMLIFrameElement;
        if (!iframe) return null;
        const src = iframe.getAttribute('src') || '';
        const match = src.match(/[?&]k=([^&]+)/);
        return match ? match[1] : null;
      });
      
      if (!sitekey) {
        throw new Error('reCAPTCHA sitekey not found');
      }
      
      console.log(`🔑 Найден sitekey: ${sitekey}`);
      
      if (!process.env.ANTICAPTCHA_API_KEY) {
        throw new Error('AntiCaptcha API key not configured');
      }
      
      try {
        const gresponse = await solveRecaptchaV2(page.url(), sitekey);
        
        await page.evaluate((token: string) => {
          const textarea = document.querySelector('textarea[name="g-recaptcha-response"]') as HTMLTextAreaElement;
          if (textarea) {
            textarea.innerHTML = token;
            textarea.value = token;
            textarea.style.display = 'block';
          }
          
          const input = document.querySelector('input[name="g-recaptcha-response"]') as HTMLInputElement;
          if (input) {
            input.value = token;
          }
          
          if (typeof (window as any).grecaptcha !== 'undefined') {
            const clients = (window as any).___grecaptcha_cfg?.clients;
            if (clients) {
              Object.keys(clients).forEach((key) => {
                const client = clients[key];
                if (client && client.callback) {
                  client.callback(token);
                }
              });
            }
          }
        }, gresponse);
        
        console.log('✅ Решение reCAPTCHA вставлено');
        await new Promise(r => setTimeout(r, 1500));
        
        // Отправка формы
        let navigationOccurred = false;
        const buttons = await page.$$('button[type="submit"], input[type="submit"]');
        
        if (buttons.length > 0) {
          console.log(`✅ Найдено ${buttons.length} submit кнопок`);
          await Promise.all([
            buttons[0].click(),
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 })
              .then(() => {
                navigationOccurred = true;
                console.log('✅ Навигация произошла после клика');
              })
              .catch(() => console.log('⚠️ Навигация не произошла'))
          ]);
        }
        
        if (!navigationOccurred) {
          console.log('🔄 Форма не отправилась, переходим на /sign напрямую...');
          await page.goto('https://my.drom.ru/sign', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          });
          await new Promise(r => setTimeout(r, 3000));
        }
      } catch (captchaError: any) {
        console.error('❌ Ошибка при решении reCAPTCHA:', captchaError.message);
        await takeDebugScreenshot(page, login, 'captcha_error', true);
        throw new Error(`Failed to solve reCAPTCHA: ${captchaError.message}`);
      }
    } else {
      console.log('✅ reCAPTCHA не обнаружена');
    }
    
    // 3. Ввод логина и пароля
    const loginInputSelector = 'input[name="sign"]';
    try {
      await page.waitForSelector(loginInputSelector, { visible: true, timeout: 30000 });
      console.log('✅ Поле логина найдено');
      
      console.log('⌨️ Ввод логина...');
      await page.click(loginInputSelector);
      await humanDelay(500, 1000);
      await page.type(loginInputSelector, login, { delay: 100 + Math.random() * 50 });
      await humanDelay(500, 1000);
      
      console.log('⌨️ Ввод пароля...');
      const passwordSelector = 'input[type="password"]';
      await page.click(passwordSelector);
      await humanDelay(500, 1000);
      await page.type(passwordSelector, password, { delay: 100 + Math.random() * 50 });
      await humanDelay(800, 1500);
      
      console.log('🔘 Поиск кнопки входа...');
      const buttonExists = await page.$('#signbutton');
      if (buttonExists) {
        console.log('✅ Найдена кнопка #signbutton');
        await page.evaluate(() => {
          const btn = document.querySelector('#signbutton');
          if (btn) btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        await humanDelay(500, 1000);
        await page.click('#signbutton');
        console.log('✅ Клик по кнопке входа выполнен');
      } else {
        console.log('⚠️ Кнопка #signbutton не найдена, пробуем fallback');
        await page.click('button[type="submit"]');
        console.log('✅ Клик по button[type="submit"] выполнен');
      }
      
      console.log('⏳ Ожидание реакции после клика...');
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 })
          .then(() => console.log('✅ Произошла навигация'))
          .catch(() => console.log('⚠️ Навигация не обнаружена')),
        page.waitForSelector('input[name="code"]', { timeout: 10000 })
          .then(() => console.log('✅ Появилось поле для кода'))
          .catch(() => console.log('⚠️ Поле кода не появилось')),
        new Promise(r => setTimeout(r, 5000))
      ]);
    } catch (e: any) {
      console.error('❌ Ошибка при вводе логина/пароля:', e.message);
      await takeDebugScreenshot(page, login, 'login_input_error', true);
      throw e;
    }
    
    // 4. Проверка 2FA
    const currentUrl = page.url();
    console.log(`📍 Текущий URL: ${currentUrl}`);
    
    let codeInput = await page.$('input[name="code"]');
    
    if (!codeInput || currentUrl.includes('/sign')) {
      console.log('📱 Drom запрашивает подтверждение для отправки кода');
      
      // Поиск кнопки "Получить СМС-код"
      const intermediateBtnSelector = "xpath/.//button[contains(., 'Получить СМС-код')] | //a[contains(., 'Получить СМС-код')]";
      const intermediateBtn = await page.$(intermediateBtnSelector);
      
      if (intermediateBtn) {
        console.log('🔘 Найдена промежуточная кнопка "Получить СМС-код", нажимаем...');
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
          intermediateBtn.click()
        ]);
        await delay(2000);
        codeInput = await page.$('input[name="code"]');
      }
      
      if (!codeInput) {
        console.log('📤 Поле ввода не найдено, ищем кнопки выбора способа отправки...');
        const targetTexts = ['отправить код на телефон', 'телефон', 'sms', 'получить код'];
        const clickableElements = await page.evaluate((texts) => {
          const results: any[] = [];
          const items = document.querySelectorAll('button, a');
          items.forEach((el, idx) => {
            const content = el.textContent?.toLowerCase() || '';
            const isVisible = (el as HTMLElement).offsetWidth > 0 && (el as HTMLElement).offsetHeight > 0;
            if (isVisible && texts.some(t => content.includes(t))) {
              results.push({ index: idx, tag: el.tagName.toLowerCase(), text: content.trim() });
            }
          });
          return results;
        }, targetTexts);
        
        if (clickableElements.length > 0) {
          const target = clickableElements[0];
          console.log(`✅ Выбран элемент для клика: <${target.tag}> с текстом "${target.text}"`);
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
            page.evaluate((idx) => {
              const items = document.querySelectorAll('button, a');
              (items[idx] as HTMLElement).click();
            }, target.index)
          ]);
          await delay(3000);
        }
      }
      
      codeInput = await page.$('input[name="code"]');
    }
    
    if (await page.$('input[name="code"]')) {
      console.log('✅ Поле кода подтверждения доступно. Ожидаем ввод в следующем запросе.');
      activeFlows.set(login, {
        page,
        timestamp: Date.now(),
        timer: setTimeout(() => cleanupFlow(login), 300 * 1000)
      });
      return {
        success: false,
        needsVerification: true,
        message: 'Код запрошен. Введите его для завершения входа.'
      };
    }
    
    if (!page.url().includes('sign')) {
      return { success: true, page };
    }
    
    throw new Error('Не удалось дойти до этапа ввода СМС кода');
    
  } catch (error) {
    // При ошибке закрываем страницу
    await page.close().catch(() => {});
    throw error;
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

async function clearBrowserContext(page: any): Promise<void> {
  try {
    console.log('🧹 Очистка контекста браузера...');
    const cookies = await page.cookies();
    if (cookies.length > 0) {
      await page.deleteCookie(...cookies);
    }
    
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    console.log('✅ Контекст браузера очищен');
  } catch (error) {
    console.error('⚠️ Ошибка при очистке контекста:', error);
  }
}

async function loadSessionIfExists(login: string, page: any): Promise<boolean> {
  const sessionPath = getSessionPath(login);
  if (!fs.existsSync(sessionPath)) {
    console.log(`📭 Сессия для ${login} не найдена`);
    return false;
  }
  
  try {
    const state = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    
    if (state.login && state.login !== login) {
      console.log(`⚠️ Сессия принадлежит другому логину (${state.login}), очищаем...`);
      await clearBrowserContext(page);
      return false;
    }
    
    const sessionAge = Date.now() - (state.timestamp || 0);
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 дней
    
    if (sessionAge > maxAge) {
      console.log(`⚠️ Сессия устарела (${Math.round(sessionAge / 86400000)} дней), требуется повторный вход`);
      fs.unlinkSync(sessionPath);
      return false;
    }
    
    await clearBrowserContext(page);
    
    if (state.cookies && state.cookies.length > 0) {
      await page.setCookie(...state.cookies);
      console.log(`🍪 Загружено ${state.cookies.length} cookies`);
    }
    
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

// --- РОУТЫ ---

// 1. ПОЛУЧЕНИЕ СООБЩЕНИЙ
app.post('/drom/get-messages', async (req: Request, res: Response) => {
  const { login, password, verificationCode, proxy } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Login/password required' });
  
  let page: any = null;
  try {
    if (verificationCode) {
      const browserData = await completeLoginFlow(login, verificationCode);
      page = browserData.page;
    } else {
      const result: any = await startLoginFlow(login, password, proxy);
      if (result.needsVerification) return res.status(202).json(result);
      page = result.page;
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
      await page.close();
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
      await saveStateAndClose(login, page);
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
      await takeDebugScreenshot(page, login, 'error_extract_dialogs', true);
      await page.close();
      return res.status(500).json({
        success: false,
        error: 'Failed to extract dialog list: ' + e.message
      });
    }
    
    if (!dialogsList || dialogsList.length === 0) {
      console.log('📭 Список диалогов пуст');
      await saveStateAndClose(login, page);
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
    await saveStateAndClose(login, page);
    
    res.json({
      success: true,
      count: detailedDialogs.length,
      dialogs: detailedDialogs
    });
    
  } catch (err: any) {
    console.error('🚨 CRITICAL ERROR в /drom/get-messages:', err.message);
    console.error('Stack:', err.stack);
    
    if (page) {
      try {
        await takeDebugScreenshot(page, login, 'critical_error_get_messages', true);
      } catch {}
      await page.close().catch(() => {});
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
  try {
    const result: any = await startLoginFlow(login, password, proxy);
    if (result.needsVerification) return res.status(202).json(result);
    page = result.page;
    
    console.log(`📤 Отправка в диалог ${dialogId}...`);
    await page.goto(`https://my.drom.ru/personal/messaging/view?dialogId=${dialogId}`, { waitUntil: 'domcontentloaded' });
    
    const textAreaSelector = 'textarea[name="message"]';
    await page.waitForSelector(textAreaSelector, { visible: true, timeout: 10000 });
    await page.type(textAreaSelector, message, { delay: 100 });
    await new Promise(r => setTimeout(r, 500));
    await page.click('button[name="post"]');
    await new Promise(r => setTimeout(r, 2000));
    
    console.log('✅ Отправлено');
    await saveStateAndClose(login, page);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Send error:', err.message);
    if (page) await page.close().catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. ПОЛУЧЕНИЕ ИЗБРАННОГО
app.post('/drom/get-bookmarks', async (req: Request, res: Response) => {
  const { login, password, verificationCode, proxy } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Login/pass required' });
  
  let page: any = null;
  try {
    if (verificationCode) {
      const browserData = await completeLoginFlow(login, verificationCode);
      page = browserData.page;
    } else {
      const result: any = await startLoginFlow(login, password, proxy);
      if (result.needsVerification) return res.status(202).json(result);
      page = result.page;
    }
    
    console.log('⭐ Переход в избранное...');
    await page.goto('https://my.drom.ru/personal/bookmark', { waitUntil: 'domcontentloaded' });
    
    try {
      await page.waitForSelector('.bull-item', { timeout: 8000 });
    } catch (e) {
      console.log('Избранное пусто');
      await saveStateAndClose(login, page);
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
    await saveStateAndClose(login, page);
    res.json({ success: true, count: bookmarks.length, bookmarks });
  } catch (error: any) {
    console.error('Error bookmarks:', error.message);
    if (page) await page.close().catch(() => {});
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
  try {
    if (verificationCode) {
      const browserData = await completeLoginFlow(login, verificationCode);
      page = browserData.page;
    } else {
      const result: any = await startLoginFlow(login, password, proxy);
      if (result.needsVerification) return res.status(202).json(result);
      page = result.page;
    }
    
    console.log(`🚗 Переход к объявлению: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
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
    await saveStateAndClose(login, page);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Offer error:', error.message);
    if (page) await page.close().catch(() => {});
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. LOGOUT ENDPOINT
app.post('/drom/logout', async (req: Request, res: Response) => {
  const { login } = req.body;
  if (!login) {
    return res.status(400).json({ error: 'Login required' });
  }
  
  let page: any = null;
  try {
    console.log(`🚀 Запуск логаута для ${login}...`);
    
    const browser = await getBrowserInstance();
    page = await browser.newPage();
    await setupAntiDetection(page);
    
    await loadSessionIfExists(login, page);
    await performLogout(page, login);
    
    const sessionPath = getSessionPath(login);
    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
      console.log(`🗑️ Файл сессии удален для ${login}`);
    }
    
    await page.close();
    res.json({
      success: true,
      message: `Logout successful for ${login}`
    });
  } catch (error: any) {
    console.error('Logout error:', error.message);
    if (page) await page.close().catch(() => {});
    res.status(500).json({
      success: false,
      error: error.message
    });
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

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, closing browser...');
  if (globalBrowser) {
    await globalBrowser.close().catch(() => {});
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 SIGINT received, closing browser...');
  if (globalBrowser) {
    await globalBrowser.close().catch(() => {});
  }
  process.exit(0);
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on port ${PORT}`));
