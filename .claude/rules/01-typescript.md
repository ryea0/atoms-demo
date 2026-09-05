# TypeScript 规则

> 来源：TypeScript 官方 handbook、typescript-eslint、社区共识（见文末）

## 编译配置（tsconfig.json）
- `strict: true` 起步，生产项目追加：`noUncheckedIndexedAccess`、`noImplicitOverride`、`noFallthroughCasesInSwitch`、`forceConsistentCasingInFileNames`
- `moduleResolution: "bundler"`（Next.js 默认）；不用 `esModuleInterop` 之外的宽松开关
- 路径别名只用 `@/*`（指向 `src/*`），不引入多层别名

## 类型纪律
- **禁止 `any`**；用 `unknown` + 收窄（类型守卫/zod）替代
- 禁止 `@ts-ignore`；用 `@ts-expect-error` + 必须带原因注释（`// @ts-expect-error <reason>`），修好即删
- 优先 `interface` 定义对象形状、`type` 做联合/工具类型；导出的类型不使用 `export type *`
- 公共函数显式标注返回类型；不依赖推断泄漏内部类型
- 从 `as` 断言倒退：能写守卫就不写断言；断言只出现在边界（外部数据解析后）
- 枚举用 `as const` 对象或字面量联合，不用 `enum`
- 数组索引访问结果按 `T | undefined` 处理（noUncheckedIndexedAccess 语义），访问后必须判空

## 命名
- 文件：组件 `PascalCase.tsx`；工具/模块 `kebab-case.ts`；测试 `*.test.ts`
- 变量/函数 camelCase；类型/接口 PascalCase；常量 UPPER_SNAKE 仅用于真正常量
- 布尔命名 `is/has/should` 前缀；异步函数名不强制 Async 后缀（返回类型已表达）

## 错误处理
- 不写空的 catch；至少 console.error + 上抛或转 Result
- 边界（API/route handler）错误必须转成结构化错误（含 code/message），不泄漏堆栈给客户端
- 异步错误不许吞：Promise 必须 await 或显式 void + .catch

## 来源
- https://www.typescriptlang.org/docs/handbook/intro.html
- https://typescript-eslint.io/rules/
- https://itnext.io/why-typescripts-strict-true-isn-t-enough-missing-compiler-flags-for-production-code-a3877b81142c
