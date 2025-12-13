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
  
  if (fs.existsSync(sessionPath)) {
    console.log('🔄 Загружаем сохранённую сессию...');
    try {
      const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      const sessionAge = Date.now() - sessionData.timestamp;
      
      if (sessionAge < 30 * 24 * 60 * 60 * 1000) {
        await context.addCookies(sessionData.cookies);
        
        await page.goto('https://my.drom.ru/personal/', { 
          waitUntil: 'domcontentloaded', 
          timeout: 15000 
        });
        
        await page.waitForTimeout(2000);
        
        const isLoggedIn = await page.evaluate(() => {
          return !document.body.innerText.includes('Войти') && 
                 !window.location.href.includes('sign');
        });
        
        if (isLoggedIn) {
          console.log('✅ Сессия валидна');
          return { success: true, needsVerification: false };
        } else {
          console.log('⚠️ Сессия устарела, удаляем');
          fs.unlinkSync(sessionPath);
        }
      } else {
        console.log('⚠️ Сессия слишком старая, удаляем');
        fs.unlinkSync(sessionPath);
      }
    } catch (e: any) {
      console.log('⚠️ Ошибка загрузки сессии:', e.message);
      if (fs.existsSync(sessionPath)) {
        fs.unlinkSync(sessionPath);
      }
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
    
    await page.waitForTimeout(3000);
    
    const currentUrl = page.url();
    console.log('📍 URL после входа:', currentUrl);
    
    const pageAnalysis = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      const allClickableElements: any[] = [];
      
      const selectors = ['button', 'a', 'div[onclick]', 'span[onclick]', '[role="button"]'];
      selectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => {
          const text = (el.textContent || '').trim();
          const visible = (el as HTMLElement).offsetParent !== null;
          if (text.length > 0 && text.length < 200) {
            allClickableElements.push({
              tag: el.tagName.toLowerCase(),
              text: text,
              visible: visible,
              className: el.className,
              id: (el as HTMLElement).id || '',
              hasPhone: text.toLowerCase().includes('телефон')
            });
          }
        });
      });
      
      return {
        url: window.location.href,
        bodyText: bodyText.substring(0, 1000),
        needsVerification: bodyText.includes('Подтверждение') || bodyText.includes('код'),
        phoneElements: allClickableElements.filter(el => el.hasPhone)
      };
    });
    
    if (pageAnalysis.needsVerification) {
      console.log('📱 Требуется подтверждение устройства');
      
      const timestamp = Date.now();
      const screenshotPath = path.join(DEBUG_DIR, `verification_${timestamp}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      
      const debugInfo: any = {
        screenshotUrl: `/debug/verification_${timestamp}.png`,
        phoneElements: pageAnalysis.phoneElements
      };
      
      if (!verificationCode) {
        let clicked = false;
        
        try {
          await page.click('text=Отправить код на телефон', { timeout: 3000 });
          clicked = true;
          await page.waitForTimeout(5000);
        } catch (e) {
          try {
            await page.click('text=телефон', { timeout: 3000 });
            clicked = true;
            await page.waitForTimeout(5000);
          } catch (e2) {
            console.log('⚠️ Не удалось нажать кнопку телефона');
          }
        }
        
        const afterClickPath = path.join(DEBUG_DIR, `after_phone_${timestamp}.png`);
        await page.screenshot({ path: afterClickPath, fullPage: true });
        debugInfo.afterClickScreenshotUrl = `/debug/after_phone_${timestamp}.png`;
        
        return { 
          success: false, 
          needsVerification: true,
          message: '✅ SMS код отправлен! Введите его в поле verificationCode',
          debug: debugInfo
        };
      }
      
      // Вводим код
      await page.waitForTimeout(2000);
      
      const inputFilled = await page.evaluate((code: string) => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const codeInput = inputs.find(inp => 
          inp.offsetParent !== null && 
          (inp.type === 'text' || inp.type === 'tel' || inp.type === 'number')
        );
        
        if (codeInput) {
          codeInput.value = code;
          codeInput.dispatchEvent(new Event('input', { bubbles: true }));
          codeInput.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      }, verificationCode);
      
      if (inputFilled) {
        await page.waitForTimeout(1500);
        
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, [type="submit"]'));
          const submitBtn = buttons.find(btn => {
            const text = (btn.textContent || '').toLowerCase();
            const visible = (btn as HTMLElement).offsetParent !== null;
            return visible && (text.includes('подтвердить') || text.includes('войти'));
          });
          
          if (submitBtn && submitBtn instanceof HTMLElement) {
            submitBtn.click();
          }
        });
        
        await page.waitForTimeout(5000);
      }
    }
    
    // Проверка успеха
    await page.waitForTimeout(2000);
    const finalUrl = page.url();
    const isSuccess = (finalUrl.includes('/personal') && !finalUrl.includes('/sign')) || 
                      finalUrl.includes('/messaging');
    
    if (isSuccess) {
      const cookies = await context.cookies();
      fs.writeFileSync(sessionPath, JSON.stringify({
        cookies: cookies,
        timestamp: Date.now(),
        login: login.substring(0, 3) + '***',
        verified: true
      }, null, 2));
      
      console.log('✅ Авторизация успешна, сессия сохранена');
      return { success: true, needsVerification: false };
    }
    
    return { 
      success: false, 
      needsVerification: false, 
      message: 'Ошибка авторизации. URL: ' + finalUrl
    };
    
  } catch (error: any) {
    console.error('❌ Ошибка авторизации:', error.message);
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
