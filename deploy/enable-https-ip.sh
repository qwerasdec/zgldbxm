#!/bin/bash
# 无域名：启用自签 HTTPS（摄像头/麦克风必需）
# cd /opt/meeting-app && sudo bash deploy/enable-https-ip.sh 112.124.13.31
set -e
IP="${1:?请传入公网 IP}"
APP_DIR="${APP_DIR:-/opt/meeting-app}"
cd "$APP_DIR"

bash deploy/gen-ssl-ip.sh "$IP"
sed "s/__DEPLOY_IP__/$IP/g" deploy/nginx-ip-with-https.conf > /etc/nginx/sites-available/meeting
ln -sf /etc/nginx/sites-available/meeting /etc/nginx/sites-enabled/meeting
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
echo "已启用 HTTPS: https://$IP/ （安全组放行 443；浏览器点「高级」继续访问）"
