import express, { Request, Response } from 'express';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';

chromium.use(StealthPlugin());

const app = express();
app.use(express.json());

const SESSIONS_DIR = path.join(__dirname, 'sessions');

// Создаём папку для сессий
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Функция для получения пути к файлу сессии
function getSessionPath(login: string): string {
  const sanitized = login.replace(/[^a-zA-Z0-9]/g, '_');
  return path.join(SESSIONS_DIR, `session_${sanitized}.json`);
}

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ 
    status: 'ok', 
    service: 'drom-automation',
    timestamp: new Date().toISOString()
  });
});

// Функция авторизации с сохранением сессии
async function loginToDrom(page: any, login: string, password: string, context: any) {
  const sessionPath = getSessionPath(login);
  
  // Пытаемся загрузить существующую сессию
  if (fs.existsSync(sessionPath)) {
    console.log('🔄 Загружаем сохранённую сессию...');
    try {
      const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      const sessionAge = Date.now() - sessionData.timestamp;
      
      // Проверяем, не старше ли сессия 24 часов
      if (sessionAge < 24 * 60 * 60 * 1000) {
        await context.addCookies(sessionData.cookies);
        
        // Проверяем валидность сессии
        await page.goto('https://my.drom.ru/personal/messaging-modal?switchPosition=dialogs', { 
          waitUntil: 'domcontentloaded', 
          timeout: 15000 
        });
        
        const isLoggedIn = await page.evaluate(() => {
          return !document.body.innerText.includes('Войти') && 
                 !window.location.href.includes('sign');
        });
        
        if (isLoggedIn) {
          console.log('✅ Сессия валидна, авторизация не требуется');
          return;
        } else {
          console.log('⚠️ Сессия устарела, выполняем новый вход...');
          fs.unlinkSync(sessionPath);
        }
      } else {
        console.log('⚠️ Сессия старше 24 часов, удаляем...');
        fs.unlinkSync(sessionPath);
      }
    } catch (e) {
      console.log('⚠️ Ошибка загрузки сессии:', e);
    }
  }
  
  // Выполняем новую авторизацию
  console.log('🔐 Выполняем авторизацию на Дром...');
  
  try {
    await page.goto('https://my.drom.ru/sign', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    
    await page.fill('input[name="sign"]', login);
    await page.waitForTimeout(800);
    
    await page.fill('input[type="password"]', password);
    await page.waitForTimeout(800);
    
    await page.click('button:has-text("Войти с паролем")');
    
    try {
      await page.waitForNavigation({ timeout: 30000, waitUntil: 'networkidle' });
    } catch (navError) {
      console.log('⚠️ Навигация не произошла');
    }
    
    await page.waitForTimeout(3000);
    
    const currentUrl = page.url();
    console.log('📍 URL после входа:', currentUrl);
    
    // Проверяем ошибки
    const hasError = await page.evaluate(() => {
      const errorTexts = ['неверный', 'ошибка', 'неправильный', 'captcha'];
      const pageText = document.body.innerText.toLowerCase();
      return errorTexts.some(err => pageText.includes(err));
    });
    
    if (hasError) {
      throw new Error('Ошибка авторизации - неверные данные или капча');
    }
    
    // Сохраняем сессию
    const cookies = await context.cookies();
    const sessionData = {
      cookies: cookies,
      timestamp: Date.now(),
      login: login.substring(0, 3) + '***'
    };
    
    fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
    console.log('✅ Сессия сохранена в', sessionPath);
    
  } catch (error: any) {
    console.error('❌ Ошибка авторизации:', error.message);
    throw error;
  }
}

// Получение сообщений
app.post('/drom/get-messages', async (req: Request, res: Response) => {
  const { login, password } = req.body;
  
  if (!login || !password) {
    return res.status(400).json({ error: 'login и password обязательны' });
  }
  
  console.log('🔍 Получаем сообщения с Дром для:', login.substring(0, 3) + '***');
  
  let screenshotBase64 = '';
  
  try {
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'ru-RU',
      timezoneId: 'Asia/Yekaterinburg'
    });

    const page = await context.newPage();
    
    // Авторизация с поддержкой сессий
    await loginToDrom(page, login, password, context);
    
    // Переход в сообщения (ваш URL)
    if (!page.url().includes('personal/messaging-modal')) {
      console.log('💬 Открываем чаты...');
      await page.goto('https://my.drom.ru/personal/messaging-modal?switchPosition=dialogs', { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
    }
    
    // Улучшенное ожидание загрузки диалогов
    console.log('⏳ Ждём загрузки диалогов...');
    
    // Ждём появления списка диалогов
    try {
      await page.waitForSelector('.dialog-list__li', { timeout: 20000, state: 'visible' });
      console.log('✅ Диалоги найдены');
    } catch (e) {
      console.log('⚠️ Селектор .dialog-list__li не найден за 20 сек');
    }
    
    // Ждём стабилизации DOM (пока список не перестанет расти)
    let previousCount = 0;
    let stableCount = 0;
    
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1000);
      
      const currentCount = await page.evaluate(() => {
        return document.querySelectorAll('.dialog-list__li').length;
      });
      
      if (currentCount === previousCount && currentCount > 0) {
        stableCount++;
        if (stableCount >= 2) {
          console.log(`✅ Список стабилизировался: ${currentCount} диалогов`);
          break;
        }
      } else {
        stableCount = 0;
      }
      
      previousCount = currentCount;
    }
    
    // Дополнительная пауза
    await page.waitForTimeout(2000);
    
    const currentUrl = page.url();
    console.log('📍 Текущий URL:', currentUrl);
    
    // Скриншот
    const screenshotBuffer = await page.screenshot({ fullPage: true });
    screenshotBase64 = screenshotBuffer.toString('base64');
    
    // Парсим диалоги
    const dialogs = await page.evaluate(() => {
      const chats: any[] = [];
      
      document.querySelectorAll('.dialog-list__li').forEach((li, idx) => {
        const dialogBrief = li.querySelector('.dialog-brief');
        const link = li.querySelector('.dialog-list__link') as HTMLAnchorElement;
        
        if (!dialogBrief || !link) return;
        
        const dialogId = dialogBrief.getAttribute('data-dialog-id');
        const interlocutor = dialogBrief.getAttribute('data-interlocutor');
        const latestMessage = dialogBrief.querySelector('.dialog-brief__latest_msg')?.textContent?.trim();
        const userName = dialogBrief.querySelector('.dialog-brief__interlocutor')?.textContent?.trim();
        const time = dialogBrief.querySelector('.bzr-dialog__message-dt')?.textContent?.trim();
        const avatarStyle = dialogBrief.querySelector('.dialog-brief__image')?.getAttribute('style');
        const avatarUrl = avatarStyle?.match(/url\((.*?)\)/)?.[1]?.replace(/['"]/g, '');
        const chatUrl = link.href;
        
        chats.push({
          id: idx,
          dialogId: dialogId,
          interlocutor: interlocutor || userName,
          userName: userName,
          latestMessage: latestMessage,
          time: time,
          avatar: avatarUrl,
          chatUrl: chatUrl,
          unread: li.classList.contains('unread') || li.classList.contains('new')
        });
      });
      
      return chats;
    });
    
    await browser.close();
    
    console.log(`✅ Найдено диалогов: ${dialogs.length}`);
    
    res.json({ 
      success: true,
      currentUrl,
      count: dialogs.length,
      dialogs,
      screenshotBase64: screenshotBase64,
      usedCache: fs.existsSync(getSessionPath(login))
    });
    
  } catch (error: any) {
    console.error('❌ Ошибка:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message, 
      stack: error.stack,
      screenshotBase64: screenshotBase64 || 'not_captured'
    });
  }
});

