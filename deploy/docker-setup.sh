#!/bin/bash
# First-time server setup: install Docker + Docker Compose on Ubuntu 22.04
# Usage: sudo bash deploy/docker-setup.sh
set -e

APP_DIR="/opt/meeting-app"

echo "==> Installing Docker..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
  echo "Docker installed: $(docker --version)"
else
  echo "Docker already installed: $(docker --version)"
fi

echo "==> Installing Docker Compose plugin..."
if ! docker compose version >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq docker-compose-plugin
fi
echo "Docker Compose: $(docker compose version)"

echo "==> Adding current user to docker group (if not root)..."
if [ "$(id -u)" -ne 0 ]; then
  usermod -aG docker "$USER" || true
  echo "NOTE: Log out and back in for group changes to take effect."
fi

echo "==> Creating app directory..."
mkdir -p "$APP_DIR"

echo "==> Creating .env template..."
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" << 'ENVEOF'
# AI Service (Volcengine Ark / SiliconFlow)
ARK_API_KEY=
AI_API_KEY=
AI_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
AI_MODEL=doubao-seed-1-8-251228

# Speech-to-Text
STT_API_KEY=
STT_BASE_URL=https://api.siliconflow.cn/v1
STT_MODEL=TeleAI/TeleSpeechASR

# Server
PORT=3001
BIND_HOST=0.0.0.0

# MySQL (Docker service name is "mysql", do NOT change MYSQL_HOST)
MYSQL_HOST=mysql
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=CHANGE_ME_TO_A_SECURE_PASSWORD
MYSQL_DATABASE=zglxm
ENVEOF
  echo "Created $APP_DIR/.env -- PLEASE EDIT IT with your real credentials."
  echo "  nano $APP_DIR/.env"
else
  echo "$APP_DIR/.env already exists, skipping."
fi

echo ""
echo "============================================="
echo "  Docker setup complete!"
echo "============================================="
echo ""
echo "Next steps:"
echo "  1. Edit $APP_DIR/.env with your API keys and MySQL password"
echo "  2. Ensure Alibaba Cloud security group allows ports 80, 443, 22"
echo "  3. Push code to GitHub to trigger automated deployment"
echo "     OR manually deploy:"
echo "     cd $APP_DIR"
echo "     docker compose up -d"
echo ""
