/**
 * typescript 档案：服务端进程内转译（typescript 包为 devDep 现状，spec §2.2），
 * 转译产物走 browser-js 沙箱与 __atoms runner——TS 与 JS 共享同一运行面。
 * 校验口径：transpileModule 的 syntactic diagnostics（reportDiagnostics: true）
 * 只报语法错；类型错不拦截（strip 后不影响运行，spec §4.1）。
 */
import ts from 'typescript';
import { checkSyntax } from '@/lib/validation/syntax';
import { scanDanger } from '@/lib/validation/danger';
import type { LanguageProfile } from '../types';

/** strip types → CommonJS（api.ts → 预览垫片/runner 可执行的 JS 文本） */
export function transpileBackend(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: 'api.ts',
  }).outputText;
}

/** 转译或报告：语法错 → { ok:false, error }（中文，进工程师带错重试链） */
export function transpileOrReport(source: string): { ok: true; js: string } | { ok: false; error: string } {
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: 'api.ts',
    reportDiagnostics: true,
  });
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const first = errors[0];
    if (first !== undefined) {
      return { ok: false, error: `TypeScript 语法错误：${ts.flattenDiagnosticMessageText(first.messageText, ' ')}` };
    }
  }
  return { ok: true, js: out.outputText };
}

export const typescriptProfile: LanguageProfile = {
  id: 'typescript',
  backendExtension: 'ts',
  backendEntryPath: 'app/backend/api.ts',
  runtime: 'browser-js',
  engineerContract: [
    '1. 后端 app/backend/api.ts：TypeScript 无框架同构模块，导出 export function handle(method: string, path: string, body: unknown): { code: number; data?: unknown; message?: string }；数据一律存内存数组/对象（类型自明，禁 any）；禁止任何 fs/net/进程/timer API；REST 语义与正确状态码（200/201/400/404/405）。',
  ],
  selfCheckHint:
    '- 写完 TS 文件后可用 bash 自检：npx tsc --noEmit <文件> 验类型语法；单任务最多 5 次、每次 ≤30s；不要用 bash 启动长驻服务、安装依赖或改文件（写文件一律走 write_file）。',
  build(files) {
    const out = new Map<string, string>();
    for (const [path, content] of files) {
      out.set(path, path.endsWith('.ts') ? transpileBackend(content) : content);
    }
    return out;
  },
  checkSyntax(path, content) {
    const result = transpileOrReport(content);
    if (!result.ok) return { ok: false, error: result.error };
    return checkSyntax(path.replace(/\.ts$/, '.js'), result.js);
  },
  scanDanger(path, content) {
    const result = transpileOrReport(content);
    if (!result.ok) return [];
    return scanDanger(path.replace(/\.ts$/, '.js'), result.js);
  },
};
