#!/bin/bash
# 在服务器 /opt/meeting-app 执行: bash deploy/check-server.sh
set -e
APP_DIR="${1:-/opt/meeting-app}"
cd "$APP_DIR"

echo "=== 1. 前端 dist（应含 index-C7jO0WLT.js，旧包会导致 Failed to fetch）==="
if [ -f dist/index.html ]; then
  grep -o 'index-[^"]*\.js' dist/index.html | head -1 || true
  ls -la dist/assets/*.js 2>/dev/null | tail -3 || echo "dist/assets 里没有 js，请上传本机 dist"
else
  echo "缺少 dist/index.html，请 WinSCP 上传本机 dist 文件夹"
fi

echo ""
echo "=== 2. Nginx → /api（应返回 JSON，不是连不上）==="
code=$(curl -s -o /tmp/reg.json -w "%{http_code}" http://127.0.0.1/api/auth/register \
  -X POST -H "Content-Type: application/json" \
  -d '{"username":"_test","displayName":"t","password":"123456"}' || echo "000")
echo "HTTP $code"
head -c 200 /tmp/reg.json 2>/dev/null; echo

echo ""
echo "=== 3. pm2 信令 ==="
pm2 status meeting-signal 2>/dev/null || echo "pm2 未运行 meeting-signal"
pm2 logs meeting-signal --lines 8 --nostream 2>/dev/null | tail -8

echo ""
echo "=== 4. MySQL ==="
if sudo mysql -e "SELECT 1" 2>/dev/null; then
  sudo mysql -e "SHOW DATABASES LIKE 'zglxm';"
else
  echo "sudo mysql 失败。用维护账号："
  echo "  sudo cat /etc/mysql/debian.cnf"
  echo "  mysql --defaults-extra-file=/etc/mysql/debian.cnf -e \"CREATE DATABASE IF NOT EXISTS zglxm;\""
fi
