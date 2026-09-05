/**
 * mock provider（DESIGN §5⑥ 行为规格，P1 交付物）：离线全链路的基石。
 * 按消息中的角色标记路由到固定优质样例（samples/）：
 * - leader（带 assign_task 工具）→ 3 个 assign_task 工具调用（pm→architect→engineer 依赖链）
 * - leader 收尾（总结/汇报，无分派工具）→ 领导汇报 + MEMORY
 * - pm → 样例 PRD；architect → 样例多段设计（system_design + mermaid + file_tree）
 * - engineer → 按目标路径用模板骨架生成文件内容
 * - 专家角色 → 固定报告模板
 *
 * 服务端专用（读文件 + env 延迟读取），不得进入客户端 bundle。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderApiJs,
  renderIndexHtml,
  renderStartSh,
} from '@/lib/agents/roles/samples/app-skeleton';
import { estimateTokens } from '@/lib/llm/estimate';
import type { AgentRole } from '@/lib/db/provider/types';
import type { LlmMessage, LlmProvider, LlmRequest, LlmResult, ToolCall } from '@/lib/llm/types';

/** mock 场景：七个角色之外还有「领导收尾汇报」 */
type MockScene = AgentRole | 'closer';

/** leader 分派链（task_key 依赖链：pm → architect → engineer） */
const LEADER_PLAN: ReadonlyArray<{
  taskKey: string;
  agent: AgentRole;
  instruction: string;
  writesPaths: string[];
  dependsOn: string[];
}> = [
  {
    taskKey: 'pm-prd',
    agent: 'pm',
    instruction: '基于用户需求产出 PRD（功能清单/用户故事/验收标准），写入 docs/prd.md',
    writesPaths: ['docs/'],
    dependsOn: [],
  },
  {
    taskKey: 'architect-design',
    agent: 'architect',
    instruction: '依据 PRD 产出系统设计与 file_tree（含 mermaid 架构图），写入 docs/system_design.md',
    writesPaths: ['docs/'],
    dependsOn: ['pm-prd'],
  },
  {
    taskKey: 'engineer-app',
    agent: 'engineer',
    instruction: '按 file_tree 逐文件实现全栈应用（浏览器内后端 + 单页前端）',
    writesPaths: ['app/', 'start_app.sh'],
    dependsOn: ['architect-design'],
  },
];

/** 角色标记表（命中越多越可信；专家角色放在通用角色之前，避免被泛化词抢先） */
const ROLE_MARKERS: ReadonlyArray<readonly [MockScene, readonly string[]]> = [
  ['analyst', ['数据分析师', '数据分析', 'analyst', '埋点']],
  ['seo', ['SEO 专家', 'SEO', '搜索引擎优化']],
  ['ads', ['广告投放专家', '广告投放', '广告', 'ads']],
  ['closer', ['收尾', '总结', '领导汇报', 'MEMORY', '汇报']],
  ['architect', ['架构师', 'architect', '系统设计', 'system_design', 'file_tree']],
  ['pm', ['产品经理', 'PRD', 'prd', '需求文档']],
  ['engineer', ['工程师', 'engineer', 'write_file', '目标文件']],
];

/** 默认流式 chunk 大小（字符） */
const CHUNK_SIZE = 6;
/** 默认 chunk 间隔（ms；DESIGN §5⑥ 原定 30ms，按控制器裁决收敛为 5ms，env 可配） */
const DEFAULT_DELAY_MS = 5;
const DELAY_ENV = 'LLM_MOCK_DELAY_MS';

/** 样例文件缓存（懒读取，避免模块加载期 IO） */
const sampleCache = new Map<string, string>();

/**
 * 读取样例文件（mock 与测试共用）。
 * 优先 project 根目录（dev/build/next start 的 cwd），兜底按模块相对路径解析。
 */
export function readSample(name: string): string {
  const cached = sampleCache.get(name);
  if (cached !== undefined) return cached;
  const candidates = [
    join(process.cwd(), 'src', 'lib', 'agents', 'roles', 'samples', name),
    fileURLToPath(new URL(`../agents/roles/samples/${name}`, import.meta.url)),
  ];
  let lastError = '';
  for (const candidate of candidates) {
    try {
      const content = readFileSync(candidate, 'utf8');
      sampleCache.set(name, content);
      return content;
    } catch (error) {
      // 逐个候选路径尝试，全部失败才上抛
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`mock provider 样例缺失：${name}（尝试过 ${candidates.join(' , ')}）——${lastError}`);
}

/** 流式延迟（每次调用读取，测试可置 0） */
function mockDelayMs(): number {
  const raw = process.env[DELAY_ENV];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DELAY_MS;
}

/** 已中止则抛 AbortError（规则 06：abort 必须级联生效） */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    const error = new Error('LLM 调用已中止（abort）');
    error.name = 'AbortError';
    throw error;
  }
}

/** 可被 abort 提前打断的 sleep */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ms <= 0) {
      throwIfAborted(signal);
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      const error = new Error('LLM 调用已中止（abort）');
      error.name = 'AbortError';
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 按 CHUNK_SIZE 切片（打字机节奏） */
function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) chunks.push(text.slice(i, i + CHUNK_SIZE));
  return chunks;
}

