/** javascript 档案：现 D2 契约原样搬入（文案逐字取自 roles/engineer.ts；dbeaa6b 后与自检行重新对齐） */
import { checkSyntax } from '@/lib/validation/syntax';
import { scanDanger } from '@/lib/validation/danger';
import type { LanguageProfile } from '../types';

export const javascriptProfile: LanguageProfile = {
  id: 'javascript',
  backendExtension: 'js',
  backendEntryPath: 'app/backend/api.js',
  runtime: 'browser-js',
  engineerContract: [
    '1. 后端 app/backend/api.js：无框架同构 CommonJS 模块，必须导出 module.exports = { handle }，其中 handle(method, path, body) 返回 { code, data?, message? }；数据一律存内存数组/对象；禁止任何 fs/net/进程/timer API；REST 语义与正确状态码（200/201/400/404/405）。',
  ],
  selfCheckHint:
    '- 写完 JS 文件后可用 bash 自检：node --check <文件> 验语法、node -e "require + handle 冒烟" 验行为；单任务最多 5 次、每次 ≤30s、命令 ≤500 字符（超长会被直接拒绝——过长自检拆成多条短命令，或只跑 node --check）；不要用 bash 启动长驻服务、安装依赖或改文件（写文件一律走 write_file）。',
  build: (files) => new Map(files),
  checkSyntax: (path, content) => checkSyntax(path, content),
  scanDanger: (path, content) => scanDanger(path, content),
};
