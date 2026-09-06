/**
 * 领导收尾角色（Task 14，DESIGN §3.3「收尾总结=领导（一次 LLM 调用）」/ §4.2 记忆与偏好）。
 *
 * 职责边界（CLAUDE.md 规则 1）：LLM 只产出「记忆内容 + 汇报文本」这两段决策；
 * 确定性代码负责——人工修改清单计算（readAllFiles 过滤 lastEditor==='human'）、
 * MEMORY.md 组装（人工修改清单恒在，不依赖模型记得）、PROGRESS.md 追加、落库与任务记录推进。
 *
 * 产出物：
 * - `.atoms/reports/MEMORY.md`（路径与 src/lib/agents/context.ts 注入的长期记忆路径一致，
 *   下次迭代由上下文组装器自动注入）
 * - `.atoms/reports/PROGRESS.md` 维护「## 领导汇报」段（文件缺失则创建带标题；每个任务边界的进度行由
 *   编排器的 progress 模块负责；重复收尾时该段整体覆盖——最新汇报生效，不无限增长）
 * - 返回汇报文本：调用方（编排器）负责作为 assistant message 落库并发 SSE message 事件
 *   （本函数不写 messages，避免与编排器双写）
 *
 * 服务端专用（读 env + 落库），不得进入客户端 bundle。
 */
import { assembleContext } from '@/lib/agents/context';
import { runAgent } from '@/lib/agents/runner';
import { AgentAbortError } from '@/lib/agents/types';
import { MAX_CONTENT_BYTES, type ToolContext } from '@/lib/agents/tools';
import { stripOuterFence } from '@/lib/agents/roles/experts';
import { resolveModel } from '@/lib/llm/client';
import { wrapMetered } from '@/lib/llm/metered-provider';
import type { LlmProvider } from '@/lib/llm/types';
import type { AgentRole, FileRow, StorageProvider } from '@/lib/db/provider/types';

/** 长期记忆路径（必须与 context.ts 注入路径一致：MEMORY.md） */
export const MEMORY_PATH = '.atoms/reports/MEMORY.md';

/**
 * 项目进度文件路径（DESIGN §1 产出结构：.atoms/reports/ 下的 PROGRESS.md）。
 * 编排器在各任务边界维护进度行；收尾只维护「领导汇报」段（最新一次覆盖，见 appendClosingSection）。
 */
export const PROGRESS_PATH = '.atoms/reports/PROGRESS.md';

/** 收尾段标题（时间线/测试都认这段） */
export const CLOSING_SECTION_HEADING = '## 领导汇报';

/**
 * 收尾 system prompt。「团队领导/收尾/MEMORY/汇报」是 mock provider 的收尾场景识别标记，
 * 措辞改动需同步 src/lib/llm/mock.ts 的 ROLE_MARKERS；刻意不出现其他角色名（避免场景误判）。
 */
export const CLOSER_SYSTEM_PROMPT = [
  '你是「团队领导」。所有成员的任务已执行完毕，现在由你做项目收尾：沉淀长期记忆（MEMORY.md）并向用户做领导汇报。',
  '',
  '输出契约（严格遵守，两部分都要有，用分隔行隔开，顺序如下）：',
  '===== .atoms/reports/MEMORY.md =====',
  '（MEMORY.md 的完整 Markdown 内容，包含三节：## 选型与关键决策、## 项目约束、## 偏好捕捉）',
  '===== 汇报 =====',
  '（面向用户的领导汇报正文：完成内容、产出概览、下一步建议；中文 Markdown 列表，可直接作为聊天回复）',
  '',
  '要求：',
  '1. MEMORY 只沉淀对后续迭代有复用价值的信息（选型理由、约束、踩坑、用户偏好），不写流水账。',
  '2. 汇报先结论后细节，不复述完整文件清单（文件树里已有）。',
  '3. 除这两部分外不要输出任何内容。',
  '',
].join('\n');

