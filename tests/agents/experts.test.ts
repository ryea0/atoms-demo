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
  CLOSING_SECTION_HEADING,
  MEMORY_PATH,
  PROGRESS_PATH,
  composeMemoryDoc,
  runCloser,
  splitCloserOutput,
  stripHumanListSection,
} from '@/lib/agents/roles/closer';
import { roleRegistry } from '@/lib/agents/registry';
import { AgentAbortError } from '@/lib/agents/runner';
import { newTestStorage } from '@/lib/db/test-util';
import type { AgentRole, StorageProvider } from '@/lib/db/provider/types';
import type { LlmProvider, LlmRequest, LlmResult } from '@/lib/llm/types';

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

/** 恒空 provider：模拟模型连续两次（首发 + 带错重试）产出空内容 */
class EmptyProvider implements LlmProvider {
  readonly name = 'empty-stub';
  readonly requests: LlmRequest[] = [];

  async stream(req: LlmRequest): Promise<LlmResult> {
    this.requests.push(req);
    return { content: '   ', toolCalls: [], usage: null };
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    return this.stream(req);
  }
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
  it('收尾边界取到的干预进收尾上下文（T31）：user prompt 带【干预指令】小节', async () => {
    const { storage, projectId } = await newProject();
    const prompts: string[] = [];
    const captureProvider: LlmProvider = {
      name: 'capture',
      async complete(req: LlmRequest): Promise<LlmResult> {
        prompts.push(req.messages.map((m) => m.content).join('\n'));
        return { content: '', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } };
      },
      async stream(req: LlmRequest): Promise<LlmResult> {
        prompts.push(req.messages.map((m) => m.content).join('\n'));
        return {
          content: '===== MEMORY =====\n## 选型与关键决策\n- 零依赖\n===== 汇报 =====\n- 本轮已完成',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    };

    const result = await runCloser({
      storage,
      projectId,
      provider: captureProvider,
      interventions: ['汇报里补一句下一步迭代方向'],
    });

    expect(prompts.join('\n')).toContain('【干预指令】');
    expect(prompts.join('\n')).toContain('汇报里补一句下一步迭代方向');
    expect(result.report).toContain('本轮已完成');
  });

  it('本轮结果注入收尾上下文（T33 反谎报）：失败项逐条列出并要求如实汇报', async () => {
    const { storage, projectId } = await newProject();
    const prompts: string[] = [];
    const captureProvider: LlmProvider = {
      name: 'capture',
      async complete(req: LlmRequest): Promise<LlmResult> {
        prompts.push(req.messages.map((m) => m.content).join('\n'));
        return { content: '', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } };
      },
      async stream(req: LlmRequest): Promise<LlmResult> {
        prompts.push(req.messages.map((m) => m.content).join('\n'));
        return {
          content: '===== MEMORY =====\n## 选型与关键决策\n- 零依赖\n===== 汇报 =====\n- 本轮已完成',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    };

    await runCloser({
      storage,
      projectId,
      provider: captureProvider,
      roundOutcome: {
        succeeded: 2,
        skipped: 1,
        failed: [{ taskKey: 'user-engineer-0', reason: '单文件任务执行失败：provider 连续两次不可用。' }],
      },
    });

    const joined = prompts.join('\n');
    expect(joined).toContain('【本轮结果】');
    expect(joined).toContain('成功 2 项、失败 1 项、跳过 1 项');
    expect(joined).toContain('user-engineer-0——单文件任务执行失败');
    // 跳过=级联后果，与根因失败分开陈述（T34）
    expect(joined).toContain('级联');
    // 反谎报要求：存在失败项时必须如实列出，不得声称所有任务均已成功完成
    expect(joined).toContain('如实');
    expect(joined).toContain('不得声称所有任务均已成功完成');
  });

  it('本轮结果无失败项：只注入成功计数，不附失败清单与如实汇报要求', async () => {
    const { storage, projectId } = await newProject();
    const prompts: string[] = [];
    const captureProvider: LlmProvider = {
      name: 'capture',
      async complete(req: LlmRequest): Promise<LlmResult> {
        prompts.push(req.messages.map((m) => m.content).join('\n'));
        return { content: '', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } };
      },
      async stream(req: LlmRequest): Promise<LlmResult> {
        prompts.push(req.messages.map((m) => m.content).join('\n'));
        return {
          content: '===== MEMORY =====\n## 选型与关键决策\n- 零依赖\n===== 汇报 =====\n- 本轮已完成',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    };

    await runCloser({ storage, projectId, provider: captureProvider, roundOutcome: { succeeded: 3, skipped: 0, failed: [] } });

    const joined = prompts.join('\n');
    expect(joined).toContain('【本轮结果】');
    expect(joined).toContain('成功 3 项、失败 0 项');
    expect(joined).not.toContain('跳过');
    expect(joined).not.toContain('失败：');
    expect(joined).not.toContain('不得声称所有任务均已成功完成');
  });

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
    // 人工修改清单由代码权威计算：prompt 不再要求模型自列（避免幻觉条目顶掉真实清单）
    expect(CLOSER_SYSTEM_PROMPT).not.toContain('人工修改清单');
  });

  it('幂等：重复收尾覆盖既有「领导汇报」段（最新生效），进度行保留', async () => {
    const { storage, projectId } = await newProject();
    await storage.upsertFile({ projectId, path: 'app/frontend/index.html', content: '<p>v1</p>', editor: 'engineer' });

    await runCloser({ storage, projectId });
    // 模拟编排器在两轮之间的进度行：插在「领导汇报」段**之前**（进度行在段前是 progress 模块的契约，
    // 段内内容收尾时会整体覆盖——最新汇报生效）
    const afterFirst = await fileOf(storage, projectId, PROGRESS_PATH);
    await storage.upsertFile({
      projectId,
      path: PROGRESS_PATH,
      content: afterFirst.content.replace(CLOSING_SECTION_HEADING, `- ✅ eng-iterate\n\n${CLOSING_SECTION_HEADING}`),
      editor: 'leader',
    });

    await runCloser({ storage, projectId });
    const progress = await fileOf(storage, projectId, PROGRESS_PATH);

    // 追加语义会出现两段（2 个标题/2 份汇报正文）；覆盖语义恒为一段
    expect(progress.content.match(/## 领导汇报/g)).toHaveLength(1);
    expect(progress.content.match(/# 领导汇报（mock 样例）/g)).toHaveLength(1);
    expect(progress.content).toContain('✅ eng-iterate');
    expect(progress.content.indexOf('✅ eng-iterate')).toBeLessThan(progress.content.indexOf('## 领导汇报'));
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

  it('清单权威在代码：模型自列的（幻觉）清单被剥除，只保留代码算出的清单', () => {
    const modelBody = [
      '## 选型与关键决策',
      '- 零依赖 + 内存态',
      '',
      '## 人工修改清单',
      '- docs/模型编造的文件.md（模型幻觉的意图说明）',
      '',
      '## 偏好捕捉',
      '- 界面清爽',
    ].join('\n');

    const doc = composeMemoryDoc(modelBody, ['app/frontend/index.html']);

    // 模型的幻觉条目不出现；代码清单出现在专属段内
    expect(doc).not.toContain('模型编造的文件');
    expect(doc.match(/## 人工修改清单/g)).toHaveLength(1);
    expect(doc.indexOf('- app/frontend/index.html')).toBeGreaterThan(doc.indexOf('## 人工修改清单'));
    // 剥除不伤及清单段之外的模型内容
    expect(doc).toContain('零依赖 + 内存态');
    expect(doc).toContain('界面清爽');
  });

  it('stripHumanListSection：清单段在末尾（无后续标题）同样剥净', () => {
    const stripped = stripHumanListSection('## 项目约束\n- 内存态\n\n## 人工修改清单\n- a.js\n- b.js\n');
    expect(stripped).toContain('内存态');
    expect(stripped).not.toContain('a.js');
    expect(stripped).not.toContain('b.js');
  });
});

describe('runExpert：失败路径（stub provider 两次空产出）', () => {
  it('重试一次仍为空 → 任务 failed + error 落库，不落半成品文件', async () => {
    const { storage, projectId } = await newProject();
    const provider = new EmptyProvider();

    const error = await runExpert({
      storage,
      projectId,
      role: 'analyst',
      instruction: '定义埋点',
      provider,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('空报告');
    expect(provider.requests).toHaveLength(2); // 首发一次 + 带错重试一次

    expect(await storage.getFile(projectId, EXPERT_REPORT_PATHS.analyst)).toBeNull();
    const runs = await storage.listAgentRuns(projectId);
    const run = runOf(runs, runs[0]?.id ?? -1);
    expect(run.status).toBe('failed');
    expect(run.error ?? '').toContain('空报告');
  });
});
