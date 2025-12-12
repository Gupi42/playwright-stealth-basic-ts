import express, { Request, Response } from 'express';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const app = express();
app.use(express.json());

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ 
    status: 'ok', 
    service: 'drom-automation',
    timestamp: new Date().toISOString()
  });
});

// Функция авторизации
async function loginToDrom(page: any, login: string, password: string) {
  console.log('🔐 Авторизация на Дром...');
  
  try {
    await page.goto('https://my.drom.ru/sign', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    
    // Заполняем телефон/логин (ваше поле: input[name="sign"])
    await page.fill('input[name="sign"]', login);
    await page.waitForTimeout(800);
    
    // Заполняем пароль
    await page.fill('input[type="password"]', password);
    await page.waitForTimeout(800);
    
    console.log('📸 Форма заполнена, отправляем...');
    
    // Нажимаем кнопку входа
    await page.click('button:has-text("Войти с паролем")');
    
    // Ждём навигацию или продолжаем
    try {
      await page.waitForNavigation({ timeout: 30000, waitUntil: 'networkidle' });
    } catch (navError) {
      console.log('⚠️ Навигация не произошла, проверяем...');
    }
    
    await page.waitForTimeout(3000);
    
    const currentUrl = page.url();
    console.log('📍 URL после входа:', currentUrl);
    
    // Проверяем ошибки
    const hasError = await page.evaluate(() => {
      const errorTexts = ['неверный', 'ошибка', 'неправильный', 'captcha', 'проверка'];
      const pageText = document.body.innerText.toLowerCase();
      return errorTexts.some(err => pageText.includes(err));
    });
    
    if (hasError) {
      const screenshot = await page.screenshot();
      const base64 = screenshot.toString('base64');
      throw new Error(`Ошибка авторизации. Screenshot: ${base64.substring(0, 50)}...`);
    }
    
    // Проверяем куки
    const cookies = await page.context().cookies();
    const hasAuthCookie = cookies.some((c: any) => 
      c.name.includes('auth') || c.name.includes('session') || c.name.includes('drom')
    );
    
    if (!hasAuthCookie && currentUrl.includes('sign')) {
      throw new Error('Авторизация не удалась - нет куки сессии.');
    }
    
    console.log('✅ Авторизация завершена');
    
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
    
    // Авторизация
    await loginToDrom(page, login, password);
    
    // Переход в сообщения (используем ваш URL)
    console.log('💬 Открываем чаты...');
    await page.goto('https://www.drom.ru/personal/messaging/', { 
      waitUntil: 'networkidle',
      timeout: 30000 
    });
    
    // Ждём загрузки списка диалогов
    console.log('⏳ Ждём загрузки диалогов...');
    try {
      await page.waitForSelector('.dialog-list__li', { timeout: 15000 });
      await page.waitForTimeout(3000); // Дополнительная пауза
    } catch (e) {
      console.log('⚠️ Селектор .dialog-list__li не найден');
    }
    
    const currentUrl = page.url();
    console.log('📍 Текущий URL:', currentUrl);
    
    // Скриншот
    const screenshotBuffer = await page.screenshot({ fullPage: true });
    screenshotBase64 = screenshotBuffer.toString('base64');
    
    // Парсим диалоги с точными селекторами
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
      screenshotBase64: screenshotBase64
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
    await loginToDrom(page, login, password);
    
    // Переход в конкретный диалог
    const chatUrl = `https://www.drom.ru/personal/messaging/view?dialogId=${dialogId}`;
    console.log('📍 Открываем чат:', chatUrl);
    
    await page.goto(chatUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    
    // Ждём загрузки поля ввода
    await page.waitForSelector('textarea[name="message"], textarea', { timeout: 10000 });
    
    // Вводим текст
    console.log('✍️ Вводим текст...');
    await page.fill('textarea[name="message"], textarea', text);
    await page.waitForTimeout(500);
    
    // Отправляем (ищем кнопку или Enter)
    const sendButton = page.locator('button[type="submit"], button:has-text("Отправить")').first();
    if (await sendButton.count() > 0) {
      await sendButton.click();
      console.log('✅ Кнопка отправки нажата');
    } else {
      await page.keyboard.press('Enter');
      console.log('✅ Нажат Enter');
    }
    
    await page.waitForTimeout(3000);
    
    // Проверяем, что сообщение появилось в списке
    const messageSent = await page.evaluate((sentText) => {
      const messages = Array.from(document.querySelectorAll('.bzr-dialog__message_out .bzr-dialog__text'));
      return messages.some(msg => msg.textContent?.includes(sentText));
    }, text);
    
    // Скриншот после отправки
    const afterSend = await page.screenshot();
    const afterBase64 = afterSend.toString('base64');
    
    await browser.close();
    
    if (messageSent) {
      console.log('✅ Сообщение подтверждено на странице');
      res.json({ 
        success: true, 
        sent: text, 
        dialogId, 
        confirmed: true 
      });
    } else {
      console.log('⚠️ Сообщение отправлено, но не найдено в списке');
      res.json({ 
        success: true, 
        sent: text, 
        dialogId, 
        confirmed: false, 
        screenshotBase64: afterBase64.substring(0, 100) + '...'
      });
    }
    
  } catch (error: any) {
    console.error('❌ Ошибка отправки:', error.message);
    res.status(500).json({ 
      error: error.message, 
      stack: error.stack 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Drom automation service на порту ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
});
