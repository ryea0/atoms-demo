/**
 * 全栈预览装配（Task 16，DESIGN §3.7 / D2 全栈契约 / Ruling 6b 信封协议）。
 *
 * 预览 = 服务端拼接：取 app/frontend/index.html，在 <head> 之后注入一个 <script>：
 * ① api.js 源码整体内联，包装成 window.__ATOMS_BACKEND__
 *    （api.js 是 CommonJS 模块：module.exports={handle}；用手工 module 垫片求值）
 * ② fetch 拦截器：/api/ 开头 → handle(method,path,body)，按 Ruling 6b 把
 *    {code,data?,message?} 映射为 Response（code→status，data 优先 message 兜底→body）；
 *    其余路径回落原生 fetch。无 api.js 时只注入拦截器占位（/api/ 一律 503）。
 *
 * 响应 CSP（rules 07 预览隔离）由路由层下发；装配层只管 HTML。
 * 服务端专用，不得进入客户端 bundle。
 */
import type { StorageProvider } from '@/lib/db/provider/types';

/** 预览入口文件（虚拟 FS 固定契约路径） */
export const PREVIEW_INDEX_PATH = 'app/frontend/index.html';
/** 预览后端模块（无框架同构 CommonJS：module.exports = { handle }） */
export const PREVIEW_API_PATH = 'app/backend/api.js';

/** 预览响应 CSP（ruling 7 逐字）：default-src none + Tailwind CDN 白名单 + connect-src none 堵外传 */
export const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://cdn.tailwindcss.com; style-src 'unsafe-inline' https://cdn.tailwindcss.com; img-src data: https:; connect-src 'none'";

/** 装配结果：失败只可能是缺入口页（api.js 缺失走占位分支，不算失败） */
export type PreviewAssembly = { ok: true; html: string } | { ok: false; reason: 'missing_index' };

/**
 * 字面 `</script` 会提前终止宿主 <script> 标签。转义成 `<\/script`：
 * 在 JS 字符串/正则字面量里两者语义等价，在代码其他位置出现本就属于畸形产物
 * （危险 API 扫描/语法校验在落库前已把关）。
 */
function escapeClosingScriptTag(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script');
}

/** ① 后端模块垫片：手工 CommonJS 求值（api.js 缺失时返回空串，不注入包装） */
const backendWrapper = (apiJsSource: string | null): string =>
  apiJsSource === null ? '' : `window.__ATOMS_BACKEND__=(function(){const module={exports:{}};${escapeClosingScriptTag(apiJsSource)};return module.exports;})();`;

/** ② fetch 拦截器（占位兼容：handle 缺失时 /api/ 一律 503 信封） */
const FETCH_SHIM = [
  '(function(){',
  'var backend=window.__ATOMS_BACKEND__;',
  'var handle=(backend&&typeof backend.handle==="function")?backend.handle:null;',
  'var nativeFetch=(typeof window.fetch==="function")?window.fetch.bind(window):null;',
  'function pathOf(input){if(typeof input==="string")return input;if(input&&typeof input.url==="string")return input.url;return String(input);}',
  'function bodyOf(init,input){',
  '  if(init&&typeof init.body!=="undefined"){if(typeof init.body==="string"){try{return JSON.parse(init.body);}catch(e){return init.body;}}return init.body;}',
  '  return null;',
  '}',
  'window.fetch=function(input,init){',
  '  var path=pathOf(input);',
  '  if(path.indexOf("/api/")===0){',
  '    var method=String((init&&init.method)||(input&&input.method)||"GET").toUpperCase();',
  '    var body=bodyOf(init,input);',
  '    return Promise.resolve().then(function(){',
  '      if(handle===null)return{code:503,message:"后端未生成（缺少 app/backend/api.js）"};',
  '      return handle(method,path,body);',
  '    }).then(function(envelope){',
  '      var result=envelope||{};',
  '      var payload=(result.data!==undefined)?result.data:((result.message!==undefined)?result.message:null);',
  '      return new Response(JSON.stringify(payload),{status:Number(result.code)||200,headers:{"Content-Type":"application/json"}});',
  '    }).catch(function(error){',
  '      return new Response(JSON.stringify({message:"后端处理出错："+((error&&error.message)?error.message:String(error))}),{status:500,headers:{"Content-Type":"application/json"}});',
  '    });',
  '  }',
  '  if(nativeFetch===null)return Promise.reject(new Error("非 /api/ 请求且原生 fetch 不可用"));',
  '  return nativeFetch(input,init);',
  '};',
  '})();',
].join('\n');

/** 组装注入块（head 内首个 script：先装后端，再装拦截器，最后才是应用自身脚本） */
function injectionBlock(apiJsSource: string | null): string {
  return `<script>\n${backendWrapper(apiJsSource)}\n${FETCH_SHIM}\n</script>`;
}

/** 纯函数装配：index.html + api.js 源码 → 注入垫片后的完整预览 HTML */
export function assemblePreviewHtml(indexHtml: string, apiJsSource: string | null): string {
  const injection = injectionBlock(apiJsSource);
  // 注入点优先 <head> 之后；无 head 退 <html> 之后；再退文档最前（畸形产物兜底，预览仍可用）
  const head = /<head[^>]*>/i.exec(indexHtml);
  if (head !== null) {
    const at = head.index + head[0].length;
    return indexHtml.slice(0, at) + injection + indexHtml.slice(at);
  }
  const html = /<html[^>]*>/i.exec(indexHtml);
  if (html !== null) {
    const at = html.index + html[0].length;
    return indexHtml.slice(0, at) + injection + indexHtml.slice(at);
  }
  return injection + indexHtml;
}

/** 读虚拟 FS 并装配：缺 index.html → {ok:false,reason:'missing_index'}（路由转 404） */
export async function assemblePreview(storage: StorageProvider, projectId: number): Promise<PreviewAssembly> {
  const index = await storage.getFile(projectId, PREVIEW_INDEX_PATH);
  if (index === null) return { ok: false, reason: 'missing_index' };
  const api = await storage.getFile(projectId, PREVIEW_API_PATH);
  return { ok: true, html: assemblePreviewHtml(index.content, api?.content ?? null) };
}
