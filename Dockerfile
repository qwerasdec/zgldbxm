# ============================================================
# Stage 1: Build the Vite + React frontend
# ============================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests first (leverages Docker layer caching)
COPY package.json package-lock.json ./

# Install ALL dependencies (including devDependencies for tsc + vite build)
RUN npm ci

# Copy source files needed for the build
COPY index.html tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts eslint.config.js ./
COPY src/ src/
COPY public/ public/

# Build the frontend (output goes to dist/)
RUN npm run build

# ============================================================
# Stage 2: Production image (Node.js server + built frontend)
# ============================================================
FROM node:20-slim AS production

# Install curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy the built frontend from Stage 1
COPY --from=builder /app/dist/ dist/

# Copy the signaling server
COPY server/ server/

# Copy entrypoint script
COPY deploy/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Environment defaults (overridden by docker-compose.yml / .env mount)
ENV NODE_ENV=production
ENV BIND_HOST=0.0.0.0
ENV PORT=3001

EXPOSE 3001

ENTRYPOINT ["/app/docker-entrypoint.sh"]
