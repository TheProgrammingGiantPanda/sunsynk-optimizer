ARG BUILD_FROM=node:20-alpine
FROM $BUILD_FROM

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

CMD ["node", "dist/optimizer/index.js"]
