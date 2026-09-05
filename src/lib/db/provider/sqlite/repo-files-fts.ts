/**
 * FTS5 全文检索仓库（DESIGN §12「检索」扩展点的 SQLite 专属实现，Task 28）。
 * - 虚表 files_fts 与同步触发器由 ddl.ts 自举（drizzle-kit 不管虚表）；本仓库只读，不写索引
 * - 索引 rowid = files.id，联表回 files 取内容并强制 project_id 过滤（CLAUDE.md 规则 9：跨项目隔离）
 * - FTS5 MATCH 不在 drizzle 查询构建器表达范围内 → 走原生 prepare + zod 收窄（better-sqlite3 为同步 API）
 * - 查询一律按字面短语解释（不解析 FTS5 语法）：查询来自模型输出的正则字符串，按语法解析既不可预期也有注入面
 */
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { FtsRankedFile, FtsSearchRepo } from '../types';

/** FTS5 短语字面量：双引号翻倍后整体包引号（空串/短串交给 trigram 语义，返回空集而不报错） */
export function quotePhrase(query:string):string {
  return `"${query.replace(/"/g, '""')}"`;
}

/** 限定的 MATCH 表达式：只搜 content 列（path 仅随行带出，不参与相关性，语义更可预期） */
function matchExpression(query:string):string {
  return `content: ${quotePhrase(query)}`;
}

/** better-sqlite3 原始行 → zod 收窄（规则 01：禁 any，外部数据过校验器） */
const rankedRows = z.array(
  z.object({ fileId:z.number(), path:z.string(), content:z.string(), score:z.number() }),
);

const BASE_SQL = [
  'SELECT f.`id` AS fileId, f.`path` AS path, f.`content` AS content, -bm25(`files_fts`) AS score',
  'FROM `files_fts` JOIN `files` f ON f.`id` = `files_fts`.`rowid`',
  'WHERE `files_fts` MATCH ? AND f.`project_id` = ?',
  'ORDER BY bm25(`files_fts`), f.`path` ASC',
].join(' ');

export function createFilesFtsRepo(client: Database.Database): FtsSearchRepo {
  /** limit=null 取全量（与 grep 同语义，展示截断由调用方决定）；否则 SQL 端 LIMIT，只取最相关的前 N 个文件 */
  async function searchFtsFiles(projectId:number, query:string, limit:number|null):Promise<FtsRankedFile[]> {
    const match = matchExpression(query);
    const rows = limit === null
      ? client.prepare(BASE_SQL).all(match, projectId)
      : client.prepare(`${BASE_SQL} LIMIT ?`).all(match, projectId, limit);
    return rankedRows.parse(rows);
  }
  return { searchFtsFiles };
}
