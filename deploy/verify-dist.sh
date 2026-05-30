#!/bin/bash
# 在服务器执行: bash /opt/meeting-app/deploy/verify-dist.sh
set -e
D="${1:-/opt/meeting-app/dist}"
echo "检查目录: $D"
test -f "$D/index.html" || { echo "缺少 index.html"; exit 1; }
grep -q 'mediapipe/selfie_segmentation/selfie_segmentation.js' "$D/index.html" || {
  echo "FAIL: index.html 里没有 mediapipe 脚本，请重新上传完整 dist"
  exit 1
}
grep -q 'type="module"' "$D/index.html" || { echo "FAIL: 缺少 React 主包 script"; exit 1; }
test -f "$D/mediapipe/selfie_segmentation/selfie_segmentation.js" || {
  echo "FAIL: 缺少 mediapipe/selfie_segmentation/selfie_segmentation.js"
  exit 1
}
test -f "$D/mediapipe/selfie_segmentation/selfie_segmentation.binarypb" || {
  echo "FAIL: 缺少 binarypb 模型文件"
  exit 1
}
echo "OK: dist 结构正常"
head -16 "$D/index.html"
