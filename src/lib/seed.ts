/**
 * 预置演示项目（Task 25 / DESIGN §P3「seed 预置项目」）：`npm run seed` 的实现体。
 *
 * 作用：演示保底——首次启动（projects 表为空）落 2 个可直接打开、可直接预览的完整项目，
 * 省去「必须先跑一轮生成才能看到工作台/预览」的冷启动成本。
 *
 * 产物来源：**直接用 samples 渲染文件树落库**（与 mock provider / 保底模板同一套黄金样例），
 * 不调 LLM、不依赖 env；lastEditor/producedBy = 'seed'（文件树绿角标「预置文件」）。
 *
 * 幂等：projects 表非空（无论哪个会话）即整表跳过——seed 只负责「从零到能演示」，
 * 绝不在已有数据的库里追加演示行。服务端专用，不得进入客户端 bundle。
 */
import { renderApiJs, renderIndexHtml, renderStartSh } from '@/lib/agents/roles/samples/app-skeleton';
import { readSample } from '@/lib/llm/mock';
import type { Project, StorageProvider } from '@/lib/db/provider/types';

/** seed 项目归属的会话（不与真实匿名会话冲突；卡片墙按 session 过滤，不会混进用户列表） */
export const SEED_SESSION_ID = 'seed';

/** seed 项目的 docs 交付物（与架构师产物同一组：PRD / 系统设计 / 机读树） */
const DOC_FILES: ReadonlyArray<{ path: string; sample: string }> = [
  { path: 'docs/prd.md', sample: 'prd.md' },
  { path: 'docs/system_design.md', sample: 'design.md' },
  { path: 'docs/file_tree.json', sample: 'filetree.json' },
];

/** 单个演示项目的配方：需求一句话 + 后端资源路由（同时决定前端模板选型） */
interface DemoRecipe {
  title: string;
  requirement: string;
  routes: readonly string[];
}

/** 两个演示项目：待办清单（CRUD 模板）+ 数据看板（dashboard 模板）——骨架品类不重样 */
const DEMO_RECIPES: readonly DemoRecipe[] = [
  {
    title: '待办清单应用',
    requirement: '做一个待办清单应用：支持新增、勾选完成、删除与筛选，数据保存在内存里',
    routes: ['/api/todos'],
  },
  {
    title: '团队数据看板',
    requirement: '做一个团队数据看板：展示新增、活跃、留存等核心指标的聚合图表',
    routes: ['/api/stats'],
  },
];

/** 渲染单个演示项目的全部文件（docs 交付物 + app 全栈骨架 + 启动说明） */
function renderProjectFiles(recipe: DemoRecipe): { path: string; content: string }[] {
  const routes = [...recipe.routes];
  return [
    ...DOC_FILES.map((doc) => ({ path: doc.path, content: readSample(doc.sample) })),
    { path: 'app/backend/api.js', content: renderApiJs(routes) },
    { path: 'app/frontend/index.html', content: renderIndexHtml(recipe.requirement, routes) },
    {
      path: 'app/README.md',
      content: [
        `# ${recipe.title}`,
        '',
        `- 需求：${recipe.requirement}`,
        `- 接口：${routes.join('、')}`,
        '- 预览：工作台右上角「预览」即可在浏览器内运行（后端为同构 handle 模块，零依赖、内存态）。',
        '',
        '> 本项目为预置演示（seed）：内容直接来自平台黄金样例，可直接预览或作为生成基线。',
        '',
      ].join('\n'),
    },
    { path: 'app/start_app.sh', content: renderStartSh() },
  ];
}

export interface SeedResult {
  /** 本次新插入的项目（幂等跳过时为空数组） */
  created: Project[];
  /** true = projects 表非空，按守卫口径整体跳过 */
  skipped: boolean;
}

/**
 * 落库预置演示项目。projects 表为空才执行（幂等）；写路径统一走 upsertFile（与 agent/
 * 人工同一入口，rules 05/11），项目行由 createProject 生成（status 默认 draft，随后置 done）。
 */
export async function seedDemoProjects(storage: StorageProvider): Promise<SeedResult> {
  // 守卫口径 = 整表非空即跳过（brief「projects 表空时插入」+ 重复执行不重复插）
  if ((await storage.countProjects()) > 0) return { created: [], skipped: true };

  const created: Project[] = [];
  for (const recipe of DEMO_RECIPES) {
    const project = await storage.createProject({
      sessionId: SEED_SESSION_ID,
      title: recipe.title,
      requirement: recipe.requirement,
      mode: 'fast',
    });
    for (const file of renderProjectFiles(recipe)) {
      await storage.upsertFile({ projectId: project.id, path: file.path, content: file.content, editor: 'seed' });
    }
    // 演示项目直接是「可打开、可预览」的完成态（重读拿更新后的行，避免返回 stale 状态）
    await storage.updateProjectStatus(project.id, 'done');
    const done = await storage.getProject(project.id);
    if (done !== null) created.push(done);
  }
  return { created, skipped: false };
}
