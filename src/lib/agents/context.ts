/**
 * 上下文组装器 + 预算裁剪（Task 9，DESIGN §4.1 组装顺序 / §4.4 分级压缩）。
 *
 * 职责：把「角色提示词 + 偏好/记忆 + 需求 + 上游交接 + 干预 + file_tree + 依赖文件正文 + 任务」
 * 组装成一次 LLM 调用的 {system, user}；总字符超 MAX_CONTEXT_CHARS 时按既定梯级裁剪。
 * 组装/裁剪是确定性代码，调度与决策留给模型——不把检索策略写进 prompt（CLAUDE.md 规则 1）。
 *
 * 依赖解析（§4.1 第 1 层「自动注入」）：file_tree.json 即检索索引——目标文件（extraFiles）在树中
 * 声明的 depends 直接拉全文；树缺失/不可解析时优雅降级为「只注入 extraFiles」。
 * 兜底启发式（无声明按路径规则补）不在此实现，由 Task 13 角色层负责传对 extraFiles。
 */
import { z } from 'zod';
import type { AgentRole, StorageProvider } from '@/lib/db/provider/types';

/** 单次调用上下文硬预算（字符，DESIGN §4.1「上限 24k 字符」） */
export const MAX_CONTEXT_CHARS = 24000;

/** file_tree 默认路径（架构师产出的机器可读依赖声明索引） */
export const DEFAULT_FILE_TREE_PATH = 'docs/file_tree.json';

/** 裁剪第 ②/④ 级：MEMORY / PREFERENCES 详情保留长度 */
const DOC_KEEP_CHARS = 2000;

/** 硬截提示（第 ④ 级追加，让模型知道上下文不完整、避免编造缺失内容） */
const TRIMMED_NOTICE = '（上下文已裁剪）';

/** 两级偏好/记忆的固定注入路径（DESIGN §4.2） */
const PREFERENCES_PATH = '.atoms/PREFERENCES.md';
const MEMORY_PATH = '.atoms/reports/MEMORY.md';

/** CJK 汉字区间（与 src/lib/llm/estimate.ts 同一口径，规避 target ES2017 的 \p{Script=Han}）；
 *  estimate.ts 用单字计数，这里取 ≥2 的连续汉字串做关键词 */
const HAN_RUN_PATTERN = /[㐀-䶿一-鿿豈-﫿]{2,}/g;

/** Markdown 标题行（1-6 级 + 空格），用于 system_design 分段 */
const HEADING_PATTERN = /^#{1,6}\s/;

/** file_tree.json 单节点：路径 + 职责描述 + 依赖声明（§4.1「把检索问题前置成设计问题」） */
export interface FileTreeNode {
  path: string;
  desc: string;
  depends: string[];
}

/** file_tree.json 结构校验：zod 收窄边界数据（rules/01「禁止 any」+ rules/07 输入校验） */
const fileTreeEntrySchema = z.object({
  path: z.string().min(1),
  desc: z.string(),
  depends: z.array(z.string()),
});
const fileTreeSchema = z.array(fileTreeEntrySchema);

export interface AssembleInput {
  storage: StorageProvider;
  projectId: number;
  /** 角色（systemPrompt 已由角色层拼好；保留在契约里供编排器归因/计量传递） */
  role: AgentRole;
  systemPrompt: string;
  task: string;
  upstreamSummaries: string[];
  interventions: string[];
  /** 机器可读依赖声明文件路径；缺省 docs/file_tree.json */
  fileTreePath?: string;
  /** 目标文件（本任务要写/改的路径）：恒注入全文，并作为树中 depends 的解析锚点 */
  extraFiles?: string[];
  /** 传入时读取 session 级个人偏好注入 system（不存在/为空则静默跳过） */
  sessionId?: string;
}

/** 注入的文件正文（path 用于 `===== path =====` 分隔与裁剪归属判断） */
interface FileBody {
  path: string;
  content: string;
}

/** file_tree 来源：原文用于全文注入，nodes 用于依赖解析 */
interface FileTreeSource {
  path: string;
  raw: string;
  nodes: FileTreeNode[];
}

