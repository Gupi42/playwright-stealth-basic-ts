import express, { Request, Response } from 'express';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';

chromium.use(StealthPlugin());

const app = express();
app.use(express.json());

const SESSIONS_DIR = path.join(__dirname, 'sessions');
const DEBUG_DIR = path.join(__dirname, 'debug');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

function getSessionPath(login: string): string {
  const sanitized = login.replace(/[^a-zA-Z0-9]/g, '_');
  return path.join(SESSIONS_DIR, `session_${sanitized}.json`);
}

// --- ХРАНИЛИЩЕ АКТИВНЫХ БРАУЗЕРОВ (ОЖИДАЮЩИХ КОД) ---
interface ActiveFlow {
  browser: any;
  context: any;
  page: any;
  timestamp: number;
  timer: NodeJS.Timeout;
}

// Храним открытые браузеры здесь: ключ = логин
const activeFlows: Map<string, ActiveFlow> = new Map();

// Функция очистки зависших браузеров
function cleanupFlow(login: string) {
  const flow = activeFlows.get(login);
  if (flow) {
    console.log(`🗑️ Очистка зависшей сессии для ${login}`);
    clearTimeout(flow.timer);
    flow.browser.close().catch(() => {});
    activeFlows.delete(login);
  }
}

// --- ОСНОВНАЯ ЛОГИКА ---

async function startLoginFlow(login: string, password: string) {
  // Если была старая висящая сессия - убиваем её
  cleanupFlow(login);

  console.log(`🚀 Запуск нового браузера для ${login}...`);
  
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'ru-RU',
    timezoneId: 'Asia/Yekaterinburg'
  });

  const page = await context.newPage();

  // 1. Попытка восстановить сохраненную куку
  const sessionPath = getSessionPath(login);
  if (fs.existsSync(sessionPath)) {
    try {
      const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      if (Date.now() - sessionData.timestamp < 30 * 24 * 60 * 60 * 1000) {
        await context.addCookies(sessionData.cookies);
        await page.goto('https://my.drom.ru/personal/', { waitUntil: 'domcontentloaded' });
        
        // Проверка авторизации
        try {
          // Исправлено: добавили типизацию (url: any)
          await page.waitForURL((url: any) => url.toString().includes('/personal'), { timeout: 5000 });
          
          if (!page.url().includes('sign')) {
            console.log('✅ Вход выполнен по сохраненной сессии');
            return { success: true, browser, context, page };
          }
        } catch (e) {}
        console.log('⚠️ Сохраненная сессия не сработала, идем через логин/пароль');
      }
    } catch (e) {}
  }

  // 2. Вход с паролем
  console.log('🔐 Ввод логина и пароля...');
  await page.goto('https://my.drom.ru/sign', { waitUntil: 'domcontentloaded' });

  const loginInput = page.locator('input[name="sign"]');
  await loginInput.waitFor({ state: 'visible', timeout: 10000 });
  await loginInput.fill(login);
  await page.waitForTimeout(300);
  
  await page.locator('input[type="password"]').fill(password);
  await page.waitForTimeout(500);
  
  await page.click('button:has-text("Войти с паролем")');
  await page.waitForTimeout(3000);

  // 3. Проверка на необходимость кода (2FA)
  const currentUrl = page.url();
  const bodyText = await page.innerText('body');
  const isVerification = bodyText.includes('Подтверждение') || bodyText.includes('код') || currentUrl.includes('/sign');

  if (isVerification && !currentUrl.includes('/personal')) {
    console.log('📱 Требуется SMS код. Оставляем браузер открытым.');
    
    // Если поле ввода скрыто, жмем кнопку отправки
    const codeInput = page.locator('input[name="code"]');
    if (!(await codeInput.isVisible())) {
       const sendBtn = page.locator('text=Отправить код').first();
       if (await sendBtn.isVisible()) {
         await sendBtn.click();
         await page.waitForTimeout(2000);
       }
    }

    // Сохраняем браузер в память
    activeFlows.set(login, {
      browser,
      context,
      page,
      timestamp: Date.now(),
      timer: setTimeout(() => cleanupFlow(login), 5 * 60 * 1000) // Закрыть через 5 мин если нет кода
    });

    return { 
      success: false, 
      needsVerification: true, 
      message: 'SMS отправлено. Отправьте код в следующем запросе.' 
    };
  }

  // Если попали сразу в ЛК (без кода)
  return { success: true, browser, context, page };
}

