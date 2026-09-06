/**
 * 工程师角色（Task 13，DESIGN §3.2 D1 混合模式 / §3.7 全栈契约 / §5⑤ 质量下限 / §5′ 校验重试）。
 *
 * 三段职责：
 * 1. buildFastFileTree：快速模式（D3）的关键词确定性选型——编排器据此逐文件派发，不经过模型决策
 * 2. runEngineerFile：D1 单文件任务 = assembleContext（依赖文件全文注入）→ runAgent（fsTools，
 *    模型必须 write_file 目标文件）→ validateFile；语法/硬违规 → 带错误反馈**重跑该单文件任务一次**
 *    （重试 = 第二次完整 runAgent，非 in-runner 重试）；仍未过 → ok=false、文件保留落库、⚠ 记入
 *    softWarnings；两次都没写文件 → 回退保底模板（三段式第 3 步，保底模板即质量下限）；
 *    工具协议失误（AgentValidationError，如 bash 命令超 500 字符）→ 按已落盘产物收口，不炸任务
 * 3. runEngineerReview：写后自审（agent 版 lint）——一次廉价 review 调用，发现问题覆写一次即止
 *
 * 计量契约（CLAUDE.md 规则 10）：每个入口只做一次 resolveModel('engineer')，
 * 同一个 model 同时绑定 runAgent 请求与 wrapMetered 计量装饰器。
 */
import { assembleContext } from '@/lib/agents/context';
import { runAgent } from '@/lib/agents/runner';
import { AgentAbortError, AgentValidationError, type RunnerCallbacks } from '@/lib/agents/types';
import { bashTool, fsTools, type Tool } from '@/lib/agents/tools';
import { javascriptProfile, resolveProfileByPaths } from '@/lib/languages';
import type { LanguageId } from '@/lib/languages/types';
import type { FileTree, FileTreeNode } from './file-tree';
import { renderApiJs, renderApiPy, renderApiTs, renderIndexHtml, renderStartSh } from './samples/app-skeleton';
import { resolveModel } from '@/lib/llm/client';
import { wrapMetered } from '@/lib/llm/metered-provider';
import { validateFile, type FileValidation } from '@/lib/validation';
import type { StorageProvider } from '@/lib/db/provider/types';
import type { LlmProvider } from '@/lib/llm/types';

export type { FileTree, FileTreeNode } from './file-tree';

/* ------------------------------------------------------------------ */
/* 上下文与结果契约                                                     */
/* ------------------------------------------------------------------ */

/** 单文件任务入参（brief 原文签名；provider/callbacks 为可选扩展，缺省走 env 工厂） */
export interface EngineerFileContext {
  storage: StorageProvider;
  projectId: number;
  requirement: string;
  /** 本任务要写的目标文件节点 */
  target: FileTreeNode;
  /** 全量文件树（任务指令与资源路由的来源；树正文注入由 assembleContext 读 docs/file_tree.json） */
  fileTree: FileTree;
  /** 上游交接摘要（架构师/快速模式的设计要点，拼进【上游交接摘要】小节） */
  designSummary: string;
  signal?: AbortSignal;
  /** 可选 provider 注入（测试 FakeProvider / 编排器计量桩）；缺省 getLlmProvider()（env 晚绑定） */
  provider?: LlmProvider;
  /** 可选回调（编排器发 file_start/delta/file_end SSE 事件用），原样透传给 AgentRunner */
  callbacks?: RunnerCallbacks;
}

/** 单文件任务结果：ok=false 表示校验未过（⚠），文件仍保留落库 */
export interface EngineerFileResult {
  runId: number;
  path: string;
  version: number;
  ok: boolean;
  softWarnings: string[];
  /** 阻断性错误（语法错误 + 硬违规），与 softWarnings 分离；ok=false ⇒ 非空（T15 契约） */
  errors?: string[];
}

/** 写后自审入参：同单文件任务 + 待审文件路径 */
export interface EngineerReviewContext extends EngineerFileContext {
  path: string;
}

/** 校验失败重试上限（DESIGN §3.4 三段式第 2 步：带错误反馈重试一次） */
const MAX_ATTEMPTS = 2;

/** 自审是廉价调用：一次检查 + 一次覆写即止，步数收紧防失控 */
const REVIEW_MAX_STEPS = 4;

/**
 * 单文件任务工具集：FS 工具 + bash 自检（每次调用前物化工作区，per-run 预算 5 次）。
 * 仅用于生成任务闭环；写后自审（runEngineerReview）保持 fsTools 不扩执行面。
 */
