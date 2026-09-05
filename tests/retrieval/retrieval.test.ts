/**
 * 检索扩展点测试（Task 28，DESIGN §12 Provider+Registry）。
 * 覆盖三层：
 * 1. registry 路由——RETRIEVAL_PROVIDER 缺省/fts5/非法值/无 FTS5 能力时的回退；
 * 2. grep 默认等价——工具输出与 Task 28 之前的原算法逐字节一致（行为不变是验收标准）；
 * 3. fts5 可选实现——虚表触发器同步（写/覆盖/删）、trigram 子串、bm25 确定性排序、跨项目隔离。
 * 落库验证走 newTestStorage（内存库，无磁盘副作用）。
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getRetriever } from '@/lib/retrieval/registry';
import type { RankedHit } from '@/lib/retrieval/types';
import { newTestStorage, newTestStorageWithDb } from '@/lib/db/test-util';
import { files } from '@/lib/db/provider/sqlite/schema';
import { fsTools, type Tool, type ToolContext } from '@/lib/agents/tools';
import type { FileRow, StorageProvider } from '@/lib/db/provider/types';

/** 测试用 env 字面量（与 tests/llm/resolve.test.ts 同理：Next 的 ProcessEnv 要求显式 NODE_ENV） */
function testEnv(partial: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...partial };
}

/** fts5 路由 env（registry 每次调用重读 env，传参注入即可测路由） */
const FTS5_ENV = testEnv({ RETRIEVAL_PROVIDER: 'fts5' });

/** 按名字取工具（缺的就是契约破坏，直接抛错让测试红） */
function toolByName(name: string): Tool {
  const tool = fsTools.find((t) => t.name === name);
  if (!tool) throw new Error(`fsTools 缺少工具 ${name}`);
  return tool;
}

/** 独立内存库 + 空项目 */
async function newCtx(role: ToolContext['role'] = 'engineer'): Promise<{
  ctx: ToolContext;
  storage: StorageProvider;
  projectId: number;
}> {
  const storage = newTestStorage();
  const project = await storage.createProject({ sessionId: 's', title: 't', requirement: 'r', mode: 'fast' });
  return { storage, projectId: project.id, ctx: { storage, projectId: project.id, role } };
}

/* ------------------------------------------------------------------ */
/* 1. registry：RETRIEVAL_PROVIDER 路由                                 */
/* ------------------------------------------------------------------ */

describe('getRetriever：RETRIEVAL_PROVIDER 路由', () => {
  it('缺省（env 无值）走 grep（默认实现）', () => {
    const storage = newTestStorage();
    expect(getRetriever(storage, testEnv()).name).toBe('grep');
  });

  it('RETRIEVAL_PROVIDER=fts5 且存储具备 sqlite 能力 → FtsRetriever', () => {
    const storage = newTestStorage();
    expect(getRetriever(storage, FTS5_ENV).name).toBe('fts5');
  });

  it('取值容忍大小写与首尾空白', () => {
    const storage = newTestStorage();
    expect(getRetriever(storage, testEnv({ RETRIEVAL_PROVIDER: '  FTS5 ' })).name).toBe('fts5');
    expect(getRetriever(storage, testEnv({ RETRIEVAL_PROVIDER: 'Grep' })).name).toBe('grep');
  });

  it('非法值回退默认 grep（不抛错）', () => {
    const storage = newTestStorage();
    expect(getRetriever(storage, testEnv({ RETRIEVAL_PROVIDER: 'nope' })).name).toBe('grep');
    expect(getRetriever(storage, testEnv({ RETRIEVAL_PROVIDER: '' })).name).toBe('grep');
  });

  it('fts5 请求但存储无 sqlite 能力 → 回退 grep 且检索仍可用', async () => {
    // 合法实现桩（无需伪造 searchFtsFiles / 双重断言）：只实现 grep 路径需要的 readAllFiles，
    // 即「无全文索引能力」的 StorageProvider（未来的 PostgresStorage 同形）——能力可选项缺省即回退
    const stub: StorageProvider = {
      readAllFiles: async (projectId: number): Promise<FileRow[]> => {
        // 桩同断言入参：检索层必须把 projectId 透传给存储（跨项目过滤由实现负责）
        expect(projectId).toBe(1);
        return [
          {
            id: 1, projectId: 1, path: 'a.ts', content: 'needle here\n', producedBy: 'seed',
            lastEditor: 'seed', editingBy: null, editingExpiresAt: null, version: 1, createdAt: 0, updatedAt: 0,
          },
        ];
      },
    } as StorageProvider;
    const retriever = getRetriever(stub, FTS5_ENV);
    expect(retriever.name).toBe('grep');
    const hits = await retriever.search('needle', { projectId: 1 });
    expect(hits).toEqual([{ path: 'a.ts', line: 1, text: 'needle here', score: 0 }]);
  });

  it('searchFtsFiles 为可选项：显式置 undefined 的实现同样回退 grep（契约即文档）', () => {
    const storage = newTestStorage();
    const withoutFts: StorageProvider = { ...storage, searchFtsFiles: undefined };
    expect(getRetriever(withoutFts, FTS5_ENV).name).toBe('grep');
  });
});

