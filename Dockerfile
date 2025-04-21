FROM node:lts-alpine AS builder

WORKDIR /build

COPY . .

RUN yarn install && yarn build

FROM node:lts-slim

ENV NODE_ENV production

RUN apt-get update && apt-get install -y \
    ffmpeg \
    libopus-dev \
    libsodium-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

USER node

WORKDIR /app

COPY package.json ./

RUN yarn install --production && yarn cache clean

COPY --from=builder /build/dist ./dist
COPY --from=builder /build/.env* ./

CMD [ "yarn", "start" ]
