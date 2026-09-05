/**
 * GrepRetriever：默认检索实现——纯 RegExp 逐行扫 files 表（DESIGN §4.6，Task 28 之前的现行为）。
 * 输出顺序 = readAllFiles 的路径升序 × 行号升序；不评分（score 恒 0），返回全量命中，
 * 展示层（grep 工具）再自行截断行数/行宽。
 */
import type { StorageProvider } from '@/lib/db/provider/types';
import { splitLfLines } from './lines';
import { BadQueryError, type RankedHit, type RetrievalProvider, type SearchOptions } from './types';

export function createGrepRetriever(storage:StorageProvider):RetrievalProvider {
  return {
    name:'grep',
    async search(query:string, opts:SearchOptions):Promise<RankedHit[]> {
      let regex:RegExp;
      try {
        regex = new RegExp(query);
      } catch (error) {
        // 查询不可用 → 类型化错误交工具层回喂模型（信息与原实现逐字节一致）
        throw new BadQueryError(error instanceof Error ? error.message : String(error));
      }
      const files = await storage.readAllFiles(opts.projectId);
      const hits:RankedHit[] = [];
      for (const file of files) {
        const lines = splitLfLines(file.content);
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? '';
          if (!regex.test(line)) continue;
          hits.push({ path:file.path, line:i + 1, text:line, score:0 });
        }
      }
      return hits;
    },
  };
}
