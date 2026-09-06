/**
 * 架构师角色（Task 12，DESIGN §3.2「结构化单发」/ §5⑤「生成质量工程」）。
 *
 * 执行形态：零工具单发，模型一次输出 **8 段**——每段以一行 `===== <路径> =====` 开头：
 *   docs/system_design.md · docs/{architecture,er_diagram,sequence_diagram,class_diagram,ui_navigation}.mmd
 *   · docs/file_tree.md（人读）· docs/file_tree.json（机读，控制器裁决：交付物按 8 个 docs 文件计）
 * 切分/校验/落库/树解析是确定性代码；缺段不抛错——缺什么少什么，警告进 run.summary
 * （fileTree 为空数组同样只记 warning，仍正常返回），由编排器/下游决定降级。
 * 机读树缺失/不可解析时空树会先触发一次「只要树」的补发窄调用（三段式第 2 步，
 * 2026-09-06 增补：真实模型单发 8 段被输出预算截断，末位的树最先死），仍失败才交降级。
 *
 * 上下文（规则 7 零历史共享）：只带「PM 的 summary + docs/prd.md 全文」，两者都缺失时降级提示。
 * 安全（规则 6/07）：分段路径与树节点路径一律过 normalizeProjectPath；契约外路径跳过并告警
 * （交付物清单由代码锁定，不交给模型自由发挥）。
 * 计量（规则 10）：resolveModel 只调一次，同一 model 同时喂 runAgent 与 wrapMetered。
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

/** 任务键（与 mock 领导分派链的 task_key 对齐） */
export const ARCHITECT_TASK_KEY = 'architect-design';

/** 交付物清单（8 个 docs 文件，顺序即输出契约顺序） */
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

/** file_tree 注入 run.summary 时的标记行（编排器断点续跑从这里还原树） */
export const FILE_TREE_SUMMARY_MARKER = 'FILE_TREE_JSON:';

/** file_tree 单节点/数组（结构定义以 context.ts 为单一来源，此处只做 re-export 供下游 import） */
export type { FileTreeNode };
export type FileTree = FileTreeNode[];

/** runArchitect 入参 */
export interface ArchitectContext {
  storage: StorageProvider;
  projectId: number;
  /** 停止信号：透传 runAgent */
  signal?: AbortSignal;
  /** 可注入 provider（测试桩 / 编排器统一入口）；缺省 getLlmProvider()，恒经 wrapMetered 计量包裹 */
  provider?: LlmProvider;
  /** 思考流透传（编排器接 SSE reasoning 事件用，T31）；缺省不透传，行为不变 */
  onReasoning?: (text: string) => void;
}

/** runArchitect 结果：任务 id + 落库文件清单 + 结构化文件树（下游逐文件派发的拓扑序） */
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

/* ------------------------------------------------------------------ */
/* 提示词                                                              */
/* ------------------------------------------------------------------ */

