/**
 * 专家角色：数据分析师 / SEO 专家 / 广告投放专家（Task 14，DESIGN §3.2「结构化单发」）。
 *
 * 自主权分配与 PM/架构师同款：决策空间小、产出形态固定 → 不用工具循环，
 * `runAgent` 零工具单发一次；角色代码负责切分落库（upsertFile）与落库前校验（validateFile）。
 * 产出路径固定 docs/{analyst|seo|ads}_report.md，供后续迭代作为依赖文件注入。
 *
 * 可靠性（CLAUDE.md 规则 5 三段式）：产物为空 / hard 违规 / 语法错误 → 带错误重试一次 →
 * 仍失败则不落半成品文件，任务标 failed（错误落 agent_runs.error）并上抛，编排器据此发 SSE error。
 * 报告本身是 Markdown（不做语法判定、不做危险扫描），此防线是通用兜底而非主路径。
 *
 * 服务端专用（读 env + 落库），不得进入客户端 bundle。
 */
import { assembleContext } from '@/lib/agents/context';
import { runAgent } from '@/lib/agents/runner';
import { AgentAbortError } from '@/lib/agents/types';
import type { ToolContext } from '@/lib/agents/tools';
import { resolveModel } from '@/lib/llm/client';
import { wrapMetered } from '@/lib/llm/metered-provider';
import { validateFile } from '@/lib/validation';
import type { AgentRole, StorageProvider } from '@/lib/db/provider/types';

/** 专家角色子集（领导可分派的三个可选专家） */
export type ExpertRole = Extract<AgentRole, 'analyst' | 'seo' | 'ads'>;

/** 各专家的固定产出路径（DESIGN §1：docs/ 对应报告） */
export const EXPERT_REPORT_PATHS: Record<ExpertRole, string> = {
  analyst: 'docs/analyst_report.md',
  seo: 'docs/seo_report.md',
  ads: 'docs/ads_report.md',
};

/**
 * 专家 system prompt。角色名（数据分析师 / SEO 专家 / 广告投放专家）是 mock provider
 * 的场景识别标记，措辞改动需同步 src/lib/llm/mock.ts 的 ROLE_MARKERS。
 * 刻意不使用「收尾/总结/汇报/MEMORY」等收尾语——那是领导收尾场景的标记。
 */
export const EXPERT_SYSTEM_PROMPTS: Record<ExpertRole, string> = {
  analyst: [
    '你是团队中的「数据分析师」（analyst）。',
    '',
    '职责：为产品定义可量化的数据方案，让后续迭代有据可依。',
    '',
    '输出契约（严格遵守）：',
    '1. 只输出一篇完整的数据分析报告（Markdown），不要寒暄，不要解释格式。',
    '2. 报告必须包含：核心指标定义（北极星指标 + 护栏指标）、埋点方案（事件名/属性/触发时机）、分析思路与洞察假设、下一步行动建议。',
    '3. 数据分析师不编造具体数值：没有真实数据时一律标注「假设/待验证」。',
    '4. 语言精炼，结论可直接执行。',
    '',
  ].join('\n'),
  seo: [
    '你是团队中的「SEO 专家」（seo）。',
    '',
    '职责：让生成的应用在搜索与分享场景中更容易被发现。',
    '',
    '输出契约（严格遵守）：',
    '1. 只输出一篇完整的 SEO 优化报告（Markdown），不要寒暄，不要解释格式。',
    '2. 报告必须包含：目标关键词与长尾词、页面标题与描述建议、站内结构化优化（语义化标签/标题层级/图片 alt）、性能与移动端要点、下一步行动建议。',
    '3. SEO 专家只给可落地的建议，不承诺排名结果。',
    '',
  ].join('\n'),
  ads: [
    '你是团队中的「广告投放专家」（ads）。',
    '',
    '职责：为产品设计投放策略，把预算花在能带来有效转化的渠道上。',
    '',
    '输出契约（严格遵守）：',
    '1. 只输出一篇完整的广告投放报告（Markdown），不要寒暄，不要解释格式。',
    '2. 报告必须包含：投放目标与受众、渠道与定向/关键词建议、落地页承接要点、转化目标与衡量口径、预算分配与下一步行动建议。',
    '3. 广告投放专家不承诺投放效果数值，只给策略与衡量方式。',
    '',
  ].join('\n'),
};

/** 单文件内容上限 512KB（.claude/rules/07「数据库写入前二次约束」，与 fs 工具同一口径） */
const MAX_CONTENT_BYTES = 512 * 1024;

/** runExpert 入参（brief 契约：存储出口 + 项目 + 角色 + 任务指令） */
export interface RunExpertInput {
  storage: StorageProvider;
  projectId: number;
  role: ExpertRole;
  instruction: string;
  /** 停止信号：级联到 runAgent → provider 调用 */
  signal?: AbortSignal;
}

/** runExpert 结果：任务记录 id + 产出文件路径 */
export interface RunExpertResult {
  runId: number;
  file: string;
}