/** PROGRESS.md 缺失时创建的文件头（导出供编排器 progress 模块复用，避免两处模板漂移） */
export const PROGRESS_HEADER = [
  '# 项目进度（PROGRESS）',
  '',
  '> 每个任务边界由编排器追加状态行（✅/🔄/⏸/❌）；项目收尾时由团队领导追加领导汇报段。',
].join('\n');

/** runCloser 入参（brief 契约：存储出口 + 项目 + 停止信号） */
export interface RunCloserInput {
  storage: StorageProvider;
  projectId: number;
  /** 停止信号：级联到 runAgent → provider 调用 */
  signal?: AbortSignal;
  /** 注入 provider（测试桩 / 编排器统一装配）；缺省走 getLlmProvider()（读 env，默认 mock） */
  provider?: LlmProvider;
  /** 思考流透传（编排器接 SSE reasoning 事件用，T31）；缺省不透传，行为不变 */
  onReasoning?: (text: string) => void;
  /** 收尾边界取到的待注入干预（T31）：编排器在 leader-closing 边界消费后传入，进【干预指令】小节 */
  interventions?: readonly string[];
}

/** runCloser 结果：任务记录 id + 记忆文件路径 + 汇报文本（由调用方作为 assistant message 落库） */
export interface RunCloserResult {
  runId: number;
  memoryFile: string;
  report: string;
}

/** 收尾输出切分结果：memory 为 null 表示模型没有给出可用的记忆正文（走确定性兜底） */
export interface CloserSplit {
  memory: string | null;
  report: string;
}

/** 分隔行：`===== label =====`（与架构师多段产出同一约定） */
const SEGMENT_LINE = /^=====\s*(.+?)\s*=====\s*$/;

/** MEMORY 标题行：`## MEMORY` / `# MEMORY（项目长期记忆）` 等 */
const MEMORY_HEADING = /^#{1,6}\s*MEMORY\b/i;

/**
 * 把收尾模型输出切成「记忆正文 + 汇报文本」。识别顺序：
 * ① `===== label =====` 分隔行（label 含 MEMORY / 汇报）；
 * ② `## MEMORY` 标题行（mock 样例格式：汇报在前、MEMORY 段在后）；
 * ③ 都没有 → 整体作为汇报文本，记忆正文为 null。
 */
export function splitCloserOutput(content: string): CloserSplit {
  const text = stripOuterFence(content);

  const segments: { label: string; body: string[] }[] = [];
  const preamble: string[] = [];
  let current: { label: string; body: string[] } | null = null;
  for (const line of text.split('\n')) {
    const label = SEGMENT_LINE.exec(line.trim())?.[1];
    if (label !== undefined) {
      current = { label, body: [] };
      segments.push(current);
      continue;
    }
    if (current === null) preamble.push(line);
    else current.body.push(line);
  }

  if (segments.length > 0) {
    const memorySegment = segments.find((segment) => /memory/i.test(segment.label));
    const reportSegment = segments.find((segment) => segment.label.includes('汇报'));
    if (memorySegment !== undefined || reportSegment !== undefined) {
      const memory = memorySegment === undefined ? null : joinTrimmed(memorySegment.body);
      // 汇报段缺失时用「前言 + 其余段落」兜底；仍为空则交由调用方走确定性降级汇报
      const report =
        reportSegment !== undefined
          ? (joinTrimmed(reportSegment.body) ?? '')
          : (joinTrimmed([
              ...preamble,
              ...segments
                .filter((segment) => segment !== memorySegment && segment !== reportSegment)
                .flatMap((segment) => segment.body),
            ]) ?? '');
      return { memory, report };
    }
  }

  const lines = text.split('\n');
  const headingIndex = lines.findIndex((line) => MEMORY_HEADING.test(line.trim()));
  if (headingIndex >= 0) {
    return {
      report: joinTrimmed(lines.slice(0, headingIndex)) ?? '',
      memory: joinTrimmed(lines.slice(headingIndex + 1)),
    };
  }
  return { memory: null, report: text.trim() };
}

