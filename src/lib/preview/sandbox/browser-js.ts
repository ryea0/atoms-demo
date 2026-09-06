/**
 * 浏览器 JS 沙箱（现状原样搬入，Task 16 / Ruling 6b 信封协议）：
 * api.js 内联成 window.__ATOMS_BACKEND__（手工 CommonJS 垫片）+ fetch 拦截器。
 * 搬动纪律：escapeClosingScriptTag/backendWrapper/FETCH_SHIM/injectionBlock/assemblePreviewHtml
 * 与原 assemble.ts 逐字节一致——回归锁在 tests/preview/assemble.test.ts。
 */
import type { LanguageProfile } from '@/lib/languages/types';
import type { PreviewInput, PreviewOutput, PreviewSandboxProvider } from './types';

/** 字面 `</script` 提前终止宿主标签 → 转义成 `<\/script`（语义等价） */
export function escapeClosingScriptTag(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script');
}

/** ① 后端模块垫片：手工 CommonJS 求值（api.js 缺失时返回空串）
 *  同时挂到 window.module.exports——兼容模型生成的「前端直接读 module.exports.handle」模式。 */
const backendWrapper = (apiJsSource: string | null): string =>
  apiJsSource === null
    ? ''
    : `window.__ATOMS_BACKEND__=(function(){const module={exports:{}};${escapeClosingScriptTag(apiJsSource)};return module.exports;})();` +
      // 兼容层：如果模型自己定义了 module 且往 exports 挂东西，则与其合并；
      // 如果模型没定义 module，则全局暴露 module.exports = __ATOMS_BACKEND__，前端直接读也能拿到。
      `(function(){ if(typeof window.module==='undefined'){window.module={exports:window.__ATOMS_BACKEND__};}else{Object.assign(window.module.exports,window.__ATOMS_BACKEND__);} })();`;

/** ② fetch 拦截器（占位兼容：handle 缺失时 /api/ 一律 503 信封） */
export const FETCH_SHIM = [
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
  '      // 返回完整信封 {code,data,message}，HTTP status 同步 code；模型生成的前端',
  '      // 习惯读 result.code 判断成功、result.data 拿数据——与后端 handle() 格式一致。',
  '      return new Response(JSON.stringify(result),{status:Number(result.code)||200,headers:{"Content-Type":"application/json"}});',
  '    }).catch(function(error){',
  '      return new Response(JSON.stringify({message:"后端处理出错："+((error&&error.message)?error.message:String(error))}),{status:500,headers:{"Content-Type":"application/json"}});',
  '    });',
  '  }',
  '  if(nativeFetch===null)return Promise.reject(new Error("非 /api/ 请求且原生 fetch 不可用"));',
  '  return nativeFetch(input,init);',
  '};',
  // 用 Object.defineProperty 设为不可写，防止模型生成的前端代码（window.fetch = mockFetch）覆盖。
  // 兼容性：IE 不支持但我们不考虑；Safari/Chrome/Firefox 全部支持。
  'try{Object.defineProperty(window,"fetch",{value:window.fetch,writable:false,configurable:false});}catch(e){}',
  '})();',
].join('\n');

/** 组装注入块（先装后端，再装拦截器；都放 head 顶部，保证页面脚本执行前 fetch 已被替换且不可覆盖） */
function injectionBlock(apiJsSource: string | null): string {
  return `<script>\n${backendWrapper(apiJsSource)}\n${FETCH_SHIM}\n</script>`;
}

/** 注入点：<head> 后 → <html> 后 → 文档最前（畸形产物兜底）。Task 11 pyodide 沙箱复用。 */
export function injectIntoHtml(indexHtml: string, injection: string): string {
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

/** 尾部注入：</body> 前 → </html> 前 → 文档末尾。用于确保 fetch 拦截器最后生效（覆盖前端代码自行设置的 window.fetch）。 */
export function injectBeforeBodyEnd(indexHtml: string, injection: string): string {
  const bodyEnd = /<\/body>/i.exec(indexHtml);
  if (bodyEnd !== null) {
    return indexHtml.slice(0, bodyEnd.index) + injection + indexHtml.slice(bodyEnd.index);
  }
  const htmlEnd = /<\/html>/i.exec(indexHtml);
  if (htmlEnd !== null) {
    return indexHtml.slice(0, htmlEnd.index) + injection + indexHtml.slice(htmlEnd.index);
  }
  return indexHtml + injection;
}

/** 纯函数装配（保留原导出名，seed/测试若有引用不断）
 *  后端模块 + fetch 拦截器一并注入到 <head> 顶部——保证页面任何脚本执行前 fetch 已被替换。
 *  拦截器通过 Object.defineProperty 设为不可写，防止模型代码（window.fetch = mockFetch）覆盖。 */
export function assemblePreviewHtml(indexHtml: string, apiJsSource: string | null): string {
  return injectIntoHtml(indexHtml, injectionBlock(apiJsSource));
}

export const browserJsSandbox: PreviewSandboxProvider = {
  kind: 'browser-js',
  assemble(input: PreviewInput): PreviewOutput {
    return { html: assemblePreviewHtml(input.indexHtml, input.backendSource) };
  },
};
