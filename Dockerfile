FROM node:lts-alpine AS builder

WORKDIR /build

COPY . .

RUN yarn install && yarn build

FROM node:lts-slim

ENV NODE_ENV production

# Установка необходимых системных зависимостей для работы с аудио
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libopus-dev \
    libsodium-dev \
    python3 \
    build-essential \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./

# Установка зависимостей с поддержкой нативных модулей
RUN yarn install --production && yarn cache clean

# Копирование скомпилированных файлов и конфигурационных файлов
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/.env* ./

# Переключение на непривилегированного пользователя для безопасности
USER node

CMD [ "yarn", "start" ]
