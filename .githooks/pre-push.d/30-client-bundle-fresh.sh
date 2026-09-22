#!/usr/bin/env bash
# T-005 终清理：client 产物新鲜度机械守卫——lib/client.js 必须与
# lib/client/* 源码同步（上轮教训：产物未随源码重建则卡片改动不上线）。
# 构建后用 git diff 比对，随后还原工作区（构建副作用不残留）。
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"

# 构建产物（写入 lib/client.js——与 build:client 同一入口，保证可比性）
npm run --silent build:client >/dev/null

if ! git diff --exit-code -- lib/client.js >/tmp/advisor-flow-client-bundle.diff 2>/dev/null; then
  cat /tmp/advisor-flow-client-bundle.diff >&2 || true
  rm -f /tmp/advisor-flow-client-bundle.diff
  # 还原工作区：构建副作用不残留（产物与源码的同步由开发者提交，不由本钩子代写）
  git checkout -- lib/client.js
  echo "pre-push: client bundle 与源码不同步——请先 npm run build:client 并提交 lib/client.js 产物" >&2
  exit 1
fi
rm -f /tmp/advisor-flow-client-bundle.diff
# 无差异：构建产物与已提交产物一致，工作区无需还原（内容逐字节相同）
exit 0