/* ------------------------------------------------------------------ */
/* 2. grep 默认等价：与 Task 28 之前的原算法逐字节一致                    */
/* ------------------------------------------------------------------ */

/** Task 28 之前 fs-tools grep 的原算法（原样照抄，仅此测试使用），锁定默认输出逐字节等价 */
function legacyGrep(filesByPathAsc: { path: string; content: string }[], pattern: string): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    return `非法正则 "${pattern}"：${error instanceof Error ? error.message : String(error)}`;
  }
  const hits: string[] = [];
  let total = 0;
  for (const file of filesByPathAsc) {
    const lines = file.content.replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (!regex.test(line)) continue;
      total += 1;
      if (hits.length < 50) {
        const shown = line.length > 240 ? `${line.slice(0, 240)}……[本行超长已截断]` : line;
        hits.push(`${file.path}:${i + 1}: ${shown}`);
      }
    }
  }
  if (total === 0) return `未命中：项目内没有匹配 /${pattern}/ 的行`;
  if (total > hits.length) hits.push(`……[共 ${total} 处命中，仅显示前 50 行，可收窄 pattern]……`);
  return hits.join('\n');
}

/** 夹具：覆盖 命中/正则/CRLF/超长行/超 50 命中 各分支；path 升序即 readAllFiles 的返回顺序 */
const FIXTURES = [
  { path: 'crlf.ts', content: 'const a = 1;\r\n// TODO fix\r\n' },
  { path: 'many.txt', content: Array.from({ length: 60 }, (_v, i) => `hit-${i + 1}`).join('\n') },
  { path: 'src/a.ts', content: 'const a = 1;\n// TODO fix me\n' },
  { path: 'src/b.ts', content: 'TODO again\n' },
  { path: 'wide.txt', content: `needle ${'x'.repeat(500)}\n` },
];

async function writeFixtures(ctx: ToolContext): Promise<void> {
  for (const file of FIXTURES) {
    const result = await toolByName('write_file').execute({ path: file.path, content: file.content }, ctx);
    if (!result.ok) throw new Error(`夹具写入失败：${result.output}`);
  }
}

