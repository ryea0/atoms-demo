/**
 * 上下文组装器测试（Task 9，DESIGN §4.1 组装顺序 / §4.4 三级裁剪 + 硬截）。
 * 存储直接用内存 SQLite（newTestStorage）——不 mock 仓库，顺带覆盖真实读路径与 project_id 过滤。
 */
import { describe, expect, it } from 'vitest';
import { assembleContext, MAX_CONTEXT_CHARS } from '@/lib/agents/context';
import { newTestStorage } from '@/lib/db/test-util';
import type { StorageProvider } from '@/lib/db/provider/types';

/* ------------------------------------------------------------------ */
/* 夹具                                                                 */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = '你是工程师，只输出单个目标文件的完整代码，禁止省略。';

/** 依赖声明树（与 src/lib/agents/roles/samples/filetree.json 同构的小样例） */
const FILE_TREE = [
  { path: 'docs/prd.md', desc: '产品需求文档', depends: [] },
  { path: 'docs/system_design.md', desc: '系统设计说明', depends: ['docs/prd.md'] },
  { path: 'app/backend/api.js', desc: '内存态后端 handle(method,path,body)', depends: ['docs/system_design.md'] },
  { path: 'app/frontend/index.html', desc: '待办单页', depends: ['app/backend/api.js'] },
];

const PRD_MD = '# PRD\nPRD-ONLY-MARKER 待办事项增删改查。';
const API_JS = 'export function handle(method, path, body) { return { ok: true }; }';
const INDEX_HTML = '<!doctype html><html><body><ul id="todos"></ul></body></html>';
const PREFERENCES_MD = '# 项目偏好\nPREF-MARKER 视觉风格走暗色顶部栏。';
const MEMORY_MD = '# 长期记忆\nMEMORY-MARKER 用户偏好中文回复。';
const NON_DEP_MD = 'NON-DEP-MARKER 与本任务无关的非依赖文件正文。';

interface SeedOptions {
  requirement?: string;
  /** 缺省=标准依赖声明树；string=原样作为文件内容（坏 JSON 用例）；null=不建该文件 */
  fileTree?: string | typeof FILE_TREE | null;
  fileTreePath?: string;
  preferencesMd?: string;
  memoryMd?: string;
  /** undefined=不写偏好行；null=写一个空对象（验证空偏好同样跳过） */
  sessionPref?: Record<string, unknown> | null;
  apiJs?: string;
  systemDesignMd?: string;
}

/** 建一个带标准文件集的项目，返回 projectId/sessionId */
async function seedProject(storage: StorageProvider, options: SeedOptions = {}) {
  const sessionId = 'session-a';
  const project = await storage.createProject({
    sessionId,
    title: '待办应用',
    requirement: options.requirement ?? '做一个待办事项应用，支持增删改查',
    mode: 'full',
  });
  const write = (path: string, content: string): Promise<{ fileId: number; version: number }> =>
    storage.upsertFile({ projectId: project.id, path, content, editor: 'architect' });

  const treePath = options.fileTreePath ?? 'docs/file_tree.json';
  if (options.fileTree !== null) {
    const tree = options.fileTree === undefined ? FILE_TREE : options.fileTree;
    const content = typeof tree === 'string' ? tree : JSON.stringify(tree, null, 2);
    await write(treePath, content);
  }
  await write('docs/prd.md', PRD_MD);
  await write(
    'docs/system_design.md',
    options.systemDesignMd ?? '# 系统设计\n## 架构\n浏览器内全栈。\n## 待办接口\nGET /api/todos。',
  );
  await write('app/backend/api.js', options.apiJs ?? API_JS);
  await write('app/frontend/index.html', INDEX_HTML);
  await write('app/other/report.md', NON_DEP_MD);
  if (options.preferencesMd !== undefined) await write('.atoms/PREFERENCES.md', options.preferencesMd);
  if (options.memoryMd !== undefined) await write('.atoms/reports/MEMORY.md', options.memoryMd);
  if (options.sessionPref !== undefined) {
    await storage.setPreference('session', sessionId, options.sessionPref ?? {});
  }
  return { projectId: project.id, sessionId };
}

