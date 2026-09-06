/**
 * 架构师角色（Task 12，DESIGN §3.2「结构化单发」/ §5⑤「生成质量工程」）。
 *
 * 执行形态：零工具三阶段串行（设计 → 图纸 → 文件树），每阶段一次 LLM 调用，
 * 产出按 `===== <路径> =====` 分段头切分后落库。三阶段拆分是为了解决真实模型
 * 8 段单发总时长超时问题（低算力模型 5 分钟内吐不完 3000+ 字），同时每步专注一个
 * 思维单元，质量优于一次输出 8 段。
 *
 *   runArchitectDesign   → docs/system_design.md（1 段，文字设计）
 *   runArchitectDiagrams → 5 张 mermaid 图（architecture/er/sequence/class/ui_navigation）
 *   runArchitectFileTree → docs/file_tree.md + docs/file_tree.json（2 段，人读 + 机读）
 *
 * 每阶段独立 agent_run、独立失败可重试；缺段只记 warning 不阻断（与原有 8 段单发
 * 语义一致），下游编排器按降级模板兜底。
 *
 * 兼容入口 runArchitect() 内部串行调三阶段，返回聚合后的 ArchitectResult（files/
 * fileTree 合并、runId 取最后一个阶段），外部调用方无需修改。
 *
 * 上下文（规则 7 零历史共享）：每阶段只带上游已落库的文件 + PM summary，
 * 不依赖前一步的对话历史。
 * 安全（规则 6/07）：分段路径与树节点路径一律过 normalizeProjectPath；契约外路径跳过并告警
 * （交付物清单由代码锁定，不交给模型自由发挥）。
 * 计量（规则 10）：每阶段独立 resolveModel + 独立 wrapMetered（三阶段三条 llm_calls）。
 *
 * 服务端专用（读样例文件 + env），不得进入客户端 bundle。
 */
import { z } from 'zod';
import { runAgent } from '@/lib/agents/runner';
import { AgentAbortError } from '@/lib/agents/types';
import {
  beginRoleRun,
  failRoleRun,
  finishRoleRun,
  renderWarnings,
  validationWarnings,
} from '@/lib/agents/roles/run-support';
import { normalizeProjectPath } from '@/lib/agents/tools';
import { DEFAULT_FILE_TREE_PATH, type FileTreeNode } from '@/lib/agents/context';
import { readSample } from '@/lib/llm/mock';
import { resolveModel } from '@/lib/llm/client';
import { wrapMetered } from '@/lib/llm/metered-provider';
import { validateFile } from '@/lib/validation';
import type { StorageProvider } from '@/lib/db/provider/types';
import type { LlmProvider } from '@/lib/llm/types';

/** 上游 PRD 路径（与 roles/pm.ts 的 PRD_PATH 同值；此处避免跨角色 import 造成环） */
const UPSTREAM_PRD_PATH = 'docs/prd.md';

/** 机读文件树路径（与 context.ts 的检索索引同一路径） */
export const FILE_TREE_PATH: string = DEFAULT_FILE_TREE_PATH;

/** 总任务键（与 mock 领导分派链的 task_key 对齐；兼容入口使用） */
export const ARCHITECT_TASK_KEY = 'architect-design';

/** 设计阶段 task key */
export const ARCHITECT_DESIGN_TASK_KEY = 'architect:design';
/** 图纸阶段 task key */
export const ARCHITECT_DIAGRAMS_TASK_KEY = 'architect:diagrams';
/** 文件树阶段 task key */
export const ARCHITECT_FILE_TREE_TASK_KEY = 'architect:file-tree';

/** 全量交付物清单（8 个 docs 文件，顺序即原输出契约顺序） */
export const ARCHITECT_DOC_PATHS: readonly string[] = [
  'docs/system_design.md',
  'docs/architecture.mmd',
  'docs/er_diagram.mmd',
  'docs/sequence_diagram.mmd',
  'docs/class_diagram.mmd',
  'docs/ui_navigation.mmd',
  'docs/file_tree.md',
  FILE_TREE_PATH,
];

/** 设计阶段交付物（1 段） */
export const ARCHITECT_DESIGN_PATHS: readonly string[] = ['docs/system_design.md'];

