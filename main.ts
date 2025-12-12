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

// Эндпоинт для скачивания debug файлов
app.get('/debug/:filename', (req: Request, res: Response) => {
  const filename = req.params.filename;
  const filepath = path.join(DEBUG_DIR, filename);
  
  if (fs.existsSync(filepath)) {
    res.sendFile(filepath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Список debug файлов
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
): Promise<{ success: boolean; needsVerification: boolean; message?: string; debug?: any }> {
  const sessionPath = getSessionPath(login);
  
  // Проверяем сохранённую сессию
  if (fs.existsSync(sessionPath)) {
    console.log('🔄 Загружаем сохранённую сессию...');
    try {
      const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      const sessionAge = Date.now() - sessionData.timestamp;
      
      if (sessionAge < 7 * 24 * 60 * 60 * 1000) {
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
    
    await page.waitForTimeout(3000);
    
    const currentUrl = page.url();
    console.log('📍 URL после входа:', currentUrl);
    
    // Детальная проверка страницы
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
              hasTelegram: text.toLowerCase().includes('telegram'),
              hasCode: text.toLowerCase().includes('код'),
              hasPhone: text.toLowerCase().includes('телефон')
            });
          }
        });
      });
      
      return {
        url: window.location.href,
        title: document.title,
        bodyText: bodyText.substring(0, 1000),
        needsVerification: bodyText.includes('Подтверждение') || 
                          bodyText.includes('Telegram') ||
                          bodyText.includes('код'),
        clickableElements: allClickableElements,
        telegramElements: allClickableElements.filter(el => el.hasTelegram),
        codeElements: allClickableElements.filter(el => el.hasCode)
      };
    });
    
    console.log('🔍 Анализ страницы:', {
      url: pageAnalysis.url,
      needsVerification: pageAnalysis.needsVerification,
      telegramElementsCount: pageAnalysis.telegramElements.length
    });
    
    if (pageAnalysis.needsVerification) {
      console.log('📱 Требуется подтверждение устройства');
      
      // Сохраняем скриншот и HTML ДО клика
      const timestamp = Date.now();
      const screenshotFilename = `verification_${timestamp}.png`;
      const htmlFilename = `verification_${timestamp}.html`;
      const screenshotPath = path.join(DEBUG_DIR, screenshotFilename);
      const htmlPath = path.join(DEBUG_DIR, htmlFilename);
      
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const html = await page.content();
      fs.writeFileSync(htmlPath, html, 'utf8');
      
      console.log('📸 Скриншот ДО клика сохранён:', screenshotPath);
      console.log('📄 HTML ДО клика сохранён:', htmlPath);
      
      const debugInfo: any = {
        screenshotUrl: `/debug/${screenshotFilename}`,
        htmlUrl: `/debug/${htmlFilename}`,
        screenshotPath: screenshotPath,
        htmlPath: htmlPath,
        telegramElements: pageAnalysis.telegramElements,
        allClickableElements: pageAnalysis.clickableElements.slice(0, 20),
        bodyPreview: pageAnalysis.bodyText
      };
      
      if (!verificationCode) {
        // Кликаем по элементу Telegram
        let clicked = false;
        
        console.log('📲 Найдено элементов с "Telegram":', pageAnalysis.telegramElements.length);
        console.log('Элементы:', pageAnalysis.telegramElements);
        
        // Способ 1: Клик по классу telegram-send-phone-btn
        try {
          clicked = await page.evaluate(() => {
            const telegramBtn = document.querySelector('.telegram-send-phone-btn');
            if (telegramBtn && telegramBtn instanceof HTMLElement) {
              console.log('Кликаем по .telegram-send-phone-btn');
              telegramBtn.click();
              return true;
            }
            return false;
          });
          
          if (clicked) {
            console.log('✅ Нажат элемент .telegram-send-phone-btn через evaluate');
            await page.waitForTimeout(5000);
          }
        } catch (e: any) {
          console.log('⚠️ Ошибка клика через класс:', e.message);
        }
        
        // Способ 2: Playwright клик по ссылке
        if (!clicked) {
          try {
            await page.click('a.telegram-send-phone-btn', { timeout: 3000 });
            console.log('✅ Нажат через Playwright a.telegram-send-phone-btn');
            clicked = true;
            await page.waitForTimeout(5000);
          } catch (e) {
            console.log('⚠️ Не удалось нажать через Playwright селектор');
          }
        }
        
        // Способ 3: Клик по тексту
        if (!clicked) {
          try {
            await page.click('text=Проверить через Telegram', { timeout: 3000 });
            console.log('✅ Нажат через text=Проверить через Telegram');
            clicked = true;
            await page.waitForTimeout(5000);
          } catch (e) {
            console.log('⚠️ Не удалось нажать через текст');
          }
        }
        
        // СКРИНШОТ ПОСЛЕ КЛИКА
        console.log('📸 Делаем скриншот ПОСЛЕ попытки клика...');
        
        const afterClickFilename = `after_telegram_click_${timestamp}.png`;
        const afterClickHtmlFilename = `after_telegram_click_${timestamp}.html`;
        const afterClickPath = path.join(DEBUG_DIR, afterClickFilename);
        const afterClickHtmlPath = path.join(DEBUG_DIR, afterClickHtmlFilename);
        
        await page.screenshot({ path: afterClickPath, fullPage: true });
        const afterClickHtml = await page.content();
        fs.writeFileSync(afterClickHtmlPath, afterClickHtml, 'utf8');
        
        console.log('📸 Скриншот ПОСЛЕ клика сохранён:', afterClickPath);
        console.log('📄 HTML ПОСЛЕ клика сохранён:', afterClickHtmlPath);
        
        // Детальный анализ страницы после клика
        const afterClickAnalysis = await page.evaluate(() => {
          const bodyText = document.body.innerText;
          
          const hasQRCode = !!document.querySelector('canvas') || 
                            !!document.querySelector('img[src*="qr"]') ||
                            bodyText.includes('QR');
          
          const inputs = Array.from(document.querySelectorAll('input'));
          const codeInput = inputs.find(inp => 
            inp.offsetParent !== null && 
            (inp.type === 'text' || inp.type === 'tel' || inp.type === 'number' ||
             inp.placeholder?.toLowerCase().includes('код'))
          );
          
          const hasSentMessage = bodyText.toLowerCase().includes('отправлен') ||
                                bodyText.toLowerCase().includes('проверьте') ||
                                bodyText.toLowerCase().includes('введите код');
          
          return {
            url: window.location.href,
            bodyText: bodyText,
            bodyPreview: bodyText.substring(0, 1500),
            hasQRCode: hasQRCode,
            hasCodeInput: !!codeInput,
            codeInputDetails: codeInput ? {
              type: codeInput.type,
              placeholder: codeInput.placeholder,
              name: codeInput.name,
              id: codeInput.id
            } : null,
            hasTelegramMessage: bodyText.includes('Telegram'),
            hasErrorMessage: bodyText.toLowerCase().includes('ошибка') || 
                            bodyText.toLowerCase().includes('неверный'),
            hasSentMessage: hasSentMessage
          };
        });
        
        console.log('🔍 ДЕТАЛЬНЫЙ анализ после клика:');
        console.log('  - URL:', afterClickAnalysis.url);
        console.log('  - Есть QR код:', afterClickAnalysis.hasQRCode);
        console.log('  - Есть поле ввода кода:', afterClickAnalysis.hasCodeInput);
        console.log('  - Есть сообщение об отправке:', afterClickAnalysis.hasSentMessage);
        console.log('  - Превью текста страницы:', afterClickAnalysis.bodyPreview.substring(0, 200));
        
        // Добавляем в debugInfo
        debugInfo.afterClickScreenshotUrl = `/debug/${afterClickFilename}`;
        debugInfo.afterClickHtmlUrl = `/debug/${afterClickHtmlFilename}`;
        debugInfo.afterClickScreenshotPath = afterClickPath;
        debugInfo.afterClickHtmlPath = afterClickHtmlPath;
        debugInfo.afterClickAnalysis = afterClickAnalysis;
        debugInfo.clicked = clicked;
        
        let message = '';
        if (afterClickAnalysis.hasQRCode) {
          message = '⚠️ Обнаружен QR-код! Дром показывает QR вместо отправки кода в Telegram. Откройте afterClickScreenshotUrl и отсканируйте QR-код в Telegram, затем сделайте новый запрос.';
        } else if (afterClickAnalysis.hasSentMessage) {
          message = '✅ Код должен быть отправлен в Telegram! Проверьте бота @dromru или личные сообщения. Введите код в поле verificationCode.';
        } else if (afterClickAnalysis.hasCodeInput) {
          message = '⚠️ Поле ввода кода найдено, но нет подтверждения отправки. Проверьте Telegram и скриншот afterClickScreenshotUrl.';
        } else {
          message = `⚠️ Клик ${clicked ? 'выполнен' : 'НЕ выполнен'}. Проверьте скриншот afterClickScreenshotUrl чтобы понять что произошло.`;
        }
        
        return { 
          success: false, 
          needsVerification: true,
          message: message,
          debug: debugInfo
        };
      }
      
      // Вводим код подтверждения
      console.log('🔢 Вводим код подтверждения:', verificationCode);
      
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
        console.log('✅ Код введён');
        await page.waitForTimeout(1000);
        
        const submitClicked = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, [type="submit"], a'));
          const submitBtn = buttons.find(btn => {
            const text = (btn.textContent || '').toLowerCase();
            const visible = (btn as HTMLElement).offsetParent !== null;
            return visible && (
              text.includes('подтвердить') || 
              text.includes('войти') ||
              btn.getAttribute('type') === 'submit'
            );
          });
          
          if (submitBtn && submitBtn instanceof HTMLElement) {
            submitBtn.click();
            return true;
          }
          return false;
        });
        
        if (submitClicked) {
          console.log('✅ Кнопка подтверждения нажата');
          await page.waitForTimeout(3000);
        } else {
          console.log('⚠️ Кнопка не найдена, возможно автопроверка');
          await page.waitForTimeout(2000);
        }
      } else {
        console.log('❌ Не удалось найти поле ввода кода');
      }
    }
    
    // Проверяем финальный результат
    await page.waitForTimeout(2000);
    const finalUrl = page.url();
    console.log('📍 Финальный URL:', finalUrl);
    
    const isSuccess = finalUrl.includes('/personal') && !finalUrl.includes('/sign');
    
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
    
    console.log('💬 Получаем список диалогов...');
    
    await page.goto('https://my.drom.ru/personal/messaging-modal', { 
      waitUntil: 'networkidle',
      timeout: 30000 
    });
    await page.waitForTimeout(2000);
    
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
  console.log(`📍 Debug files: http://localhost:${PORT}/debug`);
  console.log(`📍 Get Messages: POST http://localhost:${PORT}/drom/get-messages`);
  console.log(`📍 Send Message: POST http://localhost:${PORT}/drom/send-message`);
});
