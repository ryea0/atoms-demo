#!/usr/bin/env bash
# Atoms-Demo 公网 demo 一键部署（腾讯云轻量 Ubuntu 22.04/24.04，root 执行）
# 幂等可重复跑；详细说明见 deploy/README.md
set -euo pipefail

APP_DIR=/opt/atoms-demo
APP_USER=atoms

[[ $EUID -eq 0 ]] || { echo "请以 root 运行：sudo bash deploy/server-bootstrap.sh"; exit 1; }

echo "==> 1/8 系统依赖（nginx / 编译工具 / htpasswd）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx apache2-utils build-essential python3 ca-certificates git curl sudo

echo "==> 2/8 Node.js 22（NodeSource；已装 20+ 则跳过）"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/^v\([0-9]*\).*/\1/')" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> 3/8 内存 <3.5G 且无 swap 时补 2G swap（防 turbopack build OOM）"
total_mb=$(free -m | awk '/^Mem:/{print $2}')
if (( total_mb < 3500 )) && ! swapon --show 2>/dev/null | grep -q .; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> 4/8 拉代码（github.com/ryea0/atoms-demo → $APP_DIR）"
if [[ ! -d $APP_DIR/.git ]]; then
  rm -rf "$APP_DIR"
  git clone https://github.com/ryea0/atoms-demo.git "$APP_DIR"
else
  # 目录属主是 atoms，root 重入需显式豁免 dubious ownership（幂等重跑路径）
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" fetch origin
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" reset --hard origin/main
fi

echo "==> 5/8 专用运行用户 + 目录属主"
id "$APP_USER" >/dev/null 2>&1 || useradd -r -m -d "$APP_DIR" -s /usr/sbin/nologin "$APP_USER"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

echo "==> 6/8 依赖 + 构建 + 建表（首次约 3-5 分钟）"
sudo -u "$APP_USER" bash -ec "cd '$APP_DIR' && npm ci && npm run build && mkdir -p data && npm run db:push"
# env 兜底：真实 .env.local 由部署者 scp 覆盖（见 README）；缺失时先用 example（mock 起不来真实模型但服务可跑）
if [[ ! -f $APP_DIR/.env.local ]]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env.local"
  chown "$APP_USER":"$APP_USER" "$APP_DIR/.env.local"
  echo "    [提示] 已用 .env.example 占位——请尽快 scp 真实 .env.local 后 systemctl restart atoms"
fi

echo "==> 7/8 systemd 常驻"
cp "$APP_DIR/deploy/atoms.service" /etc/systemd/system/atoms.service
systemctl daemon-reload
systemctl enable --now atoms

echo "==> 8/8 nginx 反代（SSE 直通 + basic auth 防刷 LLM 账单）"
if [[ ! -f /etc/nginx/.atoms_htpasswd ]]; then
  pw=$(openssl rand -hex 8)
  htpasswd -bcB /etc/nginx/.atoms_htpasswd atoms "$pw" >/dev/null
  echo "    [demo 访问口令，仅此一次显示] 用户名 atoms  密码 $pw"
fi
cp "$APP_DIR/deploy/nginx-atoms.conf" /etc/nginx/sites-available/atoms
ln -sf /etc/nginx/sites-available/atoms /etc/nginx/sites-enabled/atoms
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

sleep 2
echo "==> 自检：curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/ （期望 200/401）"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/
echo "完成。公网访问 http://<服务器公网IP>/ ——记得在轻量控制台防火墙放行 80 端口。"
