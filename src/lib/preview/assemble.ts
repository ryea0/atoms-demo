/**
 * 全栈预览装配编排器（spec 2026-09-06-multi-language-design）：
 * 探测后端入口（注册表声明序）→ profile.build → getSandbox(runtime).assemble → CSP 合成。
 * CSP 基线 ruling 7 逐字；增量只来自 sandbox 的 cspExtras（当前仅 python/pyodide）。
 */
import type { StorageProvider } from '@/lib/db/provider/types';
import { LANGUAGE_PROFILES, defaultLanguageProfile } from '@/lib/languages';
import { getSandbox } from './sandbox';

export const PREVIEW_INDEX_PATH = 'app/frontend/index.html';

/** 预览响应 CSP 基线（ruling 7 逐字，不动） */
export const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://cdn.tailwindcss.com; style-src 'unsafe-inline' https://cdn.tailwindcss.com; img-src data: https:; connect-src 'none'";

export type PreviewAssembly = { ok: true; html: string; csp: string } | { ok: false; reason: 'missing_index' };

/** CSP 增量合成：extras 未给 → 原样返回；connect-src 的 'none' 与其他值互斥 → 有增量时替换 */
export function composePreviewCsp(base: string, extras?: { scriptSrc?: string[]; connectSrc?: string[] }): string {
  if (extras === undefined) return base;
  return base
    .split(';')
    .map((directive) => directive.trim())
    .filter(Boolean)
    .map((directive) => {
      const name = directive.split(' ')[0] ?? '';
      const tokens = directive.slice(name.length).trim();
      if (name === 'script-src' && extras.scriptSrc !== undefined && extras.scriptSrc.length > 0) {
        return `${name} ${[tokens, ...extras.scriptSrc].filter(Boolean).join(' ')}`;
      }
      if (name === 'connect-src' && extras.connectSrc !== undefined && extras.connectSrc.length > 0) {
        const kept = tokens === "'none'" ? '' : tokens;
        return `${name} ${[kept, ...extras.connectSrc].filter(Boolean).join(' ')}`;
      }
      return directive;
    })
    .join('; ');
}

/** 读虚拟 FS 并装配：探测后端入口（js 优先）→ build → sandbox → CSP */
export async function assemblePreview(storage: StorageProvider, projectId: number): Promise<PreviewAssembly> {
  const index = await storage.getFile(projectId, PREVIEW_INDEX_PATH);
  if (index === null) return { ok: false, reason: 'missing_index' };

  let profile = defaultLanguageProfile();
  let source: string | null = null;
  for (const candidate of LANGUAGE_PROFILES) {
    const file = await storage.getFile(projectId, candidate.backendEntryPath);
    if (file !== null) {
      profile = candidate;
      source = file.content;
      break;
    }
  }

  const built =
    source === null
      ? null
      : (profile.build(new Map([[profile.backendEntryPath, source]])).get(profile.backendEntryPath) ?? null);

  const output = getSandbox(profile.runtime).assemble({ indexHtml: index.content, backendSource: built, profile });
  return { ok: true, html: output.html, csp: composePreviewCsp(PREVIEW_CSP, output.cspExtras) };
}
