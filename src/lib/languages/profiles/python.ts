/**
 * python 档案：预览走 Pyodide（WASM CPython，无 fs/net/socket），
 * 正则危险规则是纵深第 3 道的降级实现（spec §2.2：acorn 只懂 JS）。
 * 语法校验降级放行——真校验 = 预览 boot 的 SyntaxError 横幅 + bash 自检 py_compile。
 */
import type { Danger, DangerRule } from '@/lib/validation/danger';
import type { SyntaxReport } from '@/lib/validation/syntax';
import type { LanguageProfile } from '../types';

const PY_HARD_RULES: ReadonlyArray<readonly [DangerRule, RegExp, string]> = [
  ['py_exec', /\b(?:eval|exec)\s*\(|__import__/, '检测到 Python 动态执行 API（eval/exec/__import__）：浏览器内后端禁止'],
  ['py_subprocess', /\bos\.system\s*\(|\bsubprocess\b/, '检测到 subprocess/os.system：浏览器内后端禁止起进程'],
  ['py_socket', /\bimport\s+socket\b|\bfrom\s+socket\b/, '检测到 socket 导入：浏览器内后端禁网络'],
];

const PY_SOFT_RULES: ReadonlyArray<readonly [DangerRule, RegExp, string]> = [
  ['py_net_import', /\bimport\s+(?:requests|urllib|http\.client)\b|\bfrom\s+(?:requests|urllib|http\.client)\b/, 'requests/urllib 在 Pyodide 内不可用：请用内存数据或 fetch 拦截层（前端代理）'],
];

export const pythonProfile: LanguageProfile = {
  id: 'python',
  backendExtension: 'py',
  backendEntryPath: 'app/backend/api.py',
  runtime: 'browser-pyodide',
  engineerContract: [
    '1. 后端 app/backend/api.py：Python 无框架模块，入口 def handle(method, path, body) 返回 dict {"code": int, "data"?: any, "message"?: str}；数据一律存内存 list/dict（模块级变量）；禁止 socket/subprocess/os.system/eval/exec/__import__ 与任何文件 IO；REST 语义与正确状态码（200/201/400/404/405）。',
  ],
  selfCheckHint:
    '- 写完 Python 文件后可用 bash 自检：python3 -m py_compile <文件> 验语法；单任务最多 5 次、每次 ≤30s；不要用 bash 启动长驻服务、安装依赖或改文件（写文件一律走 write_file）。',
  build: (files) => new Map(files),
  checkSyntax: (_path, _content): SyntaxReport => ({ ok: true }),
  scanDanger(path: string, content: string): Danger[] {
    if (!path.endsWith('.py')) return [];
    const found: Danger[] = [];
    for (const [rule, pattern, detail] of PY_HARD_RULES) {
      if (pattern.test(content)) found.push({ severity: 'hard', rule, detail });
    }
    for (const [rule, pattern, detail] of PY_SOFT_RULES) {
      if (pattern.test(content)) found.push({ severity: 'soft', rule, detail });
    }
    return found;
  },
};