/** 行数组 → 去首尾空行的文本；全空返回 null（空段不产生占位内容） */
function joinTrimmed(lines: string[]): string | null {
  const text = lines.join('\n').trim();
  return text === '' ? null : text;
}

/** 标题行（1-6 级） */
const HEADING_LINE = /^#{1,6}\s/;
/** 模型可能自行写出的清单段标题（前缀匹配，容许带括注） */
const HUMAN_LIST_HEADING = /^#{1,6}\s*人工修改清单/;

/**
 * 剥掉模型正文里自写的「人工修改清单」段（标题行到下一个标题行或文末）。
 * 该清单是防语义冲突的权威数据，只认代码从 files 表算出来的那份（CLAUDE.md 规则 11）；
 * 模型自己列的条目可能幻觉，一律不采信。
 */
export function stripHumanListSection(body: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    const isHeading = HEADING_LINE.test(trimmed);
    if (skipping) {
      // 剥除中遇到下一个标题段 → 恢复正常收集（该标题行本身要保留）
      if (isHeading) skipping = false;
      else continue;
    }
    if (isHeading && HUMAN_LIST_HEADING.test(trimmed)) {
      skipping = true;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * 确定性组装 MEMORY.md：模型正文（选型/约束/偏好）在前，
 * **人工修改清单恒由代码计算并追加**（模型写的一律剥除），无人工修改时明确写「无」。
 */
export function composeMemoryDoc(memoryBody: string | null, humanEditedPaths: readonly string[]): string {
  const lines: string[] = [
    '# MEMORY（项目长期记忆）',
    '',
    '> 由团队领导在收尾阶段写入；下次迭代作为长期记忆注入上下文（DESIGN §4.2）。',
    '',
  ];
  const modelBody = (memoryBody === null ? '' : stripHumanListSection(memoryBody)).trim();
  if (modelBody !== '') lines.push(modelBody, '');

  lines.push(
    '## 人工修改清单',
    '',
    humanEditedPaths.length > 0
      ? humanEditedPaths.map((path) => `- ${path}`).join('\n')
      : '- 无（本项目暂无人工修改）',
    '',
  );
  return lines.join('\n');
}

/** 模型汇报为空时的确定性降级汇报（三段式第 3 步：不静默吞，也不让收尾失败） */
function fallbackReport(fileCount: number, humanEditedPaths: readonly string[]): string {
  return [
    `- 完成内容：本轮共产出 ${fileCount} 个文件，全量清单见文件树。`,
    `- 人工修改：${humanEditedPaths.length > 0 ? humanEditedPaths.join('、') : '无'}`,
    '- 下一步建议：在预览中验收应用；如需调整，直接描述改动，或 @ 指定成员继续迭代。',
  ].join('\n');
}

/**
 * 维护 PROGRESS.md 的「领导汇报」段（幂等）：已有该段则从段首覆盖到文末——
 * 最新一次汇报生效（编排器每轮完成都会收尾，追加语义会导致标题重复与无限增长）；
 * 没有该段则追加在进度行之后；文件缺失则创建带标题。
 */
export async function appendClosingSection(
  storage: StorageProvider,
  projectId: number,
  report: string,
): Promise<void> {
  const section = `${CLOSING_SECTION_HEADING}\n\n${report}\n`;
  const existing = await storage.getFile(projectId, PROGRESS_PATH);

  if (existing === null) {
    await storage.upsertFile({ projectId, path: PROGRESS_PATH, content: `${PROGRESS_HEADER}\n\n${section}`, editor: 'leader' });
    return;
  }

  const lines = existing.content.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === CLOSING_SECTION_HEADING);
  const prefix = (headingIndex >= 0 ? lines.slice(0, headingIndex) : lines).join('\n').trimEnd();
  const content = prefix === '' ? section : `${prefix}\n\n${section}`;
  await storage.upsertFile({ projectId, path: PROGRESS_PATH, content, editor: 'leader' });
}

/** 内容字节数二次约束（rules/07）：超限直接判失败，不静默截断 */
function assertContentSize(path: string, content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_CONTENT_BYTES) {
    throw new Error(`产出 ${path} 内容 ${bytes} 字节，超过上限 ${MAX_CONTENT_BYTES} 字节（512KB）`);
  }
}

