#!/usr/bin/env bash
# Atoms-Demo 线上增量更新：拉最新 main → 装依赖 → 构建 → 重启 systemd
#
# 用法：
#   bash deploy/update.sh                  # 全量（npm ci + build，最稳，约 2-3 分钟）
#   bash deploy/update.sh --fast           # 跳过 npm ci，只 build + 重启（依赖没变时用）
#   bash deploy/update.sh --skip-build     # 纯后端改动，只拉代码 + 重启（最快）
#
# 约定：代码在 /opt/atoms-demo，运行用户 atoms，systemd 服务名 atoms。
# 需 root 执行（systemctl + chown 都要权限）。
set -euo pipefail

APP_DIR=/opt/atoms-demo
APP_USER=atoms
MODE=full   # full | fast | skip-build

[[ $EUID -eq 0 ]] || { echo "请以 root 运行：sudo bash deploy/update.sh"; exit 1; }
[[ -d $APP_DIR/.git ]] || { echo "代码目录不存在：$APP_DIR，先跑 server-bootstrap.sh"; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast)       MODE=fast ;;
    --skip-build) MODE=skip-build ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    *)
      echo "未知参数：$1"; exit 2 ;;
  esac
  shift
done

cd "$APP_DIR"

echo "==> 拉取最新 main"
git -c safe.directory="$APP_DIR" fetch origin
git -c safe.directory="$APP_DIR" reset --hard origin/main

echo "==> 修正属主（git 操作后可能产生 root 属主文件）"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

if [[ $MODE == "skip-build" ]]; then
  echo "==> [skip-build] 跳过依赖与构建，直接重启"
else
  if [[ $MODE == "full" ]]; then
    echo "==> 安装依赖（npm ci）"
    sudo -u "$APP_USER" npm ci
  else
    echo "==> [fast] 跳过 npm ci（依赖未变）"
  fi

  echo "==> 构建（next build）"
  sudo -u "$APP_USER" npm run build

  echo "==> 建表幂等更新（schema 有变则应用）"
  sudo -u "$APP_USER" mkdir -p data
  sudo -u "$APP_USER" npm run db:push
fi

echo "==> 重启应用"
systemctl restart atoms
sleep 2

echo "==> 自检"
systemctl is-active atoms
curl -s -o /dev/null -w "127.0.0.1:3000 -> %{http_code}\n" http://127.0.0.1:3000/

echo "更新完成（mode=$MODE）。"