// Отправка сообщения
app.post('/drom/send-message', async (req: Request, res: Response) => {
  const { login, password, dialogId, text } = req.body;
  
  if (!login || !password || !dialogId || !text) {
    return res.status(400).json({ 
      error: 'Все поля обязательны: login, password, dialogId, text' 
    });
  }
  
  console.log(`📤 Отправляем сообщение в диалог ${dialogId}`);
  
  try {
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
    
    // Авторизация
    await loginToDrom(page, login, password, context);
    
    // Переход в конкретный диалог
    const chatUrl = `https://www.drom.ru/personal/messaging/view?dialogId=${dialogId}`;
    console.log('📍 Открываем чат:', chatUrl);
    
    await page.goto(chatUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    
    // Ждём поле ввода
    await page.waitForSelector('textarea[name="message"], textarea', { timeout: 10000 });
    
    // Вводим текст
    console.log('✍️ Вводим текст...');
    await page.fill('textarea[name="message"], textarea', text);
    await page.waitForTimeout(500);
    
    // Отправляем
    const sendButton = page.locator('button[type="submit"], button:has-text("Отправить")').first();
    if (await sendButton.count() > 0) {
      await sendButton.click();
      console.log('✅ Кнопка отправки нажата');
    } else {
      await page.keyboard.press('Enter');
      console.log('✅ Нажат Enter');
    }
    
    await page.waitForTimeout(3000);
    
    // Проверяем отправку
    const messageSent = await page.evaluate((sentText) => {
      const messages = Array.from(document.querySelectorAll('.bzr-dialog__message_out .bzr-dialog__text'));
      return messages.some(msg => msg.textContent?.includes(sentText));
    }, text);
    
    await browser.close();
    
    if (messageSent) {
      console.log('✅ Сообщение подтверждено');
      res.json({ success: true, sent: text, dialogId, confirmed: true });
    } else {
      console.log('⚠️ Сообщение отправлено, но не подтверждено');
      res.json({ success: true, sent: text, dialogId, confirmed: false });
    }
    
  } catch (error: any) {
    console.error('❌ Ошибка отправки:', error.message);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Drom automation service на порту ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
});
