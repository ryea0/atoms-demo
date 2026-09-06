/**
 * Pyodide 预览沙箱（spec §4.2）：iframe 内跑真 Python 后端（WASM CPython）。
 * 三段注入：① CDN loader；② boot（runPythonAsync 求值 api.py + JSON 信封适配器）；
 * ③ lazy fetch 拦截器（boot 未完 await + 30s 超时；与 browser-js 的 FETCH_SHIM
 * 信封语义一致但独立成文——复制而非参数化，保 js 侧字节零变化的优先级高于 DRY）。
 * 桥接用 JSON 字符串双向序列化：避开 JsProxy（JS 对象进 python）与 Map（dict 出 python）陷阱。
 */
import type { PreviewInput, PreviewOutput, PreviewSandboxProvider } from './types';
import { escapeClosingScriptTag, injectIntoHtml } from './browser-js';

const PYODIDE_VERSION = 'v0.26.4';
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;

/** python 侧信封适配器：handle(dict) ↔ JSON 字符串；只携带存在的键 */
const PY_ADAPTER = [
  'def _atoms_handle(method, path, body_json):',
  '    import json as _json',
  '    body = _json.loads(body_json) if body_json else None',
  '    result = handle(method, path, body)',
  '    out = {"code": result.get("code", 200)}',
  '    if "data" in result: out["data"] = result["data"]',
  '    if "message" in result: out["message"] = result["message"]',
  '    return _json.dumps(out)',
].join('\n');

function pyLiteral(source: string): string {
  // JSON.stringify 做转义，再堵 </script 提前终止（与 browser-js 同一防线）
  return escapeClosingScriptTag(JSON.stringify(source));
}

/** boot 块：加载 pyodide → 求值 api.py + 适配器 → 挂 __ATOMS_BACKEND__；失败渲染中文横幅 */
function pyodideBoot(apiPySource: string): string {
  return `<script>
window.__ATOMS_BOOT_READY__=(async function(){
  var pyodide=await loadPyodide({indexURL:'${PYODIDE_BASE}'});
  await pyodide.runPythonAsync(${pyLiteral(apiPySource)});
  pyodide.runPython(${pyLiteral(PY_ADAPTER)});
  var raw=pyodide.globals.get('_atoms_handle');
  window.__ATOMS_BACKEND__={handle:function(method,path,body){
    return JSON.parse(raw(method,path,body===undefined?null:JSON.stringify(body)));
  }};
  // 兼容层：模型生成的前端常直接读 module.exports.handle——同步暴露一份。
  if(typeof window.module==='undefined'){window.module={exports:window.__ATOMS_BACKEND__};}
  else{Object.assign(window.module.exports,window.__ATOMS_BACKEND__);}
})().catch(function(error){
  var banner=document.createElement('div');
  banner.style.cssText='position:fixed;top:0;left:0;right:0;z-index:9999;padding:.75rem 1rem;background:#FEE2E2;color:#991B1B;font:13px/1.6 system-ui;';
  banner.textContent='Python 后端启动失败：'+((error&&error.message)?error.message:String(error));
  function mount(){(document.body||document.documentElement).appendChild(banner);}
  if(document.body){mount();}else{window.addEventListener('DOMContentLoaded',mount);}
  throw error;
});
</script>`;
}

/** lazy fetch 拦截器：handle 延迟解析 + boot await + 30s 超时（信封映射与 eager 版一致） */
const FETCH_SHIM_LAZY = [
  '(function(){',
  'var nativeFetch=(typeof window.fetch==="function")?window.fetch.bind(window):null;',
  'function pathOf(input){if(typeof input==="string")return input;if(input&&typeof input.url==="string")return input.url;return String(input);}',
  'function bodyOf(init,input){',
  '  if(init&&typeof init.body!=="undefined"){if(typeof init.body==="string"){try{return JSON.parse(init.body);}catch(e){return init.body;}}return init.body;}',
  '  return null;',
  '}',
  'function handleOf(){var b=window.__ATOMS_BACKEND__;return (b&&typeof b.handle==="function")?b.handle:null;}',
  'window.fetch=function(input,init){',
  '  var path=pathOf(input);',
  '  if(path.indexOf("/api/")===0){',
  '    var method=String((init&&init.method)||(input&&input.method)||"GET").toUpperCase();',
  '    var body=bodyOf(init,input);',
  '    var boot=window.__ATOMS_BOOT_READY__||Promise.resolve();',
  '    var timeout=new Promise(function(_,reject){setTimeout(function(){reject(new Error("后端启动超时（30s）"));},30000);});',
  '    return Promise.race([boot,timeout]).then(function(){',
  '      var h=handleOf();',
  '      if(h===null)return{code:503,message:"后端未生成或未就绪（缺少 app/backend/api.py）"};',
  '      return h(method,path,body);',
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
  'try{Object.defineProperty(window,"fetch",{value:window.fetch,writable:false,configurable:false});}catch(e){}',
  '})();',
].join('\n');

export const browserPyodideSandbox: PreviewSandboxProvider = {
  kind: 'browser-pyodide',
  assemble(input: PreviewInput): PreviewOutput {
    const boot = input.backendSource === null ? '' : pyodideBoot(input.backendSource);
    // 全部放 head 顶部：CDN loader + boot 块（尽早启动异步加载）+ lazy fetch 拦截器
    // （拦截器通过 Object.defineProperty 设为不可写，模型代码覆盖不了）
    const headInjection = `<script src="${PYODIDE_BASE}pyodide.js"></script>\n${boot}<script>\n${FETCH_SHIM_LAZY}\n</script>`;
    return {
      html: injectIntoHtml(input.indexHtml, headInjection),
      cspExtras: {
        scriptSrc: ['https://cdn.jsdelivr.net', "'wasm-unsafe-eval'"],
        connectSrc: ['https://cdn.jsdelivr.net'],
      },
    };
  },
};
