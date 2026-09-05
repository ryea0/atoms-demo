===== docs/system_design.md =====
# 系统设计：轻量待办事项应用（Todo）

> 架构师产出　上游：docs/prd.md（PRD v1.0）
> 运行形态：浏览器内全栈（D2）——前端单页 + 无框架同构后端 `handle(method, path, body)`；
> 后端为内存态模块，预览时由平台把 api.js 与 fetch 拦截垫片注入 index.html。

## 1. 总体结构

| 文件 | 角色 | 职责 |
| --- | --- | --- |
| `app/frontend/index.html` | 表现层 | 单页 UI（Tailwind CDN + 原生 JS），渲染列表、提交表单、交互反馈 |
| `app/backend/api.js` | 服务层 | `module.exports = { handle }`，资源 `/api/todos`，内存数组存储 |
| `app/start_app.sh` | 运行说明 | 说明浏览器内全栈的启动与预览方式（无需安装依赖） |

- 通信：前端统一 `fetch('/api/todos')`，由平台垫片拦截转交 `handle`，响应统一 `{ code, data }`。
- 约束：不落盘、不联网、不用 localStorage/cookie（iframe 无 same-origin）→ 刷新即重置内存态。
- 取舍：单清单单实体，不上框架与构建步骤；组件化用原生函数拆分（render/list/item）。

概览（详细数据流见 docs/architecture.mmd）：

```mermaid
flowchart LR
  U[用户] --> P[index.html 单页]
  P -- fetch /api/todos --> S[fetch 拦截垫片]
  S --> H[api.js handle]
  H --> M[(内存 todos 数组)]
```

## 2. 接口契约

| 方法 | 路径 | 入参 | 返回 |
| --- | --- | --- | --- |
| GET | /api/todos | - | `{code:200, data:[{id,title,done}]}` |
| POST | /api/todos | `{title}` | `{code:201, data:{id,title,done}}` |
| PUT/PATCH | /api/todos/:id | `{done?,title?}` | `{code:200, data:更新后条目}` |
| DELETE | /api/todos/:id | - | `{code:200, data:{ok:true}}` |

- 异常统一：未知路径/资源 → `{code:404, message}`；参数缺失/非法 → `{code:400, message}`。
- 空标题由前端就地校验（AC1），后端仍做一次非空兜底校验（纵深防御）。

## 3. 数据模型

单实体 `todos`（见 docs/er_diagram.mmd）：`id:number`、`title:string`、`done:boolean`、`createdAt:number`。
派生值不落存储：进度统计（F5）由 `todos` 即时 reduce 得出，避免状态不一致。

## 4. 组件规格（UI 具体到组件级）

- 顶部标题区：应用名 + 需求副标题（`text-sm text-neutral-500`）。
- 新增表单：全圆角输入框（`rounded-full border`）+ 黑色圆形「添加」按钮（44px 触控目标）；错误提示就地展示。
- 列表：卡片式条目（`rounded-lg bg-white border`），左复选框、中标题（完成态 `line-through text-neutral-400`）、右删除按钮。
- 底部统计条：「已完成 x / 共 y」+「内存态、刷新即重置」提示。

## 5. 异常与边界

- 空列表 → 引导文案（AC5）；全部完成 → 统计条显示鼓励文案。
- 未知 `:id` 的 PUT/DELETE → `{code:404}`，前端提示后刷新列表。
- 条目数按 200 条设计（PRD §9）；无分页，列表整体渲染。

## 6. 图索引

架构数据流 docs/architecture.mmd · 数据模型 docs/er_diagram.mmd · 时序 docs/sequence_diagram.mmd ·
模块协作 docs/class_diagram.mmd · 界面状态 docs/ui_navigation.mmd

===== docs/architecture.mmd =====
%% 架构与数据流：浏览器内全栈（预览时平台注入垫片，api.js 为同构模块）
flowchart LR
  U[用户操作] --> UI[index.html 单页]
  UI -- fetch /api/todos --> SHIM[fetch 拦截垫片（平台注入）]
  SHIM -- method/path/body --> H[api.js handle]
  H -- 读写 --> M[(内存 todos 数组)]
  H -- JSON {code,data} --> SHIM
  SHIM -- 响应 --> UI
  UI -. 无 localStorage（沙箱限制） .-> M

===== docs/er_diagram.mmd =====
%% 单实体：本期不做分组/标签/截止日期（PRD §3 范围）
erDiagram
  TODO {
    number id PK "自增 id"
    string title "标题（非空）"
    boolean done "完成态"
    number createdAt "创建时间戳"
  }