/** 拼接消息文本（角色识别 + 用量估算共用） */
function serializeMessages(messages: LlmMessage[]): string {
  return messages.map((m) => `${m.role}:${m.content}`).join('\n');
}

/**
 * 场景识别：优先看工具表（assign_task → 领导分派），再按标记打分
 * （system 消息权重 ×3，避免用户需求正文里的词造成误判）。
 */
export function detectScene(req: LlmRequest): MockScene {
  const hasAssignTool = req.tools?.some((t) => t.name === 'assign_task') === true;
  const systemText = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  const otherText = req.messages
    .filter((m) => m.role !== 'system')
    .map((m) => m.content)
    .join('\n');
  const countHits = (markers: readonly string[], text: string): number =>
    markers.reduce((acc, marker) => acc + (text.includes(marker) ? 1 : 0), 0);

  let best: MockScene = 'engineer';
  let bestScore = -1;
  for (const [scene, markers] of ROLE_MARKERS) {
    const score = countHits(markers, systemText) * 3 + countHits(markers, otherText);
    if (score > bestScore) {
      best = scene;
      bestScore = score;
    }
  }
  // 领导分派：带 assign_task 工具即视为路由请求（优先于文本打分）
  if (hasAssignTool) return 'leader';
  return bestScore > 0 ? best : 'engineer';
}

/** 从消息中提取需求一句话（首条用户消息首行，截断到 60 字符；
 *  assembleContext 组装的首行是【需求】小节标题，此时取小节正文首行） */
function requirementOf(messages: LlmMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  const lines = (firstUser?.content ?? '').split('\n');
  const headerIndex = lines.findIndex((line) => line.trim() === '【需求】');
  const body = headerIndex >= 0 ? lines[headerIndex + 1] : lines[0];
  const raw = body ?? '';
  return raw.replace(/^(需求|任务|请)[:：]?\s*/, '').trim().slice(0, 60);
}

/** 从消息中提取 /api/... 路由（去重；无则用默认演示路由） */
function apiRoutesOf(messages: LlmMessage[]): string[] {
  const found = new Set<string>();
  for (const match of serializeMessages(messages).matchAll(/\/api\/[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)*/gi)) {
    found.add(match[0]);
  }
  return found.size > 0 ? [...found] : [];
}

