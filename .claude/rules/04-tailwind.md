# Tailwind CSS 规则

> 来源：Tailwind 官方 docs、shadcn/ui 惯例

## 类名使用
- 优先工具类组合，不写自定义 CSS；全局样式只留 token/基础 reset
- 条件类名用 `cn()`（clsx + tailwind-merge）合并，禁止模板字符串拼接竞态
- 类名顺序遵循一致性（排版→布局→盒模型→视觉→交互态）；超长拆行或抽组件

## 设计 token（本产品视觉基线，对标 Atoms 原版）
- 背景：白 / `#F7F7F8` 面板分层；文本近黑，次级灰
- 强调色：蓝（选中态、链接、M 角标）；点睛黑（logo、发送按钮）
- 圆角：卡片 8-12px（`rounded-lg/xl`）、按钮/输入框全圆角
- 阴影：几乎不用；分隔靠 1px 细灰线（`border-border`）
- 文件名/代码一律等宽字体（`font-mono`）

## 禁止
- 行内 `style=`（动态值除外，如流式宽度）
- 魔法色值硬编码：颜色一律走 CSS 变量/token（`bg-background`、`text-muted-foreground`）
- `!important`
- 复制粘贴长串重复类名 3 次以上——抽组件

## 响应式
- 移动优先（`sm:` 起步）；三栏工作台在窄屏折叠为单栏 + 顶部 tab 切换
- 触控目标 ≥ 44px

## 来源
- https://tailwindcss.com/docs
- https://ui.shadcn.com/docs
