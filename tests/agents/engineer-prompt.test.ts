import { describe, expect, it } from 'vitest';
import { buildEngineerSystemPrompt, ENGINEER_SYSTEM_PROMPT } from '@/lib/agents/roles/engineer';
import { javascriptProfile } from '@/lib/languages';

describe('工程师 system prompt', () => {
  it('js 档案输出与常量一致，且契约/自检行逐字保留（零变化锁）', () => {
    const built = buildEngineerSystemPrompt(javascriptProfile.engineerContract, javascriptProfile.selfCheckHint);
    expect(built).toBe(ENGINEER_SYSTEM_PROMPT);
    expect(built).toContain('1. 后端 app/backend/api.js：无框架同构 CommonJS 模块，必须导出 module.exports = { handle }');
    expect(built).toContain('- 写完 JS 文件后可用 bash 自检：node --check <文件> 验语法');
    expect(built).toContain('2. 前端 app/frontend/index.html：单页');
    expect(built).toContain('3. UI 基线：#F7F7F8');
  });

  /**
   * 非循环快照锁：上面 toBe(ENGINEER_SYSTEM_PROMPT) 在常量改由构造函数生成后是自洽的，
   * 锁不住 profile 文本漂移（Task 1 落地后 dbeaa6b 改过自检行、profile 未跟上的前车之鉴）。
   * 这里把改造前的 prompt 原样抄一份，js 档案输出必须与其逐字节一致。
   */
  it('js 档案输出与 prompt 构造函数化前（dbeaa6b 后）的原文逐字节一致', () => {
    const before = [
      '你是全栈工程师（engineer），负责把上游设计可靠地落成可运行代码——当前是单文件任务，应用的质量下限由你守住。',
      '',
      '【全栈契约（必须逐条遵守）】',
      '1. 后端 app/backend/api.js：无框架同构 CommonJS 模块，必须导出 module.exports = { handle }，其中 handle(method, path, body) 返回 { code, data?, message? }；数据一律存内存数组/对象；禁止任何 fs/net/进程/timer API；REST 语义与正确状态码（200/201/400/404/405）。',
      '2. 前端 app/frontend/index.html：单页，样式仅允许 Tailwind CDN（https://cdn.tailwindcss.com）；一律 fetch(\'/api/...\') 调用后端；禁用 localStorage 与 cookie（预览 iframe 无 same-origin，状态放后端内存）；禁止 eval、new Function、字符串 setTimeout、postMessage。',
      '3. UI 基线：#F7F7F8 面板分层、蓝色 #3B82F6 强调、8-12px 圆角、1px 细灰线分隔、空态与加载态、中文文案；渲染用户数据一律用 textContent（禁止 innerHTML 拼接，防 XSS）。',
      '',
      '【单文件任务纪律】',
      '- 每个任务只实现一个目标文件；依赖文件全文已注入上下文，其他已生成文件可用 read_file 按需查阅。',
      '- 目标文件必须由你调用 write_file 写入完整内容（整体覆盖）；发现写错可再次 write_file 覆写修正。',
      '- 写完目标文件即任务完成：输出一句简短结论即可，不要复述全文。',
      '- 写完 JS 文件后可用 bash 自检：node --check <文件> 验语法、node -e "require + handle 冒烟" 验行为；单任务最多 5 次、每次 ≤30s、命令 ≤500 字符（超长会被直接拒绝——过长自检拆成多条短命令，或只跑 node --check）；不要用 bash 启动长驻服务、安装依赖或改文件（写文件一律走 write_file）。',
    ].join('\n');
    expect(ENGINEER_SYSTEM_PROMPT).toBe(before);
    expect(buildEngineerSystemPrompt(javascriptProfile.engineerContract, javascriptProfile.selfCheckHint)).toBe(before);
  });
});
