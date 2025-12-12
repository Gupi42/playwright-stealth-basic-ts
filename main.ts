import express, { Request, Response } from 'express';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const app = express();
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ 
    status: 'ok', 
    service: 'drom-automation-debug',
    timestamp: new Date().toISOString()
  });
});

app.post('/drom/debug-login', async (req: Request, res: Response) => {
  const { login, password } = req.body;
  
  if (!login || !password) {
    return res.status(400).json({ error: 'login и password обязательны' });
  }
  
  console.log('🔍 DEBUG: Тестируем авторизацию для:', login.substring(0, 3) + '***');
  
  const debug: any = {
    steps: [],
    screenshots: {},
    cookies: {},
    urls: [],
    errors: []
  };
  
  try {
    const browser = await chromium.launch({
      headless: true,
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
    
    // Логируем все console.log из браузера
    page.on('console', (msg: any) => {
      debug.steps.push({ type: 'browser_console', text: msg.text() });
    });
    
    // ШАГ 1: Переход на страницу входа
    console.log('📍 Шаг 1: Переход на страницу входа');
    debug.steps.push('Переход на https://my.drom.ru/sign');
    
    await page.goto('https://my.drom.ru/sign', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    
    debug.urls.push({ step: 1, url: page.url() });
    
    // Скриншот 1: До заполнения формы
    const screenshot1 = await page.screenshot({ fullPage: false });
    debug.screenshots.before_fill = screenshot1.toString('base64');
    debug.steps.push('Скриншот 1: Страница входа загружена');
    
    // Проверяем наличие полей формы
    const formCheck = await page.evaluate(() => {
      const signInput = document.querySelector('input[name="sign"]');
      const passwordInput = document.querySelector('input[type="password"]');
      const submitButton = document.querySelector('button:has-text("Войти с паролем")') || 
                          document.querySelector('button[type="submit"]');
      
      return {
        hasSignInput: !!signInput,
        hasPasswordInput: !!passwordInput,
        hasSubmitButton: !!submitButton,
        signInputVisible: signInput ? (signInput as HTMLElement).offsetParent !== null : false,
        passwordInputVisible: passwordInput ? (passwordInput as HTMLElement).offsetParent !== null : false,
        bodyText: document.body.innerText.substring(0, 500)
      };
    });
    
    debug.steps.push({ type: 'form_check', data: formCheck });
    console.log('🔍 Проверка формы:', formCheck);
    
    // ШАГ 2: Заполнение логина
    console.log('📝 Шаг 2: Заполняем логин');
    debug.steps.push(`Заполняем поле sign значением: ${login.substring(0, 3)}***`);
    
    await page.fill('input[name="sign"]', login);
    await page.waitForTimeout(1000);
    
    // Скриншот 2: После ввода логина
    const screenshot2 = await page.screenshot({ fullPage: false });
    debug.screenshots.after_login_input = screenshot2.toString('base64');
    
    // ШАГ 3: Заполнение пароля
    console.log('🔑 Шаг 3: Заполняем пароль');
    debug.steps.push('Заполняем поле password');
    
    await page.fill('input[type="password"]', password);
    await page.waitForTimeout(1000);
    
    // Скриншот 3: После ввода пароля
    const screenshot3 = await page.screenshot({ fullPage: false });
    debug.screenshots.after_password_input = screenshot3.toString('base64');
    
    // Проверяем значения полей перед отправкой
    const inputValues = await page.evaluate(() => {
      const signInput = document.querySelector('input[name="sign"]') as HTMLInputElement;
      const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
      
      return {
        loginLength: signInput?.value?.length || 0,
        passwordLength: passwordInput?.value?.length || 0,
        loginFilled: (signInput?.value?.length || 0) > 0,
        passwordFilled: (passwordInput?.value?.length || 0) > 0
      };
    });
    
    debug.steps.push({ type: 'input_values_check', data: inputValues });
    console.log('🔍 Проверка значений полей:', inputValues);
    
    // ШАГ 4: Клик по кнопке
    console.log('👆 Шаг 4: Нажимаем кнопку входа');
    debug.steps.push('Клик по кнопке "Войти с паролем"');
    
    // Пытаемся найти кнопку разными способами
    const buttonInfo = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      return buttons.map(btn => ({
        text: btn.textContent?.trim(),
        type: btn.type,
        name: btn.name,
        value: btn.value,
        disabled: btn.disabled,
        visible: btn.offsetParent !== null
      }));
    });
    
    debug.steps.push({ type: 'available_buttons', data: buttonInfo });
    console.log('🔍 Доступные кнопки:', buttonInfo);
    
    await page.click('button:has-text("Войти с паролем")');
    debug.steps.push('Кнопка нажата');
    
    // Скриншот 4: Сразу после клика
    await page.waitForTimeout(500);
    const screenshot4 = await page.screenshot({ fullPage: false });
    debug.screenshots.after_submit_click = screenshot4.toString('base64');
    
    // ШАГ 5: Ждём навигации
    console.log('⏳ Шаг 5: Ждём навигации...');
    debug.steps.push('Ожидание навигации');
    
    let navigationHappened = false;
    try {
      await page.waitForNavigation({ timeout: 15000, waitUntil: 'networkidle' });
      navigationHappened = true;
      debug.steps.push('Навигация произошла');
    } catch (e) {
      debug.steps.push('Навигация НЕ произошла (timeout)');
      debug.errors.push('Navigation timeout');
    }
    
    debug.urls.push({ step: 5, url: page.url(), navigationHappened });
    
    // Ждём дополнительное время
    await page.waitForTimeout(3000);
    
    // Скриншот 5: После попытки навигации
    const screenshot5 = await page.screenshot({ fullPage: true });
    debug.screenshots.after_navigation = screenshot5.toString('base64');
    
    debug.urls.push({ step: 'final', url: page.url() });
    
    // ШАГ 6: Проверка результата
    console.log('🔍 Шаг 6: Проверяем результат');
    const finalCheck = await page.evaluate(() => {
      return {
        currentUrl: window.location.href,
        bodyText: document.body.innerText.substring(0, 1000),
        hasErrorText: document.body.innerText.toLowerCase().includes('неверный') ||
                     document.body.innerText.toLowerCase().includes('ошибка'),
        title: document.title,
        hasPersonalMenu: !!document.querySelector('.personalLinks'),
        hasSignForm: !!document.querySelector('input[name="sign"]')
      };
    });
    
    debug.steps.push({ type: 'final_check', data: finalCheck });
    console.log('🔍 Финальная проверка:', finalCheck);
    
    // Сохраняем cookies
    const cookies = await context.cookies();
    debug.cookies.count = cookies.length;
    debug.cookies.list = cookies.map(c => ({ name: c.name, domain: c.domain, path: c.path }));
    debug.cookies.hasAuth = cookies.some(c => c.name.includes('auth') || c.name.includes('session'));
    
    await browser.close();
    
    // Определяем успешность
    const isSuccess = finalCheck.currentUrl.includes('/personal') && 
                     !finalCheck.currentUrl.includes('/sign') &&
                     !finalCheck.hasErrorText;
    
    debug.success = isSuccess;
    debug.conclusion = isSuccess ? 
      'Авторизация УСПЕШНА' : 
      'Авторизация ПРОВАЛИЛАСЬ - всё ещё на странице входа или есть ошибка';
    
    console.log('✅ DEBUG завершён. Успех:', isSuccess);
    
    res.json(debug);
    
  } catch (error: any) {
    console.error('❌ Ошибка в DEBUG:', error.message);
    debug.errors.push(error.message);
    debug.fatalError = {
      message: error.message,
      stack: error.stack
    };
    res.status(500).json(debug);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Drom DEBUG service на порту ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
  console.log(`📍 Debug: POST http://localhost:${PORT}/drom/debug-login`);
});
