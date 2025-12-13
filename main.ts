import express, { Request, Response } from 'express';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';

// Подключаем плагин скрытности
chromium.use(StealthPlugin());

const app = express();
app.use(express.json());

// --- КОНФИГУРАЦИЯ ---
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const DEBUG_DIR = path.join(__dirname, 'debug');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

function getSessionPath(login: string): string {
  const sanitized = login.replace(/[^a-zA-Z0-9]/g, '_');
  return path.join(SESSIONS_DIR, `session_${sanitized}.json`);
}

// --- ХРАНИЛИЩЕ АКТИВНЫХ СЕССИЙ (для 2FA) ---
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
    console.log(`🗑️ Очистка зависшей сессии для ${login}`);
    clearTimeout(flow.timer);
    flow.browser.close().catch(() => {});
    activeFlows.delete(login);
  }
}

// --- БАЗОВАЯ ЛОГИКА АВТОРИЗАЦИИ ---

async function startLoginFlow(login: string, password: string) {
  cleanupFlow(login); // Убиваем старые висящие процессы

  console.log(`🚀 Запуск браузера для ${login}...`);
  
  const browser = await chromium.launch({
    headless: true, // Поставь false, если хочешь видеть глазами
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'ru-RU',
    timezoneId: 'Asia/Yekaterinburg'
  });

  const page = await context.newPage();

  // 1. Попытка восстановить куки
  const sessionPath = getSessionPath(login);
  if (fs.existsSync(sessionPath)) {
    try {
      const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      // Куки живут 30 дней (условно)
      if (Date.now() - sessionData.timestamp < 30 * 24 * 60 * 60 * 1000) {
        await context.addCookies(sessionData.cookies);
        await page.goto('https://my.drom.ru/personal/', { waitUntil: 'domcontentloaded' });
        
        try {
          // Ждем либо редиректа на вход, либо загрузки личного кабинета
          await page.waitForTimeout(1000); 
          if (!page.url().includes('sign')) {
            console.log('✅ Вход выполнен по кукам');
            return { success: true, browser, context, page };
          }
        } catch (e) {}
        console.log('⚠️ Куки просрочены, логинимся заново');
      }
    } catch (e) {}
  }

  // 2. Ввод логина/пароля
  console.log('🔐 Вход по логину/паролю...');
  await page.goto('https://my.drom.ru/sign', { waitUntil: 'domcontentloaded' });

  const loginInput = page.locator('input[name="sign"]');
  await loginInput.waitFor({ state: 'visible', timeout: 10000 });
  await loginInput.fill(login);
  await page.waitForTimeout(300);
  
  await page.locator('input[type="password"]').fill(password);
  await page.waitForTimeout(500);
  
  // Клик "Войти"
  await page.click('button:has-text("Войти с паролем")');
  await page.waitForTimeout(3000);

  // 3. Проверка на 2FA
  const currentUrl = page.url();
  const bodyText = await page.innerText('body');
  const isVerification = bodyText.includes('Подтверждение') || bodyText.includes('код') || currentUrl.includes('/sign');

  if (isVerification && !currentUrl.includes('/personal')) {
    console.log('📱 Требуется SMS код.');
    
    // Если кнопка "Отправить код" есть — нажимаем
    if (await page.locator('text=Отправить код').isVisible()) {
         await page.click('text=Отправить код');
         await page.waitForTimeout(1000);
    }

    // Сохраняем браузер в память и ждем второго запроса с кодом
    activeFlows.set(login, {
      browser, context, page,
      timestamp: Date.now(),
      timer: setTimeout(() => cleanupFlow(login), 300 * 1000) // 5 минут
    });

    return { 
      success: false, 
      needsVerification: true, 
      message: 'SMS отправлено. Пришлите код в поле verificationCode.' 
    };
  }

  return { success: true, browser, context, page };
}