const engineerTools: Tool[] = [...fsTools, bashTool];

/* ------------------------------------------------------------------ */
/* 快速模式确定性文件树（D3）                                             */
/* ------------------------------------------------------------------ */

/** 模板种类：关键词确定性选型（CLAUDE.md 规则 1：选型是确定性代码，不是模型决策） */
type FastTemplate = 'crud' | 'dashboard' | 'landing';

/** 关键词路由表：先命中先赢（brief 顺序：todo/待办/list/清单 → dashboard/看板/仪表 → 默认落地页） */
const TEMPLATE_KEYWORDS: ReadonlyArray<{ kind: FastTemplate; pattern: RegExp }> = [
  { kind: 'crud', pattern: /todo|待办|list|清单/i },
  { kind: 'dashboard', pattern: /dashboard|看板|仪表/i },
];

/** 各模板的后端资源路由（同时决定前端 fetch 基址与后端内存分桶） */
const TEMPLATE_ROUTES: Record<FastTemplate, readonly string[]> = {
  crud: ['/api/todos'],
  dashboard: ['/api/stats'],
  landing: ['/api/leads'],
};

/** 各模板的前端职责描述（进 file_tree 节点 desc，供任务指令与上下文关键词） */
const TEMPLATE_LABEL: Record<FastTemplate, string> = {
  crud: '增删改查清单',
  dashboard: '数据仪表盘',
  landing: '产品落地页',
};

function pickTemplate(requirement: string): FastTemplate {
  for (const entry of TEMPLATE_KEYWORDS) {
    if (entry.pattern.test(requirement)) return entry.kind;
  }
  return 'landing';
}

/** 语言关键词 → LanguageId；中文紧邻场景用环视（\b 对非 ASCII 不成立） */
const LANGUAGE_KEYWORDS: ReadonlyArray<readonly [RegExp, LanguageId]> = [
  [/\btypescript\b|(?<![a-z])ts(?![a-z])/i, 'typescript'],
  [/\bpython\b|(?<![a-z])py(?![a-z])/i, 'python'],
];

/** 快速模式确定性选型（先例：pickTemplate）；默认 javascript */
export function pickLanguage(requirement: string): LanguageId {
  for (const [pattern, id] of LANGUAGE_KEYWORDS) {
    if (pattern.test(requirement)) return id;
  }
  return 'javascript';
}

/** 各语言的后端入口（完整模式由架构师 prompt 决定同一约定） */
const FAST_ENTRY: Record<LanguageId, string> = {
  javascript: 'app/backend/api.js',
  typescript: 'app/backend/api.ts',
  python: 'app/backend/api.py',
};

/**
 * 快速模式文件树：关键词确定性选型，返回 4 节点固定树（拓扑序）。
 * app/frontend/index.html depends app/backend/api.js（D2 全栈契约的骨架表达）。
 */
export function buildFastFileTree(requirement: string): FileTree {
  const kind = pickTemplate(requirement);
  const lang = pickLanguage(requirement);
  const routes = TEMPLATE_ROUTES[kind];
  const primary = routes[0] ?? TEMPLATE_ROUTES.crud[0];
  if (primary === undefined) throw new Error('快速模板缺少资源路由（不可达：TEMPLATE_ROUTES 恒非空）');
  return [
    {
      path: FAST_ENTRY[lang],
      desc: `内存态后端 handle(method,path,body)（${lang}），资源 ${primary}（REST，状态码 200/201/400/404/405）`,
      depends: [],
    },
    {
      path: 'app/frontend/index.html',
      desc: `${TEMPLATE_LABEL[kind]}单页（Tailwind CDN + fetch 调 ${primary}，禁 localStorage）`,
      depends: ['app/backend/api.js'],
    },
    {
      path: 'app/README.md',
      desc: '应用说明（功能清单、接口一览、预览方式）',
      depends: ['app/frontend/index.html'],
    },
    {
      path: 'start_app.sh',
      desc: '预览启动脚本（本地静态服务，PORT 默认 3001，零依赖）',
      depends: ['app/frontend/index.html'],
    },
  ];
}

/* ------------------------------------------------------------------ */
/* 提示词                                                               */
/* ------------------------------------------------------------------ */

/**
 * 工程师 system prompt：含 mock 角色标记「工程师」与全栈契约（D2）。
 * 刻意避开其他角色的标记词（如「系统设计」「PRD」「file_tree」），防 mock 场景误路由。
 * 契约第 1 条与 bash 自检行按语言档案注入（DESIGN §12），其余段全语言共用。
 */
