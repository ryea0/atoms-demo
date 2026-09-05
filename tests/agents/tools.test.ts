/**
 * 工具层测试（Task 7）：路径沙箱 + FS 工具。
 * brief 原文用例在前，沙箱安全补充（嵌套逃逸/空段/超长/结尾斜杠）与工具协议
 * （schema 校验回喂、parameters 派生、project 隔离）在后。
 * 落库验证走 newTestStorage（内存库，无磁盘副作用）。
 */
import { describe, expect, it } from 'vitest';
import { normalizeProjectPath } from '@/lib/agents/tools/sandbox';
import { fsTools, type Tool, type ToolContext } from '@/lib/agents/tools';
import { newTestStorage } from '@/lib/db/test-util';
import type { StorageProvider } from '@/lib/db/provider/types';

/** 按名字取工具（缺的就是契约破坏，直接抛错让测试红） */
function toolByName(name: string): Tool {
  const tool = fsTools.find((t) => t.name === name);
  if (!tool) throw new Error(`fsTools 缺少工具 ${name}`);
  return tool;
}

/** 独立内存库 + 空项目，ctx.role 默认 engineer（写文件时打在 last_editor 上） */
async function newCtx(role: ToolContext['role'] = 'engineer'): Promise<{
  ctx: ToolContext;
  storage: StorageProvider;
  projectId: number;
}> {
  const storage = newTestStorage();
  const project = await storage.createProject({ sessionId:'s', title:'t', requirement:'r', mode:'fast' });
  return { storage, projectId: project.id, ctx: { storage, projectId: project.id, role } };
}