/** 从最后一条用户消息提取目标文件路径（无则默认前端入口） */
function targetPathOf(messages: LlmMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const matches = [...(lastUser?.content ?? '').matchAll(/[\w./-]+\.(?:html?|js|mjs|json|md|sh|css|ts)/g)];
  const last = matches.at(-1)?.[0];
  return last?.replace(/^\.\//, '') ?? 'app/frontend/index.html';
}

/** 工程师产出：按目标路径选模板 */
function renderEngineerFile(path: string, messages: LlmMessage[]): string {
  const requirement = requirementOf(messages);
  const routes = apiRoutesOf(messages);
  if (path.endsWith('api.js') || path.endsWith('.js') || path.endsWith('.mjs')) {
    return renderApiJs(routes);
  }
  if (path.endsWith('.html') || path.endsWith('.htm')) {
    return renderIndexHtml(requirement, routes);
  }
  if (path.endsWith('.sh')) return renderStartSh();
  if (path.endsWith('filetree.json') || path.endsWith('file_tree.json')) {
    return `${JSON.stringify(JSON.parse(readSample('filetree.json')), null, 2)}\n`;
  }
  if (path.endsWith('.json')) return `${JSON.stringify({ requirement, path }, null, 2)}\n`;
  if (path.endsWith('.md')) {
    return [`# ${path}`, '', `- 需求：${requirement || '（未提供）'}`, '- 说明：mock 样例占位文档。', ''].join('\n');
  }
  return [`/* ${path} —— mock 兜底占位（需求：${requirement || '未提供'}） */`, ''].join('\n');
}

/**
 * 工程师场景响应（Task 13 契约：模型必须用 write_file 写目标文件）：
 * - 请求带 write_file 工具且历史尚无工具结果（首轮）→ 渲染文件全文，并同时以
 *   write_file 工具调用发出（content 携带全文，流式 delta 即打字机效果）
 * - 历史已有工具结果（write_file 已执行）→ 一句收尾结论，循环 2 步收敛
 * - 请求未带工具（裸 complete 调用/测试桩）→ 兼容旧行为：content 即文件全文
 */
function renderEngineer(req: LlmRequest): { content: string; toolCalls: ToolCall[] } {
  const target = targetPathOf(req.messages);
  const content = renderEngineerFile(target, req.messages);
  const hasWriteTool = req.tools?.some((tool) => tool.name === 'write_file') === true;
  if (!hasWriteTool) return { content, toolCalls: [] };
  if (req.messages.some((message) => message.role === 'tool')) {
    return { content: `已完成：${target} 已通过 write_file 写入，任务结束。`, toolCalls: [] };
  }
  return {
    content,
    toolCalls: [{ id: 'call_mock_write_file', name: 'write_file', args: { path: target, content } }],
  };
}

/** 专家角色固定报告模板 */
function renderExpertReport(role: Extract<MockScene, 'analyst' | 'seo' | 'ads'>, requirement: string): string {
  const heads: Record<typeof role, string> = {
    analyst: '数据分析报告',
    seo: 'SEO 优化报告',
    ads: '广告投放报告',
  };
  const bodies: Record<typeof role, string[]> = {
    analyst: ['- 核心指标建议：新增数/完成数/留存回访，先埋点再分析。', '- 洞察：完成率是待办应用的北极星指标。'],
    seo: ['- 关键词：待办清单 / todo list / 任务管理；标题与描述需包含主词。', '- 建议：语义化标签 + 移动端友好 + 首屏轻量。'],
    ads: ['- 投放策略：搜索广告承接「待办/效率」意图词，落地页直接可用。', '- 建议：以完成率与新增作为转化目标。'],
  };
  return [
    `# ${heads[role]}（mock 样例）`,
    '',
    `- 需求：${requirement || '（未提供）'}`,
    ...bodies[role],
    '',
    '> 本报告由 mock provider 生成：结构与字段即专家角色的产出契约。',
    '',
  ].join('\n');
}

/** 领导收尾汇报（含 MEMORY） */
function renderCloserReport(requirement: string): string {
  return [
    '# 领导汇报（mock 样例）',
    '',
    `- 需求：${requirement || '（未提供）'}`,
    '- 完成内容：PRD → 系统设计 → 全栈代码（前端单页 + 浏览器内后端）全链路产出。',
    '- 产出文件：docs/prd.md、docs/system_design.md、app/backend/api.js、app/frontend/index.html、start_app.sh',
    '- 关键决策：零依赖 + 内存态（浏览器沙箱内运行，禁 localStorage）。',
    '- 下游注意：预览需注入 fetch 拦截垫片；单文件修复走单文件重试。',
    '',
    '## MEMORY',
    '',
    '- 用户偏好：界面清爽、移动端可用；无账号体系诉求。',
    '- 项目约束：生成应用零依赖；数据不落盘，刷新即重置。',
    '',
  ].join('\n');
}

/** 领导分派：文本 + 3 个 assign_task 工具调用 */
function renderLeaderRoute(): { content: string; toolCalls: ToolCall[] } {
  const content = '收到需求。我把它拆成 3 个串行任务：PM 出 PRD → 架构师出设计与 file_tree → 工程师逐文件实现。';
  const toolCalls: ToolCall[] = LEADER_PLAN.map((step, index) => ({
    id: `call_mock_assign_${index + 1}`,
    name: 'assign_task',
    args: {
      task_key: step.taskKey,
      agent: step.agent,
      instruction: step.instruction,
      writes_paths: step.writesPaths,
      depends_on: step.dependsOn,
    },
  }));
  return { content, toolCalls };
}

/** 渲染一次 mock 调用的完整产出 */
function render(req: LlmRequest): { content: string; toolCalls: ToolCall[] } {
  const requirement = requirementOf(req.messages);
  const scene = detectScene(req);
  switch (scene) {
    case 'leader':
      return renderLeaderRoute();
    case 'closer':
      return { content: renderCloserReport(requirement), toolCalls: [] };
    case 'pm':
      return { content: readSample('prd.md'), toolCalls: [] };
    case 'architect':
      return { content: readSample('design.md'), toolCalls: [] };
    case 'engineer':
      return renderEngineer(req);
    case 'analyst':
    case 'seo':
    case 'ads':
      return { content: renderExpertReport(scene, requirement), toolCalls: [] };
    default: {
      const exhaustive: never = scene;
      return { content: `mock 未支持的场景：${String(exhaustive)}`, toolCalls: [] };
    }
  }
}

/** mock 用量：按字符公式给出「可信」的数值（视为真实 usage，estimated=0） */
function plausibleUsage(req: LlmRequest, content: string, toolCalls: ToolCall[]): { promptTokens: number; completionTokens: number } {
  return {
    promptTokens: estimateTokens(serializeMessages(req.messages)),
    completionTokens: estimateTokens(content + JSON.stringify(toolCalls)),
  };
}

/** 创建 mock provider（LLM_PROVIDER=mock） */
export function createMockProvider(): LlmProvider {
  return {
    name: 'mock',
    async complete(req: LlmRequest): Promise<LlmResult> {
      const { content, toolCalls } = render(req);
      return { content, toolCalls, usage: plausibleUsage(req, content, toolCalls) };
    },
    async stream(req: LlmRequest, onDelta: (text: string) => void): Promise<LlmResult> {
      const { content, toolCalls } = render(req);
      for (const chunk of chunkText(content)) {
        throwIfAborted(req.signal);
        onDelta(chunk);
        await sleep(mockDelayMs(), req.signal);
      }
      return { content, toolCalls, usage: plausibleUsage(req, content, toolCalls) };
    },
  };
}
