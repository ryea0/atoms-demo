/**
 * 产品经理角色（Task 12，DESIGN §3.2「结构化单发」/ §5⑤「生成质量工程」）。
 *
 * 执行形态：零工具单发——runAgent 不带任何工具，模型一次输出完整 PRD Markdown；
 * 切分/落库/簿记是确定性代码（validateFile → upsertFile → agent_runs），
 * 内容生成分属模型（CLAUDE.md 规则 1）。无工具循环 = 无校验重试，可靠性靠
 * 「输出契约 + 黄金样例 few-shot + 空输出即失败」三件套。
 *
 * 上下文（规则 7 零历史共享）：user prompt 只带「需求原文 + 任务」，黄金样例作 few-shot 进 system。
 * 计量（规则 10）：resolveModel 只调一次，同一 model 同时喂 runAgent 与 wrapMetered，永不失配。
 * 失败语义：模型空输出 / provider 抛错 → agent_runs 标 failed 后原样上抛（编排器决定三段式回退）；
 * 中止 → 标 stopped（停止语义）。PRD 为空会让下游架构师无从下手，故空输出按失败处理而非降级。
 *
 * 服务端专用（读样例文件 + env），不得进入客户端 bundle。
 */
import { runAgent } from '@/lib/agents/runner';
import { beginRoleRun, failRoleRun, finishRoleRun, renderWarnings, validationWarnings } from '@/lib/agents/roles/run-support';
import { readSample } from '@/lib/llm/mock';
import { resolveModel } from '@/lib/llm/client';
import { wrapMetered } from '@/lib/llm/metered-provider';
import { validateFile } from '@/lib/validation';
import type { StorageProvider } from '@/lib/db/provider/types';
import type { LlmProvider } from '@/lib/llm/types';

/** PRD 交付路径（架构师按此路径重读上游产物，规则 7） */
export const PRD_PATH = 'docs/prd.md';

/** 任务键（与 mock 领导分派链的 task_key 对齐，时间线/编排器共用） */
export const PM_TASK_KEY = 'pm-prd';

/** runPm 入参 */
export interface PmContext {
  storage: StorageProvider;
  projectId: number;
  /** 用户一句话需求 */
  requirement: string;
  /** 快速模式（DESIGN §3.8 D3）：半页精简 PRD */
  fast: boolean;
  /** 停止信号：透传 runAgent，每轮 provider 调用前检查 */
  signal?: AbortSignal;
  /** 可注入 provider（测试桩 / 编排器统一入口）；缺省 getLlmProvider()，恒经 wrapMetered 计量包裹 */
  provider?: LlmProvider;
}

/** runPm 结果：任务 id + 实际落库的文件清单 */
export interface PmResult {
  runId: number;
  files: string[];
}

/** 黄金样例 few-shot（mock 数据源同一份，样例漂移由 tests/llm 兜底） */
function fewShotPrd(): string {
  return readSample('prd.md');
}

/** PM system prompt：输出契约 + 黄金样例 few-shot；fast 切换精简/完整两档 */
export function pmSystemPrompt(fast: boolean): string {
  const mode = fast
    ? '精简版（快速模式）：控制在半页以内，只保留「功能清单（表格）」「验收标准」「边界与不做」三节，其余章节以一行带过。'
    : '完整版：以下章节全部写全——背景与目标、目标用户与场景、范围、功能清单（表格）、用户故事、交互与界面要点、验收标准、非功能需求、数据与运行边界。';
  return [
    '你是产品经理（PM），负责把一句话需求整理成可直接进入开发的产品需求文档（PRD）。',
    '',
    '【输出契约】',
    `- 只输出 PRD 的 Markdown 正文本身（将原文落库为 ${PRD_PATH}）：不要解释、不要代码围栏包裹、不要寒暄。`,
    '- 功能点用 F1/F2…、用户故事用 US1…、验收标准用 AC1… 编号，供下游逐条引用与验收。',
    '- 功能清单用表格并列出优先级（P0/P1/P2）；每条验收标准必须可操作地验证，不写「体验良好」这类不可测表述。',
    '- 运行环境红线：生成应用跑在浏览器沙箱（禁 localStorage/cookie、不允许安装第三方依赖），数据为内存态、刷新即重置——PRD 不得承诺持久化、账号体系或多端同步。',
    '- 全文中文。',
    '',
    '【本次模式】',
    mode,
    '',
    '【黄金样例（只学结构与粒度，内容必须来自本次需求，禁止照抄样例主题）】',
    fewShotPrd(),
  ].join('\n');
}

/** PM user prompt：需求原文 + 任务（零历史共享，规则 7） */
function pmUserPrompt(requirement: string): string {
  return [`【需求】${requirement.trim()}`, '', `【任务】按系统提示的输出契约产出 PRD（落库为 ${PRD_PATH}）。`].join('\n');
}

/** 从 PRD 正文拼降级摘要（交接物，规则 7）：取标题 + 功能/验收条数 */
function summarizePrd(content: string, fast: boolean, warnings: string[]): string {
  const heading = content.split('\n').find((line) => line.startsWith('#'))?.replace(/^#+\s*/, '') ?? 'PRD';
  const featureCount = (content.match(/\bF\d+\b/g) ?? []).length;
  const acCount = (content.match(/\bAC\d+\b/g) ?? []).length;
  const parts = [
    `已完成${fast ? '快速模式精简' : ''} PRD：${heading}；功能点 ${featureCount} 条、验收标准 ${acCount} 条；落库 ${PRD_PATH}。`,
  ];
  const warningBlock = renderWarnings(warnings);
  if (warningBlock !== '') parts.push(warningBlock);
  return parts.join('\n');
}

/**
 * 运行 PM 任务：单发产出 PRD → 校验 → 落库 → 收尾。
 * 失败（含空输出）时 agent_runs 标 failed 后原样上抛；中止标 stopped。
 */
export async function runPm(ctx: PmContext): Promise<PmResult> {
  const { storage, projectId, requirement, fast } = ctx;
  const runId = await beginRoleRun(storage, {
    projectId,
    taskKey: PM_TASK_KEY,
    agent: 'pm',
    task: `产出产品需求文档 ${PRD_PATH}${fast ? '（快速模式精简版）' : ''}`,
  });

  const model = resolveModel('pm');
  const provider = wrapMetered({ storage, projectId, agentRole: 'pm', model, provider: ctx.provider });

  try {
    const result = await runAgent({
      role: 'pm',
      systemPrompt: pmSystemPrompt(fast),
      userPrompt: pmUserPrompt(requirement),
      tools: [], // 零工具单发（DESIGN §3.2）：决策空间小，最可靠
      model,
      ctx: { storage, projectId, role: 'pm' },
      provider,
      signal: ctx.signal,
    });

    const content = result.content.trim();
    if (content === '') throw new Error(`PM 模型空输出，无法落库 ${PRD_PATH}（由编排器决定回退）`);

    const warnings = validationWarnings(PRD_PATH, validateFile(PRD_PATH, content));
    await storage.upsertFile({ projectId, path: PRD_PATH, content, editor: 'pm' });
    if (warnings.length > 0) {
      // 不静默：软告警打印留痕（落库不阻断，详情见 agent_runs.summary）
      console.warn(`[pm] ${PRD_PATH} 校验告警：${warnings.join('；')}`);
    }
    await finishRoleRun(storage, runId, summarizePrd(content, fast, warnings));
    return { runId, files: [PRD_PATH] };
  } catch (error) {
    await failRoleRun(storage, runId, error);
    throw error;
  }
}