/** 图纸阶段交付物（5 张 mermaid 图） */
export const ARCHITECT_DIAGRAM_PATHS: readonly string[] = [
  'docs/architecture.mmd',
  'docs/er_diagram.mmd',
  'docs/sequence_diagram.mmd',
  'docs/class_diagram.mmd',
  'docs/ui_navigation.mmd',
];

/** 文件树阶段交付物（2 段） */
export const ARCHITECT_FILE_TREE_PATHS: readonly string[] = ['docs/file_tree.md', FILE_TREE_PATH];

/** file_tree 注入 run.summary 时的标记行（编排器断点续跑从这里还原树） */
export const FILE_TREE_SUMMARY_MARKER = 'FILE_TREE_JSON:';

/** file_tree 单节点/数组（结构定义以 context.ts 为单一来源，此处只做 re-export 供下游 import） */
export type { FileTreeNode };
export type FileTree = FileTreeNode[];

/** 架构师上下文（三阶段共用） */
export interface ArchitectContext {
  storage: StorageProvider;
  projectId: number;
  /** 停止信号：透传 runAgent */
  signal?: AbortSignal;
  /** 可注入 provider（测试桩 / 编排器统一入口）；缺省走真实 provider，恒经 wrapMetered 计量包裹 */
  provider?: LlmProvider;
  /** 思考流透传（编排器接 SSE reasoning 事件用，T31）；缺省不透传，行为不变 */
  onReasoning?: (text: string) => void;
}

/** 单阶段结果 */
interface StageResult {
  runId: number;
  files: string[];
  warnings: string[];
}

/** 全量结果：任务 id（取最后阶段）+ 落库文件清单 + 结构化文件树 */
export interface ArchitectResult {
  runId: number;
  files: string[];
  fileTree: FileTree;
}

/* ------------------------------------------------------------------ */
/* 输出切分                                                            */
/* ------------------------------------------------------------------ */

/**
 * 分段头：一行内 `===== 路径 =====`（等号 ≥3 个，容忍首尾空白）。
 * 捕获组收紧为「路径形状」（以字母/数字/下划线开头，含点+扩展名）：
 * 裸等号线（`=======`，旧实现会捕获出路径 `=`）与散文式标题（`===== 小结 =====`）
 * 都不算分段头，而是留在上一段正文里——否则其后的内容会被错误归属到
 * 契约外路径并被整段丢弃（且只留下一条难以追溯的告警）。
 */
const SEGMENT_HEADER_PATTERN = /^={3,}\s*([\w][\w./-]*\.[\w-]+)\s*={3,}$/;

/** 一个待落库分段（content 保留原始换行） */
interface RawSegment {
  path: string;
  content: string;
}

interface SplitResult {
  segments: RawSegment[];
  /** 首个分段头之前、不带路径标记的正文（无法归属到文件，调用方记 warning） */
  preamble: string;
}

/** 告警里附带的原文片段（压成单行并截断：可追溯，又不撑爆 run.summary） */
function snippet(text: string, max = 80): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max)}…`;
}

/** 按 `===== 路径 =====` 行切分模型输出（确定性解析，不容错改写） */
function splitSegments(output: string): SplitResult {
  const segments: RawSegment[] = [];
  const preambleLines: string[] = [];
  let current: RawSegment | null = null;

  for (const line of output.split('\n')) {
    const match = SEGMENT_HEADER_PATTERN.exec(line);
    if (match !== null) {
      if (current !== null) segments.push(current);
      current = { path: (match[1] ?? '').trim(), content: '' };
      continue;
    }
    if (current === null) preambleLines.push(line);
    else current.content += `${line}\n`;
  }
  if (current !== null) segments.push(current);

  return { segments, preamble: preambleLines.join('\n').trim() };
}

/* ------------------------------------------------------------------ */
/* file_tree 解析                                                      */
/* ------------------------------------------------------------------ */

/** 树节点结构校验（边界数据收窄，rules/01「禁止 any」+ rules/07 输入校验） */
const fileTreeNodeSchema = z.object({
  path: z.string().min(1),
  desc: z.string(),
  depends: z.array(z.string()),
});
const fileTreeSchema = z.array(fileTreeNodeSchema);

export type ParsedFileTree = { ok: true; tree: FileTree } | { ok: false; error: string };

/**
 * 解析机读 file_tree：容忍 ```json 围栏；结构不符返回 Result 错误（不抛错）。
 * 供角色内部与编排器「从 run.summary 还原树」复用。
 */
