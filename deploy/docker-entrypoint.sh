#!/bin/sh
set -e

# Always sync dist/ from the image to the shared volume
# This ensures frontend updates are applied on every container restart
echo "[entrypoint] Syncing dist/ to shared volume..."
rm -rf /usr/share/nginx/html/*
cp -r /app/dist/* /usr/share/nginx/html/
echo "[entrypoint] dist/ synced."

# Start the Node.js signaling server
exec node server/signaling-server.js