export function buildEngineerSystemPrompt(contract: readonly string[], selfCheckHint: string): string {
  return [
    '你是全栈工程师（engineer），负责把上游设计可靠地落成可运行代码——当前是单文件任务，应用的质量下限由你守住。',
    '',
    '【全栈契约（必须逐条遵守）】',
    ...contract,
    '2. 前端 app/frontend/index.html：单页，样式仅允许 Tailwind CDN（https://cdn.tailwindcss.com）；一律 fetch(\'/api/...\') 调用后端；禁用 localStorage 与 cookie（预览 iframe 无 same-origin，状态放后端内存）；禁止 eval、new Function、字符串 setTimeout、postMessage。',
    '3. UI 基线：#F7F7F8 面板分层、蓝色 #3B82F6 强调、8-12px 圆角、1px 细灰线分隔、空态与加载态、中文文案；渲染用户数据一律用 textContent（禁止 innerHTML 拼接，防 XSS）。',
    '',
    '【单文件任务纪律】',
    '- 每个任务只实现一个目标文件；依赖文件全文已注入上下文，其他已生成文件可用 read_file 按需查阅。',
    '- 目标文件必须由你调用 write_file 写入完整内容（整体覆盖）；发现写错可再次 write_file 覆写修正。',
    '- 写完目标文件即任务完成：输出一句简短结论即可，不要复述全文。',
    selfCheckHint,
  ].join('\n');
}

/** 兼容常量（js 语义不变；新消费方一律走 buildEngineerSystemPrompt + 项目语言档案） */
export const ENGINEER_SYSTEM_PROMPT = buildEngineerSystemPrompt(
  javascriptProfile.engineerContract,
  javascriptProfile.selfCheckHint,
);

/** 写后自审 system prompt：一次廉价 review（语法/逻辑/遗漏/XSS），覆写一次即止 */
export const ENGINEER_REVIEW_SYSTEM_PROMPT = [
  '你是全栈工程师（engineer），现在执行写后自审（agent 版 lint）：只针对一个已生成文件做一次快速检查，能改才改、一次即止。',
  '',
  '【检查清单】',
  '1. 语法完整：无半截代码、无未闭合结构（JS/HTML 均需可解析）。',
  '2. 逻辑一致：前端调用路径/方法与后端 handle(method, path, body) 的路由一致；状态码正确（200/201/400/404/405）。',
  '3. 交互遗漏：对照文件职责，增删改查等必要交互是否完整。',
  '4. XSS：是否用 innerHTML 拼接用户输入（应改为 textContent）；是否出现 eval、new Function、字符串 setTimeout。',
  '',
  '【裁决规则】',
  '- 全部通过：直接回答「检查通过」，不要调用任何写文件工具。',
  '- 有问题：调用 write_file 一次性覆写修复后的完整文件（同轮完成，不反复修改）。',
  '- 不做风格化重写、不扩需求——只修真问题。',
].join('\n');

/** 从文件树各节点 desc 提取 /api/... 资源路由（任务指令提示模型用） */
function apiRoutesOfTree(tree: FileTree): string[] {
  const found = new Set<string>();
  for (const node of tree) {
    for (const match of node.desc.matchAll(/\/api\/[a-z][a-z0-9-]*/gi)) found.add(match[0]);
  }
  return [...found];
}

/**
 * 单文件任务指令：目标路径必须逐字出现且是全文最后一个路径样 token
 * （mock 工程师按最后一条用户消息的路径后缀路由——共享契约 2）。
 */
function buildTaskText(target: FileTreeNode, tree: FileTree, feedback?: string[]): string {
  const routes = apiRoutesOfTree(tree);
  const lines: string[] = [];
  if (feedback !== undefined && feedback.length > 0) {
    lines.push('【上次产出未通过校验，必须修复后重写】', ...feedback.map((item) => `- ${item}`), '');
  }
  lines.push(
    '请实现目标文件（单文件任务）。',
    `- 文件职责：${target.desc}`,
    `- 后端资源路由：${routes.join('、') || '（以文件树为准）'}`,
    '- 可用工具：write_file（写入/覆写目标文件）、read_file、list_files——目标文件必须由你调用 write_file 写入完整内容。',
    '- 写完后输出一句简短结论即可。',
    `现在调用 write_file 写入目标文件：${target.path}`,
  );
  return lines.join('\n');
}