/** 组装中间态：渲染前可被裁剪梯级逐级改写（每级后重算总长，达标即停） */
interface Assembled {
  systemPrompt: string;
  sessionPref: string | null;
  preferencesDoc: string | null;
  memoryDoc: string | null;
  requirement: string;
  summaries: string[];
  interventions: string[];
  fileTree: FileBody | null;
  /** 依赖文件正文（extraFiles ∪ 树声明 depends，路径升序） */
  depFiles: FileBody[];
  /** 非依赖文件正文：当前组装恒为空——§4.1 只注入依赖文件全文，file_tree 单独成段。
   *  字段保留是为了让裁剪第 ① 级成为显式不变量：未来组装若引入非依赖正文，先在这里被丢掉。 */
  nonDepFiles: FileBody[];
  /** 目标文件路径（extraFiles），第 ④ 级硬截时最后才动它们 */
  targetPaths: string[];
  task: string;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

/** 小节标题行：【标题】 */
function section(title: string, body: string): string {
  return `【${title}】\n${body}`;
}

/** 依赖文件分隔头（brief 规定格式） */
function fileHeader(path: string): string {
  return `===== ${path} =====`;
}

function renderSystem(a: Assembled): string {
  const blocks = [a.systemPrompt];
  if (a.sessionPref !== null) blocks.push(section('个人偏好', a.sessionPref));
  if (a.preferencesDoc !== null) blocks.push(section(`项目偏好（${PREFERENCES_PATH}）`, a.preferencesDoc));
  if (a.memoryDoc !== null) blocks.push(section(`长期记忆（${MEMORY_PATH}）`, a.memoryDoc));
  return blocks.join('\n\n');
}

function renderUser(a: Assembled): string {
  const blocks = [section('需求', a.requirement)];
  if (a.summaries.length > 0) {
    blocks.push(section('上游交接摘要', a.summaries.map((item) => `- ${item}`).join('\n')));
  }
  if (a.interventions.length > 0) {
    blocks.push(section('干预指令', a.interventions.map((item) => `- ${item}`).join('\n')));
  }
  if (a.fileTree !== null) blocks.push(section(`项目文件树（${a.fileTree.path}）`, a.fileTree.content));
  const bodies = a.nonDepFiles.length > 0 ? [...a.nonDepFiles, ...a.depFiles] : a.depFiles;
  if (bodies.length > 0) {
    blocks.push(section('依赖文件全文', bodies.map((file) => `${fileHeader(file.path)}\n${file.content}`).join('\n\n')));
  }
  blocks.push(section('任务', a.task));
  return blocks.join('\n\n');
}

/** 当前总字符量（system + user，与 MAX_CONTEXT_CHARS 同口径） */
function totalLength(a: Assembled): number {
  return renderSystem(a).length + renderUser(a).length;
}

/* ------------------------------------------------------------------ */
/* 读取与解析                                                          */
/* ------------------------------------------------------------------ */

/** 读 file_tree：缺失/坏 JSON/结构不符一律返回 null（优雅跳过树上下文，不抛错） */
async function readFileTree(
  storage: StorageProvider,
  projectId: number,
  path: string,
): Promise<FileTreeSource | null> {
  const row = await storage.getFile(projectId, path);
  if (row === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.content) as unknown;
  } catch (error) {
    console.warn(`[context] file_tree 解析失败，跳过树上下文：path=${path}，${String(error)}`);
    return null;
  }
  const result = fileTreeSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(`[context] file_tree 结构不符，跳过树上下文：path=${path}`);
    return null;
  }
  return { path, raw: row.content, nodes: result.data };
}

/** session 级个人偏好 → 文本；不存在/空对象/空串返回 null（静默跳过该段） */
async function readSessionPreference(storage: StorageProvider, sessionId: string): Promise<string | null> {
  const data = await storage.getPreference('session', sessionId);
  if (data === null || data === undefined) return null;

  let text: string;
  if (typeof data === 'string') {
    text = data;
  } else {
    try {
      text = JSON.stringify(data, null, 2) ?? '';
    } catch (error) {
      console.warn(`[context] session 偏好序列化失败，跳过注入：sessionId=${sessionId}，${String(error)}`);
      return null;
    }
  }
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '{}' || trimmed === '[]') return null;
  return trimmed;
}

/** 路径稳定升序（不依赖 locale，保证组装结果可复现） */
function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 依赖集合 = extraFiles（目标，恒注入）∪ 树中目标条目声明的 depends（直接声明，不递归展开——
 * 更上游的内容模型可用 read_file 按需自取，即 §4.1 第 2 层检索）。
 * 树缺失（null）时退化为 extraFiles 全集（兜底启发式不实现，Task 13 角色层负责传对路径）。
 */
function resolveDependencyPaths(tree: FileTreeNode[] | null, extraFiles: string[]): string[] {
  const paths = new Set<string>(extraFiles);
  if (tree !== null) {
    const targets = new Set<string>(extraFiles);
    for (const node of tree) {
      if (!targets.has(node.path)) continue;
      for (const dep of node.depends) paths.add(dep);
    }
  }
  return [...paths].sort(comparePath);
}

/* ------------------------------------------------------------------ */
/* 预算裁剪（DESIGN §4.4，逐级递进、每级后重算总长）                      */
/* ------------------------------------------------------------------ */

