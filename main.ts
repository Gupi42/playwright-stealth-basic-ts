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
  
  if (fs.existsSync(sessionPath)) {
    console.log('🔄 Загружаем сохранённую сессию...');
    try {
      const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      const sessionAge = Date.now() - sessionData.timestamp;
      
      if (sessionAge < 24 * 60 * 60 * 1000) {
        await context.addCookies(sessionData.cookies);
        
        await page.goto('https://my.drom.ru/personal/messaging-modal?switchPosition=dialogs', { 
          waitUntil: 'domcontentloaded', 
          timeout: 15000 
        });
        
        const isLoggedIn = await page.evaluate(() => {
          return !document.body.innerText.includes('Войти') && 
                 !window.location.href.includes('sign');
        });
        
        if (isLoggedIn) {
          console.log('✅ Сессия валидна');
          return;
        } else {
          console.log('⚠️ Сессия устарела');
          fs.unlinkSync(sessionPath);
        }
      } else {
        fs.unlinkSync(sessionPath);
      }
    } catch (e) {
      console.log('⚠️ Ошибка загрузки сессии');
    }
  }
  
  console.log('🔐 Авторизация на Дром...');
  
  try {
    await page.goto('https://my.drom.ru/sign', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    
    await page.fill('input[name="sign"]', login);
    await page.waitForTimeout(800);
    
    await page.fill('input[type="password"]', password);
    await page.waitForTimeout(800);
    
    await page.click('button:has-text("Войти с паролем")');
    
    let redirectAttempts = 0;
    while (redirectAttempts < 5) {
      try {
        await page.waitForNavigation({ timeout: 10000, waitUntil: 'networkidle' });
        console.log(`🔄 Редирект ${redirectAttempts + 1}: ${page.url()}`);
        
        if (page.url().includes('/sign/s2/')) {
          console.log('⏳ Промежуточная страница, ждём...');
          await page.waitForTimeout(3000);
          redirectAttempts++;
          continue;
        }
        
        if (!page.url().includes('/sign')) {
          break;
        }
        
        redirectAttempts++;
      } catch (e) {
        console.log('⚠️ Навигация завершена');
        break;
      }
    }
    
    await page.waitForTimeout(3000);
    
    const currentUrl = page.url();
    console.log('📍 Финальный URL после входа:', currentUrl);
    
    const hasError = await page.evaluate(() => {
      const errorTexts = ['неверный', 'ошибка', 'неправильный', 'captcha'];
      const pageText = document.body.innerText.toLowerCase();
      return errorTexts.some(err => pageText.includes(err));
    });
    
    if (hasError) {
      throw new Error('Ошибка авторизации');
    }
    
    const cookies = await context.cookies();
    fs.writeFileSync(sessionPath, JSON.stringify({
      cookies: cookies,
      timestamp: Date.now(),
      login: login.substring(0, 3) + '***'
    }, null, 2));
    
    console.log('✅ Авторизация завершена, сессия сохранена');
    
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
  let debugInfo: any = {};
  
  try {
    const browser = await chromium.launch({
      headless: true, // Вернул true для Railway
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'ru-RU',
      timezoneId: 'Asia/Yekaterinburg'
    });

    const page = await context.newPage();
    
    await loginToDrom(page, login, password, context);
    
    console.log('💬 Открываем чаты...');
    await page.goto('https://my.drom.ru/personal/messaging-modal?switchPosition=dialogs', { 
      waitUntil: 'load',
      timeout: 30000 
    });
    
    console.log('📍 URL:', page.url());
    
    await page.waitForTimeout(3000);
    
    console.log('⏳ Ждём появления диалогов через MutationObserver...');
    
    // ИСПРАВЛЕНО: убрал TypeScript-синтаксис из evaluate
    const dialogs = await page.evaluate(() => {
      return new Promise((resolve) => {
        let attempts = 0;
        const maxAttempts = 30;
        
        function checkDialogs() {
          const dialogElements = document.querySelectorAll('.dialog-list__li');
          
          if (dialogElements.length > 0) {
            console.log('Диалоги найдены!', dialogElements.length);
            
            const chats = [];
            
            dialogElements.forEach((li, idx) => {
              const dialogBrief = li.querySelector('.dialog-brief');
              const link = li.querySelector('.dialog-list__link');
              
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
            
            resolve(chats);
            return;
          }
          
          attempts++;
          
          if (attempts >= maxAttempts) {
            console.log('Превышено время ожидания, диалоги не найдены');
            resolve([]);
            return;
          }
          
          setTimeout(checkDialogs, 1000);
        }
        
        checkDialogs();
        
        const observer = new MutationObserver(() => {
          const hasDialogList = document.querySelector('.dialog-list__li');
          if (hasDialogList) {
            console.log('MutationObserver: диалоги появились!');
            checkDialogs();
          }
        });
        
        observer.observe(document.body, {
          childList: true,
          subtree: true
        });
      });
    });
    
    console.log(`✅ Результат: ${Array.isArray(dialogs) ? dialogs.length : 0} диалогов`);
    
    const screenshotBuffer = await page.screenshot({ fullPage: true });
    screenshotBase64 = screenshotBuffer.toString('base64');
    
    if (!Array.isArray(dialogs) || dialogs.length === 0) {
      debugInfo.html_body = await page.evaluate(() => document.body.innerHTML.substring(0, 3000));
      debugInfo.all_classes = await page.evaluate(() => {
        const elements = document.querySelectorAll('[class*="dialog"]');
        const result = [];
        for (let i = 0; i < Math.min(elements.length, 10); i++) {
          const el = elements[i];
          result.push({
            tag: el.tagName,
            classes: el.className,
            text: el.textContent?.substring(0, 100)
          });
        }
        return result;
      });
    }
    
    await browser.close();
    
    res.json({ 
      success: true,
      currentUrl: page.url(),
      count: Array.isArray(dialogs) ? dialogs.length : 0,
      dialogs: dialogs || [],
      screenshotBase64: screenshotBase64,
      usedCache: fs.existsSync(getSessionPath(login)),
      debug: debugInfo
    });
    
  } catch (error: any) {
    console.error('❌ Ошибка:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message, 
      stack: error.stack,
      screenshotBase64: screenshotBase64 || 'not_captured',
      debug: debugInfo
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
    
    await loginToDrom(page, login, password, context);
    
    const chatUrl = `https://www.drom.ru/personal/messaging/view?dialogId=${dialogId}`;
    console.log('📍 Открываем чат:', chatUrl);
    
    await page.goto(chatUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    
    await page.waitForSelector('textarea[name="message"], textarea', { timeout: 10000 });
    
    console.log('✍️ Вводим текст...');
    await page.fill('textarea[name="message"], textarea', text);
    await page.waitForTimeout(500);
    
    const sendButton = page.locator('button[type="submit"], button:has-text("Отправить")').first();
    if (await sendButton.count() > 0) {
      await sendButton.click();
      console.log('✅ Кнопка отправки нажата');
    } else {
      await page.keyboard.press('Enter');
      console.log('✅ Нажат Enter');
    }
    
    await page.waitForTimeout(3000);
    
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
