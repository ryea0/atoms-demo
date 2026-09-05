# Next.js 15 App Router 规则

> 来源：Next.js 官方文档、Vercel 博客《Common Mistakes with the App Router》（见文末）

## Server / Client 边界（最重要）
- **默认 Server Component**；只有需要交互（state/effect/事件/browser API）才 `'use client'`
- 客户端组件保持在树的最外层叶子；数据在 RSC 获取后经 props 下传，不把原始数据获取塞进 client
- 不从 client 组件 import 服务端模块（db、密钥、fs）；`'use server'` 文件不导出非异步值
- Server Actions 定义在**独立文件**（文件级 `"use server"`），供 client 组件导入使用

## 数据获取与变更
- 读：Server Component 内直接调 repository/服务层，不经过自家 HTTP API（无额外网络跳）
- 写（内部）：优先 Server Action；Route Handler 只用于：外部调用方（SSE、webhook、给 iframe 的 preview HTML、zip 导出）
- 动态路由数据：`params` 是 Promise（Next 15+），必须 `await params`
- 修改后按需 revalidate；本项目的 SQLite 读路径基本实时，不滥用缓存标签

## Route Handler 纪律
- SSE/stream 路由：`export const dynamic = 'force-dynamic'`，禁止任何缓存头
- 每个 handler 输入用 zod 校验（body/query/params），失败返回 400 + 结构化错误
- 不在 handler 里写业务逻辑——调 `src/lib/` 服务层，handler 只做：解析→校验→调用→响应

## 目录与路由
- `src/app/` 只放路由与布局；组件进 `src/components/`，逻辑进 `src/lib/`
- 布局不放会频繁失效的状态；跨组件状态用 URL/store，不用巨型 context
- metadata 用 `export const metadata` / `generateMetadata`；动态页面用后者

## 性能
- 重客户端依赖（shiki/mermaid）必须 `next/dynamic` 懒加载 + `ssr:false`（仅浏览器渲染）
- 不在根布局引入仅在个别路由用的 CSS/JS

## 来源
- https://nextjs.org/docs/app/getting-started/server-and-client-components
- https://vercel.com/blog/common-mistakes-with-the-next-js-app-router-and-how-to-fix-them
- https://nextjs.org/docs/app/guides/streaming