/** 第 ① 级：丢非依赖文件正文（file_tree 在独立字段，天然保留） */
function dropNonDependencyBodies(a: Assembled): Assembled {
  return a.nonDepFiles.length > 0 ? { ...a, nonDepFiles: [] } : a;
}

/** 第 ② 级：MEMORY 详情保留首 2000 字符 */
function truncateMemory(a: Assembled): Assembled {
  if (a.memoryDoc === null || a.memoryDoc.length <= DOC_KEEP_CHARS) return a;
  return { ...a, memoryDoc: `${a.memoryDoc.slice(0, DOC_KEEP_CHARS)}\n…（长期记忆已按预算截断）` };
}

/** 第 ④ 级（系统侧）：项目偏好详情保留首 2000 字符——system 侧内容同样受预算约束（与 MEMORY 同口径） */
function truncatePreferences(a: Assembled): Assembled {
  if (a.preferencesDoc === null || a.preferencesDoc.length <= DOC_KEEP_CHARS) return a;
  return { ...a, preferencesDoc: `${a.preferencesDoc.slice(0, DOC_KEEP_CHARS)}\n…（项目偏好已按预算截断）` };
}

/** system_design 类文件识别（路径含 system_design / system-design） */
function isSystemDesignPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.includes('system_design') || lower.includes('system-design');
}

