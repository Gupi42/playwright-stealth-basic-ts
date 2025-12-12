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
// Замените функцию loginToDrom на эту версию:
async function loginToDrom(page: any, login: string, password: string) {
  console.log('🔐 Авторизация на Дром...');
  
  try {
    // Переходим на страницу входа
    await page.goto('https://my.drom.ru/sign', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    
    // Заполняем телефон/логин
    await page.fill('input[name="sign"]', login);
    await page.waitForTimeout(800);
    
    // Заполняем пароль
    await page.fill('input[type="password"]', password);
    await page.waitForTimeout(800);
    
    // Делаем скриншот перед отправкой (для отладки)
    const beforeSubmit = await page.screenshot();
    console.log('📸 Скриншот перед отправкой формы сделан');
    
    // Нажимаем кнопку входа
    await page.click('button:has-text("Войти с паролем")');
    
    // Ждём либо редирект, либо ошибку (увеличенный таймаут)
    try {
      await page.waitForNavigation({ timeout: 30000, waitUntil: 'networkidle' });
    } catch (navError) {
      console.log('⚠️ Навигация не произошла, проверяем текущую страницу...');
    }
    
    await page.waitForTimeout(3000);
    
    // Проверяем, успешна ли авторизация
    const currentUrl = page.url();
    console.log('📍 URL после входа:', currentUrl);
    
    // Делаем скриншот после попытки входа
    const afterSubmit = await page.screenshot();
    const afterBase64 = afterSubmit.toString('base64');
    
    // Проверяем наличие ошибок на странице
    const hasError = await page.evaluate(() => {
      const errorTexts = ['неверный', 'ошибка', 'неправильный', 'captcha', 'проверка'];
      const pageText = document.body.innerText.toLowerCase();
      return errorTexts.some(err => pageText.includes(err));
    });
    
    if (hasError) {
      throw new Error(`Ошибка авторизации. Скриншот: ${afterBase64.substring(0, 50)}...`);
    }
    
    // Если всё ок, но редиректа не было - проверяем куки
    const cookies = await page.context().cookies();
    const hasAuthCookie = cookies.some((c: any) => c.name.includes('auth') || c.name.includes('session'));
    
    if (!hasAuthCookie && currentUrl.includes('sign')) {
      throw new Error('Авторизация не удалась - нет куки сессии. Возможно капча или неверные данные.');
    }
    
    console.log('✅ Авторизация завершена (куки найдены)');
    
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
      viewport: { width: 1366, height: 768 },
      locale: 'ru-RU',
      timezoneId: 'Asia/Yekaterinburg'
    });

    const page = await context.newPage();
    
    // Авторизация
    await loginToDrom(page, login, password);
    
    // Переход в сообщения
    console.log('💬 Открываем чаты...');
    await page.goto('https://my.drom.ru/personal/messaging-modal?switchPosition=dialogs', { 
      waitUntil: 'networkidle',
      timeout: 30000 
    });
    await page.waitForTimeout(5000); // Даём время на загрузку чатов
    
    const currentUrl = page.url();
    console.log('📍 Текущий URL:', currentUrl);
    
    // Скриншот страницы чатов
    const screenshotBuffer = await page.screenshot({ fullPage: true });
    screenshotBase64 = screenshotBuffer.toString('base64');
    
    // Сохраняем полный HTML для анализа
    const pageHTML = await page.content();
    
    // Парсим чаты
    const messages = await page.evaluate(() => {
      const chats: any[] = [];
      
      // Ищем все ссылки на чаты
      document.querySelectorAll('a[href*="/my/messages/"]').forEach((el, idx) => {
        const href = (el as HTMLAnchorElement).href;
        const text = el.textContent?.trim();
        
        if (text && text.length > 5) {
          chats.push({
            id: idx,
            chatUrl: href,
            previewText: text.substring(0, 200),
            outerHTML: el.outerHTML.substring(0, 400)
          });
        }
      });
      
      return chats;
    });
    
    await browser.close();
    
    console.log(`✅ Найдено чатов: ${messages.length}`);
    
    res.json({ 
      success: true,
      currentUrl,
      count: messages.length,
      messages,
      screenshotBase64: screenshotBase64, // Полный скриншот для отладки
      htmlLength: pageHTML.length
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