===== docs/sequence_diagram.mmd =====
sequenceDiagram
  participant V as 用户
  participant P as 页面脚本
  participant A as api.js handle
  V->>P: 输入标题并回车
  P->>P: 去空白 + 非空校验（AC1）
  P->>A: POST /api/todos {title}
  A-->>P: {code:201, data:todo}
  P->>V: 顶部插入条目 + 清空输入框 + 计数刷新
  V->>P: 勾选/取消勾选
  P->>A: PUT /api/todos/:id {done}
  A-->>P: {code:200, data:todo}
  P->>V: 划线置灰切换 + 计数同步（AC3）
  V->>P: 点击删除
  P->>A: DELETE /api/todos/:id
  A-->>P: {code:200, data:{ok:true}}
  P->>V: 移除该行 + 计数同步（AC4）

===== docs/class_diagram.mmd =====
%% 模块协作：原生 JS 无类继承，用模块职责表达
classDiagram
  class TodoPage {
    +render() void
    +bindEvents() void
    +showError(message) void
  }
  class TodoApi {
    +list() Promise
    +create(title) Promise
    +update(id, patch) Promise
    +remove(id) Promise
  }
  class TodoStore {
    -todos Array
    -nextId number
    +list() Array
    +create(title) Object
    +update(id, patch) Object
    +remove(id) boolean
  }
  TodoPage --> TodoApi : fetch /api/todos
  TodoApi --> TodoStore : handle 转交
  TodoStore --> TodoStore : 内存数组读写

===== docs/ui_navigation.mmd =====
%% 界面状态机：单页内四种状态（ASCII 状态名 + 中文迁移条件）
stateDiagram-v2
  [*] --> Empty
  Empty --> List : 新增第一条（AC2）
  List --> List : 新增 / 勾选 / 删除
  List --> AllDone : 全部勾选
  AllDone --> List : 取消勾选
  AllDone --> Empty : 全部删除
  List --> [*] : 全部删除
  Empty : 空列表态 AC5 引导文案 + 示例
  List : 列表态 卡片条目 + 统计条
  AllDone : 全部完成态 统计条显示鼓励文案

===== docs/file_tree.md =====
# 文件树（人读版）

依赖顺序即实现顺序：上游文档 → 后端 → 前端 → 启动说明。
`depends` 声明「实现前必须可读的文件」，编排器按此拓扑序逐文件派发单文件任务。

```json
[
  {
    "path": "docs/prd.md",
    "desc": "产品需求文档（PRD：功能清单/用户故事/验收标准）",
    "depends": []
  },
  {
    "path": "docs/system_design.md",
    "desc": "系统设计说明（运行形态、接口契约、数据模型与 5 张图索引）",
    "depends": ["docs/prd.md"]
  },
  {
    "path": "app/backend/api.js",
    "desc": "内存态后端 handle(method,path,body)，资源 /api/todos，零依赖同构模块",
    "depends": ["docs/system_design.md"]
  },
  {
    "path": "app/frontend/index.html",
    "desc": "待办单页（Tailwind CDN + fetch 调用 /api/todos，组件级 UI 规格）",
    "depends": ["app/backend/api.js"]
  },
  {
    "path": "app/start_app.sh",
    "desc": "预览启动说明（浏览器内全栈，无需安装依赖）",
    "depends": ["app/frontend/index.html"]
  }
]
```

说明：机读版见 docs/file_tree.json（两者内容一致，改树必须同步改两处）。

===== docs/file_tree.json =====
[
  {
    "path": "docs/prd.md",
    "desc": "产品需求文档（PRD：功能清单/用户故事/验收标准）",
    "depends": []
  },
  {
    "path": "docs/system_design.md",
    "desc": "系统设计说明（运行形态、接口契约、数据模型与 5 张图索引）",
    "depends": ["docs/prd.md"]
  },
  {
    "path": "app/backend/api.js",
    "desc": "内存态后端 handle(method,path,body)，资源 /api/todos，零依赖同构模块",
    "depends": ["docs/system_design.md"]
  },
  {
    "path": "app/frontend/index.html",
    "desc": "待办单页（Tailwind CDN + fetch 调用 /api/todos，组件级 UI 规格）",
    "depends": ["app/backend/api.js"]
  },
  {
    "path": "app/start_app.sh",
    "desc": "预览启动说明（浏览器内全栈，无需安装依赖）",
    "depends": ["app/frontend/index.html"]
  }
]
