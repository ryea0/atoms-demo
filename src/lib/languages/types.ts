/**
 * 语言注册表契约（DESIGN §12「语言」扩展点，spec 2026-09-06-multi-language-design）。
 * 语言的唯一判定源 = 后端入口扩展名（app/backend/api.js|.ts|.py）；
 * profile 承载该语言的全部差异面：契约文案、构建变换、校验、运行时。
 * 注意：profiles 只准 import validation 的叶子模块（syntax/danger），不得 import
 * validation/index——index 会反向 import 本注册表，形成环。
 */
import type { Danger } from '@/lib/validation/danger';
import type { SyntaxReport } from '@/lib/validation/syntax';

export type LanguageId = 'javascript' | 'typescript' | 'python';
// 未来接入位：'cpp'（预期 browser-wasm + 服务端编译）、'java'（预期 server-process，需重估安全姿态）
export type PreviewRuntime = 'browser-js' | 'browser-pyodide';

export interface LanguageProfile {
  readonly id: LanguageId;
  readonly backendExtension: 'js' | 'ts' | 'py';
  /** 后端入口约定路径（预览探测与物化投影按它找文件） */
  readonly backendEntryPath: string;
  /** 预览运行时（PreviewSandboxProvider 选型依据） */
  readonly runtime: PreviewRuntime;
  /** 工程师 system prompt【全栈契约】的后端段（第 1 条；前端/UI 条对所有语言共用） */
  readonly engineerContract: readonly string[];
  /** 工程师 prompt 的 bash 自检整行（js 档案 = 现文案逐字，保零变化） */
  readonly selfCheckHint: string;
  /** 预览/物化前的纯函数变换（ts=转译；js/py 恒等） */
  build(files: ReadonlyMap<string, string>): Map<string, string>;
  checkSyntax(path: string, content: string): SyntaxReport;
  scanDanger(path: string, content: string): Danger[];
}
