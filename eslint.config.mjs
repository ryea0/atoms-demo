import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // SDD 并行 worktree（在途分支代码不进主干 lint）
      ".superpowers/**",
      // 受控执行层物化的运行产物（files 表投影，非源码；与 vitest 排除对称，d29e767 先例）
      "data/workspaces/**",
    ],
  },
];

export default eslintConfig;
