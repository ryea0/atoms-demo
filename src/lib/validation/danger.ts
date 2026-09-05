/**
 * 危险 API 扫描层（纯函数，rules/07「生成物安全」/ DESIGN §5③ 纵深第 3 道）：
 * acorn AST 精检 + 正则兜底/辅检，输出 hard（拦截落库+带错重试）与 soft（⚠ 警告不拦截）。
 *
 * hard：eval / new Function / 字符串或模板字面量首参 setTimeout / postMessage 接收链指向 parent|top / 非白名单外链 script
 * soft：恒真 while(true) 无 break / fetch 到非 /api/ 地址（按字面量与模板静态前缀判定）
 *
 * 作用范围：AST 规则作用于 .js/.mjs 及 .html 内联 <script>；外链 script 白名单的正则规则仅作用于 .html。
 * 死循环/外部 fetch 在 .html 中按内联脚本逐段判（AST 优先，单段解析失败才退正则），避免与 AST 双通道重复计数。
 * 解析失败（acorn 抛错）时退回正则粗扫，避免因语法错误漏检注入类 API。
 */
import { parse as parseJs, type Node as AcornNode } from 'acorn';
import { parse as parseHtml, type DefaultTreeAdapterMap } from 'parse5';

import { extensionOf } from './syntax';

/** 危险规则名（稳定标识：前端展示、编排器重试提示与测试断言都依赖它） */
export type DangerRule =
  | 'eval'
  | 'new_function'
  | 'timer_string'
  | 'post_message_parent'
  | 'external_script'
  | 'infinite_loop'
  | 'external_fetch';

/** 一条危险/警告：severity=hard 拦截，soft 仅警告 */
export interface Danger {
  severity: 'hard' | 'soft';
  rule: DangerRule;
  detail: string;
}

/** acorn AST 节点的最小结构视图：只依赖 type/loc/arguments，其余子节点用守卫收窄（避免 any） */
interface AstNode {
  type: string;
  loc?: { start?: { line?: number } } | null;
  arguments?: unknown[];
  [key: string]: unknown;
}

/** 内联脚本片段（含在 HTML 中的起始行号，便于 detail 定位） */
interface ScriptChunk {
  code: string;
  line: number;
}

/** postMessage 逃逸目标关键字 */
const ESCAPE_TARGETS = new Set(['parent', 'top']);

/** 允许的第三方 script CDN（与 preview CSP script-src 白名单一致） */
const SCRIPT_CDN_WHITELIST = new Set(['cdn.tailwindcss.com']);

/** 前端调用后端的统一前缀（DESIGN §5① 契约），其余地址视为外联 */
const API_PREFIX = '/api/';

/** 外链 <script src="...">（引号形式；生成物不写无引号属性） */
const SCRIPT_SRC_PATTERN = /<script\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi;

/** 扫描入口：按扩展名分派；未知扩展名（md/sh/json/css…）不做危险扫描 */
export function scanDanger(path: string, content: string): Danger[] {
  const ext = extensionOf(path);
  if (ext === 'js' || ext === 'mjs') return scanScript(content, 1);
  if (ext === 'html' || ext === 'htm') return scanHtml(content);
  return [];
}

/* ------------------------------------------------------------------ */
/* 脚本扫描（AST 精检 + 解析失败正则兜底）                                */
/* ------------------------------------------------------------------ */

/** 扫描一段 JS：可解析则走 AST，否则退回正则粗扫 */
function scanScript(code: string, baseLine: number): Danger[] {
  const ast = tryParseScript(code);
  if (ast === null) return regexScan(code, baseLine);
  const dangers: Danger[] = [];
  walkAst(ast, (node) => {
    dangers.push(...dangersOfNode(node, baseLine));
  });
  return dangers;
}

/** acorn 解析；失败返回 null（语法错误本身由 checkSyntax 上报，这里只负责降级） */
function tryParseScript(code: string): AstNode | null {
  try {
    const ast: AcornNode = parseJs(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      locations: true,
    });
    // 边界断言：acorn 的泛型 Node 无索引签名，统一转成本层的最小结构视图后再守卫收窄
    return ast as unknown as AstNode;
  } catch {
    return null;
  }
}

