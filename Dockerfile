# Используем Node.js 20 slim образ
FROM node:20-slim

# Устанавливаем переменные окружения для уменьшения вывода
ENV DEBIAN_FRONTEND=noninteractive

# Устанавливаем зависимости для Chrome и дополнительные утилиты
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Добавляем репозиторий Google Chrome
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list'

# Устанавливаем Google Chrome Stable
RUN apt-get update && apt-get install -y \
    google-chrome-stable \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Создаем рабочую директорию
WORKDIR /app

# Копируем package файлы
COPY package*.json ./
COPY tsconfig.json ./

# Устанавливаем зависимости
# Важно: puppeteer не будет скачивать свой Chromium, т.к. мы используем системный Chrome
RUN npm ci --only=production && npm cache clean --force

# Копируем исходный код
COPY . .

# Компилируем TypeScript
RUN npm run build

# Создаем директорию для данных с правильными правами
RUN mkdir -p /app/data/sessions /app/data/debug && \
    chmod -R 777 /app/data

# Устанавливаем переменные окружения
ENV NODE_ENV=production
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
# Увеличиваем лимит памяти для Node.js
ENV NODE_OPTIONS="--max-old-space-size=2048"

# Открываем порт
EXPOSE 3000

# Запускаем приложение с увеличенным лимитом памяти
CMD ["node", "--max-old-space-size=2048", "dist/main.js"]
