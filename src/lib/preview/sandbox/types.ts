/** §12「预览沙箱」扩展点：iframe 内如何跑起后端。backendSource 已过 profile.build。 */
import type { LanguageProfile } from '@/lib/languages/types';

export interface PreviewInput {
  indexHtml: string;
  backendSource: string | null;
  profile: LanguageProfile;
}

export interface PreviewOutput {
  html: string;
  /** CSP 指令增量；undefined = 无增量（CSP 逐字节保持基线） */
  cspExtras?: { scriptSrc?: string[]; connectSrc?: string[] };
}

export interface PreviewSandboxProvider {
  readonly kind: 'browser-js' | 'browser-pyodide';
  assemble(input: PreviewInput): PreviewOutput;
}
