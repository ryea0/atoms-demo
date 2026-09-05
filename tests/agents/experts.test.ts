/**
 * Task 14 测试：专家角色（analyst/seo/ads）+ 领导收尾（MEMORY/PROGRESS/汇报）+ 角色注册表。
 *
 * provider 一律走缺省 getLlmProvider()（LLM_PROVIDER 缺省即 mock），LLM_MOCK_DELAY_MS=0 加速；
 * 落库验证用 newTestStorage（内存库）。纯函数（输出切分 / MEMORY 组装）单独成组直测。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXPERT_REPORT_PATHS,
  EXPERT_SYSTEM_PROMPTS,
  assessOutput,
  runExpert,
  stripOuterFence,
} from '@/lib/agents/roles/experts';
import {
  CLOSER_SYSTEM_PROMPT,
  MEMORY_PATH,
  PROGRESS_PATH,
  composeMemoryDoc,
  runCloser,
  splitCloserOutput,
} from '@/lib/agents/roles/closer';
import { roleRegistry } from '@/lib/agents/registry';
import { AgentAbortError } from '@/lib/agents/runner';
import { newTestStorage } from '@/lib/db/test-util';
import type { AgentRole, StorageProvider } from '@/lib/db/provider/types';

/* ------------------------------------------------------------------ */
/* 测试工具                                                             */
/* ------------------------------------------------------------------ */

/** 记录被改动的 env，测试结束后原样恢复（避免污染其他测试文件） */
const ORIGINAL_ENV = new Map<string, string | undefined>();

