/**
 * 角色层共享簿记（Task 12）：agent_runs 生命周期 + 产物校验告警格式化。
 * 只被角色模块（pm / architect / engineer…）复用；调度与决策不在此
 * （CLAUDE.md 规则 1：LLM 只做决策，确定性代码做执行）。
 *
 * 状态语义（DESIGN §3.5/§3.6）：
 * - 开跑 = status running + started_at
 * - 正常结束 = status done + summary（规则 7：summary 是子任务间唯一交接物）
 * - 中止（AbortError）= status stopped、error 置空——停止语义，非失败语义
 * - 其余异常 = status failed + error 落库（不静默吞），由编排器决定三段式回退
 *
 * 服务端专用，不得进入客户端 bundle。
 */
import type { CreateAgentRunInput, StorageProvider, UpdateAgentRunPatch } from '@/lib/db/provider/types';
import type { FileValidation } from '@/lib/validation';

/** 是否为中止类错误（AgentAbortError 与 DOM/Node 的 AbortError 命名兼容） */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** 建任务并标记开跑（createAgentRun 默认 pending → running，started_at 由角色开跑时补） */
export async function beginRoleRun(storage: StorageProvider, input: CreateAgentRunInput): Promise<number> {
  const run = await storage.createAgentRun(input);
  await storage.updateAgentRun(run.id, { status: 'running', startedAt: Date.now() });
  return run.id;
}

/** 正常收尾：done + 交接摘要 + ended_at */
export async function finishRoleRun(storage: StorageProvider, runId: number, summary: string): Promise<void> {
  await storage.updateAgentRun(runId, { status: 'done', summary, endedAt: Date.now() });
}

/** 异常收尾：中止 → stopped；其余 → failed + error（超长截断，防异常正文撑爆行） */
export async function failRoleRun(storage: StorageProvider, runId: number, error: unknown): Promise<void> {
  const patch: UpdateAgentRunPatch = isAbortError(error)
    ? { status: 'stopped', error: null, endedAt: Date.now() }
    : { status: 'failed', error: (error instanceof Error ? error.message : String(error)).slice(0, 2000), endedAt: Date.now() };
  await storage.updateAgentRun(runId, patch);
}

/**
 * 产物校验告警（不阻断）：docs 产物是 md/mmd/json，危险扫描对其恒为空、语法校验只对 json 生效；
 * 硬性违规/语法错误同样只记录——「带错误重试 + 硬拒绝」的下限兜底是代码产物（工程师角色）的职责。
 */
export function validationWarnings(path: string, validation: FileValidation): string[] {
  const warnings: string[] = [];
  for (const danger of validation.hard) warnings.push(`${path}：硬性违规 ${danger.rule}——${danger.detail}`);
  for (const danger of validation.soft) warnings.push(`${path}：警告 ${danger.rule}——${danger.detail}`);
  if (validation.syntaxError !== undefined) warnings.push(`${path}：${validation.syntaxError}`);
  return warnings;
}

/** 告警段落拼接（进 run.summary 与时间线，可见即不静默） */
export function renderWarnings(warnings: string[]): string {
  if (warnings.length === 0) return '';
  return `警告（不阻断，共 ${warnings.length} 条）：\n${warnings.map((item) => `- ${item}`).join('\n')}`;
}
