FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data && chown node:node /data

COPY src ./src

ENV PORT=8788
ENV DATA_PATH=/data/webex.sqlite
ENV NODE_ENV=production

USER node
EXPOSE 8788

CMD ["node", "--experimental-sqlite", "--experimental-strip-types", "src/index.ts"]
