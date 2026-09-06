/**
 * FS 工具集（write_file / read_file / list_files / grep）——DESIGN §4.5/§4.6。
 * 边界：工具只操作虚拟文件系统（files 表，经 StorageProvider，全部强制 project_id），
 * 不直接碰宿主磁盘；命令执行走受控执行层 src/lib/exec/（bash.ts，2026-09-06 增补，
 * 守卫见 .claude/rules/07-security.md「受控执行层」）。
 * 每个工具自带 zod schema（execute 前校验，失败回喂给模型重试）与由 schema 派生的
 * JSON Schema parameters（给 LLM 的 function calling 声明），二者同源不漂移。
 */
import { z } from 'zod';
import type { AgentRole, StorageProvider } from '@/lib/db/provider/types';
import { getRetriever } from '@/lib/retrieval/registry';
import { BadQueryError, type RankedHit } from '@/lib/retrieval/types';
import { normalizeProjectPath } from './sandbox';

/**
 * 工具参数 JSON Schema（OpenAI/Anthropic 兼容的 function calling 结构）。
 * 由 zod schema 经 z.toJSONSchema 派生，这里只声明消费方关心的字段，其余放行。
 */
export type JSONSchema = {
  [key:string]: unknown;
  type?:string | readonly string[];
  description?:string;
  properties?:Record<string, unknown>;
  required?:readonly string[];
};

/** 工具执行上下文：由 AgentRunner 注入，工具据此闭包绑定项目与当前角色 */
export interface ToolContext { storage:StorageProvider; projectId:number; role:AgentRole; }

/** 工具统一契约：ok=false 的 output 是给模型看的错误说明（供 runner 回喂重试） */
export interface Tool {
  name:string;
  description:string;
  /** 入参 zod 校验器（runner 侧复用同一份做预检） */
  schema:z.ZodType;
  /** 给 LLM 的参数声明（由 schema 派生） */
  parameters:JSONSchema;
  execute(args:unknown, ctx:ToolContext):Promise<{ok:boolean;output:string}>;
}

/**
 * 内容上限 512KB（.claude/rules/07「数据库写入前二次约束」，按 UTF-8 字节数计）。
 * 单一事实来源：fs 工具（write_file）与角色层的直写落库（专家报告 / MEMORY）共用同一口径。
 */
export const MAX_CONTENT_BYTES = 512 * 1024;
/** read_file 截断保护（DESIGN §4.6）：超过 400 行只回首尾各 200 行 */
const READ_TRUNCATE_LINES = 400;
const READ_HEAD_LINES = 200;
const READ_TAIL_LINES = 200;
/**
 * read_file 输出字符兜底（DESIGN §4.6 上下文预算）：
 * 行数达标（≤400 行）的文件仍可能是压缩 JS/base64 这类超长行，全部吐出会撑爆模型上下文，
 * 故最终输出超限再按首尾各半截断（保留首尾可见性语义）。
 */
const READ_MAX_OUTPUT_CHARS = 16000;
/** grep 输出行数上限（DESIGN §4.6 工具结果截断） */
const GREP_MAX_LINES = 50;
/** grep 单行展示上限（压缩/超长行也占上下文预算） */
const GREP_LINE_CHARS = 240;

/**
 * zod 校验失败 → 一行可读错误（字段路径 + 原因），直接回喂模型。
 * 工具层（defineTool 预检）与 AgentRunner（Task 8 调用前预检）共用同一份格式，
 * 保证模型在两条路径上看到一致的错误说明；"参数校验失败：" 前缀由调用方拼接。
 */
export function formatZodIssues(error:z.ZodError):string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/** 派生 JSON Schema：去掉 $schema 头（部分 provider 的 schema 转换器对顶层额外字段严格） */
function toParameters(schema:z.ZodType):JSONSchema {
  const parameters:JSONSchema = z.toJSONSchema(schema);
  delete parameters.$schema;
  return parameters;
}

/**
 * 工具工厂：包一层"校验 + parameters 派生"，具体实现只写业务逻辑。
 * 泛型让 execute 拿到已收窄的入参类型，对外仍暴露统一 Tool 契约。
 */
function defineTool<S extends z.ZodType>(def:{
  name:string;
  description:string;
  schema:S;
  execute(args:z.infer<S>, ctx:ToolContext):Promise<{ok:boolean;output:string}>;
}):Tool {
  return {
    name:def.name,
    description:def.description,
    schema:def.schema,
    parameters:toParameters(def.schema),
    async execute(args:unknown, ctx:ToolContext):Promise<{ok:boolean;output:string}> {
      const parsed = def.schema.safeParse(args);
      if (!parsed.success) return { ok:false, output:`参数校验失败：${formatZodIssues(parsed.error)}` };
      return def.execute(parsed.data, ctx);
    },
  };
}

/** 路径入参统一校验：任何 FS 工具的 path 都过同一道沙箱 */
function checkedPath(path:string):{ok:true;path:string}|{ok:false;output:string} {
  const result = normalizeProjectPath(path);
  return result.ok ? result : { ok:false, output:`路径不合法：${result.error}` };
}

/** CRLF 归一：否则行号错位、行尾锚点正则（如 TODO$）会静默失配 */
function toLf(content:string):string {
  return content.replace(/\r\n/g, '\n');
}

/** read_file 行数截断：末尾换行不算新行；>400 行 → 首 200 + 省略提示（含总行数）+ 尾 200 */
function truncateLines(content:string):string {
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  if (total <= READ_TRUNCATE_LINES) return content;
  const omitted = total - READ_HEAD_LINES - READ_TAIL_LINES;
  const marker = `……[中间省略 ${omitted} 行，文件共 ${total} 行，仅显示首尾各 ${READ_HEAD_LINES} 行]……`;
  return [...lines.slice(0, READ_HEAD_LINES), marker, ...lines.slice(total - READ_TAIL_LINES)].join('\n');
}