/** 单节点规则判定（CallExpression / NewExpression / WhileStatement） */
function dangersOfNode(node: AstNode, baseLine: number): Danger[] {
  if (node.type === 'CallExpression' || node.type === 'NewExpression') {
    return dangersOfCall(node, baseLine);
  }
  if (node.type === 'WhileStatement') return dangersOfWhile(node, baseLine);
  return [];
}

/** 调用/构造类规则：eval、new Function、字符串 setTimeout、外部 fetch、postMessage 逃逸 */
function dangersOfCall(node: AstNode, baseLine: number): Danger[] {
  const name = calleeName(node.callee);
  if (name === null) return [];
  const line = lineOf(node, baseLine);

  if (name === 'eval') {
    return [danger('hard', 'eval', line, '调用 eval()：动态执行任意代码（注入面）')];
  }
  if (name === 'Function') {
    return [danger('hard', 'new_function', line, 'new Function()：字符串建函数，等价动态执行')];
  }
  if (name === 'setTimeout') {
    // 只有「代码以字面量写出」（字符串/模板字面量）才判注入 hard；
    // 函数引用、成员方法、变量等一律放行，避免误伤 setTimeout(save, 500) 这类正常用法
    if (isStringOrTemplateLiteral(node.arguments?.[0])) {
      return [danger('hard', 'timer_string', line, 'setTimeout 首参为字符串/模板字面量：疑似字符串代码注入')];
    }
    return [];
  }
  if (name === 'fetch') {
    const target = literalText(node.arguments?.[0]);
    // 非字面量（变量/拼接，如 fetch(API + '/' + id)）不报，避免误报
    if (target === null || target.startsWith(API_PREFIX)) return [];
    return [danger('soft', 'external_fetch', line, `fetch 到非 ${API_PREFIX} 地址「${target}」，预览沙箱禁外联`)];
  }
  if (name === 'postMessage') {
    return dangersOfPostMessage(node, line);
  }
  return [];
}

/** postMessage：接收链（parent / window.top …）指向外层 frame → 逃逸 hard。
 * 只看接收链，不看 targetOrigin 字符串内容——URL 里带 top/parent 字样不代表跨 frame。 */
function dangersOfPostMessage(node: AstNode, line: number): Danger[] {
  const callee = node.callee;
  const receiver = isAstNode(callee) && callee.type === 'MemberExpression' ? callee.object : null;
  if (!chainHasName(receiver, ESCAPE_TARGETS)) return [];
  return [danger('hard', 'post_message_parent', line, 'postMessage 面向 parent/top：可逃出预览 iframe')];
}

/** 恒真 while(true) 且循环体内无 break → soft 死循环警告 */
function dangersOfWhile(node: AstNode, baseLine: number): Danger[] {
  if (booleanLiteralValue(node.test) !== true) return [];
  if (containsBreak(node.body)) return [];
  return [
    danger('soft', 'infinite_loop', lineOf(node, baseLine), 'while(true) 循环体内无 break：可能卡死预览主线程'),
  ];
}

/* ------------------------------------------------------------------ */
/* HTML 扫描（外链 script 白名单 + 内联脚本逐段 AST）                     */
/* ------------------------------------------------------------------ */

function scanHtml(content: string): Danger[] {
  const dangers: Danger[] = scanExternalScripts(content);
  let chunks: ScriptChunk[];
  try {
    chunks = collectInlineScripts(parseHtml(content, { sourceCodeLocationInfo: true }));
  } catch {
    // parse5 都解析不动 → 全文正则粗扫兜底，不因结构破坏漏检
    return [...dangers, ...regexScan(content, 1)];
  }
  for (const chunk of chunks) dangers.push(...scanScript(chunk.code, chunk.line));
  return dangers;
}

/** 非白名单的外链 script → hard（正则辅检，AST 无法覆盖 src 属性） */
function scanExternalScripts(content: string): Danger[] {
  const dangers: Danger[] = [];
  for (const match of content.matchAll(SCRIPT_SRC_PATTERN)) {
    const src = match[2];
    if (typeof src !== 'string' || !isExternalUrl(src)) continue;
    const host = hostnameOf(src);
    if (host !== null && SCRIPT_CDN_WHITELIST.has(host)) continue;
    dangers.push(
      danger('hard', 'external_script', lineAt(content, match.index ?? 0, 1), `外链脚本「${src}」不在 CDN 白名单（${[...SCRIPT_CDN_WHITELIST].join(', ')}）`),
    );
  }
  return dangers;
}