describe('grep 默认等价（经 getRetriever 路由后行为不变）', () => {
  const PATTERNS = ['TODO', 'const \\w+ = \\d+', 'needle', 'hit-', 'zzz-not-there', '(unclosed'];

  it.each(PATTERNS)('pattern=%j 工具输出与原算法逐字节一致', async (pattern) => {
    const { ctx } = await newCtx();
    await writeFixtures(ctx);
    const result = await toolByName('grep').execute({ pattern }, ctx);
    expect(result.output).toBe(legacyGrep(FIXTURES, pattern));
  });

  it('无命中仍给提示、非法正则仍 ok:false', async () => {
    const { ctx } = await newCtx();
    await writeFixtures(ctx);
    const miss = await toolByName('grep').execute({ pattern: 'zzz-not-there' }, ctx);
    expect(miss.ok).toBe(true);
    expect(miss.output).toBe('未命中：项目内没有匹配 /zzz-not-there/ 的行');

    const bad = await toolByName('grep').execute({ pattern: '(unclosed' }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain('非法正则');
  });

  it('grep 实现的命中顺序 = 路径升序 × 行号升序，且不评分（score=0）', async () => {
    const { storage, projectId } = await newCtx();
    const ctx: ToolContext = { storage, projectId, role: 'engineer' };
    await writeFixtures(ctx);
    const hits = await getRetriever(storage, testEnv()).search('TODO', { projectId });
    expect(hits).toEqual([
      { path: 'crlf.ts', line: 2, text: '// TODO fix', score: 0 },
      { path: 'src/a.ts', line: 2, text: '// TODO fix me', score: 0 },
      { path: 'src/b.ts', line: 1, text: 'TODO again', score: 0 },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* 3. fts5：虚表触发器同步 + trigram + bm25 + 隔离                       */
/* ------------------------------------------------------------------ */

describe('FtsRetriever：写路径经触发器同步进索引', () => {
  it('写文件立即可搜（trigram 子串命中 api.js），行号与内容正确', async () => {
    const { storage, projectId } = await newCtx();
    await storage.upsertFile({ projectId, path: 'src/api.js', content: 'export const client = 1;\n// api.js helper\n', editor: 'seed' });
    const hits = await getRetriever(storage, FTS5_ENV).search('api.js', { projectId });
    expect(hits).toEqual([
      { path: 'src/api.js', line: 2, text: '// api.js helper', score: expect.any(Number) },
    ]);
  });

  it('覆盖写：旧内容搜不到、新内容搜到（version+1 也同步）', async () => {
    const { storage, projectId } = await newCtx();
    const { version } = await storage.upsertFile({ projectId, path: 'notes.md', content: 'old content about widgets\n', editor: 'seed' });
    expect(version).toBe(1);
    await storage.upsertFile({ projectId, path: 'notes.md', content: 'brand new gadgets\n', editor: 'human' });
    const retriever = getRetriever(storage, FTS5_ENV);
    expect(await retriever.search('widgets', { projectId })).toEqual([]);
    const hits = await retriever.search('gadgets', { projectId });
    expect(hits.map((h) => [h.path, h.line, h.text])).toEqual([['notes.md', 1, 'brand new gadgets']]);
  });

  it('删除文件：索引同步删除，搜不到', async () => {
    const { storage, db } = newTestStorageWithDb();
    const project = await storage.createProject({ sessionId: 's', title: 't', requirement: 'r', mode: 'fast' });
    const { fileId } = await storage.upsertFile({ projectId: project.id, path: 'tmp.md', content: 'ephemeral needle here\n', editor: 'seed' });
    expect((await getRetriever(storage, FTS5_ENV).search('ephemeral', { projectId: project.id })).length).toBe(1);

    await db.delete(files).where(eq(files.id, fileId));
    expect(await getRetriever(storage, FTS5_ENV).search('ephemeral', { projectId: project.id })).toEqual([]);
  });

  it('删除项目（级联删 files）后索引同步清空', async () => {
    const { storage: storage2 } = newTestStorageWithDb();
    const project = await storage2.createProject({ sessionId: 's2', title: 't', requirement: 'r', mode: 'fast' });
    await storage2.upsertFile({ projectId: project.id, path: 'gone.md', content: 'vanishing words\n', editor: 'seed' });
    expect((await getRetriever(storage2, FTS5_ENV).search('vanishing', { projectId: project.id })).length).toBe(1);
    await storage2.deleteProject(project.id);
    expect(await getRetriever(storage2, FTS5_ENV).search('vanishing', { projectId: project.id })).toEqual([]);
  });
});

describe('FtsRetriever：trigram 语义（与 grep 的有意差异）', () => {
  it('trigram 最小粒度：<3 字符查询无命中（不报错）', async () => {
    const { storage, projectId } = await newCtx();
    await storage.upsertFile({ projectId, path: 'a.md', content: 'abcdef word\n', editor: 'seed' });
    const retriever = getRetriever(storage, FTS5_ENV);
    expect(await retriever.search('ab', { projectId })).toEqual([]);
    expect(await retriever.search('abc', { projectId }).then((hits) => hits.length)).toBe(1);
  });

  it('ASCII 大小写不敏感（trigram 折叠；grep 正则默认区分大小写）', async () => {
    const { storage, projectId } = await newCtx();
    await storage.upsertFile({ projectId, path: 'a.md', content: 'keep CALM and carry on\n', editor: 'seed' });
    const hits = await getRetriever(storage, FTS5_ENV).search('calm', { projectId });
    expect(hits.map((h) => h.text)).toEqual(['keep CALM and carry on']);
  });

  it('查询按字面短语解释，不做正则（a|b 只命中字面 a|b）', async () => {
    const { storage, projectId } = await newCtx();
    await storage.upsertFile({ projectId, path: 'alt.md', content: 'value is a|b here\nplain banana\n', editor: 'seed' });
    const hits = await getRetriever(storage, FTS5_ENV).search('a|b', { projectId });
    expect(hits.map((h) => [h.line, h.text])).toEqual([[1, 'value is a|b here']]);
  });
});

describe('FtsRetriever：bm25 排序与 limit', () => {
  async function rankedFixture(): Promise<{ storage: StorageProvider; projectId: number }> {
    const { storage } = await newCtx();
    const project = (await storage.listProjects('s'))[0];
    if (!project) throw new Error('夹具项目缺失');
    await storage.upsertFile({ projectId: project.id, path: 'docs/b.md', content: 'see api.js once\n', editor: 'seed' });
    await storage.upsertFile({ projectId: project.id, path: 'docs/a.md', content: 'api.js api.js api.js api.js api.js\n', editor: 'seed' });
    return { storage, projectId: project.id };
  }

  it('多次命中者排前，且重复调用顺序确定', async () => {
    const { storage, projectId } = await rankedFixture();
    const retriever = getRetriever(storage, FTS5_ENV);
    const first = await retriever.search('api.js', { projectId });
    expect(first.map((h) => h.path)).toEqual(['docs/a.md', 'docs/b.md']);
    expect(first.map((h) => h.line)).toEqual([1, 1]);
    for (let i = 0; i < 3; i += 1) {
      const again = await retriever.search('api.js', { projectId });
      expect(again.map((h) => h.path)).toEqual(['docs/a.md', 'docs/b.md']);
    }
    // score 越大越相关，且命中同词的两个文件 score 不同（可比较）
    expect(first[0]?.score).toBeGreaterThan(first[1]?.score ?? 0);
  });

  it('limit 按相关性截断（只取最相关文件的命中行）', async () => {
    const { storage, projectId } = await rankedFixture();
    const hits = await getRetriever(storage, FTS5_ENV).search('api.js', { projectId, limit: 1 });
    expect(hits.map((h) => h.path)).toEqual(['docs/a.md']);
  });

  it('多行命中按行号升序展开', async () => {
    const { storage, projectId } = await newCtx();
    await storage.upsertFile({ projectId, path: 'm.md', content: 'first zebra\nmiddle\nzebra again\n', editor: 'seed' });
    const hits = await getRetriever(storage, FTS5_ENV).search('zebra', { projectId });
    expect(hits.map((h) => h.line)).toEqual([1, 3]);
  });
});

describe('FtsRetriever：项目隔离（规则 9）', () => {
  it('B 项目搜不到 A 项目写入的内容', async () => {
    const storage = newTestStorage();
    const a = await storage.createProject({ sessionId: 's', title: 'A', requirement: 'r', mode: 'fast' });
    const b = await storage.createProject({ sessionId: 's', title: 'B', requirement: 'r', mode: 'fast' });
    await storage.upsertFile({ projectId: a.id, path: 'secret.md', content: 'classified-token here\n', editor: 'seed' });
    const retriever = getRetriever(storage, FTS5_ENV);
    expect((await retriever.search('classified-token', { projectId: a.id })).map((h) => h.path)).toEqual(['secret.md']);
    expect(await retriever.search('classified-token', { projectId: b.id })).toEqual([]);
  });
});

describe('grep 工具经 getRetriever 端到端路由（env 晚绑定）', () => {
  it('RETRIEVAL_PROVIDER=fts5 时工具输出切换为 fts5 语义', async () => {
    const { ctx } = await newCtx();
    await writeFixtures(ctx);
    process.env.RETRIEVAL_PROVIDER = 'fts5';
    try {
      // 大写查询：grep 正则区分大小写不会命中 src/b.ts 的 'TODO again'，fts5 大小写折叠会命中
      const result = await toolByName('grep').execute({ pattern: 'todo again' }, ctx);
      expect(result.ok).toBe(true);
      expect(result.output).toContain('src/b.ts:1: TODO again');
    } finally {
      delete process.env.RETRIEVAL_PROVIDER;
    }
    // env 撤销后回到 grep 语义：大写 pattern 不命中（区分大小写）
    const backToGrep = await toolByName('grep').execute({ pattern: 'todo again' }, ctx);
    expect(backToGrep.output).toBe('未命中：项目内没有匹配 /todo again/ 的行');
  });

  it('fts5 模式下超长命中行仍按工具层口径截断', async () => {
    const { ctx } = await newCtx();
    await writeFixtures(ctx);
    process.env.RETRIEVAL_PROVIDER = 'fts5';
    try {
      const result = await toolByName('grep').execute({ pattern: 'needle' }, ctx);
      expect(result.ok).toBe(true);
      expect(result.output).toContain('wide.txt:1:');
      expect(result.output).toContain('本行超长已截断');
    } finally {
      delete process.env.RETRIEVAL_PROVIDER;
    }
  });
});

/** 类型冒烟：RankedHit 形状固定（path/line/text/score），防字段改名悄悄破坏消费方 */
describe('RetrievalProvider 契约', () => {
  it('RankedHit 字段齐全', () => {
    const hit: RankedHit = { path: 'a.ts', line: 1, text: 'x', score: 0 };
    expect(Object.keys(hit).sort()).toEqual(['line', 'path', 'score', 'text']);
  });
});