/** 自审任务指令（同样保证目标路径是最后一个路径样 token） */
function buildReviewTaskText(ctx: EngineerReviewContext): string {
  const lines = [
    `请自审目标文件 ${ctx.path}（职责：${ctx.target.desc}），文件全文已注入上文依赖文件。`,
    '- 逐条过检查清单：语法 / 逻辑与路由一致性 / 交互遗漏 / XSS。',
    '- 无问题：只回答「检查通过」，不要写任何文件。',
  ];
  if (ctx.designSummary.trim() !== '') lines.push(`- 设计要点（对照遗漏项）：${ctx.designSummary.trim()}`);
  lines.push(`- 有问题：调用 write_file 一次性覆写修复后的完整文件：${ctx.path}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 保底模板回退（三段式第 3 步）                                          */
/* ------------------------------------------------------------------ */

/** 按扩展名渲染保底模板：模型两次都没 write_file 时的确定性兜底（DESIGN §5⑤ 下限保证） */
function renderFallbackFile(path: string, requirement: string, routes: string[]): string {
  if (/\.ts$/.test(path)) return renderApiTs(routes);
  if (/\.py$/.test(path)) return renderApiPy(routes);
  if (/\.m?js$/.test(path)) return renderApiJs(routes);
  if (/\.html?$/.test(path)) return renderIndexHtml(requirement, routes);
  if (path.endsWith('.sh')) return renderStartSh();
  if (path.endsWith('.md')) {
    return [
      '# 应用说明',
      '',
      `- 需求：${requirement}`,
      `- 接口：${routes.join('、') || '无'}`,
      '',
      '在平台预览面板打开 app/frontend/index.html 即可运行（浏览器内全栈、零依赖、内存态）。',
      '',
    ].join('\n');
  }
  return `/* ${path} —— 保底模板占位（需求：${requirement}） */\n`;
}

/* ------------------------------------------------------------------ */
/* 内部小工具                                                           */
/* ------------------------------------------------------------------ */

/** 校验结论 → 阻断性错误列表（语法错误 + 硬违规）；空 = 通过 */
function blockingErrors(verdict: FileValidation): string[] {
  return [
    ...(verdict.syntaxError !== undefined ? [verdict.syntaxError] : []),
    ...verdict.hard.map((item) => item.detail),
  ];
}

/** unknown → 可读错误信息（落 agent_runs.error 用，不泄漏堆栈） */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 运行收尾/终止的 agent_runs 推进（短小：一次 update，不在事务里做任何慢操作） */
async function finishRun(
  storage: StorageProvider,
  projectId: number,
  runId: number,
  patch: { status: 'done' | 'failed' | 'stopped'; summary?: string; error?: string },
): Promise<void> {
  await storage.updateAgentRun(runId, { endedAt: Date.now(), ...patch }, projectId);
}

/** 运行异常的统一落库：停止（signal）/ 失败（其余）标记后由调用方上抛（SSE error 事件归编排器） */
async function failRun(storage: StorageProvider, projectId: number, runId: number, error: unknown): Promise<void> {
  if (error instanceof AgentAbortError) {
    await finishRun(storage, projectId, runId, { status: 'stopped' });
  } else {
    await finishRun(storage, projectId, runId, { status: 'failed', error: errorMessage(error) });
  }
}

/* ------------------------------------------------------------------ */
/* runEngineerFile（D1 单文件任务）                                      */
/* ------------------------------------------------------------------ */

/**
 * 执行一个单文件任务：最多两次完整 runAgent（第二次带第一次的校验错误反馈）。
 * 文件落库由模型 write_file 完成（mock 工程师同样遵守）；两次都没写 → 保底模板回退。
 */
export async function runEngineerFile(ctx: EngineerFileContext): Promise<EngineerFileResult> {
  // 计量契约：唯一一次 resolveModel，同时绑定请求与 llm_calls 记账
  const model = resolveModel('engineer');

  const run = await ctx.storage.createAgentRun({
    projectId: ctx.projectId,
    taskKey: `engineer:${ctx.target.path}`,
    agent: 'engineer',
    task: `实现 ${ctx.target.path}（${ctx.target.desc}）`,
  });
  await ctx.storage.updateAgentRun(run.id, { status: 'running', startedAt: Date.now() }, ctx.projectId);

  try {
    // 语言档案按文件树解析（后端入口在册即中，无入口回退 js）：契约与自检行随项目语言注入
    const profile = resolveProfileByPaths(ctx.fileTree.map((node) => node.path));
    let feedback: string[] | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const assembled = await assembleContext({
        storage: ctx.storage,
        projectId: ctx.projectId,
        role: 'engineer',
        systemPrompt: buildEngineerSystemPrompt(profile.engineerContract, profile.selfCheckHint),
        task: buildTaskText(ctx.target, ctx.fileTree, feedback),
        upstreamSummaries: ctx.designSummary.trim() === '' ? [] : [ctx.designSummary],
        interventions: [],
        extraFiles: ctx.target.depends,
      });

      /**
       * 三段式第 3 步（runner 契约：AgentValidationError 的回退由调用方做）：
       * 工具协议连续失误（如 bash 命令超 500 字符两轮未过）只终止本轮决策循环，不炸整个
       * 文件任务——交付物可能已经写好（线上案例：api.js 落库后死于自检超限）。
       * 停止（Abort）/步数超限/provider 错误语义不变，照旧上抛。
       */
      let toolProtocolError: string | undefined;
      try {
        await runAgent({
          role: 'engineer',
          systemPrompt: assembled.system,
          userPrompt: assembled.user,
          tools: engineerTools,
          model,
          ctx: { storage: ctx.storage, projectId: ctx.projectId, role: 'engineer' },
          provider: wrapMetered({
            storage: ctx.storage,
            projectId: ctx.projectId,
            agentRole: 'engineer',
            model,
            provider: ctx.provider,
          }),
          callbacks: ctx.callbacks,
          signal: ctx.signal,
        });
      } catch (error) {
        if (!(error instanceof AgentValidationError)) throw error;
        toolProtocolError = error.message;
      }

      const row = await ctx.storage.getFile(ctx.projectId, ctx.target.path);
      if (row === null) {
        // 模型没有 write_file 目标文件：带反馈重跑；两次都没写 → 保底模板（三段式第 3 步）
        if (attempt < MAX_ATTEMPTS) {
          feedback = toolProtocolError === undefined
            ? ['上次运行没有调用 write_file 写入目标文件——本任务必须以 write_file 写入完整内容。']
            : [
                `上次运行中${toolProtocolError}。请改用 write_file 写入目标文件完成本任务；`
                + '如仍要 bash 自检，命令必须 ≤500 字符（过长请拆成多条短命令或只跑 node --check）。',
              ];
          continue;
        }
        const content = renderFallbackFile(ctx.target.path, ctx.requirement, apiRoutesOfTree(ctx.fileTree));
        const upserted = await ctx.storage.upsertFile({
          projectId: ctx.projectId,
          path: ctx.target.path,
          content,
          editor: 'engineer',
        });
        const verdict = validateFile(ctx.target.path, content);
        const fallbackErrors = blockingErrors(verdict);
        const softWarnings = [
          ...verdict.soft.map((item) => item.detail),
          '模型两次均未调用 write_file 写入目标文件，已回退保底模板。',
        ];
        await finishRun(ctx.storage, ctx.projectId, run.id, {
          status: 'done',
          summary: `${ctx.target.path} v${upserted.version} 由保底模板生成（模型未写入）`,
        });
        return {
          runId: run.id,
          path: ctx.target.path,
          version: upserted.version,
          ok: verdict.ok,
          softWarnings,
          ...(fallbackErrors.length === 0 ? {} : { errors: fallbackErrors }),
        };
      }

      const verdict = validateFile(row.path, row.content);
      const errors = blockingErrors(verdict);
      const softWarnings = verdict.soft.map((item) => item.detail);

      if (errors.length === 0) {
        const suffix = softWarnings.length > 0 ? `（⚠ ${softWarnings.length} 条软警告）` : '';
        // 工具协议失误被容忍收口：summary 留痕（错误不静默吞），不改判 ok
        const fumbleNote = toolProtocolError === undefined ? '' : '（含一次工具校验失误，已按落盘产物收口）';
        await finishRun(ctx.storage, ctx.projectId, run.id, {
          status: 'done',
          summary: `${row.path} v${row.version} 完成${suffix}${fumbleNote}`,
        });
        return { runId: run.id, path: row.path, version: row.version, ok: true, softWarnings };
      }
      if (attempt < MAX_ATTEMPTS) {
        feedback = errors; // D1：重试 = 重跑该单文件任务（第二次完整 runAgent，带错误反馈）
        continue;
      }

      // 重试后仍未通过：文件保留落库 + ⚠（softWarnings 一并带回，供编排器标 SSE）
      await finishRun(ctx.storage, ctx.projectId, run.id, {
        status: 'done',
        summary: `${row.path} v${row.version} 保留落库，校验未通过（⚠ ${errors.length} 处待修复）`,
      });
      return {
        runId: run.id,
        path: row.path,
        version: row.version,
        ok: false,
        softWarnings: [...softWarnings, ...errors],
        errors, // ok=false ⇒ errors 非空（T15 契约）
      };
    }
    throw new Error('runEngineerFile 未产生结果（不可达：循环内所有路径均 return）');
  } catch (error) {
    await failRun(ctx.storage, ctx.projectId, run.id, error);
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* runEngineerReview（写后自审，DESIGN §5⑤ LLM 自审）                     */
/* ------------------------------------------------------------------ */

/**
 * 写后自审：一次廉价 review 调用（语法/逻辑/遗漏/XSS 清单），发现问题由模型
 * write_file 覆写修复，一次即止（一次即止限制的是 LLM 调用次数，不是校验）。
 * 改写后必须复检新内容：语法/硬违规 → restoreFileVersion 回滚到自审前版本、
 * 返回 false、错误记入 agent_runs.error。返回 true 仅当改写且通过复检。
 */
export async function runEngineerReview(ctx: EngineerReviewContext): Promise<boolean> {
  const before = await ctx.storage.getFile(ctx.projectId, ctx.path);
  if (before === null) return false; // 文件不存在，无从自审

  // 计量契约：同 runEngineerFile，一次 resolveModel 双绑定
  const model = resolveModel('engineer');
  const run = await ctx.storage.createAgentRun({
    projectId: ctx.projectId,
    taskKey: `engineer-review:${ctx.path}`,
    agent: 'engineer',
    task: `写后自审 ${ctx.path}`,
  });
  await ctx.storage.updateAgentRun(run.id, { status: 'running', startedAt: Date.now() }, ctx.projectId);

  try {
    const assembled = await assembleContext({
      storage: ctx.storage,
      projectId: ctx.projectId,
      role: 'engineer',
      systemPrompt: ENGINEER_REVIEW_SYSTEM_PROMPT,
      task: buildReviewTaskText(ctx),
      upstreamSummaries: ctx.designSummary.trim() === '' ? [] : [ctx.designSummary],
      interventions: [],
      // 目标文件恒注入全文（cheap review 不再让模型 read_file 省一步）
      extraFiles: [ctx.path, ...ctx.target.depends],
    });

    await runAgent({
      role: 'engineer',
      systemPrompt: assembled.system,
      userPrompt: assembled.user,
      tools: fsTools,
      model,
      maxSteps: REVIEW_MAX_STEPS,
      ctx: { storage: ctx.storage, projectId: ctx.projectId, role: 'engineer' },
      provider: wrapMetered({
        storage: ctx.storage,
        projectId: ctx.projectId,
        agentRole: 'engineer',
        model,
        provider: ctx.provider,
      }),
      callbacks: ctx.callbacks,
      signal: ctx.signal,
    });

    const after = await ctx.storage.getFile(ctx.projectId, ctx.path);
    if (after === null) {
      // 理论不可达（自审前文件存在且本流程只有 write_file 一种写路径）；显式失败好过误报
      await finishRun(ctx.storage, ctx.projectId, run.id, {
        status: 'done',
        summary: `${ctx.path} 自审期间文件消失，按未改写处理`,
      });
      return false;
    }
    if (after.version <= before.version) {
      await finishRun(ctx.storage, ctx.projectId, run.id, {
        status: 'done',
        summary: `${ctx.path} 自审通过，未改写`,
      });
      return false;
    }

    // 发生了改写：复检新内容（一次即止限制调用次数，不豁免校验）
    const reviewErrors = blockingErrors(validateFile(ctx.path, after.content));
    if (reviewErrors.length === 0) {
      await finishRun(ctx.storage, ctx.projectId, run.id, {
        status: 'done',
        summary: `${ctx.path} 自审后已覆写修复（v${after.version}）`,
      });
      return true;
    }

    // 改写引入语法/硬违规：回滚到自审前版本（可再撤销），错误落 agent_runs.error
    await ctx.storage.restoreFileVersion(ctx.projectId, before.id, before.version);
    await finishRun(ctx.storage, ctx.projectId, run.id, {
      status: 'done',
      summary: `${ctx.path} 自审改写未通过校验，已回滚至 v${before.version}（⚠）`,
      error: reviewErrors.join('；'),
    });
    return false;
  } catch (error) {
    await failRun(ctx.storage, ctx.projectId, run.id, error);
    throw error;
  }
}
