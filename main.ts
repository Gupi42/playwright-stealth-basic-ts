import express, { Request, Response } from 'express';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';

chromium.use(StealthPlugin());

const app = express();
app.use(express.json());

const SESSIONS_DIR = path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
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

async function loginToDrom(
  page: any, 
  login: string, 
  password: string, 
  context: any, 
  verificationCode?: string
): Promise<{ success: boolean; needsVerification: boolean; message?: string }> {
  const sessionPath = getSessionPath(login);
  
  // Проверяем сохранённую сессию
  if (fs.existsSync(sessionPath) && !verificationCode) {
    console.log('🔄 Загружаем сохранённую сессию...');
    try {
      const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      const sessionAge = Date.now() - sessionData.timestamp;
      
      if (sessionAge < 7 * 24 * 60 * 60 * 1000) { // 7 дней
        await context.addCookies(sessionData.cookies);
        
        await page.goto('https://my.drom.ru/personal/', { 
          waitUntil: 'domcontentloaded', 
          timeout: 15000 
        });
        
        const isLoggedIn = await page.evaluate(() => {
          return !document.body.innerText.includes('Войти') && 
                 !window.location.href.includes('sign');
        });
        
        if (isLoggedIn) {
          console.log('✅ Сессия валидна');
          return { success: true, needsVerification: false };
        } else {
          console.log('⚠️ Сессия устарела');
          fs.unlinkSync(sessionPath);
        }
      } else {
        fs.unlinkSync(sessionPath);
      }
    } catch (e) {
      console.log('⚠️ Ошибка загрузки сессии');
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
    
    // Ждём ответа
    await page.waitForTimeout(3000);
    
    const currentUrl = page.url();
    console.log('📍 URL после входа:', currentUrl);
    
    // Проверяем, требуется ли подтверждение
    const pageState = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      return {
        needsVerification: bodyText.includes('Подтверждение по телефону') || 
                          bodyText.includes('Проверить через Telegram') ||
                          bodyText.includes('Отправить код на телефон'),
        hasTelegramButton: !!Array.from(document.querySelectorAll('button'))
          .find(btn => btn.textContent?.includes('Проверить через Telegram')),
        hasPhoneButton: !!Array.from(document.querySelectorAll('button'))
          .find(btn => btn.textContent?.includes('Отправить код на телефон'))
      };
    });
    
    if (pageState.needsVerification) {
      console.log('📱 Требуется подтверждение устройства');
      
      if (!verificationCode) {
        // Автоматически выбираем Telegram если доступен
        if (pageState.hasTelegramButton) {
          console.log('📲 Нажимаем "Проверить через Telegram"...');
          await page.click('button:has-text("Проверить через Telegram")');
          await page.waitForTimeout(2000);
        }
        
        return { 
          success: false, 
          needsVerification: true,
          message: 'Требуется код подтверждения из Telegram. Отправьте запрос повторно с полем verificationCode'
        };
      }
      
      // Вводим код подтверждения
      console.log('🔢 Вводим код подтверждения:', verificationCode);
      
      // Ищем поле ввода кода
      const hasCodeInput = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        return inputs.some(input => 
          input.type === 'text' || 
          input.type === 'tel' ||
          input.name?.includes('code') ||
          input.placeholder?.toLowerCase().includes('код')
        );
      });
      
      if (!hasCodeInput) {
        // Возможно нужно сначала нажать кнопку
        if (pageState.hasTelegramButton) {
          await page.click('button:has-text("Проверить через Telegram")');
          await page.waitForTimeout(2000);
        } else if (pageState.hasPhoneButton) {
          await page.click('button:has-text("Отправить код на телефон")');
          await page.waitForTimeout(2000);
        }
      }
      
      // Вводим код (пробуем разные селекторы)
      try {
        await page.fill('input[type="text"]', verificationCode);
      } catch {
        try {
          await page.fill('input[type="tel"]', verificationCode);
        } catch {
          try {
            await page.fill('input[name*="code"]', verificationCode);
          } catch {
            await page.fill('input[placeholder*="код"]', verificationCode);
          }
        }
      }
      
      await page.waitForTimeout(1000);
      
      // Ищем и нажимаем кнопку подтверждения
      const hasSubmitButton = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.some(btn => 
          btn.textContent?.includes('Подтвердить') ||
          btn.textContent?.includes('Войти') ||
          btn.type === 'submit'
        );
      });
      
      if (hasSubmitButton) {
        await page.click('button[type="submit"]');
        console.log('✅ Код отправлен');
        await page.waitForTimeout(3000);
      } else {
        // Если нет кнопки, возможно код проверяется автоматически
        await page.waitForTimeout(2000);
      }
    }
    
    // Проверяем финальный результат
    await page.waitForTimeout(2000);
    const finalUrl = page.url();
    console.log('📍 Финальный URL:', finalUrl);
    
    const isSuccess = finalUrl.includes('/personal') && !finalUrl.includes('/sign');
    
    if (isSuccess) {
      // Сохраняем сессию
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
    
    // Проверяем на ошибки
    const hasError = await page.evaluate(() => {
      const errorTexts = ['неверный', 'ошибка', 'неправильный', 'некорректный'];
      const pageText = document.body.innerText.toLowerCase();
      return errorTexts.some(err => pageText.includes(err));
    });
    
    if (hasError) {
      return { 
        success: false, 
        needsVerification: false, 
        message: 'Неверный логин, пароль или код подтверждения' 
      };
    }
    
    return { 
      success: false, 
      needsVerification: false, 
      message: 'Неизвестная ошибка авторизации' 
    };
    
  } catch (error: any) {
    console.error('❌ Ошибка авторизации:', error.message);
    throw error;
  }
}