/** 架构师 system prompt：8 段输出契约 + 硬约束 + 黄金样例 few-shot */
export function architectSystemPrompt(): string {
  return [
    '你是架构师，负责基于上游 PRD 产出系统设计与文件树，为下游「逐文件实现」提供唯一事实来源。',
    '',
    '【输出契约——一次输出 8 段，每段第一行必须是 `===== 路径 =====`（路径前后不加任何多余文字）】',
    `1. docs/system_design.md：运行形态、模块职责表、接口契约、数据模型、异常与边界；UI 规格具体到组件级（布局/状态/样式要点）。`,
    '2. docs/architecture.mmd：架构与数据流图（mermaid flowchart）。',
    '3. docs/er_diagram.mmd：数据模型图（mermaid erDiagram）。',
    '4. docs/sequence_diagram.mmd：关键交互时序图（mermaid sequenceDiagram）。',
    '5. docs/class_diagram.mmd：模块协作图（mermaid classDiagram）。',
    '6. docs/ui_navigation.mmd：界面状态机（mermaid stateDiagram-v2）。',
    `7. docs/file_tree.md：人读版文件树（说明 + 用 \`\`\`json 围栏嵌同一份树）。`,
    `8. ${FILE_TREE_PATH}：机读版文件树，形如 [{"path":"app/frontend/index.html","desc":"职责一句话","depends":["app/backend/api.js"]}]，按依赖拓扑序排列；depends 只能指向树内已有路径。`,
    '- 五个 .mmd 段内只放 mermaid 源码（可用 %% 注释），不要 ``` 围栏、不要解释文字。',
    '- 缺段会降低下游质量，但不要发明契约外的路径；某张图确实不适用时输出带 %% 说明的最小占位图。',
    '',
    '【硬约束】',
    '- 后端必须是无框架同构模块 app/backend/api.js：导出 handle(method, path, body)，数据存内存，禁 fs/net/timer。',
    '- 前端为单页 app/frontend/index.html，统一 fetch(\'/api/...\') 调后端；禁 localStorage/cookie（浏览器沙箱无 same-origin）。',
    '- 生成应用零依赖、无构建步骤；图一律 mermaid（不用 PlantUML）。',
    '- 全文中文。',
    '- 后端入口：默认 app/backend/api.js；leader 交接写明「后端语言=typescript|python」时改用 api.ts/api.py（同构 handle 契约不变，语言差异由工程师契约段约束）。',
    '',
    '【黄金样例（只学结构、粒度与分段格式，内容必须来自本次 PRD，禁止照抄样例主题）】',
    readSample('design.md'),
  ].join('\n');
}

