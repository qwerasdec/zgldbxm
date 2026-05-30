#!/bin/bash
# 在阿里云 Ubuntu 22.04 上首次安装环境（root 或 sudo）
# 用法: sudo bash deploy/setup-ubuntu.sh 112.124.13.31
set -e
DEPLOY_IP="${1:?请传入公网 IP，例如: sudo bash deploy/setup-ubuntu.sh 112.124.13.31}"
APP_DIR="/opt/meeting-app"

echo "==> 安装 Node.js 20、Nginx、pm2..."
apt-get update -qq
apt-get install -y -qq curl nginx openssl
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
npm install -g pm2

echo "==> 配置 Nginx（IP: $DEPLOY_IP）..."
sed "s/__DEPLOY_IP__/$DEPLOY_IP/g" "$APP_DIR/deploy/nginx-ip.conf" > /etc/nginx/sites-available/meeting
ln -sf /etc/nginx/sites-available/meeting /etc/nginx/sites-enabled/meeting
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl reload nginx

echo "==> 完成。请确保阿里云安全组已放行 TCP 80（若用 HTTPS 再放行 443）"
echo "    项目目录: $APP_DIR"
echo "    下一步: cd $APP_DIR && npm ci && npm run build && pm2 start deploy/ecosystem.config.cjs"
