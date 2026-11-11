FROM node:22-alpine AS client-build
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.js ./
COPY client ./client
RUN npm run build

FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production API_PORT=3000 API_HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && mkdir -p /app/data \
  && chown -R node:node /app
COPY server.mjs ./server.mjs
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]

FROM caddy:2-alpine AS web
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=client-build /workspace/dist /srv
