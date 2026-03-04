ARG BUILD_FROM
FROM $BUILD_FROM

# HA base images are Alpine-based but don't include Node.js
RUN apk add --no-cache nodejs npm

WORKDIR /app

COPY package*.json ./
# Install all deps (including devDeps) so TypeScript is available for the build
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Prune dev dependencies from the final image
RUN npm prune --omit=dev

CMD ["node", "dist/optimizer/index.js"]