/** 按 Markdown 标题切段（标题前的前言也算一段，同样参与关键词筛选） */
function splitSections(content: string): string[] {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const line of content.split('\n')) {
    if (HEADING_PATTERN.test(line) && current.length > 0) {
      chunks.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((lines) => lines.join('\n'));
}

/** 段内第一个标题文本（无标题返回 null），用于被裁段落的索引提示 */
function firstHeading(chunk: string): string | null {
  for (const line of chunk.split('\n')) {
    if (HEADING_PATTERN.test(line)) return line.replace(/^#{1,6}\s*/, '').trim();
  }
  return null;
}

/** 段落是否命中任一关键词（ASCII 不区分大小写） */
function containsAnyKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

/**
 * 从任务指令与目标路径提取关键词：ASCII 标识符（API/组件名）+ 中文相邻二字组（规则式近似，无分词器）。
 * 只服务第 ③ 级筛选；命中过宽时该级自动不裁（全部命中=原样保留），因此宁滥勿缺。
 */
function extractKeywords(task: string, targetPaths: string[]): string[] {
  const keywords = new Set<string>();
  for (const token of task.match(/[A-Za-z_][A-Za-z0-9_-]+/g) ?? []) keywords.add(token.toLowerCase());
  for (const run of task.match(HAN_RUN_PATTERN) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) keywords.add(run.slice(i, i + 2));
  }
  for (const path of targetPaths) {
    const parts = path.split('/');
    const base = parts[parts.length - 1];
    if (base !== undefined && base.length >= 2) keywords.add(base.toLowerCase());
  }
  return [...keywords];
}

/** 第 ③ 级：仅保留含任务关键词的段落，被裁段落留标题索引（模型可再用 read_file 取全文） */
function keepKeywordSections(content: string, keywords: string[]): string {
  if (keywords.length === 0) return content;
  const chunks = splitSections(content);
  const hits = chunks.map((chunk) => containsAnyKeyword(chunk, keywords));
  const kept = chunks.filter((_, index) => hits[index] === true);
  if (kept.length === chunks.length) return content;

  const droppedCount = chunks.length - kept.length;
  const droppedTitles = chunks
    .filter((_, index) => hits[index] !== true)
    .map(firstHeading)
    .filter((title): title is string => title !== null && title !== '');
  const note =
    droppedTitles.length > 0
      ? `\n（已按任务相关性省略 ${droppedCount} 段：${droppedTitles.join('、')}）`
      : `\n（已按任务相关性省略 ${droppedCount} 段）`;
  const body = kept.join('\n');
  return body === '' ? `（system_design 已按任务相关性裁剪，无匹配段落）${note}` : `${body}${note}`;
}

function trimSystemDesignSections(a: Assembled, keywords: string[]): Assembled {
  let changed = false;
  const depFiles = a.depFiles.map((file) => {
    if (!isSystemDesignPath(file.path)) return file;
    const next = keepKeywordSections(file.content, keywords);
    if (next === file.content) return file;
    changed = true;
    return { path: file.path, content: next };
  });
  return changed ? { ...a, depFiles } : a;
}

/**
 * 第 ④ 级（user 侧硬截）：依赖正文按保护级从低到高整篇丢弃——先丢树声明依赖，后丢 extraFiles 目标。
 * dropSequence 覆盖全部 depFiles，循环结束后若仍超预算（无正文可丢），由 buildOutput 对 user 整体硬截。
 */
function hardTrim(a: Assembled): { assembled: Assembled; trimmed: boolean } {
  const targets = new Set(a.targetPaths);
  // 丢弃顺序：非目标（保护级低）在前，目标在后；同保护级内从列表尾部往前丢
  const dropSequence = [
    ...a.depFiles.filter((file) => !targets.has(file.path)).reverse(),
    ...a.depFiles.filter((file) => targets.has(file.path)).reverse(),
  ];

  let current = a;
  let trimmed = false;

  for (const victim of dropSequence) {
    if (totalLength(current) <= MAX_CONTEXT_CHARS) break;
    current = { ...current, depFiles: current.depFiles.filter((file) => file.path !== victim.path) };
    trimmed = true;
  }
  return { assembled: current, trimmed };
}

/** 预算裁剪主流程：逐级执行、每级后重算总长、达标即停 */
function applyBudget(a: Assembled): { assembled: Assembled; hardTrimmed: boolean } {
  let current = dropNonDependencyBodies(a);
  if (totalLength(current) <= MAX_CONTEXT_CHARS) return { assembled: current, hardTrimmed: false };

  current = truncateMemory(current);
  if (totalLength(current) <= MAX_CONTEXT_CHARS) return { assembled: current, hardTrimmed: false };

  current = trimSystemDesignSections(current, extractKeywords(current.task, current.targetPaths));
  if (totalLength(current) <= MAX_CONTEXT_CHARS) return { assembled: current, hardTrimmed: false };

  // 第 ④ 级（硬截）：系统侧先裁项目偏好详情，再丢依赖正文；仍超由 buildOutput 硬截 user 尾部
  current = truncatePreferences(current);
  if (totalLength(current) <= MAX_CONTEXT_CHARS) return { assembled: current, hardTrimmed: false };

  const result = hardTrim(current);
  return { assembled: result.assembled, hardTrimmed: result.trimmed };
}

/**
 * 渲染输出；走过 user 侧硬截梯级则追加提示，且任何情况下都保证总量 ≤ MAX_CONTEXT_CHARS。
 * （systemPrompt 为角色层常量、非文件内容，按调用契约视为有界；文件类系统侧内容由第②/④级约束。）
 */
function buildOutput(a: Assembled, hardTrimmed: boolean): { system: string; user: string } {
  const system = renderSystem(a);
  let user = renderUser(a);
  if (hardTrimmed) user = `${user}\n${TRIMMED_NOTICE}`;

  if (system.length + user.length > MAX_CONTEXT_CHARS) {
    // 最后兜底（如需求本身超长、无正文可丢）：硬截 user 尾部并重加提示
    const budget = Math.max(0, MAX_CONTEXT_CHARS - system.length - TRIMMED_NOTICE.length - 1);
    user = `${user.slice(0, budget)}\n${TRIMMED_NOTICE}`;
  }
  return { system, user };
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/** 组装一次 LLM 调用的上下文（project 缺失即抛错——上游归属校验失效时的显式失败） */
export async function assembleContext(input: AssembleInput): Promise<{ system: string; user: string }> {
  const project = await input.storage.getProject(input.projectId);
  if (project === null) {
    throw new Error(`项目不存在：projectId=${input.projectId}，无法组装上下文`);
  }

  const rows = await input.storage.readAllFiles(input.projectId);
  const contentByPath = new Map<string, string>();
  for (const row of rows) contentByPath.set(row.path, row.content);

  const treePath = input.fileTreePath ?? DEFAULT_FILE_TREE_PATH;
  const tree = await readFileTree(input.storage, input.projectId, treePath);

  const extraFiles = input.extraFiles ?? [];
  const depFiles: FileBody[] = [];
  for (const path of resolveDependencyPaths(tree?.nodes ?? null, extraFiles)) {
    const content = contentByPath.get(path);
    if (content !== undefined) depFiles.push({ path, content });
  }

  const sessionPref = input.sessionId === undefined ? null : await readSessionPreference(input.storage, input.sessionId);

  const assembled: Assembled = {
    systemPrompt: input.systemPrompt,
    sessionPref,
    preferencesDoc: contentByPath.get(PREFERENCES_PATH) ?? null,
    memoryDoc: contentByPath.get(MEMORY_PATH) ?? null,
    requirement: project.requirement,
    summaries: input.upstreamSummaries,
    interventions: input.interventions,
    fileTree: tree === null ? null : { path: tree.path, content: tree.raw },
    depFiles,
    nonDepFiles: [],
    targetPaths: extraFiles,
    task: input.task,
  };

  const trimmed = applyBudget(assembled);
  return buildOutput(trimmed.assembled, trimmed.hardTrimmed);
}
