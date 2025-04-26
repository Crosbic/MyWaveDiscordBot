FROM node:lts-alpine AS builder

WORKDIR /build

COPY . .

RUN yarn install && yarn build

FROM node:lts-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    libopus-dev \
    libsodium-dev \
    python3 \
    build-essential \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV production
USER node

WORKDIR /app

COPY package.json ./

RUN yarn install --production && yarn cache clean

COPY --from=builder /build/dist ./dist