/**
 * 剥掉整体包裹的 Markdown 代码围栏：模型按契约可能把整份报告包进一个 ``` 围栏
 * （与 PM/架构师「单个代码块内的完整文件内容」约定对齐）；整体未包裹时原样返回。
 * 只处理「首行围栏 + 末行围栏」的整体包裹，不碰正文内部的围栏。
 */
export function stripOuterFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}

/** 落库前裁决结果：ok=false 时 detail 为可直接回喂/落库的中文原因 */
export interface OutputVerdict {
  ok: boolean;
  detail: string;
  /** 软警告文案（不拦截落库，附进任务摘要） */
  soft: string[];
}

/**
 * 产物落库前裁决（纯函数）：空产出 / 语法错误 / 危险用法（hard）都判失败。
 * 报告是 Markdown（不做语法判定、不做危险扫描），这里主要拦「模型输出为空」与通用兜底。
 */
export function assessOutput(path: string, content: string): OutputVerdict {
  if (content.trim() === '') return { ok: false, detail: '模型未产出任何内容（空报告）', soft: [] };
  const verdict = validateFile(path, content);
  const soft = verdict.soft.map((danger) => `${danger.rule}（${danger.detail}）`);
  if (verdict.ok) return { ok: true, detail: '', soft };
  const parts: string[] = [];
  if (verdict.syntaxError !== undefined) parts.push(`语法错误：${verdict.syntaxError}`);
  for (const danger of verdict.hard) parts.push(`禁止用法 ${danger.rule}（${danger.detail}）`);
  return { ok: false, detail: parts.length > 0 ? parts.join('；') : '未通过落库前校验', soft };
}

/** 裁决失败的中文反馈（回喂给模型重试一次） */
function validationFeedback(path: string, verdict: OutputVerdict): string {
  return `上一次产出 ${path} 未通过落库前校验（${verdict.detail}）。请修正后只输出完整的 Markdown 文件内容，不要附加说明。`;
}

/** 软警告 → 摘要附注（不拦截落库） */
function softNote(verdict: OutputVerdict): string {
  return verdict.soft.length > 0 ? `；软警告：${verdict.soft.join('、')}` : '';
}

/** 内容字节数二次约束（rules/07）：超限直接判失败，不静默截断报告 */
function assertContentSize(path: string, content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_CONTENT_BYTES) {
    throw new Error(`产出 ${path} 内容 ${bytes} 字节，超过上限 ${MAX_CONTENT_BYTES} 字节（512KB）`);
  }
}

/**
 * 运行一个专家任务：单发产出专项报告并落库。
 * 任务记录在本函数内创建并推进（done/failed/stopped + summary），summary 是下游交接物。
 */
export async function runExpert(ctx: RunExpertInput): Promise<RunExpertResult> {
  const { storage, projectId, role, instruction, signal } = ctx;
  const path = EXPERT_REPORT_PATHS[role];

  const run = await storage.createAgentRun({
    projectId,
    taskKey: `${role}-report`,
    agent: role,
    task: instruction,
  });
  await storage.updateAgentRun(run.id, { status: 'running', startedAt: Date.now() }, projectId);

  /** 单发一次：上下文组装 → 零工具 runAgent → 剥围栏 */
  const singleShot = async (extraFeedback?: string): Promise<string> => {
    const model = resolveModel(role);
    // 计量装饰器与内核共用同一 model：实际请求的 model 与 llm_calls 记账的 model 永远一致（CLAUDE.md 规则 10）
    const provider = wrapMetered({ storage, projectId, agentRole: role, model });
    const assembled = await assembleContext({
      storage,
      projectId,
      role,
      systemPrompt: EXPERT_SYSTEM_PROMPTS[role],
      task: extraFeedback === undefined ? instruction : `${instruction}\n\n${extraFeedback}`,
      upstreamSummaries: [],
      interventions: [],
      extraFiles: [path],
    });
    const result = await runAgent({
      role,
      systemPrompt: assembled.system,
      userPrompt: assembled.user,
      tools: [],
      model,
      ctx: { storage, projectId, role } satisfies ToolContext,
      provider,
      signal,
    });
    return stripOuterFence(result.content);
  };

  try {
    let content = await singleShot();
    let verdict = assessOutput(path, content);
    if (!verdict.ok) {
      // 三段式第 2 步：带错误重试一次
      content = await singleShot(validationFeedback(path, verdict));
      verdict = assessOutput(path, content);
      if (!verdict.ok) {
        throw new Error(`专家报告重试一次后仍未通过落库前校验：${verdict.detail}`);
      }
    }
    assertContentSize(path, content);

    const { version } = await storage.upsertFile({ projectId, path, content, editor: role });
    const summary = `已产出 ${path}（v${version}，${content.length} 字符）${softNote(verdict)}`;
    await storage.updateAgentRun(run.id, { status: 'done', summary, endedAt: Date.now() }, projectId);
    return { runId: run.id, file: path };
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
