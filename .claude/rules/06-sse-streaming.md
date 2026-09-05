# SSE 流式规则（Next.js Route Handler）

> 来源：Next.js Streaming 官方指南、whatwg SSE 规范、社区实战（见文末）

## 服务端（Route Handler）
- 立即返回 `Response`，流式工作放回调/IIFE 内启动——不要先做慢初始化再返回
- 必备响应头：
  - `Content-Type: text/event-stream`
  - `Cache-Control: no-cache, no-transform`
  - `Connection: keep-alive`
  - **`X-Accel-Buffering: no`**（防 nginx/网关缓冲——漏掉会"卡住不出字"）
- 路由声明 `export const dynamic = 'force-dynamic'`
- 每条事件带自增 `id:` 字段（我们协议的 seq）——断线重连时浏览器自动带 `Last-Event-ID` 请求头
- handler 读取 `request.headers.get('Last-Event-ID')`，从内存事件环形缓冲重放缺失事件
- 心跳：每 15-25s 发一行 `: ping\n\n` 注释帧保活（防中间层掐空闲连接）
- abort 处理：监听 `request.signal`，客户端断开时停止编排器推送并释放资源（AbortController 级联到 LLM 调用）
- 事件格式严格：`id: <seq>\nevent: <type>\ndata: <单行JSON>\n\n`；data 内换行必须转义

## 客户端（EventSource）
- 用原生 EventSource（自动重连、自动带 Last-Event-ID）；不自造轮询
- 组件卸载/切换项目时 `es.close()`（useEffect cleanup）——不关会堆积连接
- 重连后的 UI 策略：先以快照 API 对齐状态，再把重放事件 apply 到 store
- 消费侧按 `path` 分流 delta（打字机只渲染当前打开文件），其余仅更新文件树状态

## 协议（本项目）
`{seq, projectId, runId, event, agent?, path?, content?, summary?, error?}`
event ∈ agent_start|file_start|delta|file_end|agent_end|message|intervention_injected|done|stopped|error

## 来源
- https://nextjs.org/docs/app/guides/streaming
- https://github.com/vercel/next.js/discussions/48427
- https://hpbn.co/server-sent-events/
- https://http.dev/last-event-id
