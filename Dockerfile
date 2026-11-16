FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY schema.sql ./
COPY auth-schema.sql ./
COPY auth-handoff-schema.sql ./
COPY user-profile-schema.sql ./
COPY achievement-schema.sql ./
COPY steam-sync-schema.sql ./
COPY drop-schema.sql ./
COPY drop-cooldown-schema.sql ./
COPY p15-schema.sql ./
COPY p15-delivery-schema.sql ./
COPY p15-building-gold-schema.sql ./
COPY p15-respec-schema.sql ./
COPY config/ ./config/
COPY scripts/ ./scripts/
COPY src/ ./src/
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV AUCTION_HOST=0.0.0.0 AUCTION_PORT=3001 AUCTION_SQLITE_PATH=/app/data/auction-demo.sqlite
EXPOSE 3001
VOLUME ["/app/data"]
CMD ["node","--experimental-strip-types","src/main.ts"]
