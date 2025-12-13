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

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

if (!fs.existsSync(DEBUG_DIR)) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

function getSessionPath(login: string): string {
  const sanitized = login.replace(/[^a-zA-Z0-9]/g, '_');
  return path.join(SESSIONS_DIR, `session_${sanitized}.json`);
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({ 
    status: 'ok', 
    service: 'drom-automation',
    timestamp: new Date().toISOString()
  });
});

app.get('/debug/:filename', (req: Request, res: Response) => {
  const filename = req.params.filename;
  const filepath = path.join(DEBUG_DIR, filename);
  
  if (fs.existsSync(filepath)) {
    res.sendFile(filepath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

app.get('/debug', (_req: Request, res: Response) => {
  const files = fs.readdirSync(DEBUG_DIR);
  const fileList = files.map(f => ({
    name: f,
    url: `/debug/${f}`,
    size: fs.statSync(path.join(DEBUG_DIR, f)).size
  }));
  res.json({ files: fileList, count: files.length });
});

async function loginToDrom(
  page: any, 
  login: string, 
  password: string, 
  context: any, 
  verificationCode?: string
): Promise<{ success: boolean; needsVerification: boolean; message?: string; debug?: any; warning?: string }> {
  const sessionPath = getSessionPath(login);
  
  // 1. ПРОВЕРКА СОХРАНЕННОЙ СЕССИИ
  if (fs.existsSync(sessionPath)) {
    console.log('🔄 Найдена сохранённая сессия, пробуем восстановить...');
    try {
      const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      // Если сессии меньше 30 дней
      if (Date.now() - sessionData.timestamp < 30 * 24 * 60 * 60 * 1000) {
        await context.addCookies(sessionData.cookies);
        
        // Проверяем, жива ли сессия переходом в ЛК
        await page.goto('https://my.drom.ru/personal/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        
        try {
            // Ждем завершения редиректов
            await page.waitForTimeout(1000); 
            const currentUrl = page.url();
            
            // Если нас не выкинуло на /sign, значит мы внутри
            if (!currentUrl.includes('/sign')) {
              console.log('✅ Сессия активна, вход выполнен автоматически');
              return { success: true, needsVerification: false };
            }
        } catch (e) {}
        
        console.log('⚠️ Сессия устарела или сброшена сервером');
        fs.unlinkSync(sessionPath); // Удаляем старую
      }
    } catch (e: any) {
      console.log('⚠️ Ошибка чтения сессии:', e.message);
    }
  }
  
  // 2. ПОЛНАЯ АВТОРИЗАЦИЯ
  console.log('🔐 Начинаем вход с паролем...');
  
  try {
    await page.goto('https://my.drom.ru/sign', { waitUntil: 'domcontentloaded' });
    
    // Ввод логина
    const loginInput = page.locator('input[name="sign"]');
    await loginInput.waitFor({ state: 'visible', timeout: 10000 });
    await loginInput.fill(login);
    await page.waitForTimeout(300);
    
    // Ввод пароля
    await page.locator('input[type="password"]').fill(password);
    await page.waitForTimeout(500);
    
    // Кнопка входа
    await page.click('button:has-text("Войти с паролем")');
    
    await page.waitForTimeout(3000); // Ждем реакции
    
    // 3. ПРОВЕРКА НА 2FA (SMS)
    const currentUrl = page.url();
    const bodyText = await page.innerText('body');
    const isVerificationPage = bodyText.includes('Подтверждение') || bodyText.includes('код') || currentUrl.includes('/sign');

    if (isVerificationPage && !currentUrl.includes('/personal')) {
      console.log('📱 Требуется подтверждение по СМС');

      // Локатор для поля ввода (тот самый, который мы нашли)
      const codeInput = page.locator('input[name="code"]');
      
      // Если поле НЕ видимо, значит нужно нажать "Отправить код"
      if (!(await codeInput.isVisible())) {
          console.log('🖱️ Поле ввода не видно, ищем кнопку отправки СМС...');
          const sendButtons = [
            page.locator('text=Отправить код'),
            page.locator('text=телефон'),
            page.locator('button:has-text("СМС")')
          ];

          for (const btn of sendButtons) {
            if (await btn.count() > 0 && await btn.first().isVisible()) {
                await btn.first().click();
                console.log('✅ Нажата кнопка отправки кода');
                await page.waitForTimeout(2000);
                break;
            }
          }
      }

      // Если кода нет в запросе — возвращаем просьбу его ввести
      if (!verificationCode) {
        const timestamp = Date.now();
        await page.screenshot({ path: path.join(DEBUG_DIR, `need_code_${timestamp}.png`) });
        
        return { 
          success: false, 
          needsVerification: true,
          message: 'SMS отправлено. Введите полученный код в поле verificationCode',
          debug: { screenshotUrl: `/debug/need_code_${timestamp}.png` }
        };
      }

      // 4. ВВОД КОДА
      console.log(`✍️ Вводим код подтверждения: ${verificationCode}`);
      
      await codeInput.waitFor({ state: 'visible', timeout: 5000 });
      await codeInput.fill(verificationCode);
      await page.waitForTimeout(500);

      // Жмем подтвердить (ищем кнопку по разным текстам)
      const confirmBtn = page.locator('button:has-text("Подтвердить"), button:has-text("Войти")').first();
      if (await confirmBtn.isVisible()) {
          await confirmBtn.click();
      } else {
          // Иногда достаточно нажать Enter
          await page.keyboard.press('Enter');
      }

      console.log('⏳ Ждем проверки кода...');
      // Ждем перехода в личный кабинет
      try {
        await page.waitForURL(url => url.toString().includes('/personal') || url.toString().includes('/messaging'), { timeout: 20000 });
      } catch (e) {
         console.log('⚠️ Тайм-аут перехода. Возможно, неверный код.');
      }
    }
    
    // 5. ФИНАЛЬНАЯ ПРОВЕРКА И СОХРАНЕНИЕ
    const finalUrl = page.url();
    const isSuccess = finalUrl.includes('/personal') || finalUrl.includes('/messaging');
    
    if (isSuccess) {
      console.log('🎉 Успешный вход!');
      const cookies = await context.cookies();
      fs.writeFileSync(sessionPath, JSON.stringify({
        cookies: cookies,
        timestamp: Date.now(),
        login: login,
        verified: true
      }, null, 2));
      
      return { success: true, needsVerification: false };
    }
    
    // Если дошли сюда — значит вход не удался
    const timestamp = Date.now();
    await page.screenshot({ path: path.join(DEBUG_DIR, `fail_${timestamp}.png`) });
    
    return { 
      success: false, 
      needsVerification: false, 
      message: 'Неверный код или ошибка сайта. URL: ' + finalUrl,
      debug: { screenshotUrl: `/debug/fail_${timestamp}.png` }
    };
    
  } catch (error: any) {
    console.error('❌ Критическая ошибка:', error.message);
    throw error;
  }
}

app.post('/drom/get-messages', async (req: Request, res: Response) => {
  const { login, password, verificationCode } = req.body;
  
  if (!login || !password) {
    return res.status(400).json({ error: 'login и password обязательны' });
  }
  
  console.log('🔍 Получаем сообщения для:', login.substring(0, 3) + '***');
  
  let browser;
  
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'ru-RU',
      timezoneId: 'Asia/Yekaterinburg'
    });

    const page = await context.newPage();
    
    const loginResult = await loginToDrom(page, login, password, context, verificationCode);
    
    if (loginResult.needsVerification) {
      await browser.close();
      return res.status(202).json({
        success: false,
        needsVerification: true,
        message: loginResult.message,
        debug: loginResult.debug
      });
    }
    
    if (!loginResult.success) {
      await browser.close();
      return res.status(401).json({
        success: false,
        message: loginResult.message || 'Ошибка авторизации'
      });
    }
    
    console.log('💬 Парсим диалоги со страницы...');
    
    // ✅ ПАРСИНГ HTML ВМЕСТО API
    await page.goto('https://my.drom.ru/personal/messaging-modal?switchPosition=dialogs', { 
      waitUntil: 'networkidle',
      timeout: 30000 
    });
    await page.waitForTimeout(3000);
    
    // Парсим диалоги из HTML
    const dialogs = await page.evaluate(() => {
      const dialogElements = Array.from(document.querySelectorAll('.bzr-dialog-brief'));
      
      return dialogElements.map((el, idx) => {
        const nameEl = el.querySelector('.bzr-dialog__interlocutor-name');
        const messageEl = el.querySelector('.bzr-dialog__latest_msg');
        const timeEl = el.querySelector('.bzr-dialog__message-dt');
        const linkEl = el.querySelector('a[href*="/messaging/view"]');
        const avatarEl = el.querySelector('.bzr-dialog__avatar');
        
        const href = linkEl ? linkEl.getAttribute('href') : '';
        const dialogIdMatch = href?.match(/dialogId=([^&]+)/);
        const dialogId = dialogIdMatch ? dialogIdMatch[1] : '';
        
        let avatarUrl = '';
        if (avatarEl) {
          const style = window.getComputedStyle(avatarEl);
          const bgImage = style.backgroundImage;
          const urlMatch = bgImage.match(/url\(["']?([^"')]+)["']?\)/);
          if (urlMatch) {
            avatarUrl = urlMatch[1];
          }
        }
        
        return {
          id: idx,
          dialogId: dialogId,
          userName: nameEl?.textContent?.trim() || '',
          interlocutor: nameEl?.textContent?.trim() || '',
          latestMessage: messageEl?.textContent?.trim() || '',
          time: timeEl?.textContent?.trim() || '',
          avatar: avatarUrl,
          chatUrl: href ? `https://my.drom.ru${href}` : '',
          fullUrl: dialogId ? `https://my.drom.ru/personal/messaging/view?dialogId=${dialogId}` : '',
          isUnread: el.classList.contains('unread') || el.classList.contains('bzr-dialog-brief_unread')
        };
      });
    });
    
    await browser.close();
    
    console.log(`✅ Найдено диалогов: ${dialogs.length}`);
    
    res.json({ 
      success: true,
      count: dialogs.length,
      dialogs: dialogs
    });
    
  } catch (error: any) {
    console.error('❌ Ошибка:', error.message);
    if (browser) {
      await browser.close();
    }
    res.status(500).json({ 
      success: false,
      error: error.message
    });
  }
});

app.post('/drom/send-message', async (req: Request, res: Response) => {
  const { login, password, verificationCode, dialogId, text } = req.body;
  
  if (!login || !password || !dialogId || !text) {
    return res.status(400).json({ 
      error: 'Все поля обязательны: login, password, dialogId, text' 
    });
  }
  
  let browser;
  
  try {
    browser = await chromium.launch({
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
    
    const loginResult = await loginToDrom(page, login, password, context, verificationCode);
    
    if (loginResult.needsVerification) {
      await browser.close();
      return res.status(202).json({
        success: false,
        needsVerification: true,
        message: loginResult.message,
        debug: loginResult.debug
      });
    }
    
    if (!loginResult.success) {
      await browser.close();
      return res.status(401).json({
        success: false,
        message: loginResult.message
      });
    }
    
    const chatUrl = `https://my.drom.ru/personal/messaging/view?dialogId=${dialogId}`;
    
    await page.goto(chatUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    
    await page.waitForSelector('textarea[name="message"]', { timeout: 10000 });
    await page.fill('textarea[name="message"]', text);
    await page.waitForTimeout(500);
    
    const sendButton = page.locator('button[name="post"][value="Отправить"]').first();
    if (await sendButton.count() > 0) {
      await sendButton.click();
    } else {
      await page.keyboard.press('Enter');
    }
    
    await page.waitForTimeout(3000);
    
    const messageSent = await page.evaluate((sentText) => {
      const messages = Array.from(document.querySelectorAll('.bzr-dialog__message_out .bzr-dialog__text'));
      return messages.some(msg => msg.textContent?.includes(sentText));
    }, text);
    
    await browser.close();
    
    res.json({ 
      success: true, 
      sent: text, 
      dialogId, 
      confirmed: messageSent 
    });
    
  } catch (error: any) {
    console.error('❌ Ошибка отправки:', error.message);
    if (browser) {
      await browser.close();
    }
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Drom automation service на порту ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
  console.log(`📍 Debug: http://localhost:${PORT}/debug`);
  console.log(`📍 Get Messages: POST http://localhost:${PORT}/drom/get-messages`);
  console.log(`📍 Send Message: POST http://localhost:${PORT}/drom/send-message`);
});
