/**
 * Shiki 高亮封装（Task 21 查看器：代码文件 + Markdown 代码块共用）。
 *
 * 依赖纪律（.claude/rules/02）：shiki 是重依赖，只允许在浏览器侧按需加载——
 * 本模块被「懒加载的查看器视图」引用，且内部用 dynamic import 引入 shiki，
 * 首次真正高亮时才拉取（SSR 阶段不会被求值，也不会进首屏 bundle）。
 * 失败处理：语言不支持 / 加载失败时抛错，由调用方降级为纯文本 pre（不白屏）。
 */
import type { BundledLanguage, BundledTheme, SpecialLanguage } from 'shiki';

/** 可安全交给 shiki 的语言 id（扩展名/围栏信息串 → 这里必须收敛） */
export type HighlightLanguage = BundledLanguage | SpecialLanguage;

/** 流式高亮节流间隔（.claude/rules/03：不逐字符 setState 整棵树，按 120ms 合批） */
export const HIGHLIGHT_DEBOUNCE_MS = 120;

/** 高亮主题（与产品视觉基线一致：白底浅色） */
const HIGHLIGHT_THEME: BundledTheme = 'github-light';

/** 扩展名 → shiki 语言（生成物常用面；未列出的走纯文本） */
const EXTENSION_LANGUAGES: Readonly<Record<string, HighlightLanguage>> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  jsonc: 'jsonc',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  py: 'python',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  java: 'java',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  kt: 'kotlin',
  swift: 'swift',
  vue: 'vue',
  toml: 'toml',
  ini: 'ini',
  xml: 'xml',
  svg: 'xml',
  dockerfile: 'dockerfile',
};

/** Markdown 围栏信息串别名（```js / ```shell / ```text 等） */
const FENCE_ALIASES: Readonly<Record<string, HighlightLanguage>> = {
  js: 'javascript',
  javascript: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'tsx',
  json: 'json',
  html: 'html',
  css: 'css',
  scss: 'scss',
  md: 'markdown',
  markdown: 'markdown',
  python: 'python',
  py: 'python',
  shell: 'shellscript',
  sh: 'shellscript',
  bash: 'shellscript',
  console: 'shellscript',
  yaml: 'yaml',
  yml: 'yaml',
  sql: 'sql',
  java: 'java',
  go: 'go',
  rust: 'rust',
  ruby: 'ruby',
  php: 'php',
  c: 'c',
  cpp: 'cpp',
  csharp: 'csharp',
  kotlin: 'kotlin',
  swift: 'swift',
  diff: 'diff',
  dockerfile: 'dockerfile',
  toml: 'toml',
  ini: 'ini',
  xml: 'xml',
  text: 'text',
  txt: 'text',
  plain: 'text',
};

function extensionOf(pathOrLang: string): string {
  const normalized = pathOrLang.trim().toLowerCase();
  const dot = normalized.lastIndexOf('.');
  const ext = dot >= 0 ? normalized.slice(dot + 1) : normalized;
  // 路径无扩展名（如 Dockerfile）时整段即语言名
  return /^[a-z0-9]+$/.test(ext) ? ext : '';
}

/**
 * 路径或围栏信息串 → shiki 语言 id。
 * 未知值一律回退纯文本（绝不把任意字符串直接交给 shiki，避免运行时抛错/越界）。
 */
export function resolveLanguage(pathOrLang: string): HighlightLanguage {
  const key = extensionOf(pathOrLang);
  if (key === '') return 'text';
  return EXTENSION_LANGUAGES[key] ?? FENCE_ALIASES[key] ?? 'text';
}

/** 高亮为 HTML（shiki 输出自包含内联样式，无外链 CSS；失败抛错由调用方降级） */
export async function highlightToHtml(code: string, lang: HighlightLanguage): Promise<string> {
  const { codeToHtml } = await import('shiki');
  return codeToHtml(code, { lang, theme: HIGHLIGHT_THEME });
}