/** 设置 env 并登记原值（同键多次设置只登记第一次） */
function setEnv(key: string, value: string | undefined): void {
  if (!ORIGINAL_ENV.has(key)) ORIGINAL_ENV.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeAll(() => {
  // 角色层走缺省 provider 工厂：显式钉住 mock + 关闭流式延迟（打字机节奏在测试里是纯等待）
  setEnv('LLM_PROVIDER', 'mock');
  setEnv('LLM_MOCK_DELAY_MS', '0');
});

afterAll(() => {
  for (const [key, value] of ORIGINAL_ENV) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** 独立内存库 + 空项目 */
async function newProject(requirement = '做一个待办清单应用'): Promise<{
  storage: StorageProvider;
  projectId: number;
}> {
  const storage = newTestStorage();
  const project = await storage.createProject({
    sessionId: 'session-a',
    title: '待办清单',
    requirement,
    mode: 'full',
  });
  return { storage, projectId: project.id };
}

/** 取指定 id 的任务记录（缺失即显式失败，规避 noUncheckedIndexedAccess 的可空索引访问） */
function runOf(runs: Awaited<ReturnType<StorageProvider['listAgentRuns']>>, runId: number) {
  const run = runs.find((item) => item.id === runId);
  if (run === undefined) throw new Error(`预期存在 agent_run id=${runId}，实际没有`);
  return run;
}

/** 取指定路径的文件行（缺失即显式失败） */
async function fileOf(storage: StorageProvider, projectId: number, path: string) {
  const row = await storage.getFile(projectId, path);
  if (row === null) throw new Error(`预期存在文件 ${path}，实际没有`);
  return row;
}

/* ------------------------------------------------------------------ */
/* 角色注册表                                                          */
/* ------------------------------------------------------------------ */

describe('roleRegistry：七角色齐全（@ 浮层与头像数据源）', () => {
  it('键恰好是七个 AgentRole', () => {
    expect(Object.keys(roleRegistry).sort()).toEqual(
      ['ads', 'analyst', 'architect', 'engineer', 'leader', 'pm', 'seo'].sort(),
    );
  });

  it('颜色与 DESIGN 指定值一致', () => {
    const expected: Record<AgentRole, string> = {
      leader: '#3B82F6',
      pm: '#8B5CF6',
      architect: '#06B6D4',
      engineer: '#10B981',
      analyst: '#F59E0B',
      seo: '#EC4899',
      ads: '#EF4444',
    };
    for (const [role, color] of Object.entries(expected)) {
      expect(roleRegistry[role as AgentRole].color).toBe(color);
    }
  });

  it('每个角色都有中文名、emoji 与一句话职责（用户可见文案非空）', () => {
    for (const meta of Object.values(roleRegistry)) {
      expect(meta.name.length).toBeGreaterThan(0);
      expect(meta.emoji.length).toBeGreaterThan(0);
      expect(meta.blurb.length).toBeGreaterThan(0);
      // 中文文案：至少含一个非 ASCII 字符（防止误写成英文占位）
      expect(/[^\x00-\x7F]/u.test(meta.name)).toBe(true);
      expect(/[^\x00-\x7F]/u.test(meta.blurb)).toBe(true);
    }
  });

  it('专家角色名与 mock 角色标记契约一致', () => {
    expect(roleRegistry.analyst.name).toBe('数据分析师');
    expect(roleRegistry.seo.name).toBe('SEO 专家');
    expect(roleRegistry.ads.name).toBe('广告专家');
  });
});

/* ------------------------------------------------------------------ */
/* 专家角色                                                            */
/* ------------------------------------------------------------------ */

describe('runExpert：结构化单发产出专项报告', () => {
  it('brief 用例：analyst 产出报告落库（文件 + 任务记录 done + 摘要）', async () => {
    const { storage, projectId } = await newProject();
    const result = await runExpert({
      storage,
      projectId,
      role: 'analyst',
      instruction: '为这个待办应用定义核心指标与埋点方案',
    });

    expect(result.file).toBe('docs/analyst_report.md');
    const row = await fileOf(storage, projectId, result.file);
    expect(row.content).toContain('数据分析报告');
    expect(row.lastEditor).toBe('analyst');
    expect(row.version).toBe(1);

    const run = runOf(await storage.listAgentRuns(projectId), result.runId);
    expect(run.agent).toBe('analyst');
    expect(run.status).toBe('done');
    expect(run.summary ?? '').toContain('docs/analyst_report.md');
  });

  it('补充：seo 与 ads 各自产出对应报告', async () => {
    const { storage, projectId } = await newProject();

    const seo = await runExpert({ storage, projectId, role: 'seo', instruction: '给出关键词与站内优化建议' });
    expect(seo.file).toBe(EXPERT_REPORT_PATHS.seo);
    expect((await fileOf(storage, projectId, seo.file)).content).toContain('SEO');

    const ads = await runExpert({ storage, projectId, role: 'ads', instruction: '给出投放策略与转化目标' });
    expect(ads.file).toBe(EXPERT_REPORT_PATHS.ads);
    expect((await fileOf(storage, projectId, ads.file)).content).toContain('广告');
  });

  it('模型绑定走 resolveModel(role) 且 LLM 调用计量落库（runAgent 与 wrapMetered 同一 model）', async () => {
    setEnv('LLM_MODEL_ANALYST', 'model-analyst-x');
    try {
      const { storage, projectId } = await newProject();
      await runExpert({ storage, projectId, role: 'analyst', instruction: '定义埋点' });

      const usage = await storage.usageByProject(projectId);
      expect(usage).toHaveLength(1);
      expect(usage[0]?.agentRole).toBe('analyst');
      expect(usage[0]?.model).toBe('model-analyst-x');
      expect(usage[0]?.calls).toBe(1);
      expect(usage[0]?.tokens).toBeGreaterThan(0);
    } finally {
      setEnv('LLM_MODEL_ANALYST', undefined);
    }
  });

  it('专家 system prompt 含各自角色名（mock 场景识别契约）', () => {
    expect(EXPERT_SYSTEM_PROMPTS.analyst).toContain('数据分析师');
    expect(EXPERT_SYSTEM_PROMPTS.seo).toContain('SEO 专家');
    expect(EXPERT_SYSTEM_PROMPTS.ads).toContain('广告投放专家');
    // 收尾语 mark 只属于 closer：专家 prompt 不应携带（避免 mock 场景误判）
    expect(EXPERT_SYSTEM_PROMPTS.analyst).not.toMatch(/收尾|总结|领导汇报/);
  });

  it('报告路径契约：三个专家各一篇 docs/*_report.md', () => {
    expect(EXPERT_REPORT_PATHS.analyst).toBe('docs/analyst_report.md');
    expect(EXPERT_REPORT_PATHS.seo).toBe('docs/seo_report.md');
    expect(EXPERT_REPORT_PATHS.ads).toBe('docs/ads_report.md');
  });

  it('停止语义：signal 已中止 → 任务标 stopped 并上抛 AbortError（不落半成品）', async () => {
    const { storage, projectId } = await newProject();
    const controller = new AbortController();
    controller.abort();

    const error = await runExpert({
      storage,
      projectId,
      role: 'analyst',
      instruction: '定义埋点',
      signal: controller.signal,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AgentAbortError);
    expect(await storage.getFile(projectId, EXPERT_REPORT_PATHS.analyst)).toBeNull();
    const runs = await storage.listAgentRuns(projectId);
    const run = runOf(runs, runs[0]?.id ?? -1);
    expect(run.status).toBe('stopped');
    expect(run.error ?? '').toContain('中止');
  });
});

describe('assessOutput / stripOuterFence：落库前裁决（纯函数）', () => {
  it('空产出判失败（重试一次后仍为空则任务 failed）', () => {
    const verdict = assessOutput('docs/analyst_report.md', '   \n  ');
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('空');
  });

  it('Markdown 报告放行；JS 语法错误与危险用法拦截', () => {
    expect(assessOutput('docs/seo_report.md', '# SEO 优化报告\n\n- 关键词').ok).toBe(true);

    const syntax = assessOutput('app/x.js', 'const a = ;');
    expect(syntax.ok).toBe(false);
    expect(syntax.detail).toContain('语法错误');

    const danger = assessOutput('app/y.js', 'const f = eval("1+1");\n');
    expect(danger.ok).toBe(false);
    expect(danger.detail).toContain('eval');
  });

  it('剥整体围栏：模型把整份报告包进一个代码块时取内部内容', () => {
    expect(stripOuterFence('```markdown\n# 报告\n\n- 要点\n```')).toBe('# 报告\n\n- 要点');
    // 正文内部围栏不受影响；未包裹时原样返回
    expect(stripOuterFence('# 报告\n\n```js\nconst a = 1;\n```\n')).toContain('```js');
  });
});

/* ------------------------------------------------------------------ */
/* 领导收尾                                                            */
/* ------------------------------------------------------------------ */

describe('runCloser：MEMORY + PROGRESS 领导汇报段', () => {
  it('brief 用例：closer 写 MEMORY 且汇报文本非空（PROGRESS.md 缺失时创建）', async () => {
    const { storage, projectId } = await newProject();
    await storage.upsertFile({
      projectId,
      path: 'app/frontend/index.html',
      content: '<html><body>todo</body></html>',
      editor: 'engineer',
    });

    const result = await runCloser({ storage, projectId });

    expect(result.memoryFile).toBe(MEMORY_PATH);
    expect(result.report.trim().length).toBeGreaterThan(0);

    const memory = await fileOf(storage, projectId, MEMORY_PATH);
    expect(memory.content).toContain('MEMORY');
    expect(memory.content).toContain('人工修改清单');
    expect(memory.lastEditor).toBe('leader');

    // PROGRESS.md 原本不存在 → 收尾创建并带「领导汇报」段
    const progress = await fileOf(storage, projectId, PROGRESS_PATH);
    expect(progress.content).toContain('## 领导汇报');

    const run = runOf(await storage.listAgentRuns(projectId), result.runId);
    expect(run.agent).toBe('leader');
    expect(run.status).toBe('done');
    expect((run.summary ?? '').length).toBeGreaterThan(0);
  });

  it('补充：人工修改清单（lastEditor=human）注入 MEMORY', async () => {
    const { storage, projectId } = await newProject();
    await storage.upsertFile({ projectId, path: 'app/frontend/index.html', content: '<p>v1</p>', editor: 'engineer' });
    // 人机共编：人工保存 = last_editor 翻成 human（与 saveHuman 同一仓库语义）
    await storage.upsertFile({ projectId, path: 'app/frontend/index.html', content: '<p>人工微调</p>', editor: 'human' });
    await storage.upsertFile({ projectId, path: 'app/backend/api.js', content: 'export const a = 1;', editor: 'engineer' });

    const result = await runCloser({ storage, projectId });
    const memory = await fileOf(storage, projectId, result.memoryFile);

    expect(memory.content).toContain('app/frontend/index.html');
    expect(memory.content).not.toContain('- app/backend/api.js');
  });

  it('补充：PROGRESS.md 已存在时在末尾追加领导汇报段（不覆盖既有进度行）', async () => {
    const { storage, projectId } = await newProject();
    await storage.upsertFile({
      projectId,
      path: PROGRESS_PATH,
      content: '# 项目进度\n\n- ✅ pm-prd\n',
      editor: 'leader',
    });

    const result = await runCloser({ storage, projectId });
    const progress = await fileOf(storage, projectId, PROGRESS_PATH);

    expect(progress.content).toContain('✅ pm-prd');
    expect(progress.content).toContain('## 领导汇报');
    expect(progress.content.indexOf('## 领导汇报')).toBeGreaterThan(progress.content.indexOf('pm-prd'));
    expect(result.report.trim().length).toBeGreaterThan(0);
  });

  it('closer system prompt 含「团队领导」收尾语境（mock closer 模板契约）', () => {
    expect(CLOSER_SYSTEM_PROMPT).toContain('团队领导');
    expect(CLOSER_SYSTEM_PROMPT).toContain('收尾');
    expect(CLOSER_SYSTEM_PROMPT).toContain('MEMORY');
    expect(CLOSER_SYSTEM_PROMPT).toContain('汇报');
  });
});

/* ------------------------------------------------------------------ */
/* 纯函数：收尾输出切分与 MEMORY 组装                                    */
/* ------------------------------------------------------------------ */

describe('splitCloserOutput：模型输出 → MEMORY 正文 + 汇报文本', () => {
  it('分隔行格式（架构师同款 ===== label =====）', () => {
    const content = [
      '===== .atoms/reports/MEMORY.md =====',
      '## 选型与关键决策',
      '- 零依赖 + 内存态',
      '===== 汇报 =====',
      '- 完成内容：全栈应用已产出',
    ].join('\n');

    const split = splitCloserOutput(content);
    expect(split.memory).toContain('零依赖 + 内存态');
    expect(split.report).toContain('全栈应用已产出');
    expect(split.report).not.toContain('零依赖');
  });

  it('mock 格式（## MEMORY 标题切分）', () => {
    const content = [
      '# 领导汇报（mock 样例）',
      '',
      '- 完成内容：PRD → 设计 → 代码',
      '',
      '## MEMORY',
      '',
      '- 用户偏好：界面清爽',
    ].join('\n');

    const split = splitCloserOutput(content);
    expect(split.report).toContain('PRD → 设计 → 代码');
    expect(split.memory).toContain('用户偏好：界面清爽');
  });

  it('无任何结构标记 → 整体作为汇报，MEMORY 正文为 null（走确定性兜底）', () => {
    const split = splitCloserOutput('应用已生成完毕，可以预览。');
    expect(split.report).toContain('应用已生成完毕');
    expect(split.memory).toBeNull();
  });
});

describe('composeMemoryDoc：确定性组装（人工修改清单恒在）', () => {
  it('模型未产出记忆正文 → 兜底骨架 + 人工修改清单', () => {
    const doc = composeMemoryDoc(null, ['app/frontend/index.html', 'docs/prd.md']);
    expect(doc).toContain('# MEMORY');
    expect(doc).toContain('## 人工修改清单');
    expect(doc).toContain('- app/frontend/index.html');
    expect(doc).toContain('- docs/prd.md');
  });

  it('无人工修改 → 明确写「无」而不是留空', () => {
    const doc = composeMemoryDoc('## 选型与关键决策\n- 零依赖', []);
    expect(doc).toContain('零依赖');
    expect(doc).toMatch(/人工修改清单/);
    expect(doc).toContain('无');
  });

  it('模型正文已含人工修改清单 → 不重复追加同一段', () => {
    const doc = composeMemoryDoc('## 人工修改清单\n- app/x.js', ['app/x.js']);
    expect(doc.match(/## 人工修改清单/g)).toHaveLength(1);
  });
});
