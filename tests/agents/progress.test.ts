/**
 * progress.ts 单元（2026-09-06 用户验收反馈）：任务计划清单原语。
 * 覆盖：轮计划写入 / 子任务登记 / 原地打勾 / 轮次作用域 / 匹配失败降级 / 收尾段保护。
 * 存储走内存桩（newTestStorage），不依赖 LLM。
 */
import { describe, expect, it } from 'vitest';
import { newTestStorage } from '@/lib/db/test-util';
import {
  addTaskSubtasks,
  appendProgressLine,
  fileDoneLine,
  filePlanLine,
  markFileLine,
  markTaskLine,
  startRoundPlan,
  taskDoneLine,
  taskStartLine,
} from '@/lib/agents/progress';
import { CLOSING_SECTION_HEADING, PROGRESS_PATH } from '@/lib/agents/roles/closer';
import type { StorageProvider } from '@/lib/db/provider/types';

async function contentOf(storage: StorageProvider, projectId: number): Promise<string> {
  const row = await storage.getFile(projectId, PROGRESS_PATH);
  if (row === null) throw new Error(`${PROGRESS_PATH} 未生成`);
  return row.content;
}

async function newProject(): Promise<{ storage: StorageProvider; projectId: number }> {
  const storage = newTestStorage();
  const project = await storage.createProject({ sessionId: 's', title: 't', requirement: 'r', mode: 'full' });
  return { storage, projectId: project.id };
}

const PM = { taskKey: 'pm-prd', agent: 'pm' as const, instruction: '产出 PRD，写入 docs/prd.md' };
const ENG = { taskKey: 'eng-code', agent: 'engineer' as const, instruction: '逐文件实现' };

describe('progress 任务计划清单', () => {
  it('startRoundPlan：缺失时带头部创建；每任务一行未勾选，顺序即入参序', async () => {
    const { storage, projectId } = await newProject();
    const ref = await startRoundPlan(storage, projectId, [PM, ENG]);
    const content = await contentOf(storage, projectId);
    expect(content).toContain('# 项目进度（PROGRESS）');
    expect(content).toContain(ref.heading);
    expect(content).toMatch(/^- \[ \] pm-prd（产品经理）：产出 PRD/m);
    expect(content).toMatch(/^- \[ \] eng-code（工程师）：逐文件实现/m);
    expect(content.indexOf('pm-prd')).toBeLessThan(content.indexOf('eng-code'));
  });

  it('startRoundPlan：同分钟重跑不撞锚（标题追加序号）', async () => {
    const { storage, projectId } = await newProject();
    const a = await startRoundPlan(storage, projectId, [PM]);
    const b = await startRoundPlan(storage, projectId, [PM]);
    expect(a.heading).not.toBe(b.heading);
  });

  it('addTaskSubtasks：子任务缩进行插在任务行正下方', async () => {
    const { storage, projectId } = await newProject();
    const ref = await startRoundPlan(storage, projectId, [PM, ENG]);
    await addTaskSubtasks(storage, projectId, ref, 'pm-prd', ['docs/prd.md']);
    const lines = (await contentOf(storage, projectId)).split('\n');
    const idx = lines.findIndex((line) => line.startsWith('- [ ] pm-prd（'));
    expect(lines[idx + 1]).toBe(filePlanLine('docs/prd.md'));
  });

  it('markTaskLine：整行原地改写（[ ]→[x]），其余行不动', async () => {
    const { storage, projectId } = await newProject();
    const ref = await startRoundPlan(storage, projectId, [PM, ENG]);
    await markTaskLine(storage, projectId, ref, 'pm-prd', taskStartLine(PM.agent, PM.taskKey, PM.instruction));
    await markTaskLine(storage, projectId, ref, 'pm-prd', taskDoneLine(PM.agent, PM.taskKey, '完成'));
    const content = await contentOf(storage, projectId);
    expect(content).toMatch(/^- \[x\] pm-prd（产品经理）：完成$/m);
    expect(content).toMatch(/^- \[ \] eng-code（工程师）/m); // 未触碰
    expect(content.match(/pm-prd/g)).toHaveLength(1); // 原地改写，无重复行
  });

  it('markFileLine：按路径改写子任务行；找不到时降级为文末注记行', async () => {
    const { storage, projectId } = await newProject();
    const ref = await startRoundPlan(storage, projectId, [ENG]);
    await addTaskSubtasks(storage, projectId, ref, 'eng-code', ['app/a.js', 'app/b.js']);
    await markFileLine(storage, projectId, ref, 'app/a.js', fileDoneLine('app/a.js', 1));
    const content = await contentOf(storage, projectId);
    expect(content).toMatch(/^  - \[x\] app\/a\.js（v1）$/m);
    expect(content).toMatch(/^  - \[ \] app\/b\.js$/m);
    // 未登记的路径：降级追加（不崩、不丢记录）——追加在文末（内容以 \n 收尾，取最后一个非空行）
    await markFileLine(storage, projectId, ref, 'app/c.js', fileDoneLine('app/c.js', 2));
    const lines = (await contentOf(storage, projectId)).split('\n');
    const lastNonEmpty = [...lines].reverse().find((line) => line.trim() !== '');
    expect(lastNonEmpty).toBe('  - [x] app/c.js（v2）');
  });

  it('作用域：第二轮不误改第一轮同 taskKey 的复选框', async () => {
    const { storage, projectId } = await newProject();
    const r1 = await startRoundPlan(storage, projectId, [PM]);
    await markTaskLine(storage, projectId, r1, 'pm-prd', taskDoneLine(PM.agent, PM.taskKey, '第一轮完成'));
    const r2 = await startRoundPlan(storage, projectId, [PM]);
    await markTaskLine(storage, projectId, r2, 'pm-prd', taskDoneLine(PM.agent, PM.taskKey, '第二轮完成'));
    const content = await contentOf(storage, projectId);
    expect(content).toMatch(/^- \[x\] pm-prd（产品经理）：第一轮完成$/m);
    expect(content).toMatch(/^- \[x\] pm-prd（产品经理）：第二轮完成$/m);
    expect(content.indexOf(r1.heading)).toBeLessThan(content.indexOf(r2.heading));
  });

  it('收尾段保护：已有「## 领导汇报」时，插入与改写都发生在段之前', async () => {
    const { storage, projectId } = await newProject();
    await appendProgressLine(storage, projectId, '- ✅ 历史进度行');
    await storage.upsertFile({
      projectId,
      path: PROGRESS_PATH,
      content: `# 项目进度（PROGRESS）\n\n- ✅ 历史进度行\n\n${CLOSING_SECTION_HEADING}\n旧汇报\n`,
      editor: 'leader',
    });
    const ref = await startRoundPlan(storage, projectId, [PM]);
    await markTaskLine(storage, projectId, ref, 'pm-prd', taskDoneLine(PM.agent, PM.taskKey, '完成'));
    const content = await contentOf(storage, projectId);
    expect(content.indexOf('- [x] pm-prd')).toBeLessThan(content.indexOf(CLOSING_SECTION_HEADING));
    expect(content.indexOf(ref.heading)).toBeLessThan(content.indexOf(CLOSING_SECTION_HEADING));
    expect(content).toContain('旧汇报'); // 段内不越界覆盖
  });
});
