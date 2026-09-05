/**
 * FtsRetriever：可选检索实现——同库 fts5 虚表（trigram 分词）+ bm25 排序（DESIGN §12，T28）。
 * 索引由 ddl.ts 的触发器随 files 写路径同步，检索层只读；全文索引是方言能力（FtsSearchRepo），
 * 按**能力探测**选择实现——存储没有该方法（如未来的 PostgresStorage 未实现）时返回 null，
 * 由 registry 回退默认 grep（不抛错、不静默改变语义）。
 *
 * 与 grep 的有意语义差异（工具描述已向模型说明）：
 * - 查询按字面短语匹配，不做正则解释；trigram 最小粒度 3 字符，更短的查询返回空集
 * - trigram 对 ASCII 折叠大小写，行级命中同样按大小写不敏感的子串判定
 * - 排序：bm25（文件级相关性）→ 同分按路径升序；同一文件内按行号升序展开（确定性）
 */
import type { StorageProvider } from '@/lib/db/provider/types';
import { splitLfLines } from './lines';
import type { RankedHit, RetrievalProvider, SearchOptions } from './types';

export function createFtsRetriever(storage:StorageProvider):RetrievalProvider|null {
  // 结构化能力探测：不依赖具体类/模块实例（避免 alias 与相对路径混用时模块双实例导致探测失效）
  const { searchFtsFiles } = storage;
  if (typeof searchFtsFiles !== 'function') return null;
  return {
    name:'fts5',
    async search(query:string, opts:SearchOptions):Promise<RankedHit[]> {
      const ranked = await searchFtsFiles(opts.projectId, query, opts.limit ?? null);
      const needle = query.toLowerCase();
      const hits:RankedHit[] = [];
      for (const file of ranked) {
        const lines = splitLfLines(file.content);
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? '';
          // 与 trigram 的 ASCII 折叠对齐：行级命中用大小写不敏感子串判定
          if (!line.toLowerCase().includes(needle)) continue;
          hits.push({ path:file.path, line:i + 1, text:line, score:file.score });
        }
      }
      return hits;
    },
  };
}
