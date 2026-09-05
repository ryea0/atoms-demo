/**
 * 语法校验层（纯函数）：path + content 进，verdict 出，不触 db、不做 IO。
 * 覆盖 .js/.mjs（acorn，按 ESM 解析以支持生成后端的 export）、.json（JSON.parse）、
 * .html（parse5 + <html> 存在性与 <script> 配对粗检）；其余扩展名（md/mmd/sh/css…）一律放行。
 */
import { parse as parseJs } from 'acorn';
import { parse as parseHtml } from 'parse5';

/** 语法校验结论；error 为中文可读信息（保留底层解析器的原始报错便于定位） */
export interface SyntaxReport {
  ok: boolean;
  error?: string;
}

/** 参与 JS 语法解析的扩展名 */
const JS_EXTENSIONS = new Set(['js', 'mjs']);

/** 参与 HTML 语法粗检的扩展名（.html 为主，.htm 兼容） */
const HTML_EXTENSIONS = new Set(['html', 'htm']);

/** 取小写扩展名；无扩展名或点开头文件（如 .gitignore）返回空串 */
export function extensionOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** 语法校验入口：按扩展名分派；未知扩展名视为纯文本放行 */
export function checkSyntax(path: string, content: string): SyntaxReport {
  const ext = extensionOf(path);
  if (JS_EXTENSIONS.has(ext)) return checkJs(content);
  if (ext === 'json') return checkJson(content);
  if (HTML_EXTENSIONS.has(ext)) return checkHtml(content);
  // .md/.mmd/.sh/.css 等非代码文件不做语法判定
  return { ok: true };
}

/** JS：acorn 解析（module 模式——生成后端 api.js 须支持 export/import） */
function checkJs(content: string): SyntaxReport {
  try {
    parseJs(content, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      locations: true,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `JS 语法错误：${errorMessage(error)}` };
  }
}

/** JSON：直接 JSON.parse */
function checkJson(content: string): SyntaxReport {
  try {
    JSON.parse(content) as unknown;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `JSON 语法错误：${errorMessage(error)}` };
  }
}

/** HTML：parse5 兜底解析 + <html> 存在性 + <script> 开闭配对粗检 */
function checkHtml(content: string): SyntaxReport {
  try {
    parseHtml(content, { sourceCodeLocationInfo: true });
  } catch (error) {
    return { ok: false, error: `HTML 解析失败：${errorMessage(error)}` };
  }
  if (!/<html[\s>]/i.test(content)) {
    return { ok: false, error: 'HTML 缺少 <html> 标签（生成页面须为完整文档）' };
  }
  const openTags = countMatches(content, /<script\b/gi);
  const closeTags = countMatches(content, /<\/script\s*>/gi);
  if (openTags !== closeTags) {
    return { ok: false, error: `HTML <script> 标签未配对（开 ${openTags} 处 / 闭 ${closeTags} 处）` };
  }
  return { ok: true };
}

/** 统计正则命中次数（pattern 须带 g 标志） */
function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

/** 未知错误值转可读信息（不泄漏堆栈） */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
