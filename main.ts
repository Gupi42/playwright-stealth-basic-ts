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

// Функция авторизации (используется в обоих эндпоинтах)
async function loginToDrom(page: any, login: string, password: string) {
  console.log('🔐 Авторизация на Дром...');
  
  // Переходим сразу на страницу входа
  await page.goto('https://my.drom.ru/sign', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  
  // Заполняем телефон/логин (из скриншота видно: обычный input без атрибута name)
  await page.fill('input[name="sign"]', login);
  await page.waitForTimeout(500);
  
  // Заполняем пароль
  await page.fill('input[name="password"]', password);
  await page.waitForTimeout(500);
  
  // Нажимаем "Войти с паролем"
  await page.click('button:has-text("Войти с паролем")');
  
  // Ждём редиректа после входа
  await page.waitForNavigation({ timeout: 15000 });
  await page.waitForTimeout(2000);
  
  console.log('✅ Авторизация завершена');
}

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
      viewport: { width: 1366, height: 768 },
      locale: 'ru-RU'
    });

    const page = await context.newPage();
    
    // Авторизация
    await loginToDrom(page, login, password);
    
    // Переход в сообщения
    console.log('💬 Открываем чаты...');
    await page.goto('https://www.drom.ru/my/messages/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    
    // Получаем URL текущей страницы для отладки
    const currentUrl = page.url();
    console.log('📍 Текущий URL:', currentUrl);
    
    // Скриншот для отладки
    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const screenshotBase64 = screenshotBuffer.toString('base64');
    
    // Парсим HTML страницы для анализа
    const pageContent = await page.content();
    
    // Пытаемся найти элементы чатов
    const messages = await page.evaluate(() => {
      const chats: any[] = [];
      
      // Разные варианты селекторов для поиска чатов
      const selectors = [
        '[class*="chat"]',
        '[class*="message"]',
        '[class*="dialog"]',
        '[class*="conversation"]',
        '[data-chat]',
        '[data-message]',
        'a[href*="/my/messages/"]'
      ];
      
      selectors.forEach(selector => {
        document.querySelectorAll(selector).forEach((el, idx) => {
          const text = el.textContent?.trim();
          if (text && text.length > 10) { // Только если есть осмысленный текст
            chats.push({
              id: `${selector}_${idx}`,
              selector: selector,
              text: text.substring(0, 200),
              html: el.outerHTML.substring(0, 300),
              classes: el.className
            });
          }
        });
      });
      
      return chats.slice(0, 30); // Первые 30 элементов
    });
    
    await browser.close();
    
    console.log(`✅ Найдено элементов: ${messages.length}`);
    
    res.json({ 
      success: true,
      currentUrl,
      count: messages.length,
      messages,
      screenshotBase64: screenshotBase64.substring(0, 100) + '...', // Preview
      pageTitle: await page.title()
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
    return res.status(400).json({ error: 'Все поля обязательны: login, password, chatUrl, text' });
  }
  
  console.log('📤 Отправляем сообщение в чат:', chatUrl);
  
  try {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'ru-RU'
    });

    const page = await context.newPage();
    
    // Авторизация
    await loginToDrom(page, login, password);
    
    // Переход в конкретный чат
    await page.goto(chatUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    
    // Ввод текста (селектор уточнить после теста!)
    await page.fill('textarea, input[type="text"]', text);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    
    await browser.close();
    
    console.log('✅ Сообщение отправлено');
    res.json({ success: true, sent: text, chatUrl });
    
  } catch (error: any) {
    console.error('❌ Ошибка отправки:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Drom automation service на порту ${PORT}`);
});
