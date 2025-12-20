# --- ИСПОЛЬЗУЕМ ОБРАЗ PUPPETEER ВМЕСТО PLAYWRIGHT ---
# В этом образе (от разработчиков Puppeteer) уже есть Node.js + Chrome + все системные библиотеки Linux
FROM ghcr.io/puppeteer/puppeteer:23.10.1

# Работаем от root, чтобы иметь права на установку/сборку
USER root

WORKDIR /app

# Копируем конфиги зависимостей
COPY package*.json ./
COPY tsconfig.json ./

# Устанавливаем пакеты
# --ignore-scripts важен: он не даст npm пытаться скачать Chrome заново (он уже есть в системе)
RUN npm install --ignore-scripts

# Копируем исходный код
COPY . .

# Собираем TypeScript в JavaScript (папка dist)
RUN npm run build

# Указываем Puppeteer, где искать браузер (в этом образе он лежит тут)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV NODE_ENV=production

# Запускаем собранный JS файл напрямую
CMD ["node", "dist/main.js"]