/**
 * 运行领导收尾：写 MEMORY.md + 追加 PROGRESS 领导汇报段，返回汇报文本。
 * 任务记录在本函数内创建并推进（done/failed/stopped + summary）。
 */
export async function runCloser(ctx: RunCloserInput): Promise<RunCloserResult> {
  const { storage, projectId, signal, provider } = ctx;
  const role: AgentRole = 'leader';

  const run = await storage.createAgentRun({
    projectId,
    taskKey: 'leader-closing',
    agent: role,
    task: '收尾：沉淀 MEMORY 并向用户汇报',
  });
  await storage.updateAgentRun(run.id, { status: 'running', startedAt: Date.now() }, projectId);

  try {
    const rows = await storage.readAllFiles(projectId);
    // 人工修改清单（CLAUDE.md 规则 11）：确定性计算，不交给模型统计
    const humanEditedPaths = rows
      .filter((row: FileRow) => row.lastEditor === 'human')
      .map((row) => row.path)
      .sort();

    const fileList = rows.map((row) => `- ${row.path}（last_editor=${row.lastEditor}）`).join('\n');
    const humanList = humanEditedPaths.map((path) => `- ${path}`).join('\n');
    const task = [
      '收尾：请基于以下项目全貌产出 MEMORY 与领导汇报。',
      '【项目文件清单】',
      fileList === '' ? '-（暂无文件）' : fileList,
      '【人工修改清单（必须原样保留其意图）】',
      humanList === '' ? '- 无' : humanList,
    ].join('\n');

    const model = resolveModel(role);
    // 计量装饰器与内核共用同一 model；注入的 provider 只替换底层模型出口（测试桩/编排器装配）
    const meteredProvider = wrapMetered({ storage, projectId, agentRole: role, model, provider });
    const assembled = await assembleContext({
      storage,
      projectId,
      role,
      systemPrompt: CLOSER_SYSTEM_PROMPT,
      task,
      upstreamSummaries: [],
      interventions: ctx.interventions === undefined ? [] : [...ctx.interventions],
    });
    const result = await runAgent({
      role,
      systemPrompt: assembled.system,
      userPrompt: assembled.user,
      tools: [],
      model,
      ctx: { storage, projectId, role } satisfies ToolContext,
      provider: meteredProvider,
      callbacks: ctx.onReasoning === undefined ? undefined : { onReasoning: ctx.onReasoning },
      signal,
    });

    const split = splitCloserOutput(result.content);
    const report = split.report !== '' ? split.report : fallbackReport(rows.length, humanEditedPaths);
    const memoryDoc = composeMemoryDoc(split.memory, humanEditedPaths);
    assertContentSize(MEMORY_PATH, memoryDoc);

    await storage.upsertFile({ projectId, path: MEMORY_PATH, content: memoryDoc, editor: role });
    await appendClosingSection(storage, projectId, report);

    const summary = `收尾完成：${MEMORY_PATH} 已写入（人工修改 ${humanEditedPaths.length} 项），${PROGRESS_PATH} 已追加「${CLOSING_SECTION_HEADING}」段`;
    await storage.updateAgentRun(run.id, { status: 'done', summary, endedAt: Date.now() }, projectId);
    return { runId: run.id, memoryFile: MEMORY_PATH, report };
  } catch (error) {
    // 中止=停止语义（非失败）；其余落 agent_runs.error 供时间线/SSE 展示
    const aborted = error instanceof AgentAbortError || (error instanceof Error && error.name === 'AbortError');
    await storage.updateAgentRun(
      run.id,
      {
        status: aborted ? 'stopped' : 'failed',
        error: error instanceof Error ? error.message : String(error),
        endedAt: Date.now(),
      },
      projectId,
    );
    throw error;
  }
}