/** 收集 HTML 内联脚本（跳过 JSON/模板类 type，避免把数据当 JS 误判） */
function collectInlineScripts(
  node: DefaultTreeAdapterMap['node'],
  out: ScriptChunk[] = [],
): ScriptChunk[] {
  if (node.nodeName === '#text') return out;
  if ('tagName' in node && node.tagName === 'script' && isExecutableType(node.attrs)) {
    const code = node.childNodes
      .filter((child): child is DefaultTreeAdapterMap['textNode'] => child.nodeName === '#text')
      .map((child) => child.value)
      .join('');
    if (code.trim().length > 0) {
      out.push({ code, line: node.sourceCodeLocation?.startLine ?? 1 });
    }
    return out;
  }
  if ('childNodes' in node) {
    for (const child of node.childNodes) collectInlineScripts(child, out);
  }
  if ('content' in node) collectInlineScripts(node.content, out); // <template> 内容
  return out;
}

/** script 的 type 属性是否为可执行 JS（无 type 视为 JS；json/template 类跳过） */
function isExecutableType(attrs: Array<{ name: string; value: string }>): boolean {
  const type = attrs.find((attr) => attr.name.toLowerCase() === 'type')?.value ?? '';
  return !/(json|template|text\/html)/i.test(type);
}

/** 外链脚本白名单扫描：仅判 http(s) 与协议相对地址 */
function isExternalUrl(src: string): boolean {
  return /^https?:\/\//i.test(src) || src.startsWith('//');
}