export function parseFileTree(raw: string): ParsedFileTree {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const text = (fenced?.[1] ?? trimmed).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return { ok: false, error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const checked = fileTreeSchema.safeParse(parsed);
  if (!checked.success) {
    return { ok: false, error: `结构不符（需 [{"path","desc","depends":[]}]）：${checked.error.message}` };
  }
  return { ok: true, tree: checked.data };
}

/** 树节点逐个过沙箱归一（不合格节点剔除并记 warning），返回可用节点 */
function normalizeTreeNodes(nodes: FileTreeNode[], warnings: string[]): FileTree {
  const tree: FileTree = [];
  for (const node of nodes) {
    const nodePath = normalizeProjectPath(node.path);
    if (!nodePath.ok) {
      warnings.push(`file_tree 节点路径未过沙箱，已剔除：${node.path}（${nodePath.error}）`);
      continue;
    }
    tree.push({ ...node, path: nodePath.path });
  }
  return tree;
}

/* ------------------------------------------------------------------ */
/* 公共落库工具                                                         */
/* ------------------------------------------------------------------ */

/**
 * 把模型输出按 expectedPaths 白名单过滤后落库，返回落库成功的路径列表 + 告警。
 * 契约外路径、空段、沙箱不通过、校验不通过都只记 warning，不抛错。
 */
async function upsertExpectedSegments(
  storage: StorageProvider,
  projectId: number,
  content: string,
  expectedPaths: readonly string[],
  warnings: string[],
): Promise<string[]> {
  const expected = new Set<string>(expectedPaths);
  const { segments, preamble } = splitSegments(content);
  if (preamble !== '') {
    warnings.push(`输出开头有未归属任何交付物的正文（未落库，原文片段：${snippet(preamble)}）`);
  }
  const files: string[] = [];
  for (const segment of segments) {
    const trimmed = segment.content.trim();
    if (trimmed === '') {
      warnings.push(`分段 ${segment.path} 为空，已跳过`);
      continue;
    }
    const checked = normalizeProjectPath(segment.path);
    if (!checked.ok) {
      warnings.push(`分段路径未过沙箱，已跳过：${segment.path}（${checked.error}）`);
      continue;
    }
    if (!expected.has(checked.path)) {
      warnings.push(`契约外交付物，已跳过：${checked.path}（交付清单由代码锁定）`);
      continue;
    }
    warnings.push(...validationWarnings(checked.path, validateFile(checked.path, trimmed)));
    await storage.upsertFile({ projectId, path: checked.path, content: trimmed, editor: 'architect' });
    if (!files.includes(checked.path)) files.push(checked.path);
  }
  // 缺段告警（调用方若需全量缺失统计可自行再算）
  for (const expectedPath of expectedPaths) {
    if (!files.includes(expectedPath)) {
      warnings.push(`缺失交付物：${expectedPath}`);
    }
  }
  return files;
}

/* ------------------------------------------------------------------ */
/* 硬约束共享段                                                        */
/* ------------------------------------------------------------------ */

/** 所有架构师 prompt 共用的硬约束段（技术栈 + 安全边界） */
function hardConstraintsBlock(): string {
  return [
    '【硬约束】',
    '- 后端必须是无框架同构模块 app/backend/api.js：导出 handle(method, path, body)，数据存内存，禁 fs/net/timer。',
    "- 前端为单页 app/frontend/index.html，统一 fetch('/api/...') 调后端；禁 localStorage/cookie（浏览器沙箱无 same-origin）。",
    '- 生成应用零依赖、无构建步骤；图一律 mermaid（不用 PlantUML）。',
    '- 全文中文。',
    '- 后端入口：默认 app/backend/api.js；leader 交接写明「后端语言=typescript|python」时改用 api.ts/api.py（同构 handle 契约不变，语言差异由工程师契约段约束）。',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 阶段 1：设计（system_design.md）                                     */
/* ------------------------------------------------------------------ */

function designSystemPrompt(): string {
  return [
    '你是架构师，负责基于上游 PRD 产出系统设计文档。',
    '',
    '【输出契约——只输出 1 段，第一段以 `===== docs/system_design.md =====` 开头】',
    '内容：运行形态、模块职责表、接口契约、数据模型、异常与边界；UI 规格具体到组件级（布局/状态/样式要点）。',
    '不要输出 mermaid 图、不要输出文件树、不要输出任何其他分段——那些由后续阶段负责。',
    '',
    hardConstraintsBlock(),
    '',
    '【黄金样例（只学结构、粒度与分段格式，内容必须来自本次 PRD，禁止照抄样例主题）】',
    readSample('design.md').split(/^={3,}\s*docs\/architecture\.mmd\s*={3,}$/m)[0] ?? readSample('design.md'),
  ].join('\n');
}

function designUserPrompt(prd: string | null, pmSummary: string | null): string {
  const handoff = pmSummary ?? '（无上游摘要：PM 任务缺失或被中断）';
  const prdBlock = prd ?? `（未读到 ${UPSTREAM_PRD_PATH}：上游缺失，请按合理假设补齐边界并在设计中注明。）`;
  return [
    `【上游交接（PM 摘要）】\n${handoff}`,
    '',
    `【上游 PRD（${UPSTREAM_PRD_PATH} 全文）】\n${prdBlock}`,
    '',
    '【任务】产出系统设计文档（docs/system_design.md）：只输出这一段文字设计，图纸与文件树由后续阶段负责。',
  ].join('\n');
}

/** 阶段 1：系统设计文档 */
export async function runArchitectDesign(ctx: ArchitectContext): Promise<StageResult> {
  const { storage, projectId } = ctx;
  const runId = await beginRoleRun(storage, {
    projectId,
    taskKey: ARCHITECT_DESIGN_TASK_KEY,
    agent: 'architect',
    task: '产出系统设计文档（docs/system_design.md）',
  });
  const model = resolveModel('architect');
  const provider = wrapMetered({ storage, projectId, agentRole: 'architect', model, provider: ctx.provider });
  try {
    const prd = await storage.getFile(projectId, UPSTREAM_PRD_PATH);
    const runs = await storage.listAgentRuns(projectId);
    const pmRun = runs.filter((run) => run.agent === 'pm').at(-1) ?? null;

    const result = await runAgent({
      role: 'architect',
      systemPrompt: designSystemPrompt(),
      userPrompt: designUserPrompt(prd?.content ?? null, pmRun?.summary ?? null),
      tools: [],
      model,
      ctx: { storage, projectId, role: 'architect' },
      provider,
      callbacks: ctx.onReasoning === undefined ? undefined : { onReasoning: ctx.onReasoning },
      signal: ctx.signal,
    });

    const warnings: string[] = [];
    const files = await upsertExpectedSegments(storage, projectId, result.content, ARCHITECT_DESIGN_PATHS, warnings);
    await finishRoleRun(
      storage,
      runId,
      `架构师·设计阶段：产出 ${files.length}/${ARCHITECT_DESIGN_PATHS.length} 个交付物（${files.join('、') || '无'}）${renderWarnings(warnings)}`,
    );
    return { runId, files, warnings };
  } catch (error) {
    await failRoleRun(storage, runId, error);
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* 阶段 2：图纸（5 张 mermaid 图）                                       */
/* ------------------------------------------------------------------ */

function diagramsSystemPrompt(): string {
  return [
    '你是架构师，负责基于已确认的系统设计产出 5 张 mermaid 架构图。',
    '',
    '【输出契约——一次输出 5 段，每段第一行必须是 `===== 路径 =====`】',
    '1. docs/architecture.mmd：架构与数据流图（mermaid flowchart）。',
    '2. docs/er_diagram.mmd：数据模型图（mermaid erDiagram）。',
    '3. docs/sequence_diagram.mmd：关键交互时序图（mermaid sequenceDiagram）。',
    '4. docs/class_diagram.mmd：模块协作图（mermaid classDiagram）。',
    '5. docs/ui_navigation.mmd：界面状态机（mermaid stateDiagram-v2）。',
    '- 每个 .mmd 段内只放 mermaid 源码（可用 %% 注释），不要 ``` 围栏、不要解释文字。',
    '- 缺段会降低下游质量，但不要发明契约外的路径；某张图确实不适用时输出带 %% 说明的最小占位图。',
    '',
    hardConstraintsBlock(),
  ].join('\n');
}

function diagramsUserPrompt(design: string | null, prd: string | null): string {
  return [
    design === null
      ? '（已落库交付物中没有 system_design.md——按 PRD 直接画图，图中注明是基于 PRD 的推断）'
      : `【已落库 system_design.md】\n${design}`,
    '',
    prd === null ? '' : `【上游 PRD（参考）】\n${prd}\n`,
    '',
    '【任务】依据系统设计产出 5 张 mermaid 架构图（architecture / er / sequence / class / ui_navigation）。只输出图，不要输出文字设计、不要输出文件树。',
  ].join('\n');
}

/** 阶段 2：5 张 mermaid 图 */
export async function runArchitectDiagrams(ctx: ArchitectContext): Promise<StageResult> {
  const { storage, projectId } = ctx;
  const runId = await beginRoleRun(storage, {
    projectId,
    taskKey: ARCHITECT_DIAGRAMS_TASK_KEY,
    agent: 'architect',
    task: '产出 5 张 mermaid 架构图',
  });
  const model = resolveModel('architect');
  const provider = wrapMetered({ storage, projectId, agentRole: 'architect', model, provider: ctx.provider });
  try {
    const design = (await storage.getFile(projectId, 'docs/system_design.md'))?.content ?? null;
    const prd = (await storage.getFile(projectId, UPSTREAM_PRD_PATH))?.content ?? null;

    const result = await runAgent({
      role: 'architect',
      systemPrompt: diagramsSystemPrompt(),
      userPrompt: diagramsUserPrompt(design, prd),
      tools: [],
      model,
      ctx: { storage, projectId, role: 'architect' },
      provider,
      callbacks: ctx.onReasoning === undefined ? undefined : { onReasoning: ctx.onReasoning },
      signal: ctx.signal,
    });

    const warnings: string[] = [];
    const files = await upsertExpectedSegments(storage, projectId, result.content, ARCHITECT_DIAGRAM_PATHS, warnings);
    await finishRoleRun(
      storage,
      runId,
      `架构师·图纸阶段：产出 ${files.length}/${ARCHITECT_DIAGRAM_PATHS.length} 张图（${files.join('、') || '无'}）${renderWarnings(warnings)}`,
    );
    return { runId, files, warnings };
  } catch (error) {
    await failRoleRun(storage, runId, error);
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* 阶段 3：文件树（file_tree.md + file_tree.json）                       */
/* ------------------------------------------------------------------ */

function fileTreeSystemPrompt(): string {
  return [
    '你是架构师，负责基于系统设计产出工程化文件树（逐文件实现的拓扑依据）。',
    '',
    '【输出契约——只输出 2 段，每段以 `===== 路径 =====` 开头】',
    `1. docs/file_tree.md：人读版文件树（说明 + 用 \`\`\`json 围栏嵌同一份树）。`,
    `2. ${FILE_TREE_PATH}：机读版文件树，形如 [{"path":"app/frontend/index.html","desc":"职责一句话","depends":["app/backend/api.js"]}]，按依赖拓扑序排列；depends 只能指向树内已有路径。`,
    '',
    hardConstraintsBlock(),
  ].join('\n');
}

function fileTreeUserPrompt(design: string | null, prd: string | null): string {
  return [
    design === null
      ? '（已落库交付物中没有 system_design.md——按 PRD 直接规划文件树，在 desc 里注明是基于 PRD 的推断）'
      : `【已落库 system_design.md】\n${design}`,
    '',
    prd === null ? '' : `【上游 PRD（参考）】\n${prd}\n`,
    '',
    '【任务】依据系统设计产出文件树（人读 + 机读各一段）。机读树是下游逐文件派发的唯一拓扑依据，depends 必须写准。只输出文件树，不要输出设计文档、不要输出 mermaid 图。',
  ].join('\n');
}

/** 阶段 3：文件树 */
export async function runArchitectFileTree(ctx: ArchitectContext): Promise<StageResult & { fileTree: FileTree }> {
  const { storage, projectId } = ctx;
  const runId = await beginRoleRun(storage, {
    projectId,
    taskKey: ARCHITECT_FILE_TREE_TASK_KEY,
    agent: 'architect',
    task: '产出文件树（人读版 + 机读 JSON）',
  });
  const model = resolveModel('architect');
  const provider = wrapMetered({ storage, projectId, agentRole: 'architect', model, provider: ctx.provider });
  try {
    const design = (await storage.getFile(projectId, 'docs/system_design.md'))?.content ?? null;
    const prd = (await storage.getFile(projectId, UPSTREAM_PRD_PATH))?.content ?? null;

    const result = await runAgent({
      role: 'architect',
      systemPrompt: fileTreeSystemPrompt(),
      userPrompt: fileTreeUserPrompt(design, prd),
      tools: [],
      model,
      ctx: { storage, projectId, role: 'architect' },
      provider,
      callbacks: ctx.onReasoning === undefined ? undefined : { onReasoning: ctx.onReasoning },
      signal: ctx.signal,
    });

    const warnings: string[] = [];
    const files = await upsertExpectedSegments(storage, projectId, result.content, ARCHITECT_FILE_TREE_PATHS, warnings);

    let fileTree: FileTree = [];
    const fileTreeRow = await storage.getFile(projectId, FILE_TREE_PATH);
    if (fileTreeRow === null) {
      warnings.push(`缺失机读 ${FILE_TREE_PATH}，file_tree 视为空`);
    } else {
      const parsed = parseFileTree(fileTreeRow.content);
      if (parsed.ok) {
        fileTree = normalizeTreeNodes(parsed.tree, warnings);
      } else {
        warnings.push(`${FILE_TREE_PATH}：${parsed.error}——file_tree 视为空`);
      }
    }

    /**
     * 三段式第 2 步（容错兜底）：树空时补发一次「只要树」的窄契约小调用
     * （原单发 8 段时这个补发很常用；三阶段拆出后，树阶段本身就是窄契约，
     * 补发作为双重兜底——真失败了仍失败，不炸主流程）。
     * provider 错误吞成 warning 不炸 run（补发是增强项），停止语义照常上抛。
     */
    if (fileTree.length === 0) {
      try {
        const repaired = await runAgent({
          role: 'architect',
          systemPrompt: fileTreeRepairSystemPrompt(),
          userPrompt: fileTreeRepairUserPrompt(design, prd),
          tools: [],
          model,
          ctx: { storage, projectId, role: 'architect' },
          provider,
          callbacks: ctx.onReasoning === undefined ? undefined : { onReasoning: ctx.onReasoning },
          signal: ctx.signal,
        });
        const parsedRepair = parseFileTree(repaired.content);
        if (!parsedRepair.ok) {
          warnings.push(`补发修复未产出可用树：${parsedRepair.error}`);
        } else {
          const repairedTree = normalizeTreeNodes(parsedRepair.tree, warnings);
          if (repairedTree.length === 0) {
            warnings.push('补发树为空数组，维持降级');
          } else {
            fileTree = repairedTree;
            await storage.upsertFile({
              projectId,
              path: FILE_TREE_PATH,
              content: `${JSON.stringify(repairedTree, null, 2)}\n`,
              editor: 'architect',
            });
            if (!files.includes(FILE_TREE_PATH)) files.push(FILE_TREE_PATH);
            warnings.push(`机读 ${FILE_TREE_PATH} 缺失，已由补发小调用修复（${repairedTree.length} 节点）`);
          }
        }
      } catch (error) {
        if (error instanceof AgentAbortError) throw error;
        warnings.push(`补发修复失败（${error instanceof Error ? error.message : String(error)}），维持降级`);
      }
    }
    if (fileTree.length === 0) warnings.push('file_tree 为空数组：下游无拓扑序可用，需按降级模板生成');

    await finishRoleRun(
      storage,
      runId,
      `架构师·文件树阶段：产出 ${files.length}/${ARCHITECT_FILE_TREE_PATHS.length} 个交付物（${files.join('、') || '无'}）；file_tree ${fileTree.length} 节点${renderWarnings(warnings)}`,
    );
    return { runId, files, warnings, fileTree };
  } catch (error) {
    await failRoleRun(storage, runId, error);
    throw error;
  }
}

/** 补发 system prompt：窄契约——只出一份树（与原 fileTreeRepair 一致，保留作兜底） */
function fileTreeRepairSystemPrompt(): string {
  return [
    '你是架构师，执行一次窄任务：上一轮产出中机读文件树缺失或不可解析。',
    '只输出一份 file_tree JSON（裸 JSON 或 ```json 围栏均可），不要输出任何其他文件、图或解释文字。',
    '结构：[{"path":"...","desc":"职责一句话","depends":["..."]}]，按依赖拓扑序排列，depends 只指向树内已有路径。',
    '后端入口默认 app/backend/api.js；leader 交接 summary 写明「后端语言=typescript|python」时改用 api.ts/api.py（同构 handle 契约不变）。'
      + "前端固定 app/frontend/index.html（单页，fetch('/api/...')，禁 localStorage）。生成应用零依赖、无构建步骤。",
  ].join('\n');
}

/** 补发 user prompt */
function fileTreeRepairUserPrompt(design: string | null, prd: string | null): string {
  return [
    design === null
      ? '（已落库交付物中没有 system_design.md——按 PRD 直接规划）'
      : `【已落库 system_design.md】\n${design}`,
    '',
    prd === null ? '（PRD 缺失——按任务上下文合理假设并在 desc 里写明）' : `【PRD 全文】\n${prd}`,
    '',
    '【任务】依据上述材料产出 file_tree JSON（只输出树本身）。',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 兼容入口：三阶段串行编排                                              */
/* ------------------------------------------------------------------ */

/** 交接摘要：产出清单 + 告警 + 序列化的 file_tree（规则 7：summary 是唯一交接物） */
function summarizeArchitecture(files: string[], fileTree: FileTree, warnings: string[]): string {
  const missing = ARCHITECT_DOC_PATHS.filter((path) => !files.includes(path));
  if (missing.length > 0) {
    warnings.unshift(`缺失 ${missing.length} 个交付物：${missing.join('、')}（缺什么少什么，不阻断）`);
  }
  const lines = [
    `架构师产出 ${files.length}/${ARCHITECT_DOC_PATHS.length} 个设计交付物：${files.join('、') || '（无）'}`,
    `file_tree：${fileTree.length} 节点（下游按此拓扑序逐文件派发）`,
  ];
  const warningBlock = renderWarnings(warnings);
  if (warningBlock !== '') lines.push(warningBlock);
  lines.push(FILE_TREE_SUMMARY_MARKER, JSON.stringify(fileTree));
  return lines.join('\n');
}

/**
 * 兼容入口：串行跑三阶段（设计 → 图纸 → 文件树），返回聚合结果。
 *
 * 任一阶段抛出错误（provider 错误 / 停止）都会中止后续阶段并上抛；
 * 缺段等软性失败只记 warning，继续往下走（与原单发 8 段的容错语义一致）。
 *
 * 聚合结果的 runId 取最后阶段（文件树）的 runId，files 是三阶段合并去重，
 * fileTree 取自文件树阶段。
 */
export async function runArchitect(ctx: ArchitectContext): Promise<ArchitectResult> {
  const { storage } = ctx;
  const allFiles: string[] = [];
  const allWarnings: string[] = [];

  // 阶段 1：设计
  const designResult = await runArchitectDesign(ctx);
  for (const f of designResult.files) if (!allFiles.includes(f)) allFiles.push(f);
  allWarnings.push(...designResult.warnings);

  // 阶段 2：图纸（设计失败会抛错直接上抛，不会到这里）
  const diagramsResult = await runArchitectDiagrams(ctx);
  for (const f of diagramsResult.files) if (!allFiles.includes(f)) allFiles.push(f);
  allWarnings.push(...diagramsResult.warnings);

  // 阶段 3：文件树
  const treeResult = await runArchitectFileTree(ctx);
  for (const f of treeResult.files) if (!allFiles.includes(f)) allFiles.push(f);
  allWarnings.push(...treeResult.warnings);

  // 用最终 runId 写一条聚合 summary（供下游编排器 / leader 读取）
  // （三阶段各自已经写了自己的 summary；这里再补一个"总体"，保持与旧入口一致的 summary 内容）
  await finishRoleRun(storage, treeResult.runId, summarizeArchitecture(allFiles, treeResult.fileTree, allWarnings));
  return { runId: treeResult.runId, files: allFiles, fileTree: treeResult.fileTree };
}
