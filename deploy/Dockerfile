FROM node:24-bookworm-slim AS build
WORKDIR /work
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system fireball && useradd --system --gid fireball --home-dir /nonexistent fireball
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /work/dist ./dist
USER fireball
EXPOSE 8787
CMD ["node", "dist/src/main.js"]
