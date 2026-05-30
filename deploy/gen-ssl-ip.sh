#!/bin/bash
# 在服务器上执行：为公网 IP 生成自签证书（无域名时用）
# bash deploy/gen-ssl-ip.sh 112.124.13.31
set -e
IP="${1:?用法: bash deploy/gen-ssl-ip.sh 你的公网IP}"
APP_DIR="${APP_DIR:-/opt/meeting-app}"
mkdir -p "$APP_DIR/deploy/ssl"
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout "$APP_DIR/deploy/ssl/ip.key" \
  -out "$APP_DIR/deploy/ssl/ip.crt" \
  -subj "/CN=$IP" \
  -addext "subjectAltName=IP:$IP"
echo "证书已生成: $APP_DIR/deploy/ssl/ip.crt"
echo "请取消 deploy/nginx-ip.conf 中 443 段的注释后: sudo nginx -t && sudo systemctl reload nginx"