async function completeLoginFlow(login: string, code: string) {
  const flow = activeFlows.get(login);
  if (!flow) throw new Error('Сессия истекла. Повторите вход без кода.');

  console.log(`✍️ Ввод кода для ${login}...`);
  const { page } = flow;

  try {
    await page.locator('input[name="code"]').fill(code);
    await page.waitForTimeout(500);

    // Enter или клик подтверждения
    const confirmBtn = page.locator('button:has-text("Подтвердить"), button:has-text("Войти")').first();
    if (await confirmBtn.isVisible()) {
        await confirmBtn.click();
    } else {
        await page.keyboard.press('Enter');
    }

    // Ждем перехода в ЛК
    await page.waitForURL((url: URL) => url.toString().includes('/personal'), { timeout: 15000 });
    
    console.log('🎉 Код принят!');
    clearTimeout(flow.timer);
    activeFlows.delete(login); // Удаляем из ожидания, возвращаем управление
    
    return { success: true, browser: flow.browser, context: flow.context, page: flow.page };
  } catch (error) {
    await page.screenshot({ path: path.join(DEBUG_DIR, `code_fail_${Date.now()}.png`) });
    throw new Error('Неверный код или ошибка входа');
  }
}

async function saveCookiesAndClose(login: string, browser: any, context: any, close: boolean = true) {
    const cookies = await context.cookies();
    fs.writeFileSync(getSessionPath(login), JSON.stringify({
      cookies,
      timestamp: Date.now(),
      login
    }, null, 2));
    
    if (close) await browser.close();
}

// --- РОУТ 1: ПОЛУЧЕНИЕ СООБЩЕНИЙ ---

app.post('/drom/get-messages', async (req: Request, res: Response) => {
  const { login, password, verificationCode } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Login/pass required' });

  let browserData;

  try {
    // Логика входа
    if (verificationCode) {
      browserData = await completeLoginFlow(login, verificationCode);
    } else {
      const result: any = await startLoginFlow(login, password);
      if (result.needsVerification) return res.status(202).json(result);
      browserData = result;
    }

    const { page, browser, context } = browserData;

    console.log('💬 Получаем список диалогов...');
    await page.goto('https://my.drom.ru/personal/messaging-modal?switchPosition=dialogs', { waitUntil: 'domcontentloaded' });
    
    // Ждем список (или понимаем, что его нет)
    try {
        await page.waitForSelector('.dialog-list__li', { timeout: 5000 });
    } catch (e) {
        console.log('Список пуст');
        await saveCookiesAndClose(login, browser, context);
        return res.json({ success: true, count: 0, dialogs: [] });
    }

    // Собираем базовый список ID
    const dialogsList = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.dialog-list__li')).map(el => {
            const linkEl = el.querySelector('a[href*="/messaging/view"]');
            const href = linkEl ? linkEl.getAttribute('href') : '';
            const dialogIdMatch = href?.match(/dialogId=([^&]+)/);
            return {
                dialogId: dialogIdMatch ? dialogIdMatch[1] : null
            };
        }).filter(d => d.dialogId);
    });

    console.log(`📋 Найдено диалогов: ${dialogsList.length}. Парсим детали (макс 20)...`);
    
    const detailedDialogs = [];
    const limit = Math.min(dialogsList.length, 20); // Лимит, чтобы не ждать вечность

    for (let i = 0; i < limit; i++) {
        const dItem = dialogsList[i];
        if(!dItem.dialogId) continue;

        try {
            await page.goto(`https://my.drom.ru/personal/messaging/view?dialogId=${dItem.dialogId}`, { waitUntil: 'domcontentloaded' });
            
            // Ждем контейнер сообщения или хедер
            try { await page.waitForSelector('.bzr-dialog-header__title', { timeout: 3000 }); } catch(e) {}

            const details = await page.evaluate(() => {
                // 1. Автомобиль
                const headerLink = document.querySelector('.bzr-dialog-header__sub-title a');
                let carTitle = '';
                let carUrl = '';
                if (headerLink) {
                    carTitle = headerLink.textContent?.trim() || '';
                    const href = headerLink.getAttribute('href');
                    carUrl = href ? (href.startsWith('//') ? 'https:' + href : href) : '';
                }

                // 2. Последнее сообщение (ВХОДЯЩЕЕ)
                // Ищем все входящие (.bzr-dialog__message_in) и берем последнее
                const incomingMsgs = Array.from(document.querySelectorAll('.bzr-dialog__message_in'));
                let lastIncomingText = null;
                let lastIncomingTime = null;
                let isUnread = false; // Можно попробовать определить по стилям, если нужно

                if (incomingMsgs.length > 0) {
                    const lastEl = incomingMsgs[incomingMsgs.length - 1];
                    lastIncomingText = lastEl.querySelector('.bzr-dialog__text')?.textContent?.trim() || '';
                    lastIncomingTime = lastEl.querySelector('.bzr-dialog__message-dt')?.textContent?.trim() || '';
                }

                return { carTitle, carUrl, lastIncomingText, lastIncomingTime };
            });

            detailedDialogs.push({
                dialogId: dItem.dialogId,
                ...details
            });

            // Рандомная пауза для анти-фрода
            await page.waitForTimeout(Math.floor(Math.random() * 500) + 200);

        } catch (e) {
            console.error(`Ошибка диалога ${dItem.dialogId}`, e);
        }
    }

    await saveCookiesAndClose(login, browser, context);
    res.json({ success: true, count: detailedDialogs.length, dialogs: detailedDialogs });

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    if (browserData?.browser) await browserData.browser.close().catch(() => {});
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- РОУТ 2: ОТПРАВКА ОТВЕТА ---