/** read_file 字符兜底：行数达标但总量超长（超长行/压缩 JS）时按首尾各半截断，附诚实提示 */
function capChars(text:string):string {
  if (text.length <= READ_MAX_OUTPUT_CHARS) return text;
  const keep = Math.floor(READ_MAX_OUTPUT_CHARS / 2);
  const omitted = text.length - keep * 2;
  const marker = `……[中段省略 ${omitted} 字符，内容共 ${text.length} 字符，仅显示首尾各 ${keep} 字符]……`;
  return `${text.slice(0, keep)}${marker}${text.slice(-keep)}`;
}

const writeFileSchema = z.object({
  path:z.string().describe('目标文件路径，相对项目根（如 src/app/page.tsx、docs/prd.md）'),
  content:z.string().describe('完整文件内容（UTF-8 文本，整体覆盖写入，不含行号）'),
});

const readFileSchema = z.object({
  path:z.string().describe('要读取的文件路径，相对项目根'),
});

const listFilesSchema = z.object({}).describe('无需参数');

const grepSchema = z.object({
  pattern:z.string().min(1).describe('JS 正则表达式（对每一行做匹配，如 "TODO|FIXME"）'),
});

/** 写入虚拟文件系统（upsert：已存在则入档旧版本并 version+1），editor 记当前角色 */
const writeFile = defineTool({
  name:'write_file',
  description:'写文件到当前项目的虚拟文件系统（已存在则覆盖并生成新版本）。路径必须是相对项目根的合法相对路径。',
  schema:writeFileSchema,
  async execute(args, ctx) {
    const path = checkedPath(args.path);
    if (!path.ok) return path;
    const bytes = Buffer.byteLength(args.content, 'utf8');
    if (bytes > MAX_CONTENT_BYTES) {
      return { ok:false, output:`内容 ${bytes} 字节超过上限 ${MAX_CONTENT_BYTES} 字节（512KB），请精简或拆分文件` };
    }
    const { version } = await ctx.storage.upsertFile({
      projectId:ctx.projectId,
      path:path.path,
      content:args.content,
      editor:ctx.role,
    });
    return { ok:true, output:`已写入 ${path.path} v${version}` };
  },
});

/** 读取单个文件（>400 行截断保护，防止大文件挤爆上下文） */
const readFile = defineTool({
  name:'read_file',
  description:'读取当前项目中一个文件的完整内容；超过 400 行的文件只返回首尾各 200 行并标注省略行数。',
  schema:readFileSchema,
  async execute(args, ctx) {
    const path = checkedPath(args.path);
    if (!path.ok) return path;
    const row = await ctx.storage.getFile(ctx.projectId, path.path);
    if (!row) return { ok:false, output:'文件不存在' };
    const content = toLf(row.content);
    if (content.length === 0) return { ok:true, output:'（空文件）' };
    return { ok:true, output:capChars(truncateLines(content)) };
  },
});

/** 文件清单（升序，每行一个 path）——先看全貌再决定读哪个 */
const listFiles = defineTool({
  name:'list_files',
  description:'列出当前项目已生成的全部文件路径（每行一个，按路径升序），不返回内容。',
  schema:listFilesSchema,
  async execute(_args, ctx) {
    const items = await ctx.storage.listFiles(ctx.projectId);
    if (items.length === 0) return { ok:true, output:'（当前项目还没有文件）' };
    return { ok:true, output:items.map((item) => item.path).join('\n') };
  },
});

/**
 * 正则扫全项目文件内容，输出 path:line: 匹配行（上限 50 行，超出给总数提示）。
 * 检索本体经 getRetriever 路由（DESIGN §12：默认 grep，RETRIEVAL_PROVIDER=fts5 时换全文索引），
 * 工具层只负责展示口径（行数/行宽截断、命中计数、错误回喂）——默认输出与检索层抽取前逐字节一致。
 */
const grep = defineTool({
  name:'grep',
  description:'在当前项目所有文件内容里逐行检索，输出 path:line: 匹配行（最多 50 行）。默认按 JS 正则匹配；启用全文索引时按字面短语匹配（大小写不敏感、非正则）。适合"这个函数在哪被调用"类问题。',
  schema:grepSchema,
  async execute(args, ctx) {
    let hits:RankedHit[];
    try {
      hits = await getRetriever(ctx.storage).search(args.pattern, { projectId:ctx.projectId });
    } catch (error) {
      if (error instanceof BadQueryError) {
        return { ok:false, output:`非法正则 "${args.pattern}"：${error.message}` };
      }
      throw error;
    }
    if (hits.length === 0) return { ok:true, output:`未命中：项目内没有匹配 /${args.pattern}/ 的行` };
    const lines:string[] = [];
    for (const hit of hits.slice(0, GREP_MAX_LINES)) {
      const shown = hit.text.length > GREP_LINE_CHARS ? `${hit.text.slice(0, GREP_LINE_CHARS)}……[本行超长已截断]` : hit.text;
      lines.push(`${hit.path}:${hit.line}: ${shown}`);
    }
    if (hits.length > lines.length) lines.push(`……[共 ${hits.length} 处命中，仅显示前 ${GREP_MAX_LINES} 行，可收窄 pattern]……`);
    return { ok:true, output:lines.join('\n') };
  },
});

/** FS 工具集（顺序稳定：写/读/列/搜） */
export const fsTools:Tool[] = [writeFile, readFile, listFiles, grep];
