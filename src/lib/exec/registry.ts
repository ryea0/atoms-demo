/**
 * 执行注册表（DESIGN §12「执行」行）：EXEC_PROVIDER = local（默认）| disabled。
 * - env 晚绑定：每次调用重读（与 retrieval/llm 层同一取舍），不缓存 provider
 * - disabled 一键全关（终端 503、agent bash 工具收到禁用提示）
 * - 未知取值回退 local（与 RETRIEVAL_PROVIDER 同一先例：能力默认可用，不因配置错误而不可用）
 */
import { createLocalExecutionProvider } from './local';
import type { ExecutionProvider } from './types';

/** 同一原因只告警一次（工具每次调用都会重建 provider，进程级去重防刷屏） */
const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[exec] ${message}`);
}

function createDisabledExecutionProvider(): ExecutionProvider {
  return {
    kind: 'disabled',
    run: async () => ({
      ok: false, exitCode: null, reason: 'disabled',
      output: '执行能力已禁用（EXEC_PROVIDER=disabled），无法运行命令。',
      durationMs: 0,
    }),
  };
}

export function getExecutionProvider(env: NodeJS.ProcessEnv = process.env): ExecutionProvider {
  const kind = (env.EXEC_PROVIDER ?? 'local').trim().toLowerCase();
  if (kind === 'disabled') return createDisabledExecutionProvider();
  if (kind !== 'local') warnOnce(`未知 EXEC_PROVIDER：${kind}（可选 local|disabled），回退默认 local`);
  return createLocalExecutionProvider(env);
}