// Эндпоинт для получения сообщений
app.post('/drom/get-messages', async (req: Request, res: Response) => {
  const { login, password, verificationCode } = req.body;
  
  if (!login || !password) {
    return res.status(400).json({ error: 'login и password обязательны' });
  }
  
  console.log('🔍 Получаем сообщения для:', login.substring(0, 3) + '***');
  
  try {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
        message: loginResult.message
      });
    }
    
    if (!loginResult.success) {
      await browser.close();
      return res.status(401).json({
        success: false,
        message: loginResult.message || 'Ошибка авторизации'
      });
    }
    
    console.log('💬 Получаем список диалогов...');
    
    // Открываем страницу сообщений
    await page.goto('https://my.drom.ru/personal/messaging-modal', { 
      waitUntil: 'networkidle',
      timeout: 30000 
    });
    await page.waitForTimeout(2000);
    
    // Запрашиваем API
    const apiUrl = 'https://my.drom.ru/personal/messaging/inbox-list?ajax=1&fromIndex=0&count=50&list=personal';
    const response = await page.goto(apiUrl, { 
      waitUntil: 'networkidle',
      timeout: 30000 
    });
    
    const jsonText = await response?.text();
    console.log('📦 API ответ, длина:', jsonText?.length);
    
    if (!jsonText || jsonText.length < 10) {
      await browser.close();
      return res.status(500).json({
        success: false,
        error: 'Пустой ответ от API',
        response: jsonText
      });
    }
    
    const data = JSON.parse(jsonText);
    
    if (!data.briefs || !Array.isArray(data.briefs)) {
      await browser.close();
      return res.json({
        success: false,
        error: 'API не вернул диалоги',
        apiResponse: data
      });
    }
    
    const dialogs = data.briefs.map((brief: any, idx: number) => ({
      id: idx,
      dialogId: brief.dialogId,
      interlocutor: brief.interlocutor,
      userName: brief.interlocutor,
      latestMessage: brief.html?.match(/dialog-brief__latest_msg[^>]*>([^<]+)</)?.[1]?.trim() || '',
      time: brief.html?.match(/bzr-dialog__message-dt[^>]*>([^<]+)</)?.[1]?.trim() || '',
      avatar: brief.html?.match(/background-image:\s*url\(([^)]+)\)/)?.[1] || '',
      chatUrl: `https://my.drom.ru${brief.url}`,
      fullUrl: `https://my.drom.ru/personal/messaging/view?dialogId=${brief.dialogId}`,
      isUnread: brief.isUnread,
      lastMessageDate: brief.lastMessageDate,
      canRemove: brief.canRemoveDialog
    }));
    
    await browser.close();
    
    console.log(`✅ Найдено диалогов: ${dialogs.length}`);
    
    res.json({ 
      success: true,
      count: dialogs.length,
      dialogs: dialogs
    });
    
  } catch (error: any) {
    console.error('❌ Ошибка:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message
    });
  }
});

// Эндпоинт для отправки сообщения
app.post('/drom/send-message', async (req: Request, res: Response) => {
  const { login, password, verificationCode, dialogId, text } = req.body;
  
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
    
    const loginResult = await loginToDrom(page, login, password, context, verificationCode);
    
    if (loginResult.needsVerification) {
      await browser.close();
      return res.status(202).json({
        success: false,
        needsVerification: true,
        message: loginResult.message
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
    console.log('📍 Открываем чат:', chatUrl);
    
    await page.goto(chatUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    
    await page.waitForSelector('textarea[name="message"]', { timeout: 10000 });
    
    console.log('✍️ Вводим текст...');
    await page.fill('textarea[name="message"]', text);
    await page.waitForTimeout(500);
    
    const sendButton = page.locator('button[name="post"][value="Отправить"]').first();
    if (await sendButton.count() > 0) {
      await sendButton.click();
      console.log('✅ Кнопка отправки нажата');
    } else {
      await page.keyboard.press('Enter');
      console.log('✅ Нажат Enter');
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
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Drom automation service на порту ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
  console.log(`📍 Get Messages: POST http://localhost:${PORT}/drom/get-messages`);
  console.log(`📍 Send Message: POST http://localhost:${PORT}/drom/send-message`);
});
