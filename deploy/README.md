# 公网 demo 部署（腾讯云轻量服务器）

> 形态：Next.js 常驻进程（`next start`）+ SQLite（`data/app.db`）+ nginx 反代。
> serverless（Vercel 等）不可行：better-sqlite3 原生模块 + 持久文件 + SSE 长连接。

## 前置

- 轻量应用服务器 2C4G（2G 内存也可，脚本会自动补 swap），系统 Ubuntu 22.04 / 24.04
- **控制台防火墙放行 80 端口**（轻量控制台 → 防火墙 → 添加规则 TCP:80）
- 本地仓库已 push 到 `github.com/ryea0/atoms-demo`（public，服务器直接 clone）

## 三步部署

```bash
# 1. 上传真实 env（含 LLM key；在本地仓库根目录执行，IP 换成服务器公网 IP）
scp .env.local root@<IP>:/tmp/env.local

# 2. 登录服务器
ssh root@<IP>

# 3. 落 env → 跑脚本
mv /tmp/env.local /tmp/env.stage   # 先放到 /tmp，脚本 clone 完再归位
mkdir -p /opt/atoms-demo 2>/dev/null || true   # 首次无需此步，直接跑脚本见下
bash <(curl -fsSL https://raw.githubusercontent.com/ryea0/atoms-demo/main/deploy/server-bootstrap.sh)   # 或 git clone 后执行 deploy/server-bootstrap.sh
cp /tmp/env.stage /opt/atoms-demo/.env.local && chown atoms:atoms /opt/atoms-demo/.env.local
systemctl restart atoms
```

> 脚本幂等，重复执行 = 更新部署（拉最新 main 重新 build 并重启）。

## 服务器 `.env.local` 必改项（相对本地开发）

| 变量 | 值 | 原因 |
|---|---|---|
| `EXEC_PROVIDER` | `disabled` | **红线**（rules/07）：受控执行层宿主同权非沙箱，公网=匿名 RCE。关掉后终端面板 503、agent bash 自检回禁用提示 |
| `COOKIE_SECURE` | `false` | 裸 IP http 部署无 HTTPS，默认 Secure cookie 会被浏览器丢弃（session 全坏）。有备案域名上 HTTPS 后删掉此行 |

其余（`LLM_*` 真实 key、`DB_FILE` 等）与本地一致。**改完必须 `systemctl restart atoms`**。

## 验证

```bash
systemctl status atoms                 # active (running)
journalctl -u atoms -n 50 --no-pager   # 启动日志（env 加载/端口）
curl -s -o /dev/null -w '%{http_code}\' http://127.0.0.1/   # 401（basic auth 生效）
```

浏览器打开 `http://<IP>/` → 输入口令（bootstrap 首次运行输出，忘了就重置：
`htpasswd -bB /etc/nginx/.atoms_htpasswd atoms <新密码>`）→ 建项目跑一轮 mock/真实流式 → 预览。

## 常用运维

```bash
systemctl restart atoms                # 重启应用
journalctl -u atoms -f                 # 跟日志
# 更新部署（服务器上）：
cd /opt/atoms-demo && sudo -u atoms bash -ec 'git fetch origin && git reset --hard origin/main && npm ci && npm run build'
systemctl restart atoms
# 备份：仅一个文件（SQLite 全量）+ 工作区目录
scp root@<IP>:/opt/atoms-demo/data/app.db ./backup-$(date +%F).db
```

## 已知限制（demo 姿态，有意为之）

- **HTTP 无 TLS**：上海地域未备案域名走不了 80/443 的正规证书链，裸 IP + `COOKIE_SECURE=false` 降级；会话 cookie 仍有 HttpOnly/SameSite=Lax
- **终端/bash 自检已关**（`EXEC_PROVIDER=disabled`）：要演示终端面板亮点，在本机跑（内网边界内合法），现场补演
- **basic auth 是防刷 LLM 账单闸门**，不是安全边界；评测结束直接销毁实例，`app.db` 留档即可
- LLM key 只存在服务器 `.env.local`（root/atoms 可读），不进 git