/** 工程师单文件任务的典型入参（可局部覆盖） */
function baseInput(
  storage: StorageProvider,
  projectId: number,
  overrides: Partial<Parameters<typeof assembleContext>[0]> = {},
): Parameters<typeof assembleContext>[0] {
  return {
    storage,
    projectId,
    role: 'engineer',
    systemPrompt: SYSTEM_PROMPT,
    task: '实现待办列表页面 app/frontend/index.html，调用 TODO API',
    upstreamSummaries: ['架构师：系统设计已完成，接口为 /api/todos'],
    interventions: ['干预：按钮文案统一用中文'],
    extraFiles: ['app/frontend/index.html'],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* 组装顺序（DESIGN §4.1）                                              */
/* ------------------------------------------------------------------ */

describe('assembleContext 组装顺序', () => {
  it('system=提示词+偏好+PREFERENCES+MEMORY；user=需求+摘要+干预+file_tree+依赖正文+任务，且按此顺序', async () => {
    const storage = newTestStorage();
    const { projectId, sessionId } = await seedProject(storage, {
      preferencesMd: PREFERENCES_MD,
      memoryMd: MEMORY_MD,
      sessionPref: { nickname: '阿汤', editingEnabled: true },
    });

    const { system, user } = await assembleContext(baseInput(storage, projectId, { sessionId }));

    // system：角色提示词在前，随后依次是 session 偏好 / 项目偏好 / 长期记忆
    expect(system).toContain(SYSTEM_PROMPT);
    expect(system).toContain('【个人偏好】');
    expect(system).toContain('"nickname"');
    expect(system).toContain('【项目偏好');
    expect(system).toContain('PREF-MARKER');
    expect(system).toContain('【长期记忆');
    expect(system).toContain('MEMORY-MARKER');
    expect(system.indexOf(SYSTEM_PROMPT)).toBeLessThan(system.indexOf('【个人偏好】'));
    expect(system.indexOf('【个人偏好】')).toBeLessThan(system.indexOf('【项目偏好'));
    expect(system.indexOf('【项目偏好')).toBeLessThan(system.indexOf('【长期记忆'));

    // user：需求 → 交接摘要 → 干预 → file_tree → 依赖文件正文 → 任务
    expect(user).toContain('【需求】');
    expect(user).toContain('做一个待办事项应用，支持增删改查');
    expect(user).toContain('【上游交接摘要】');
    expect(user).toContain('- 架构师：系统设计已完成，接口为 /api/todos');
    expect(user).toContain('【干预指令】');
    expect(user).toContain('- 干预：按钮文案统一用中文');
    expect(user).toContain('【项目文件树');
    expect(user).toContain('"docs/prd.md"');
    expect(user).toContain('===== app/backend/api.js =====');
    expect(user).toContain('===== app/frontend/index.html =====');
    expect(user).toContain(API_JS);
    expect(user).toContain(INDEX_HTML);
    expect(user).toContain('【任务】');
    expect(user).toContain('实现待办列表页面');
    expect(user.indexOf('【需求】')).toBeLessThan(user.indexOf('【上游交接摘要】'));
    expect(user.indexOf('【上游交接摘要】')).toBeLessThan(user.indexOf('【干预指令】'));
    expect(user.indexOf('【干预指令】')).toBeLessThan(user.indexOf('【项目文件树'));
    expect(user.indexOf('【项目文件树')).toBeLessThan(user.indexOf('===== app/backend/api.js ====='));
    expect(user.indexOf('===== app/frontend/index.html =====')).toBeLessThan(user.indexOf('【任务】'));

    // 非依赖文件正文不注入（PRD 不是 index.html 的直接依赖）
    expect(user).not.toContain('PRD-ONLY-MARKER');
    expect(user).not.toContain(NON_DEP_MD);
  });

  it('未传 sessionId / 偏好不存在 / 偏好为空对象时，均不出现个人偏好段', async () => {
    // 有偏好但未传 sessionId → 不注入
    const withPref = newTestStorage();
    const a = await seedProject(withPref, { sessionPref: { nickname: '阿汤' } });
    expect((await assembleContext(baseInput(withPref, a.projectId))).system).not.toContain('【个人偏好】');

    // 传了 sessionId 但库里没有偏好行
    const noPref = newTestStorage();
    const b = await seedProject(noPref);
    const noPrefResult = await assembleContext(baseInput(noPref, b.projectId, { sessionId: b.sessionId }));
    expect(noPrefResult.system).not.toContain('【个人偏好】');

    // 偏好行是空对象（等价于没配）
    const emptyPref = newTestStorage();
    const c = await seedProject(emptyPref, { sessionPref: null });
    const emptyResult = await assembleContext(baseInput(emptyPref, c.projectId, { sessionId: c.sessionId }));
    expect(emptyResult.system).not.toContain('【个人偏好】');
  });

  it('项目不存在 → 抛中文错误，不静默', async () => {
    const storage = newTestStorage();
    await expect(assembleContext(baseInput(storage, 424242))).rejects.toThrow('项目不存在');
  });
});

/* ------------------------------------------------------------------ */
/* 依赖解析（fileTree depends ∪ extraFiles）                             */
/* ------------------------------------------------------------------ */

describe('assembleContext 依赖解析', () => {
  it('树存在：按目标 extraFiles 的 depends 并集注入（api.js 目标连带 system_design），非依赖不注入', async () => {
    const storage = newTestStorage();
    const { projectId } = await seedProject(storage);
    const { user } = await assembleContext(
      baseInput(storage, projectId, {
        extraFiles: ['app/backend/api.js'],
        task: '实现后端 API，支持待办增删改查',
      }),
    );
    expect(user).toContain('===== app/backend/api.js =====');
    expect(user).toContain('===== docs/system_design.md =====');
    expect(user).not.toContain('===== app/frontend/index.html =====');
    expect(user).not.toContain('PRD-ONLY-MARKER');
  });

  it('未传 fileTreePath 时默认读 docs/file_tree.json（树段落 + depends 解析都在）', async () => {
    const storage = newTestStorage();
    const { projectId } = await seedProject(storage);
    const { user } = await assembleContext(baseInput(storage, projectId));
    expect(user).toContain('【项目文件树（docs/file_tree.json）】');
    expect(user).toContain('===== app/backend/api.js =====');
  });

  it('fileTree 缺失 → 不抛错、无树段落，extraFiles 兜底注入', async () => {
    const storage = newTestStorage();
    const { projectId } = await seedProject(storage, { fileTree: null });
    const { user } = await assembleContext(baseInput(storage, projectId));
    expect(user).not.toContain('【项目文件树');
    expect(user).toContain('===== app/frontend/index.html =====');
    expect(user).toContain(INDEX_HTML);
  });

  it('fileTree 坏 JSON / 结构不符 → 不抛错，同样走 extraFiles 兜底', async () => {
    const storage = newTestStorage();
    const broken = await seedProject(storage, { fileTree: '{ 这不是 JSON' });
    const brokenResult = await assembleContext(baseInput(storage, broken.projectId));
    expect(brokenResult.user).not.toContain('【项目文件树');
    expect(brokenResult.user).toContain('===== app/frontend/index.html =====');

    const wrongShape = await seedProject(storage, { fileTree: '[{"path":"a.js","depends":[]}]' }); // 缺 desc，结构不符
    const shapeResult = await assembleContext(baseInput(storage, wrongShape.projectId));
    expect(shapeResult.user).not.toContain('【项目文件树');
    expect(shapeResult.user).toContain('===== app/frontend/index.html =====');
  });

  it('声明的依赖文件不存在于虚拟 FS → 静默跳过该文件', async () => {
    const storage = newTestStorage();
    const { projectId } = await seedProject(storage, {
      fileTree: [{ path: 'app/frontend/index.html', desc: '待办单页', depends: ['docs/ghost.md'] }],
    });
    const { user } = await assembleContext(baseInput(storage, projectId));
    expect(user).not.toContain('===== docs/ghost.md =====');
    expect(user).toContain('===== app/frontend/index.html =====');
  });
});

/* ------------------------------------------------------------------ */
/* 预算裁剪（DESIGN §4.4）                                              */
/* ------------------------------------------------------------------ */

describe('assembleContext 预算裁剪', () => {
  it('① 超长依赖文件 → 总量达标、file_tree 保留、非依赖正文不出现、任务保留、带裁剪提示', async () => {
    const storage = newTestStorage();
    const { projectId } = await seedProject(storage, { apiJs: `const data = "${'x'.repeat(40000)}";` });
    const { system, user } = await assembleContext(baseInput(storage, projectId));

    expect(system.length + user.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(user).toContain('===== app/frontend/index.html ====='); // 目标文件被保护
    expect(user).toContain('"docs/prd.md"'); // file_tree 全文保留
    expect(user).not.toContain(NON_DEP_MD); // 非依赖文件正文不出现
    expect(user).toContain('实现待办列表页面'); // 任务指令不被裁掉
    expect(user).toContain('（上下文已裁剪）'); // 硬截提示
  });

  it('② 超长中文依赖文件同样触发阈值，最终总长 ≤ 24000', async () => {
    const storage = newTestStorage();
    const { projectId } = await seedProject(storage, { apiJs: '待'.repeat(30000) });
    const { system, user } = await assembleContext(baseInput(storage, projectId));

    expect(system.length + user.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(user).toContain('"docs/prd.md"');
    expect(user).toContain('（上下文已裁剪）');
  });

  it('③ 超长 MEMORY → 详情保留首 2000 字符即达标，无需硬截', async () => {
    const storage = newTestStorage();
    const memoryMd = `${'记'.repeat(1900)}MEMORY-KEEP-MARKER${'记'.repeat(30000)}MEMORY-TAIL-MARKER`;
    const { projectId } = await seedProject(storage, { memoryMd });
    const { system, user } = await assembleContext(baseInput(storage, projectId));

    expect(system.length + user.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(system).toContain('MEMORY-KEEP-MARKER'); // 首 2000 字符仍在
    expect(system).not.toContain('MEMORY-TAIL-MARKER'); // 详情已裁
    expect(system).toContain('长期记忆已按预算截断');
    expect(user).not.toContain('（上下文已裁剪）'); // 第 ② 级即达标，不走硬截
  });

  it('④ system_design 超长 → 仅保留含任务关键词的段落', async () => {
    const storage = newTestStorage();
    const systemDesignMd = [
      '# 系统设计',
      `## 待办模块接口\n${'待'.repeat(12000)}\nKEEP-MARKER`,
      `## 广告投放系统\n${'广'.repeat(12000)}\nDROP-AD-MARKER`,
      `## 数据存储设计\n${'存'.repeat(12000)}\nDROP-DB-MARKER`,
    ].join('\n');
    const { projectId } = await seedProject(storage, { systemDesignMd });
    const { system, user } = await assembleContext(
      baseInput(storage, projectId, {
        extraFiles: ['app/backend/api.js'],
        task: '实现后端 API，支持待办增删改查',
      }),
    );

    expect(system.length + user.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(user).toContain('KEEP-MARKER'); // 命中关键词的段落保留
    expect(user).not.toContain('DROP-AD-MARKER'); // 无关段落被裁
    expect(user).not.toContain('DROP-DB-MARKER');
    expect(user).toContain('已按任务相关性省略'); // 被裁段落留标题索引
    expect(user).not.toContain('（上下文已裁剪）'); // 第 ③ 级即达标，不走硬截
  });

  it('⑤ 头部（需求）本身超预算 → 全部梯级后仍整体硬截 user 尾部并加提示', async () => {
    const storage = newTestStorage();
    const { projectId } = await seedProject(storage, { requirement: `需${'求'.repeat(30000)}` });
    const { system, user } = await assembleContext(baseInput(storage, projectId));

    expect(system.length + user.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(user).toContain('【需求】');
    expect(user).toContain('（上下文已裁剪）');
  });

  it('预算常量为 24000（与 DESIGN §4.1 一致，防止被顺手改掉）', () => {
    expect(MAX_CONTEXT_CHARS).toBe(24000);
  });
});
