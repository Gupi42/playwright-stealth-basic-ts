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
  
  // --- БЛОК 1: ПРОВЕРКА СОХРАНЕННОЙ СЕССИИ (Оставляем как было) ---
  if (fs.existsSync(sessionPath)) {
    console.log('🔄 Загружаем сохранённую сессию...');
    try {
      const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      if (Date.now() - sessionData.timestamp < 7 * 24 * 60 * 60 * 1000) {
        await context.addCookies(sessionData.cookies);
        await page.goto('https://my.drom.ru/personal/', { waitUntil: 'domcontentloaded', timeout: 15000 });
        try {
            await page.waitForURL('**/personal/**', { timeout: 5000 });
            if (await page.locator('a[href*="/sign"]').count() === 0) {
              console.log('✅ Сессия валидна');
              return { success: true, needsVerification: false };
            }
        } catch (e) {}
        console.log('⚠️ Сессия устарела');
        fs.unlinkSync(sessionPath);
      }
    } catch (e) {}
  }
  
  // --- БЛОК 2: АВТОРИЗАЦИЯ ---
  console.log('🔐 Авторизация на Дром...');
  
  try {
    await page.goto('https://my.drom.ru/sign', { waitUntil: 'domcontentloaded' });
    
    // Ввод логина и пароля
    const loginInput = page.locator('input[name="sign"]');
    await loginInput.waitFor({ state: 'visible', timeout: 10000 });
    await loginInput.fill(login);
    await page.waitForTimeout(300);
    
    await page.locator('input[type="password"]').fill(password);
    await page.waitForTimeout(500);
    await page.click('button:has-text("Войти с паролем")');
    
    // Ждем реакции страницы (переход или запрос кода)
    await page.waitForTimeout(3000); 

    // --- БЛОК 3: ДИАГНОСТИКА СТРАНИЦЫ ПОДТВЕРЖДЕНИЯ ---
    
    // Проверяем, остались ли мы на странице входа или нас перекинуло на confirm
    // Признаки 2FA: URL содержит 'sign', текст "код" или "подтверждение"
    const currentUrl = page.url();
    const bodyText = await page.innerText('body');
    const isVerificationPage = bodyText.includes('Подтверждение') || 
                               bodyText.includes('код') || 
                               (currentUrl.includes('/sign') && !bodyText.includes('Войти с паролем'));

    if (isVerificationPage) {
      console.log('🔍 ПОПАЛИ НА ЭТАП ПРОВЕРКИ. СБОР ИНФОРМАЦИИ...');
      
      const timestamp = Date.now();
      
      // 1. Делаем скриншот того, что видит бот
      const screenshotName = `debug_auth_${timestamp}.png`;
      const screenshotPath = path.join(DEBUG_DIR, screenshotName);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      
      // 2. Собираем HTML всех инпутов для анализа
      const inputAnalysis = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        return inputs.map(el => ({
          outerHTML: el.outerHTML, // Полный HTML тега
          type: el.type,
          name: el.name,
          id: el.id,
          placeholder: el.placeholder,
          class: el.className,
          isVisible: el.offsetParent !== null // Виден ли элемент глазу
        }));
      });
      
      console.log('📋 Найденные инпуты:', inputAnalysis);

      // Сохраним полный HTML страницы на всякий случай
      const htmlPath = path.join(DEBUG_DIR, `debug_page_${timestamp}.html`);
      fs.writeFileSync(htmlPath, await page.content());

      return { 
        success: false, 
        needsVerification: true,
        message: 'Требуется анализ полей. См. debug поле.',
        debug: {
          screenshotUrl: `/debug/${screenshotName}`,
          foundInputs: inputAnalysis, // <--- ВОТ ЭТО САМОЕ ВАЖНОЕ
          currentUrl: currentUrl,
          htmlDumpUrl: `/debug/debug_page_${timestamp}.html`
        }
      };
    }
    
    // Проверка успешного входа (если 2FA не было)
    if (currentUrl.includes('/personal') || currentUrl.includes('/messaging')) {
      const cookies = await context.cookies();
      fs.writeFileSync(sessionPath, JSON.stringify({
        cookies: cookies,
        timestamp: Date.now(),
        login: login,
        verified: true
      }, null, 2));
      return { success: true, needsVerification: false };
    }
    
    // Если и не вошли, и не 2FA
    return { 
      success: false, 
      needsVerification: false, 
      message: 'Непонятное состояние. URL: ' + currentUrl
    };
    
  } catch (error: any) {
    console.error('❌ Ошибка:', error.message);
    const timestamp = Date.now();
    await page.screenshot({ path: path.join(DEBUG_DIR, `fatal_error_${timestamp}.png`) });
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
