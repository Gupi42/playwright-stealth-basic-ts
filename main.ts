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
  
  // --- БЛОК 1: ПРОВЕРКА СЕССИИ (без изменений) ---
  if (fs.existsSync(sessionPath)) {
    // ... (код проверки сессии тот же, что был раньше) ...
    // Для краткости этот блок можно оставить из предыдущего ответа, 
    // но если хочешь полный код - скажи, я скину файл целиком.
    // Пока предполагаем, что мы идем сразу на вход.
  }
  
  console.log('🔐 Авторизация на Дром...');
  
  try {
    await page.goto('https://my.drom.ru/sign', { waitUntil: 'domcontentloaded' });
    
    // Ввод логина/пароля
    const loginInput = page.locator('input[name="sign"]');
    await loginInput.waitFor({ state: 'visible', timeout: 10000 });
    await loginInput.fill(login);
    await page.waitForTimeout(300);
    
    await page.locator('input[type="password"]').fill(password);
    await page.waitForTimeout(500);
    await page.click('button:has-text("Войти с паролем")');
    
    // Ждем перехода на шаг 2
    await page.waitForTimeout(3000); 

    const currentUrl = page.url();
    const bodyText = await page.innerText('body');
    const isVerificationPage = bodyText.includes('Подтверждение') || 
                               bodyText.includes('код') || 
                               (currentUrl.includes('/sign') && !bodyText.includes('Войти с паролем'));

    if (isVerificationPage) {
      console.log('📱 Находимся на странице подтверждения...');
      
      // --- НОВАЯ ЛОГИКА: НАЖАТИЕ КНОПКИ ОТПРАВКИ ---
      
      // Ищем кнопки, которые могут инициировать отправку СМС
      // Drom часто пишет "Отправить код на телефон" или просто отображает телефон как ссылку
      const potentialButtons = [
        page.locator('text=Отправить код'),
        page.locator('text=телефон'),
        page.locator('button:has-text("СМС")'),
        page.locator('[role="button"]:has-text("код")')
      ];

      let buttonClicked = false;
      
      for (const btn of potentialButtons) {
        if (await btn.count() > 0 && await btn.first().isVisible()) {
          console.log(`🖱️ Кликаем по кнопке: "${await btn.first().innerText()}"`);
          try {
            await btn.first().click();
            buttonClicked = true;
            // Ждем анимации появления поля ввода
            await page.waitForTimeout(3000); 
            break; // Если кликнули, выходим из цикла
          } catch (e) {
            console.log('Не удалось кликнуть, пробуем следующую...');
          }
        }
      }

      if (!buttonClicked) {
        console.log('⚠️ Кнопка отправки кода не найдена или код уже отправлен автоматически.');
      }

      // --- ДИАГНОСТИКА ПОСЛЕ КЛИКА ---
      console.log('🔍 Сбор информации о полях ввода...');
      
      const timestamp = Date.now();
      
      // 1. Скриншот (чтобы увидеть, появилось ли поле)
      const screenshotName = `debug_after_click_${timestamp}.png`;
      const screenshotPath = path.join(DEBUG_DIR, screenshotName);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      
      // 2. Сбор инпутов
      const inputAnalysis = await page.evaluate(() => {
        // Собираем вообще все инпуты, которые видим
        const inputs = Array.from(document.querySelectorAll('input'));
        return inputs.map(el => {
          const rect = el.getBoundingClientRect();
          const isVisible = rect.width > 0 && rect.height > 0 && el.offsetParent !== null;
          
          return {
            tag: 'input',
            outerHTML: el.outerHTML,
            type: el.type,
            name: el.name,
            id: el.id,
            placeholder: el.placeholder,
            class: el.className,
            isVisible: isVisible,
            value: el.value
          };
        });
      });
      
      console.log('📋 Найденные инпуты:', JSON.stringify(inputAnalysis, null, 2));

      return { 
        success: false, 
        needsVerification: true, 
        message: buttonClicked 
          ? 'Кнопка нажата. Проверьте debug поля.' 
          : 'Кнопка не найдена, проверьте скриншот.',
        debug: {
          screenshotUrl: `/debug/${screenshotName}`,
          foundInputs: inputAnalysis.filter((i: any) => i.isVisible), // Фильтруем только видимые
          buttonClicked: buttonClicked
        }
      };
    }
    
    // Успешный вход без 2FA
    if (currentUrl.includes('/personal') || currentUrl.includes('/messaging')) {
        // ... сохранение кук ...
        return { success: true, needsVerification: false };
    }
    
    return { 
      success: false, 
      needsVerification: false, 
      message: 'Непонятное состояние. URL: ' + currentUrl 
    };
    
  } catch (error: any) {
    console.error('❌ Ошибка:', error.message);
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