/** 架构师 user prompt：上游交接（PM summary）+ PRD 全文 + 任务 */
function architectUserPrompt(prd: string | null, pmSummary: string | null): string {
  const handoff = pmSummary ?? '（无上游摘要：PM 任务缺失或被中断）';
  const prdBlock = prd ?? `（未读到 ${UPSTREAM_PRD_PATH}：上游缺失，请按合理假设补齐边界并在 system_design 中注明。）`;
  return [
    `【上游交接（PM 摘要）】\n${handoff}`,
    '',
    `【上游 PRD（${UPSTREAM_PRD_PATH} 全文）】\n${prdBlock}`,
    '',
    `【任务】产出系统设计与 file_tree：按系统提示的输出契约一次输出 8 段（含 5 张 mermaid 图与机读 ${FILE_TREE_PATH}）。`,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 机读树补发修复（三段式第 2 步）                                        */
/* ------------------------------------------------------------------ */

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

/** 补发 system prompt：窄契约——只出一份树，不带 8 段分段协议（小输出，避开截断） */
function fileTreeRepairSystemPrompt(): string {
  return [
    '你是架构师，执行一次窄任务：上一轮单发产出被截断，机读文件树缺失。',
    '只输出一份 file_tree JSON（裸 JSON 或 ```json 围栏均可），不要输出任何其他文件、图或解释文字。',
    '结构：[{"path":"...","desc":"职责一句话","depends":["..."]}]，按依赖拓扑序排列，depends 只指向树内已有路径。',
    '后端固定 app/backend/api.js（无框架同构模块，导出 handle(method, path, body)，数据存内存）；'
      + "前端固定 app/frontend/index.html（单页，fetch('/api/...')，禁 localStorage）。生成应用零依赖、无构建步骤。",
  ].join('\n');
}

/** 补发 user prompt：已落库设计（若有）+ PRD（若有）作为依据 */
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
 * 运行架构师任务：单发产出 8 段设计 → 逐段校验落库 → 解析 file_tree → 收尾。
 * 缺段/坏段只记 warning 不抛错；provider 抛错/中止才走 failed/stopped 收尾并上抛。
 */
export async function runArchitect(ctx: ArchitectContext): Promise<ArchitectResult> {
  const { storage, projectId } = ctx;
  const runId = await beginRoleRun(storage, {
    projectId,
    taskKey: ARCHITECT_TASK_KEY,
    agent: 'architect',
    task: '产出系统设计 + 5 张 mermaid 图 + file_tree（8 个 docs 文件）',
  });

  const model = resolveModel('architect');
  const provider = wrapMetered({ storage, projectId, agentRole: 'architect', model, provider: ctx.provider });

  try {
    // 上游交接：PRD 全文 + PM summary（零历史共享，规则 7；缺失即降级提示，不阻断）
    const prd = await storage.getFile(projectId, UPSTREAM_PRD_PATH);
    const runs = await storage.listAgentRuns(projectId);
    const pmRun = runs.filter((run) => run.agent === 'pm').at(-1) ?? null;

    const result = await runAgent({
      role: 'architect',
      systemPrompt: architectSystemPrompt(),
      userPrompt: architectUserPrompt(prd?.content ?? null, pmRun?.summary ?? null),
      tools: [], // 零工具单发（DESIGN §3.2）
      model,
      ctx: { storage, projectId, role: 'architect' },
      provider,
      callbacks: ctx.onReasoning === undefined ? undefined : { onReasoning: ctx.onReasoning },
      signal: ctx.signal,
    });

    const warnings: string[] = [];
    const { segments, preamble } = splitSegments(result.content);
    if (preamble !== '') {
      warnings.push(`输出开头有未归属任何交付物的正文（未落库，原文片段：${snippet(preamble)}）`);
    }

    const expected = new Set<string>(ARCHITECT_DOC_PATHS);
    const files: string[] = [];
    let fileTreeRaw: string | null = null;

    for (const segment of segments) {
      const content = segment.content.trim();
      if (content === '') {
        warnings.push(`分段 ${segment.path} 为空，已跳过`);
        continue;
      }
      const checked = normalizeProjectPath(segment.path); // 规则 6/07：模型给的路径必须过沙箱
      if (!checked.ok) {
        warnings.push(`分段路径未过沙箱，已跳过：${segment.path}（${checked.error}）`);
        continue;
      }
      if (!expected.has(checked.path)) {
        warnings.push(`契约外交付物，已跳过：${checked.path}（交付清单由代码锁定）`);
        continue;
      }
      warnings.push(...validationWarnings(checked.path, validateFile(checked.path, content)));
      await storage.upsertFile({ projectId, path: checked.path, content, editor: 'architect' });
      if (!files.includes(checked.path)) files.push(checked.path);
      if (checked.path === FILE_TREE_PATH) fileTreeRaw = content;
    }

    // file_tree 解析：机读段优先；解析失败/无节点都只记 warning（缺什么少什么，不抛错）
    let fileTree: FileTree = [];
    if (fileTreeRaw === null) {
      warnings.push(`缺失机读 ${FILE_TREE_PATH}，file_tree 视为空（将尝试补发修复）`);
    } else {
      const parsed = parseFileTree(fileTreeRaw);
      if (parsed.ok) {
        fileTree = normalizeTreeNodes(parsed.tree, warnings);
      } else {
        warnings.push(`${FILE_TREE_PATH}：${parsed.error}——file_tree 视为空（将尝试补发修复）`);
      }
    }

    /**
     * 三段式第 2 步（2026-09-06 线上案例：真实模型单发 8 段被输出预算/总时长截断，
     * 末位的机读树最先死 → 下游整体降级成与需求无关的快速模板）：
     * 树空时补发一次「只要树」的窄契约小调用，依据 = 本轮已落库 system_design（若有）+ PRD（若有）。
     * 修复成功 → 树落库并入 files；仍失败 → 维持空树 warning（第 3 步降级交给编排器）。
     * provider 错误吞成 warning 不炸 run（补发是增强项），停止语义照常上抛。
     */
    if (fileTree.length === 0) {
      const design = files.includes('docs/system_design.md')
        ? (await storage.getFile(projectId, 'docs/system_design.md'))?.content ?? null
        : null;
      try {
        const repaired = await runAgent({
          role: 'architect',
          systemPrompt: fileTreeRepairSystemPrompt(),
          userPrompt: fileTreeRepairUserPrompt(design, prd?.content ?? null),
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
        if (error instanceof AgentAbortError) throw error; // 停止语义不吞
        warnings.push(`补发修复失败（${error instanceof Error ? error.message : String(error)}），维持降级`);
      }
    }
    if (fileTree.length === 0) warnings.push('file_tree 为空数组：下游无拓扑序可用，需按降级模板生成');

    await finishRoleRun(storage, runId, summarizeArchitecture(files, fileTree, warnings));
    return { runId, files, fileTree };
  } catch (error) {
    await failRoleRun(storage, runId, error);
    throw error;
  }
}
