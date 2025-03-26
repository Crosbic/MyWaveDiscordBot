FROM node:lts-alpine AS builder

WORKDIR /build

COPY . .

RUN yarn install && yarn build

FROM node:lts-slim

ENV NODE_ENV production
USER node

WORKDIR /app

COPY package.json ./

RUN yarn install --production && yarn cache clean

COPY --from=builder /build/dist ./dist

CMD [ "yarn", "start" ]