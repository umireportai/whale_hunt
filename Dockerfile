FROM node:24.21.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && mkdir -p /app/data && chown -R node:node /app/data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 API_PORT=8311 DATABASE_PATH=/app/data/whale-hunt.sqlite DATA_MODE=synthetic
EXPOSE 8311
VOLUME ["/app/data"]
CMD ["npm", "start"]
