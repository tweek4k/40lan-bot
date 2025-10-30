#!/bin/sh
set -e

# Ensure data directory exists and is writable by app user
mkdir -p /app/data || true
chown -R app:app /app/data 2>/dev/null || true

# Run the app as non-root
exec su-exec app:app npm start
