# 安全规则（本项目）

> 覆盖：密钥管理、输入校验、虚拟 FS 沙箱、预览隔离、生成物安全

## 密钥
- 一切密钥只经环境变量注入，服务端读取（`process.env`）；**绝不**进代码、git、日志、客户端 bundle、SSE 事件
- `.env*` 在 .gitignore；提供 `.env.example` 占位
- 日志/llm_calls 落库时脱敏（不存 api_key；错误信息剔除 Authorization 头）

## 输入校验
- 所有 API 输入（body/query/params）zod 校验后使用；SSE/预览/导出路由同样不豁免
- 数据库写入前二次约束（长度上限：content ≤ 512KB、字符串字段截断）

## 虚拟文件系统沙箱（agent 工具红线）
- `write_file/read_file` 的 path 必须过归一化校验：拒绝绝对路径、`../` 逃逸、空段、`\0`；白名单字符集
- 工具闭包绑定 project_id；任何文件操作 WHERE project_id（防跨项目读写）
- 不提供 bash/exec/spawn 类工具——不做服务端代码执行

## 预览隔离（生成代码运行边界）
- iframe：`sandbox="allow-scripts"`（不带 allow-same-origin）+ srcDoc
- preview 响应加 CSP：`script-src 'self' https://cdn.tailwindcss.com; connect-src 'none'`（堵数据外传）
- 生成物落库前过危险 API AST 扫描（eval/new Function/字符串 setTimeout/postMessage to parent → 硬拒绝重试；死循环/外部 fetch → 软警告）
- 已知限制写明：无 same-origin → 生成应用不可用 localStorage/cookie（prompt 引导内存态）

## 会话
- 匿名 session cookie：httpOnly、SameSite=Lax、secure(生产)；projectId 归属校验（他人 id 404）
- 停止/干预/回滚等变更接口幂等且校验归属

## 依赖
- 生成物零依赖（无 npm 安装面=无供应链风险）；平台自身依赖定期 `npm audit`，CI 不引入新高危
