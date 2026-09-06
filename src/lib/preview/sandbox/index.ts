/** 沙箱注册表：runtime → provider。P3 落地 pyodide 后在此注册。 */
import type { PreviewRuntime } from '@/lib/languages/types';
import type { PreviewSandboxProvider } from './types';
import { browserJsSandbox } from './browser-js';

const SANDBOXES: Partial<Record<PreviewRuntime, PreviewSandboxProvider>> = {
  'browser-js': browserJsSandbox,
};

/** 未注册 runtime 回退 browser-js（先例：EXEC_PROVIDER 回退 local；只告警一次） */
let warned = false;
export function getSandbox(runtime: PreviewRuntime): PreviewSandboxProvider {
  const found = SANDBOXES[runtime];
  if (found !== undefined) return found;
  if (!warned) {
    console.warn(`[preview] 未注册的运行时 ${runtime}，回退 browser-js`);
    warned = true;
  }
  return browserJsSandbox;
}