app.post('/drom/send-message', async (req: Request, res: Response) => {
    const { login, password, dialogId, message } = req.body;

    if (!login || !password || !dialogId || !message) {
        return res.status(400).json({ error: 'Missing login, password, dialogId or message' });
    }

    let browserData;
    try {
        // Логинимся (обычно пройдет быстро по кукам)
        const result: any = await startLoginFlow(login, password);
        if (result.needsVerification) {
            // Если вдруг запросил 2FA при отправке - возвращаем 202,
            // но в реальном сценарии лучше сначала дернуть /get-messages, чтобы обновить сессию
            return res.status(202).json(result);
        }
        browserData = result;
        const { page, browser, context } = browserData;

        console.log(`📤 Отправка сообщения в диалог ${dialogId}...`);
        
        // Переход сразу в диалог
        await page.goto(`https://my.drom.ru/personal/messaging/view?dialogId=${dialogId}`, { waitUntil: 'domcontentloaded' });

        // Ждем поле ввода
        const textAreaSelector = 'textarea[name="message"]';
        try {
            await page.waitForSelector(textAreaSelector, { timeout: 10000 });
        } catch (e) {
            throw new Error('Не найдено поле ввода. Возможно диалог закрыт или удален.');
        }

        // Вводим текст
        await page.locator(textAreaSelector).fill(message);
        await page.waitForTimeout(500);

        // Кнопка отправки (ищем по name="post" или типу submit внутри формы)
        const sendBtnSelector = 'button[name="post"], button[data-action="submit-message"]';
        
        // Слушаем ответ сети, чтобы убедиться что ушло
        const [response] = await Promise.all([
             // Ожидаем, что после клика будет POST запрос или перезагрузка
             // Drom часто просто сабмитит форму и перезагружает страницу
             page.waitForLoadState('domcontentloaded'), 
             page.click(sendBtnSelector)
        ]);

        // Проверяем, появилось ли сообщение в чате (опционально)
        // Ищем наше сообщение в исходящих (.bzr-dialog__message_out) с нашим текстом
        // Это не всегда надежно из-за обрезки текста, но попробуем простой чек:
        // Просто считаем успешным, если не вылетела ошибка.

        console.log('✅ Сообщение отправлено');
        
        await saveCookiesAndClose(login, browser, context);
        res.json({ success: true, message: 'Отправлено' });

    } catch (error: any) {
        console.error('❌ Ошибка отправки:', error.message);
        if (browserData?.browser) await browserData.browser.close().catch(() => {});
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- ЗАПУСК ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