describe('normalizeProjectPath：brief 原文用例', () => {
  it.each([['../escape'], ['/abs'], ['a\\b'], ['a/./b']])('拒绝 %j', (bad) => {
    const result = normalizeProjectPath(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  it('放行 docs/prd.md 且原样返回', () => {
    const result = normalizeProjectPath('docs/prd.md');
    expect(result).toEqual({ ok:true, path:'docs/prd.md' });
  });
});

describe('normalizeProjectPath：安全补充', () => {
  it.each([
    ['空串', ''],
    ['嵌套逃逸', 'docs/../../etc/passwd'],
    ['反斜杠逃逸', '..\\..\\x'],
    ['连续斜杠空段', 'a//b'],
    ['结尾斜杠', 'docs/'],
    ['纯点段', 'a/..'],
    ['含空格', 'a b/c.txt'],
    ['含中文', '文档/需求.md'],
    ['冒号盘符', 'C:/x.txt'],
    ['null 字节', 'a\0b'],
  ])('拒绝%s：%j', (_label, bad) => {
    expect(normalizeProjectPath(bad).ok).toBe(false);
  });

  it('拒绝超过 200 字符的路径', () => {
    const long = `a${'b'.repeat(200)}.txt`; // 204 字符
    expect(long.length).toBeGreaterThan(200);
    expect(normalizeProjectPath(long).ok).toBe(false);
  });

  it('放行白名单内的常见路径', () => {
    const okPaths = ['src/app/page.tsx', 'src/App_Component-v2.test.tsx', '.env', 'a/b/c/d.ts', 'README.md'];
    for (const p of okPaths) expect(normalizeProjectPath(p)).toEqual({ ok:true, path:p });
  });
});

describe('fsTools：write_file', () => {
  it('写入落库并打 editor=ctx.role，输出 已写入 <path> v<version>', async () => {
    const { ctx, storage, projectId } = await newCtx('engineer');
    const result = await toolByName('write_file').execute({ path:'docs/prd.md', content:'# PRD' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toBe('已写入 docs/prd.md v1');

    const row = await storage.getFile(projectId, 'docs/prd.md');
    expect(row?.content).toBe('# PRD');
    expect(row?.version).toBe(1);
    expect(row?.lastEditor).toBe('engineer');
    expect(row?.producedBy).toBe('engineer');
  });

  it('覆盖写版本递增，且 editor 跟随当前角色', async () => {
    const { ctx, storage, projectId } = await newCtx('architect');
    await toolByName('write_file').execute({ path:'docs/design.md', content:'v1' }, ctx);
    const second = await toolByName('write_file').execute({ path:'docs/design.md', content:'v2' }, ctx);
    expect(second.output).toBe('已写入 docs/design.md v2');

    const row = await storage.getFile(projectId, 'docs/design.md');
    expect(row?.content).toBe('v2');
    expect(row?.version).toBe(2);
    expect(row?.lastEditor).toBe('architect');
  });

  it('沙箱拒绝的路径返回 ok:false 并带原因', async () => {
    const { ctx, storage, projectId } = await newCtx();
    const result = await toolByName('write_file').execute({ path:'../escape.md', content:'x' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('..');
    expect(await storage.listFiles(projectId)).toHaveLength(0);
  });

  it('内容超过 512KB 拒绝落库（.claude/rules/07 二次约束）', async () => {
    const { ctx, storage, projectId } = await newCtx();
    const big = 'x'.repeat(512 * 1024 + 1);
    const result = await toolByName('write_file').execute({ path:'a.txt', content:big }, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('字节');
    expect(await storage.listFiles(projectId)).toHaveLength(0);
  });

  it('512KB 上限按 UTF-8 字节数计（多字节字符不被字符数漏过）', async () => {
    const { ctx, storage, projectId } = await newCtx();
    // 180000 个汉字：字符数 18 万（远低于 512K），字节数 540000（超过 512KB）
    const result = await toolByName('write_file').execute({ path:'cjk.txt', content:'中'.repeat(180000) }, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('字节');
    expect(await storage.listFiles(projectId)).toHaveLength(0);

    // 恰好 524288 字节的 ASCII 内容放行（边界）
    const exact = 'x'.repeat(512 * 1024);
    const okResult = await toolByName('write_file').execute({ path:'exact.txt', content:exact }, ctx);
    expect(okResult.ok).toBe(true);
  });
});

describe('fsTools：read_file', () => {
  it('文件不存在返回 ok:false / 文件不存在', async () => {
    const { ctx } = await newCtx();
    const result = await toolByName('read_file').execute({ path:'nope.md' }, ctx);
    expect(result).toEqual({ ok:false, output:'文件不存在' });
  });

  it('空文件返回可读提示而非空串', async () => {
    const { ctx } = await newCtx();
    await toolByName('write_file').execute({ path:'empty.md', content:'' }, ctx);
    const result = await toolByName('read_file').execute({ path:'empty.md' }, ctx);
    expect(result).toEqual({ ok:true, output:'（空文件）' });
  });

  it('短文件原样返回全文', async () => {
    const { ctx } = await newCtx();
    await toolByName('write_file').execute({ path:'a.md', content:'l1\nl2\nl3' }, ctx);
    const result = await toolByName('read_file').execute({ path:'a.md' }, ctx);
    expect(result).toEqual({ ok:true, output:'l1\nl2\nl3' });
  });

  it('恰好 400 行不截断', async () => {
    const { ctx } = await newCtx();
    const content = Array.from({ length:400 }, (_v, i) => `line-${i + 1}`).join('\n');
    await toolByName('write_file').execute({ path:'a.md', content }, ctx);
    const result = await toolByName('read_file').execute({ path:'a.md' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('line-400');
    expect(result.output).not.toContain('省略');
  });

  it('超过 400 行返回首尾各 200 行 + 行数提示', async () => {
    const { ctx } = await newCtx();
    const content = Array.from({ length:500 }, (_v, i) => `line-${i + 1}`).join('\n');
    await toolByName('write_file').execute({ path:'big.md', content }, ctx);
    const result = await toolByName('read_file').execute({ path:'big.md' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('line-1');
    expect(result.output).toContain('line-200');
    expect(result.output).toContain('line-301');
    expect(result.output).toContain('line-500');
    expect(result.output).not.toContain('line-250'); // 被省略的中段
    expect(result.output).toContain('500'); // 行数提示含总行数
  });

  it('行数达标但总量超长（100 行 × 1000 字符）仍按首尾字符截断并给诚实提示', async () => {
    const { ctx } = await newCtx();
    const content = Array.from({ length:100 }, (_v, i) => {
      const label = `line-${i + 1}:`;
      return label + 'x'.repeat(1000 - label.length); // 每行恰好 1000 字符，共 ~100k 字符
    }).join('\n');
    await toolByName('write_file').execute({ path:'wide.md', content }, ctx);
    const result = await toolByName('read_file').execute({ path:'wide.md' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('line-1:');
    expect(result.output).toContain('line-100:');
    expect(result.output).not.toContain('line-50'); // 中段被省略
    expect(result.output).toContain('字符'); // 截断提示按字符数说明
    expect(result.output.length).toBeLessThan(17000);
  });

  it('单行超长（1 行 50k 字符）也被字符上限截断', async () => {
    const { ctx } = await newCtx();
    await toolByName('write_file').execute({ path:'min.js', content:'a'.repeat(50000) }, ctx);
    const result = await toolByName('read_file').execute({ path:'min.js' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output.startsWith('aaaa')).toBe(true);
    expect(result.output).toContain('字符');
    expect(result.output.length).toBeLessThan(17000);
  });

  it('CRLF 内容按 LF 返回（不漏 \r）', async () => {
    const { ctx } = await newCtx();
    await toolByName('write_file').execute({ path:'win.md', content:'l1\r\nl2\r\nl3' }, ctx);
    const result = await toolByName('read_file').execute({ path:'win.md' }, ctx);
    expect(result).toEqual({ ok:true, output:'l1\nl2\nl3' });
  });

  it('沙箱拒绝的路径返回 ok:false', async () => {
    const { ctx } = await newCtx();
    const result = await toolByName('read_file').execute({ path:'/etc/passwd' }, ctx);
    expect(result.ok).toBe(false);
  });
});

describe('fsTools：list_files', () => {
  it('每行一个 path，按路径升序', async () => {
    const { ctx } = await newCtx();
    await toolByName('write_file').execute({ path:'src/b.ts', content:'b' }, ctx);
    await toolByName('write_file').execute({ path:'a.md', content:'a' }, ctx);
    const result = await toolByName('list_files').execute({}, ctx);
    expect(result).toEqual({ ok:true, output:'a.md\nsrc/b.ts' });
  });

  it('空项目给出友好提示', async () => {
    const { ctx } = await newCtx();
    const result = await toolByName('list_files').execute({}, ctx);
    expect(result.ok).toBe(true);
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.output).not.toContain('\n');
  });
});

describe('fsTools：grep', () => {
  it('命中行按 path:line: 内容 输出', async () => {
    const { ctx } = await newCtx();
    await toolByName('write_file').execute({ path:'src/a.ts', content:'const a = 1;\n// TODO fix me\n' }, ctx);
    await toolByName('write_file').execute({ path:'src/b.ts', content:'TODO again\n' }, ctx);
    const result = await toolByName('grep').execute({ pattern:'TODO' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('src/a.ts:2: // TODO fix me');
    expect(result.output).toContain('src/b.ts:1: TODO again');
  });

  it('支持正则语法', async () => {
    const { ctx } = await newCtx();
    await toolByName('write_file').execute({ path:'a.ts', content:'const count = 42;\nconst label = "x";\n' }, ctx);
    const result = await toolByName('grep').execute({ pattern:'const \\w+ = \\d+' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('a.ts:1: const count = 42;');
    expect(result.output).not.toContain('label');
  });

  it('命中超过 50 行截断并给出总数', async () => {
    const { ctx } = await newCtx();
    const content = Array.from({ length:60 }, (_v, i) => `hit-${i + 1}`).join('\n');
    await toolByName('write_file').execute({ path:'many.txt', content }, ctx);
    const result = await toolByName('grep').execute({ pattern:'hit-' }, ctx);
    expect(result.ok).toBe(true);
    const lines = result.output.split('\n').filter((l) => l.startsWith('many.txt:'));
    expect(lines).toHaveLength(50);
    expect(lines[0]).toContain('hit-1');
    expect(lines[49]).toContain('hit-50');
    expect(result.output).toContain('60'); // 截断提示含总命中数
  });

  it('无命中返回提示而非空串', async () => {
    const { ctx } = await newCtx();
    await toolByName('write_file').execute({ path:'a.txt', content:'hello\n' }, ctx);
    const result = await toolByName('grep').execute({ pattern:'zzz-not-there' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('超长命中行截断展示（守住上下文预算）', async () => {
    const { ctx } = await newCtx();
    await toolByName('write_file').execute({ path:'wide.txt', content:`needle ${'x'.repeat(500)}\n` }, ctx);
    const result = await toolByName('grep').execute({ pattern:'needle' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('needle');
    expect(result.output).toContain('本行超长已截断');
    expect(result.output.length).toBeLessThan(400);
  });

  it('CRLF 文件按 LF 逐行扫，行尾锚点正则能命中', async () => {
    const { ctx } = await newCtx();
    await toolByName('write_file').execute({ path:'src/win.ts', content:'const a = 1;\r\n// TODO fix\r\n' }, ctx);
    const result = await toolByName('grep').execute({ pattern:'fix$' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('src/win.ts:2: // TODO fix');
  });

  it('非法正则返回 ok:false + 错误信息', async () => {
    const { ctx } = await newCtx();
    const result = await toolByName('grep').execute({ pattern:'(unclosed' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('非法正则');
  });
});

describe('fsTools：project 隔离（工具闭包绑定 ctx.projectId）', () => {
  it('A 项目写入的文件，B 项目读不到、grep 不中', async () => {
    const storage = newTestStorage();
    const a = await storage.createProject({ sessionId:'s', title:'A', requirement:'r', mode:'fast' });
    const b = await storage.createProject({ sessionId:'s', title:'B', requirement:'r', mode:'fast' });
    const ctxA: ToolContext = { storage, projectId:a.id, role:'engineer' };
    const ctxB: ToolContext = { storage, projectId:b.id, role:'engineer' };

    await toolByName('write_file').execute({ path:'secret.md', content:'needle-xyz' }, ctxA);

    const read = await toolByName('read_file').execute({ path:'secret.md' }, ctxB);
    expect(read).toEqual({ ok:false, output:'文件不存在' });

    const grep = await toolByName('grep').execute({ pattern:'needle-xyz' }, ctxB);
    expect(grep.ok).toBe(true);
    expect(grep.output).toContain('未命中'); // 无命中提示，而非泄漏 A 项目内容
    expect(grep.output).not.toContain('secret.md');

    const list = await toolByName('list_files').execute({}, ctxB);
    expect(list.output).not.toContain('secret.md');
  });
});

describe('工具协议（Task 8 runner 消费面）', () => {
  it('fsTools 恰好暴露 4 个工具，命名固定', () => {
    expect(fsTools.map((t) => t.name)).toEqual(['write_file', 'read_file', 'list_files', 'grep']);
  });

  it('每个工具都带 schema 与派生的 parameters（JSON Schema object）', () => {
    const expectedArgs:Record<string, string[]> = {
      write_file:['content', 'path'],
      read_file:['path'],
      list_files:[],
      grep:['pattern'],
    };
    for (const tool of fsTools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters.type).toBe('object');
      expect(Object.keys(tool.parameters.properties ?? {}).sort()).toEqual(expectedArgs[tool.name]);
      expect([...(tool.parameters.required ?? [])].sort()).toEqual(expectedArgs[tool.name]);
    }
  });

  it('args 未过 schema 校验时返回 ok:false + 校验错误（供 runner 回喂重试）', async () => {
    const { ctx } = await newCtx();
    const missingContent = await toolByName('write_file').execute({ path:'a.ts' }, ctx);
    expect(missingContent.ok).toBe(false);
    expect(missingContent.output).toContain('校验失败');

    const notObject = await toolByName('read_file').execute('nope', ctx);
    expect(notObject.ok).toBe(false);
    expect(notObject.output).toContain('校验失败');

    const badPattern = await toolByName('grep').execute({ pattern:42 }, ctx);
    expect(badPattern.ok).toBe(false);
    expect(badPattern.output).toContain('校验失败');
  });
});
