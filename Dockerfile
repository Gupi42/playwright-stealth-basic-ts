# Используем обычный Node.js образ, так как мы будем качать хром сами
# (образ puppeteer уже не дает преимуществ, если там пути кривые)
FROM node:20-slim

# Устанавливаем зависимости для запуска Chrome (это обязательно для slim образа)
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

# ВАЖНО: Убрали --ignore-scripts. 
# Теперь npm install выполнит postinstall скрипт puppeteer и скачает браузер (или проверит его)
# Но так как мы поставили google-chrome-stable через apt, лучше использовать его.
RUN npm install

COPY . .
RUN npm run build

# Указываем путь к Chrome, который мы поставили через APT
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV NODE_ENV=production

CMD ["node", "dist/main.js"]
