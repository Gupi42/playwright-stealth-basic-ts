import express from 'express';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Добавляем stealth-плагин
chromium.use(StealthPlugin());

const app = express();
app.use(express.json());

// Health check эндпоинт
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'drom-automation',
    timestamp: new Date().toISOString()
  });
});

// Получение сообщений с Дром
app.post('/drom/get-messages', async (req, res) => {
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
    
    // Авторизация на Дром
    console.log('📍 Переход на Дром...');
    await page.goto('https://www.drom.ru/', { waitUntil: 'networkidle' });
    
    // Ищем кнопку входа (селектор нужно уточнить через DevTools!)
    const loginBtn = page.locator('text=Войти').first();
    if (await loginBtn.count() > 0) {
      await loginBtn.click();
      await page.waitForTimeout(2000);
    }
    
    // Вводим данные (селекторы примерные, нужно проверить!)
    console.log('🔐 Авторизация...');
    await page.fill('input[name="login"], input[type="email"]', login);
    await page.fill('input[name="password"], input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle');
    
    // Переход в сообщения
    console.log('💬 Открываем чаты...');
    await page.goto('https://www.drom.ru/my/messages/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    
    // Делаем скриншот для отладки
    const screenshot = await page.screenshot({ encoding: 'base64' });
    
    // Парсинг сообщений (ВАЖНО: селекторы нужно уточнить!)
    const messages = await page.evaluate(() => {
      const chats: any[] = [];
      
      // Ищем любые элементы, похожие на чаты
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
      
      return chats.slice(0, 20); // Первые 20 для отладки
    });
    
    await browser.close();
    
    console.log(`✅ Найдено элементов: ${messages.length}`);
    
    res.json({ 
      success: true, 
      count: messages.length,
      messages,
      screenshot: screenshot.substring(0, 100) + '...' // Первые 100 символов
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
app.post('/drom/send-message', async (req, res) => {
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
    
    // Авторизация (копируем логику выше)
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
    
    // Открываем конкретный чат
    await page.goto(chatUrl);
    await page.waitForTimeout(2000);
    
    // Ввод текста (селектор уточнить!)
    await page.fill('textarea, input[type="text"]', text);
    await page.keyboard.press('Enter'); // или click на кнопку
    await page.waitForTimeout(2000);
    
    await browser.close();
    
    console.log('✅ Сообщение отправлено');
    res.json({ success: true, sent: text });
    
  } catch (error: any) {
    console.error('❌ Ошибка отправки:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Drom automation service запущен на порту ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
});
