FROM node:20-alpine

WORKDIR /app

COPY package*.json tsconfig.json ./
COPY src/ ./src/

# Install all deps (including devDeps) so TypeScript is available for the build
RUN npm ci

RUN npm run build

# Prune dev dependencies from the final image
RUN npm prune --omit=dev

CMD ["node", "dist/optimizer/index.js"]
