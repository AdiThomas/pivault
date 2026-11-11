# Caddy with the PiVault web app baked in.
# Build context is the repository root:  docker build -f deploy/web.Dockerfile .

FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY mobile/package.json mobile/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY mobile/ ./
# Served from the same address as the API, so the app defaults to its own origin.
RUN npx expo export --platform web

FROM caddy:2-alpine
COPY --from=web /app/dist /srv/web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
