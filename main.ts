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

// Получение сообщений
app.post('/drom/get-messages', async (req: Request, res: Response) => {
  const { login, password } = req.body;
  
  if (!login || !password) {
    return res.status(400).json({ error: 'login и password обязательны' });
  }
  
  console.log('🔍 Получаем сообщения с Дром для:', login);
  
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
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 }
    });

    const page = await context.newPage();
    
    console.log('📍 Переход на Дром...');
    await page.goto('https://www.drom.ru/', { waitUntil: 'networkidle' });
    
    // Поиск кнопки входа
    const loginBtn = page.locator('text=Войти').first();
    if (await loginBtn.count() > 0) {
      await loginBtn.click();
      await page.waitForTimeout(2000);
    }
    
    console.log('🔐 Авторизация...');
    await page.fill('input[name="login"], input[type="email"]', login);
    await page.fill('input[name="password"], input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle');
    
    console.log('💬 Открываем чаты...');
    await page.goto('https://www.drom.ru/my/messages/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    
    // Скриншот в base64
    const screenshotBuffer = await page.screenshot();
    const screenshotBase64 = screenshotBuffer.toString('base64');
    
    // Парсинг сообщений
    const messages = await page.evaluate(() => {
      const chats: any[] = [];
      const selectors = [
        '[class*="chat"]',
        '[class*="message"]',
        '[class*="dialog"]',
        '[class*="conversation"]'
      ];
      
      selectors.forEach(selector => {
        document.querySelectorAll(selector).forEach((el, idx) => {
          const text = el.textContent?.trim();
          if (text && text.length > 0) {
            chats.push({
              id: idx,
              selector: selector,
              text: text.substring(0, 150),
              html: el.outerHTML.substring(0, 200)
            });
          }
        });
      });
      
      return chats.slice(0, 20);
    });
    
    await browser.close();
    
    console.log(`✅ Найдено элементов: ${messages.length}`);
    
    res.json({ 
      success: true, 
      count: messages.length,
      messages,
      screenshotPreview: screenshotBase64.substring(0, 100) + '...'
    });
    
  } catch (error: any) {
    console.error('❌ Ошибка:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message, 
      stack: error.stack 
    });
  }
});

// Отправка сообщения
app.post('/drom/send-message', async (req: Request, res: Response) => {
  const { login, password, chatUrl, text } = req.body;
  
  if (!login || !password || !chatUrl || !text) {
    return res.status(400).json({ error: 'Все поля обязательны' });
  }
  
  console.log('📤 Отправляем сообщение:', text.substring(0, 50));
  
  try {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      viewport: { width: 1366, height: 768 }
    });

    const page = await context.newPage();
    
    await page.goto('https://www.drom.ru/');
    const loginBtn = page.locator('text=Войти').first();
    if (await loginBtn.count() > 0) {
      await loginBtn.click();
      await page.waitForTimeout(2000);
    }
    
    await page.fill('input[name="login"], input[type="email"]', login);
    await page.fill('input[name="password"], input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle');
    
    await page.goto(chatUrl);
    await page.waitForTimeout(2000);
    
    await page.fill('textarea, input[type="text"]', text);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    
    await browser.close();
    
    console.log('✅ Сообщение отправлено');
    res.json({ success: true, sent: text });
    
  } catch (error: any) {
    console.error('❌ Ошибка отправки:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Drom automation service на порту ${PORT}`);
});
