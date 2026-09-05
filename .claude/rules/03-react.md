# React 19 规则

> 来源：React 官方文档 react.dev

## 组件
- 函数组件 only；props 只读，不改
- 组件单一职责：一个文件一个导出组件（小组件可同文件，上限 ~3 个且强相关）
- 列表渲染 key 用稳定业务 id，禁用数组索引（列表会增删时）
- 不派生可计算状态：能由 props/现有 state 算出的不另存 state（React 官方 "You Might Not Need an Effect"）

## Hooks
- 只在组件顶层调用；条件逻辑放进 hook 内部
- useEffect 只用于**与外部系统同步**（订阅、定时器、DOM、SSE）；数据变换/事件响应不用 effect
- 依赖数组诚实：宁可 eslint exhaustive-deps 报错修复，不写 `// eslint-disable-line`
- cleanup 必须完整：EventSource/AbortController/定时器在 return 里关闭，防泄漏与重复连接
- 自定义 hook 命名 `use*`，只在其内部调用其他 hook

## 状态
- 就近原则：state 放使用它的最小子树；不先上 Context
- 服务端数据状态用轮询/SSE 驱动的 store 或 SWR 式缓存，不复制进 useState 再手动同步
- 表单受控/非受控不混用同一字段

## 渲染
- 副作用不放在渲染路径（渲染必须纯净）；事件处理器或 effect 里做变更
- 大列表虚拟化或分页；流式打字机文本用 ref 操作滚动，不逐字符 setState 整棵树

## 来源
- https://react.dev/learn/you-might-not-need-an-effect
- https://react.dev/reference/react/hooks
