#!/bin/bash
# 在服务器首次执行一次（需已上传代码到 /opt/meeting-app）
# sudo bash deploy/remote-install.sh 112.124.13.31
set -e
IP="${1:?用法: bash deploy/remote-install.sh 你的公网IP}"
APP="/opt/meeting-app"
cd "$APP"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "请编辑 $APP/.env 后重新执行本脚本末尾的 pm2 restart"
  nano .env
fi

npm ci --omit=dev
npm run build 2>/dev/null || true

if [ -f deploy/setup-ubuntu.sh ]; then
  bash deploy/setup-ubuntu.sh "$IP"
fi

if [ -f deploy/gen-ssl-ip.sh ] && [ ! -f deploy/ssl/ip.crt ]; then
  bash deploy/gen-ssl-ip.sh "$IP"
fi

if [ -f deploy/nginx-ip-with-https.conf ]; then
  sed "s/__DEPLOY_IP__/$IP/g" deploy/nginx-ip-with-https.conf > /etc/nginx/sites-available/meeting
  ln -sf /etc/nginx/sites-available/meeting /etc/nginx/sites-enabled/meeting
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
fi

pm2 start deploy/ecosystem.config.cjs 2>/dev/null || pm2 restart meeting-signal
pm2 save
pm2 startup || true

echo "完成: https://$IP/  （自签证书需在浏览器点继续访问）"