/** 取 URL 主机名；非法地址返回 null（交给调用方按未知处理） */
function hostnameOf(src: string): string | null {
  try {
    return new URL(src.startsWith('//') ? `https:${src}` : src).hostname;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 正则兜底粗扫（acorn 解析失败时不漏检）                                 */
/* ------------------------------------------------------------------ */

interface RoughRule {
  rule: DangerRule;
  severity: 'hard' | 'soft';
  pattern: RegExp;
  detail: string;
}

/** 粗扫规则：与 AST 规则同名同 severity，detail 注明为正则命中 */
const ROUGH_RULES: RoughRule[] = [
  { rule: 'eval', severity: 'hard', pattern: /\beval\s*\(/g, detail: '疑似 eval() 调用（正则粗扫）' },
  { rule: 'new_function', severity: 'hard', pattern: /\bnew\s+Function\s*\(/g, detail: '疑似 new Function()（正则粗扫）' },
  { rule: 'timer_string', severity: 'hard', pattern: /\bsetTimeout\s*\(\s*['"`]/g, detail: '疑似 setTimeout 首参为字符串（正则粗扫）' },
  {
    rule: 'post_message_parent',
    severity: 'hard',
    pattern: /\b(?:parent|top)\s*\.\s*postMessage\s*\(/gi,
    detail: '疑似 postMessage 面向 parent/top（正则粗扫）',
  },
  { rule: 'infinite_loop', severity: 'soft', pattern: /\bwhile\s*\(\s*true\s*\)/gi, detail: '疑似 while(true) 无 break（正则粗扫）' },
  { rule: 'external_fetch', severity: 'soft', pattern: /\bfetch\s*\(\s*['"`]\s*(?!\/api\/)/g, detail: `疑似 fetch 到非 ${API_PREFIX} 地址（正则粗扫）` },
];

function regexScan(text: string, baseLine: number): Danger[] {
  const dangers: Danger[] = [];
  for (const { rule, severity, pattern, detail } of ROUGH_RULES) {
    for (const match of text.matchAll(pattern)) {
      dangers.push(danger(severity, rule, lineAt(text, match.index ?? 0, baseLine), detail));
    }
  }
  return dangers;
}

/* ------------------------------------------------------------------ */
/* AST 遍历与守卫工具                                                    */
/* ------------------------------------------------------------------ */

/** 深度优先遍历所有节点（acorn 产物为无环树，不设访问集合） */
function walkAst(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) if (isAstNode(item)) walkAst(item, visit);
    } else if (isAstNode(value)) {
      walkAst(value, visit);
    }
  }
}

/** 结构守卫：未知值是否为带 type 的 AST 节点 */
function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/** 是否为「代码以字面量写出」：字符串字面量或模板字面量（用于字符串 setTimeout 注入判定） */
function isStringOrTemplateLiteral(node: unknown): boolean {
  if (!isAstNode(node)) return false;
  if (node.type === 'Literal') return typeof node.value === 'string';
  return node.type === 'TemplateLiteral';
}

/** 取字面量的可读文本：字符串字面量取其值；模板字面量取插值前的静态前缀。
 * 取前缀是保守选择——插值段（如 `/api/todos/${id}` 的 `${id}`）无法静态求值，
 * 但其前的静态段已足够判定是否走 `/api/` 契约；前缀为空时按非白名单处理（宁可多一条软警告）。 */
function literalText(node: unknown): string | null {
  const value = stringLiteralValue(node);
  if (value !== null) return value;
  if (!isAstNode(node) || node.type !== 'TemplateLiteral' || !Array.isArray(node.quasis)) return null;
  const quasi: unknown = node.quasis[0]; // TemplateElement
  if (!isAstNode(quasi)) return null;
  const payload: unknown = quasi.value; // { raw, cooked }
  return readStringField(payload, 'cooked') ?? readStringField(payload, 'raw');
}

/** 读取对象上指定 string 字段（AST 载荷无类型，用守卫而非断言） */
function readStringField(obj: unknown, key: string): string | null {
  if (typeof obj !== 'object' || obj === null || !(key in obj)) return null;
  const value: unknown = (obj as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/** 标识符名；非标识符返回 null */
function identifierName(node: unknown): string | null {
  if (!isAstNode(node) || node.type !== 'Identifier' || typeof node.name !== 'string') return null;
  return node.name;
}

/** 成员属性名：非计算属性取标识符，计算属性取字符串字面量（覆盖 window['eval']） */
function memberPropertyName(node: unknown): string | null {
  if (!isAstNode(node) || node.type !== 'MemberExpression') return null;
  return node.computed === true ? stringLiteralValue(node.property) : identifierName(node.property);
}

/** 调用目标名：标识符或成员属性名（eval / window.eval / obj.setTimeout 统一处理） */
function calleeName(callee: unknown): string | null {
  return identifierName(callee) ?? memberPropertyName(callee);
}

/** 字符串字面量值；非字符串字面量返回 null */
function stringLiteralValue(node: unknown): string | null {
  if (!isAstNode(node) || node.type !== 'Literal' || typeof node.value !== 'string') return null;
  return node.value;
}

/** 布尔字面量值；非布尔字面量返回 null */
function booleanLiteralValue(node: unknown): boolean | null {
  if (!isAstNode(node) || node.type !== 'Literal' || typeof node.value !== 'boolean') return null;
  return node.value;
}

/** 成员链上是否出现给定标识符名（parent / window.parent / window.top …） */
function chainHasName(expr: unknown, names: ReadonlySet<string>): boolean {
  let current: unknown = expr;
  for (let depth = 0; depth < 16 && isAstNode(current); depth += 1) {
    const name = identifierName(current) ?? memberPropertyName(current);
    if (name !== null && names.has(name)) return true;
    if (current.type !== 'MemberExpression') return false;
    current = current.object;
  }
  return false;
}

/** 循环体内是否含 break；不下潜到内层循环/switch（其 break 不属于本层） */
function containsBreak(node: unknown): boolean {
  if (!isAstNode(node)) return false;
  if (node.type === 'BreakStatement') return true;
  if (
    node.type === 'WhileStatement' ||
    node.type === 'DoWhileStatement' ||
    node.type === 'ForStatement' ||
    node.type === 'ForInStatement' ||
    node.type === 'ForOfStatement' ||
    node.type === 'SwitchStatement'
  ) {
    return false;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) if (containsBreak(item)) return true;
    } else if (containsBreak(value)) {
      return true;
    }
  }
  return false;
}

function lineOf(node: AstNode, baseLine: number): number {
  return node.loc?.start?.line ?? baseLine;
}

/** 按字符偏移推算行号（正则命中只有 index） */
function lineAt(text: string, index: number, baseLine: number): number {
  return baseLine + text.slice(0, index).split('\n').length - 1;
}

function danger(severity: 'hard' | 'soft', rule: DangerRule, line: number, text: string): Danger {
  return { severity, rule, detail: `第 ${line} 行：${text}` };
}
