FROM ghcr.io/puppeteer/puppeteer:23.10.1

USER root
WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

RUN npm install --ignore-scripts

COPY . .
RUN npm run build

ENV NODE_ENV=production
# Не задаем PUPPETEER_EXECUTABLE_PATH вручную!

CMD ["node", "dist/main.js"]
