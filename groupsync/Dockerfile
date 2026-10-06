FROM node:22-alpine

WORKDIR /app
# Prebuilt by `npm run build:addon` (web app + bundled server)
COPY app/ /app/

ENV NODE_ENV=production \
    PORT=8099 \
    MEDIA_PORT=5174 \
    DIST_DIR=/app/dist \
    INGRESS_ONLY=1

CMD ["node", "/app/server.mjs"]
