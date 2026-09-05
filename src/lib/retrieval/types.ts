/**
 * 检索扩展点契约（DESIGN §12「类型即文档」）。
 * 调用方（agent 工具层）只 import 本文件与 registry，不感知具体实现——
 * 切换检索策略（grep → fts5）不改调用方。
 */

/** 单条命中：text 为原始行（未截断，截断是展示层工具的职责）；line 从 1 起；score 越大越相关 */
export interface RankedHit { path:string; line:number; text:string; score:number; }

/** 检索入参：projectId 强制（规则 9 跨项目隔离）；limit 缺省 = 全量命中（展示截断由调用方决定） */
export interface SearchOptions { projectId:number; limit?:number; }

/**
 * 检索 Provider（DESIGN §12「检索」行）：
 * - grep（默认）：纯 RegExp 逐行扫 files 表，不评分（score 恒 0），返回全量命中
 * - fts5（RETRIEVAL_PROVIDER=fts5）：同库 fts5 虚表 trigram 分词 + bm25 排序
 */
export interface RetrievalProvider {
  name:'grep'|'fts5';
  search(query:string, opts:SearchOptions):Promise<RankedHit[]>;
}

/** 查询本身不可用（如非法正则）：工具层转成可回喂模型的错误说明，而不是让整次调用中断 */
export class BadQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadQueryError';
  }
}
