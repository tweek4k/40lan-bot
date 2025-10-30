# Multi-arch Node image (works on x64, arm64, armv7)
FROM node:20-alpine

WORKDIR /app

# Install production deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app source
COPY . .

# Ensure a default data path inside the container
ENV DATA_FILE=/app/lan-data.json

# Prepare writable data dir and non-root user; install su-exec for uid drop at runtime
RUN addgroup -S app && adduser -S app -G app \
  && mkdir -p /app/data \
  && chown -R app:app /app \
  && apk add --no-cache su-exec

# Use an entrypoint that fixes ownership on mounted volumes then drops privileges
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
