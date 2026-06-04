#!/bin/bash
# 在 ECS 上以 root 执行：bash deploy/setup-coturn.sh
# 为手机热点 / 对称 NAT 提供 TURN 中继，WebRTC 才能互通

set -euo pipefail

TURN_USER="${TURN_USER:-turnuser}"
TURN_PASS="${TURN_PASS:-turnpass123}"
PUBLIC_IP="${PUBLIC_IP:-$(curl -s --max-time 3 ifconfig.me || hostname -I | awk '{print $1}')}"

echo "[coturn] 安装 coturn..."
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y coturn

echo "[coturn] 写入配置，外网 IP=${PUBLIC_IP}"
cat >/etc/turnserver.conf <<EOF
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
relay-ip=${PUBLIC_IP}
external-ip=${PUBLIC_IP}
min-port=49152
max-port=65535
fingerprint
lt-cred-mech
user=${TURN_USER}:${TURN_PASS}
realm=meeting.local
no-cli
no-loopback-peers
no-multicast-peers
verbose
EOF

sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true

systemctl enable coturn
systemctl restart coturn
systemctl --no-pager status coturn | head -5

echo ""
echo "[coturn] 完成。请在阿里云安全组放行："
echo "  UDP/TCP 3478"
echo "  UDP 49152-65535"
echo ""
echo "前端 RTC 配置用户名/密码：${TURN_USER} / ${TURN_PASS}"
