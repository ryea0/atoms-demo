/**
 * 检索注册表（DESIGN §12「Provider + Registry」）：RETRIEVAL_PROVIDER = grep（默认）| fts5。
 * - env 晚绑定：每次调用重读（与 LLM 层既有取舍一致，进程内改 env 立即生效），不缓存 provider
 * - 未知取值 / 存储不具备 FTS5 能力 → 回退默认 grep（检索是工具的加固项，不因配置错误而不可用）
 */
import type { StorageProvider } from '@/lib/db/provider/types';
import { createFtsRetriever } from './fts';
import { createGrepRetriever } from './grep';
import type { RetrievalProvider } from './types';

/** 同一原因只告警一次：工具每次调用都会重建 provider，重复告警会刷屏（单实例内存态，进程级去重即可） */
const warned = new Set<string>();
function warnOnce(message:string):void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[retrieval] ${message}`);
}

export function getRetriever(storage:StorageProvider, env:NodeJS.ProcessEnv = process.env):RetrievalProvider {
  const kind = (env.RETRIEVAL_PROVIDER ?? 'grep').trim().toLowerCase();
  if (kind === 'fts5') {
    const fts = createFtsRetriever(storage);
    if (fts) return fts;
    warnOnce('RETRIEVAL_PROVIDER=fts5 但当前存储不提供 FTS5 能力，回退默认 grep');
    return createGrepRetriever(storage);
  }
  if (kind !== 'grep') warnOnce(`未知 RETRIEVAL_PROVIDER：${kind}（可选 grep|fts5），回退默认 grep`);
  return createGrepRetriever(storage);
}
