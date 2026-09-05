/**
 * PROGRESS.md 进度行维护（Task 15，DESIGN §3.3「标记进度=编排器」）。
 *
 * 每个任务边界（含工程师单文件任务）模板化追加一行状态（✅/🔄/⏸/❌）；
 * 收尾段（CLOSING_SECTION_HEADING 起）由 closer 整段覆盖到文末——因此进度行
 * 必须插在收尾段标题**之前**（插入位置错误会让重跑收尾时吞掉历史进度行）。
 *
 * 服务端专用（写 files 表），不得进入客户端 bundle。
 */
import { CLOSING_SECTION_HEADING, PROGRESS_HEADER, PROGRESS_PATH } from '@/lib/agents/roles/closer';
import { roleRegistry } from '@/lib/agents/registry';
import type { AgentRole } from '@/lib/db/provider/types';
import type { StorageProvider } from '@/lib/db/provider/types';

/** 单行摘要截断（进度行可读即可，全文在 agent_runs.summary / 事件里） */
const SNIPPET_MAX = 120;

/** 摘要片段：压成单行并截断 */
function snippet(text: string, max = SNIPPET_MAX): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max)}…`;
}

/**
 * 在收尾段之前插入一行进度（文件缺失则带头部创建）。
 * 串行编排下无并发写；editor=leader（进度文件归领导名下，与 closer 一致）。
 */
export async function appendProgressLine(storage: StorageProvider, projectId: number, line: string): Promise<void> {
  const existing = await storage.getFile(projectId, PROGRESS_PATH);
  if (existing === null) {
    const content = `${PROGRESS_HEADER}\n\n${line}\n`;
    await storage.upsertFile({ projectId, path: PROGRESS_PATH, content, editor: 'leader' });
    return;
  }

  const lines = existing.content.split('\n');
  const headingIndex = lines.findIndex((item) => item.trim() === CLOSING_SECTION_HEADING);
  if (headingIndex < 0) {
    // 尚无收尾段：直接追加在文末
    const content = `${existing.content.trimEnd()}\n${line}\n`;
    await storage.upsertFile({ projectId, path: PROGRESS_PATH, content, editor: 'leader' });
    return;
  }

  // 有收尾段：插到段标题之前，保持标题前空行分隔
  const prefix = lines.slice(0, headingIndex).join('\n').trimEnd();
  const suffix = lines.slice(headingIndex).join('\n');
  const content = prefix === '' ? `${line}\n\n${suffix}\n` : `${prefix}\n${line}\n\n${suffix}`;
  await storage.upsertFile({ projectId, path: PROGRESS_PATH, content, editor: 'leader' });
}

/** 任务开始（🔄） */
export function taskStartLine(agent: AgentRole, taskKey: string, instruction: string): string {
  return `- 🔄 ${taskKey}（${roleRegistry[agent].name}）：${snippet(instruction, 60)}`;
}

/** 任务成功（✅，摘要来自角色 run.summary） */
export function taskDoneLine(agent: AgentRole, taskKey: string, summary: string | null): string {
  return `- ✅ ${taskKey}（${roleRegistry[agent].name}）：${snippet(summary ?? '完成')}`;
}

/** 任务失败（❌） */
export function taskFailedLine(agent: AgentRole, taskKey: string, error: string): string {
  return `- ❌ ${taskKey}（${roleRegistry[agent].name}）：${snippet(error)}`;
}

/** 任务跳过（⏸：前置失败，级联跳过） */
export function taskSkippedLine(agent: AgentRole, taskKey: string, failedDep: string): string {
  return `- ⏸ ${taskKey}（${roleRegistry[agent].name}）：前置任务 ${failedDep} 未成功，已跳过`;
}

/** 用户停止（⏸） */
export function taskStoppedLine(agent: AgentRole, taskKey: string): string {
  return `- ⏸ ${taskKey}（${roleRegistry[agent].name}）：用户停止，已中断`;
}

/** 工程师单文件成功（✅） */
export function fileDoneLine(path: string, version: number): string {
  return `- ✅ ${path}（v${version}）`;
}

/** 工程师单文件校验未过（❌，文件保留落库待修复） */
export function fileFailedLine(path: string, errors: string[]): string {
  return `- ❌ ${path}：${snippet(errors.join('；'))}`;
}

/** 工程师单文件挂起（⏸：人工软锁，等待裁决） */
export function filePausedLine(path: string): string {
  return `- ⏸ ${path}：人工编辑软锁生效，已挂起并请求裁决`;
}
