import { describe, expect, it } from 'vitest';
import type { StorageProvider } from '@/lib/db/provider/types';
import { assemblePreview, composePreviewCsp, PREVIEW_CSP, PREVIEW_INDEX_PATH } from '@/lib/preview/assemble';

/** 最小 storage 桩：assemblePreview 只用 getFile */
function fakeStorage(files: Record<string, string>): StorageProvider {
  return {
    getFile: async (_projectId: number, path: string) =>
      Object.prototype.hasOwnProperty.call(files, path) ? { content: files[path] } : null,
  } as unknown as StorageProvider;
}

const INDEX = '<html><head><title>t</title></head><body></body></html>';
const API_JS = 'module.exports={handle:()=>({code:200})};';

/** 现 FETCH_SHIM 逐字节快照（搬动前的真身；改一个字符此测试即红） */
const FETCH_SHIM_LOCK = [
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
  '})();',
].join('\n');

describe('预览装配（js 项目 byte 级回归）', () => {
  it('后端模块注入 head 顶部 + FETCH_SHIM 注入 </body> 前（保证拦截器最后生效）', async () => {
    const result = await assemblePreview(fakeStorage({ [PREVIEW_INDEX_PATH]: INDEX, 'app/backend/api.js': API_JS }), 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wrapper = `window.__ATOMS_BACKEND__=(function(){const module={exports:{}};${API_JS};return module.exports;})();` +
      '(function(){ if(typeof window.module===\'undefined\'){window.module={exports:window.__ATOMS_BACKEND__};}else{Object.assign(window.module.exports,window.__ATOMS_BACKEND__);} })();';
    const expectedHead = `<html><head><script>\n${wrapper}\n</script><title>t</title></head><body>`;
    const expectedBody = `<script>\n${FETCH_SHIM_LOCK}\n</script></body></html>`;
    expect(result.html).toBe(expectedHead + expectedBody);
    expect(result.csp).toBe(PREVIEW_CSP);
  });

  it('缺 api.js → 占位分支（后端空 + 拦截器仍注入）；缺 index.html → missing_index', async () => {
    const placeholder = await assemblePreview(fakeStorage({ [PREVIEW_INDEX_PATH]: INDEX }), 1);
    // 后端为空串时 head 里只有 <script>\n\n</script>，拦截器在 body 末尾
    expect(placeholder.ok && placeholder.html).toBe(
      `<html><head><script>\n\n</script><title>t</title></head><body><script>\n${FETCH_SHIM_LOCK}\n</script></body></html>`,
    );
    const missing = await assemblePreview(fakeStorage({ 'app/backend/api.js': API_JS }), 1);
    expect(missing).toEqual({ ok: false, reason: 'missing_index' });
  });

  it('api.js 内含 </script> 时转义（不提前终止宿主 script）', async () => {
    const tricky = 'var s = "</script>";module.exports={handle:()=>({code:200})};';
    const result = await assemblePreview(fakeStorage({ [PREVIEW_INDEX_PATH]: INDEX, 'app/backend/api.js': tricky }), 1);
    expect(result.ok && result.html).toContain('<\\/script>');
  });
});

describe('composePreviewCsp', () => {
  it('无增量 → 原样返回（=== 基线，逐字节）', () => {
    expect(composePreviewCsp(PREVIEW_CSP, undefined)).toBe(PREVIEW_CSP);
  });
  it('script-src 追加、connect-src 替换 none（none 与其他值互斥）', () => {
    const out = composePreviewCsp(PREVIEW_CSP, { scriptSrc: ['https://cdn.jsdelivr.net', "'wasm-unsafe-eval'"], connectSrc: ['https://cdn.jsdelivr.net'] });
    expect(out).toContain("script-src 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net 'wasm-unsafe-eval'");
    expect(out).toContain('connect-src https://cdn.jsdelivr.net');
    expect(out).not.toContain("connect-src 'none'");
    expect(out).toContain("default-src 'none'");
  });
});