async function completeLoginFlow(login: string, code: string) {
  const flow = activeFlows.get(login);
  
  if (!flow) {
    throw new Error('⏳ Время сессии истекло или браузер закрыт. Повторите запрос без кода.');
  }

  console.log(`✍️ Вводим код для ${login} в существующий браузер...`);
  const { page } = flow;

  try {
    const codeInput = page.locator('input[name="code"]');
    await codeInput.waitFor({ state: 'visible', timeout: 5000 });
    await codeInput.fill(code);
    await page.waitForTimeout(500);

    // Жмем Enter или кнопку
    const confirmBtn = page.locator('button:has-text("Подтвердить"), button:has-text("Войти")').first();
    if (await confirmBtn.isVisible()) {
        await confirmBtn.click();
    } else {
        await page.keyboard.press('Enter');
    }

    // ИСПРАВЛЕНИЕ ОШИБКИ ЗДЕСЬ: (url: any)
    await page.waitForURL((url: any) => url.toString().includes('/personal'), { timeout: 20000 });
    
    console.log('🎉 Успешный вход после кода!');
    
    // Удаляем из списка ожидающих (но браузер не закрываем, вернем его для работы)
    clearTimeout(flow.timer);
    activeFlows.delete(login);
    
    return { success: true, browser: flow.browser, context: flow.context, page: flow.page };

  } catch (error: any) {
    await page.screenshot({ path: path.join(DEBUG_DIR, `code_fail_${Date.now()}.png`) });
    throw new Error('Ошибка ввода кода или неверный код');
  }
}

// --- РОУТЫ ---

app.post('/drom/get-messages', async (req: Request, res: Response) => {
  const { login, password, verificationCode } = req.body;
  
  if (!login || !password) return res.status(400).json({ error: 'Login/pass required' });

  let browserData;

  try {
    if (verificationCode) {
      // 2-й шаг: есть код, ищем активный браузер
      browserData = await completeLoginFlow(login, verificationCode);
    } else {
      // 1-й шаг: начинаем вход
      const result: any = await startLoginFlow(login, password);
      
      if (result.needsVerification) {
        return res.status(202).json(result);
      }
      browserData = result;
    }

    // Если мы здесь, значит вход успешен
    const { page, context, browser } = browserData;

    // Сохраняем успешную сессию
    const cookies = await context.cookies();
    fs.writeFileSync(getSessionPath(login), JSON.stringify({
      cookies,
      timestamp: Date.now(),
      login,
      verified: true
    }, null, 2));

    // --- ПАРСИНГ СООБЩЕНИЙ ---
    console.log('💬 Парсим диалоги...');
    await page.goto('https://my.drom.ru/personal/messaging-modal?switchPosition=dialogs', { waitUntil: 'networkidle' });
    
    const dialogs = await page.evaluate(() => {
        const dialogElements = Array.from(document.querySelectorAll('.bzr-dialog-brief'));
        return dialogElements.map((el, idx) => {
            const nameEl = el.querySelector('.bzr-dialog__interlocutor-name');
            const messageEl = el.querySelector('.bzr-dialog__latest_msg');
            const timeEl = el.querySelector('.bzr-dialog__message-dt');
            const linkEl = el.querySelector('a[href*="/messaging/view"]');
            
            const href = linkEl ? linkEl.getAttribute('href') : '';
            const dialogIdMatch = href?.match(/dialogId=([^&]+)/);
            
            return {
                id: idx,
                dialogId: dialogIdMatch ? dialogIdMatch[1] : '',
                userName: nameEl?.textContent?.trim() || '',
                latestMessage: messageEl?.textContent?.trim() || '',
                time: timeEl?.textContent?.trim() || ''
            };
        });
    });

    await browser.close();
    
    res.json({ success: true, count: dialogs.length, dialogs });

  } catch (error: any) {
    console.error('❌ Ошибка:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- ДОП. РОУТЫ ---
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/debug/:filename', (req, res) => {
    const p = path.join(DEBUG_DIR, req.params.filename);
    if(fs.existsSync(p)) res.sendFile(p);
    else res.status(404).send('Not found');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на ${PORT}`));
