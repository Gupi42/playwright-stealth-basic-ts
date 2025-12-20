FROM ghcr.io/puppeteer/puppeteer:23.10.1

USER root
WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

# --ignore-scripts здесь ПРАВИЛЬНО, чтобы не качать дубль хрома
RUN npm install --ignore-scripts

COPY . .
RUN npm run build

# ЯВНО указываем путь к системному Chrome, который предустановлен в образе
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV NODE_ENV=production

CMD ["node", "dist/main.js"]
