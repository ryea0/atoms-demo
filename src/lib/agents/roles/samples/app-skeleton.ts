/**
 * 生成应用模板骨架（DESIGN §5⑤「下限保证」——保底模板即质量下限）：
 * mock provider 的工程师产出、以及真实模型连续失败时的兜底模板都从这里取。
 *
 * 三套模板（DESIGN §5⑤：2-3 套精致骨架）：列表 CRUD / 数据仪表盘 / 落地页，
 * 由路由清单确定性分派（/api/stats→仪表盘、/api/leads→落地页、默认 CRUD）。
 *
 * 生成物红线（rules/07 安全 + DESIGN §5′）：
 * - 零依赖（仅 Tailwind CDN）、无构建步骤；后端为浏览器内同构 `handle(method,path,body)`
 * - 禁 localStorage/cookie（iframe 无 same-origin）→ 全部内存态
 * - 不出现 eval / new Function / 字符串 setTimeout / postMessage / while(true)
 * - 用户数据一律经 DOM API + textContent 注入（不 innerHTML 拼接，防 XSS）
 *
 * UI 基线（DESIGN §5⑤ 现代 UI / .claude/rules/04 token）：#F7F7F8 面板分层、
 * 蓝色 #3B82F6 强调、8-12px 圆角、1px 细灰线分隔、空态与加载态、中文文案。
 */

/** 生成应用统一使用的 Tailwind CDN（与 preview CSP script-src 白名单一致） */
export const TAILWIND_CDN = 'https://cdn.tailwindcss.com';

/** 默认演示资源路径（生成应用与样例对齐） */
export const DEFAULT_API_ROUTE = '/api/todos';

/** 仪表盘聚合资源路由（同时是模板分派信号） */
const DASHBOARD_ROUTE = '/api/stats';

/** 落地页留资资源路由（同时是模板分派信号） */
const LANDING_ROUTE = '/api/leads';

/** 模板种类：按路由清单确定性分派（不进模型决策，CLAUDE.md 规则 1） */
type AppKind = 'crud' | 'dashboard' | 'landing';

/** 路由清单 → 模板种类：stats→仪表盘、leads→落地页，其余（含空清单）→CRUD */
function kindOfRoutes(routes: string[]): AppKind {
  if (routes.some((route) => route.includes(DASHBOARD_ROUTE))) return 'dashboard';
  if (routes.some((route) => route.includes(LANDING_ROUTE))) return 'landing';
  return 'crud';
}

/** HTML 文本转义（标题/需求文案注入时防结构破坏） */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 从 '/api/todos' 取资源名 'todos'（用于后端内存分桶） */
function resourceOf(route: string): string {
  const parts = route.split('/').filter(Boolean);
  return parts[1] ?? 'todos';
}

/** 从路由列表取前端实际调用的第一个路由（无则用默认演示路由） */
export function primaryRoute(routes: string[]): string {
  const first = routes.find((r) => r.trim().length > 0);
  return first ?? DEFAULT_API_ROUTE;
}

/** HTML 文档头（三套模板共用：meta + Tailwind CDN + 可用接口注释） */
function htmlHead(title: string, apiRoutes: string[]): string[] {
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${title}</title>`,
    `  <!-- 可用接口：${apiRoutes.join(', ') || DEFAULT_API_ROUTE} -->`,
    `  <script src="${TAILWIND_CDN}"></script>`,
    '</head>',
  ];
}

/* ------------------------------------------------------------------ */
/* 前端：分派入口 + 三套模板                                             */
/* ------------------------------------------------------------------ */

/**
 * 渲染前端单页（index.html）：按路由清单分派到 CRUD / 仪表盘 / 落地页模板。
 * @param requirement 用户一句话需求（注入标题与副标题）
 * @param apiRoutes   后端路由清单（决定模板种类与 API 基址）
 */
export function renderIndexHtml(requirement: string, apiRoutes: string[]): string {
  const kind = kindOfRoutes(apiRoutes);
  if (kind === 'dashboard') return renderDashboardHtml(requirement, apiRoutes);
  if (kind === 'landing') return renderLandingHtml(requirement, apiRoutes);
  return renderCrudHtml(requirement, apiRoutes);
}

/** CRUD 模板：完整增删改查（含内联编辑）+ 空态 + 首屏加载态 */
function renderCrudHtml(requirement: string, apiRoutes: string[]): string {
  const clean = requirement.trim();
  const title = escapeHtml(clean.slice(0, 24) || '待办清单');
  const subtitle = escapeHtml(clean.slice(0, 60) || '一个简洁的待办清单');
  const api = primaryRoute(apiRoutes);
  const lines: string[] = [
    ...htmlHead(title, apiRoutes),
    '<body class="bg-[#F7F7F8] text-neutral-900 antialiased">',
    '  <main class="mx-auto max-w-xl px-5 py-10">',
    '    <header>',
    '      <p class="text-xs font-semibold tracking-widest text-[#3B82F6] uppercase">Atoms Demo</p>',
    `      <h1 class="mt-1 text-2xl font-semibold tracking-tight">${subtitle}</h1>`,
    '      <p class="mt-2 text-sm text-neutral-500">记录、勾选、编辑、删除——数据保存在内存态后端，刷新页面即重置。</p>',
    '    </header>',
    '',
    '    <section class="mt-6 rounded-xl border border-neutral-200 bg-white p-5">',
    '      <div class="flex items-center justify-between">',
    '        <p id="stats" class="text-sm text-neutral-500">已完成 0 / 共 0</p>',
    '        <span id="sync-badge" class="rounded-full bg-[#3B82F6]/10 px-2.5 py-1 text-xs font-medium text-[#3B82F6]">已同步</span>',
    '      </div>',
    '      <div class="mt-4 h-px bg-neutral-100"></div>',
    '      <form id="create-form" class="mt-4 flex gap-2">',
    '        <input id="title-input" autocomplete="off" placeholder="记下一件事…" class="flex-1 rounded-full border border-neutral-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-[#3B82F6] focus:ring-2 focus:ring-[#3B82F6]/20" />',
    '        <button type="submit" class="rounded-full bg-[#3B82F6] px-5 py-2.5 text-sm font-medium text-white transition hover:opacity-90">添加</button>',
    '      </form>',
    '    </section>',
    '',
    '    <section class="mt-5">',
    '      <div id="loading" class="space-y-2" aria-label="加载中">',
    '        <div class="h-[52px] animate-pulse rounded-lg border border-neutral-200 bg-white px-4"></div>',
    '        <div class="h-[52px] animate-pulse rounded-lg border border-neutral-200 bg-white px-4"></div>',
    '        <div class="h-[52px] animate-pulse rounded-lg border border-neutral-200 bg-white px-4"></div>',
    '      </div>',
    '      <ul id="todo-list" class="space-y-2"></ul>',
    '      <div id="empty" class="mt-2 hidden rounded-xl border border-dashed border-neutral-300 bg-white/60 px-4 py-10 text-center">',
    '        <p class="text-sm text-neutral-400">还没有记录，先添加一条吧</p>',
    '      </div>',
    '    </section>',
    '',
    '    <p class="mt-8 text-xs text-neutral-400">数据保存在浏览器内内存态后端（api.js），刷新页面即重置。</p>',
    '  </main>',
    '',
    '  <script>',
    "    (function () {",
    "      'use strict';",
    `      var API = '${api}';`,
    "      var listEl = document.getElementById('todo-list');",
    "      var emptyEl = document.getElementById('empty');",
    "      var loadingEl = document.getElementById('loading');",
    "      var statsEl = document.getElementById('stats');",
    "      var badgeEl = document.getElementById('sync-badge');",
    "      var formEl = document.getElementById('create-form');",
    "      var inputEl = document.getElementById('title-input');",
    '      var editingId = null; // 正在编辑标题的条目 id（状态只存内存，不用浏览器本地存储）',
    '      var firstLoad = true;',
    '      var busy = 0;',
    '',
    '      function markBusy(delta) {',
    '        busy = Math.max(0, busy + delta);',
    '        if (busy > 0) {',
    "          badgeEl.textContent = '同步中…';",
    "          badgeEl.className = 'rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-500';",
    '        } else {',
    "          badgeEl.textContent = '已同步';",
    "          badgeEl.className = 'rounded-full bg-[#3B82F6]/10 px-2.5 py-1 text-xs font-medium text-[#3B82F6]';",
    '        }',
    '      }',
    '',
    '      function done() { markBusy(-1); load(); }',
    '      function fail(name) {',
    '        return function (err) {',
    '          markBusy(-1);',
    '          console.error(name + \'失败\', err);',
    "          badgeEl.textContent = '同步失败';",
    "          badgeEl.className = 'rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-500';",
    '        };',
    '      }',
    '',
    '      function render(todos) {',
    '        listEl.textContent = \'\';',
    '        var doneCount = 0;',
    '        todos.forEach(function (todo) {',
    '          if (todo.done) doneCount += 1;',
    '          listEl.appendChild(itemOf(todo));',
    '        });',
    '        statsEl.textContent = \'已完成 \' + doneCount + \' / 共 \' + todos.length;',
    '        emptyEl.classList.toggle(\'hidden\', todos.length !== 0);',
    '      }',
    '',
    '      /** 单条目：查看态（勾选/标题/编辑/删除）或编辑态（输入框/保存/取消） */',
    '      function itemOf(todo) {',
    "        var li = document.createElement('li');",
    "        li.className = 'flex items-center gap-3 rounded-lg border border-neutral-200 bg-white px-4 py-3 transition hover:border-neutral-300';",
    '        if (editingId === todo.id) return editRowOf(li, todo);',
    '',
    "        var box = document.createElement('input');",
    '        box.type = \'checkbox\';',
    '        box.checked = !!todo.done;',
    "        box.className = 'h-4 w-4 accent-[#3B82F6]';",
    '        box.addEventListener(\'change\', function () { update(todo.id, { done: box.checked }); });',
    '',
    "        var label = document.createElement('span');",
    '        label.className = todo.done ? \'flex-1 truncate text-sm text-neutral-400 line-through\' : \'flex-1 truncate text-sm\';',
    '        label.textContent = todo.title;',
    '',
    "        var edit = actionButton('编辑');",
    '        edit.addEventListener(\'click\', function () { editingId = todo.id; load(); });',
    "        var del = actionButton('删除');",
    '        del.className = \'rounded-full px-3 py-1.5 text-xs text-neutral-400 transition hover:bg-red-50 hover:text-red-500\';',
    '        del.addEventListener(\'click\', function () { remove(todo.id); });',
    '',
    '        li.appendChild(box);',
    '        li.appendChild(label);',
    '        li.appendChild(edit);',
    '        li.appendChild(del);',
    '        return li;',
    '      }',
    '',
    '      function editRowOf(li, todo) {',
    "        var input = document.createElement('input');",
    '        input.value = todo.title;',
    "        input.className = 'flex-1 rounded-full border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-[#3B82F6]';",
    "        var save = actionButton('保存');",
    '        save.addEventListener(\'click\', function () {',
    '          var title = input.value.trim();',
    '          if (title.length === 0) return;',
    '          update(todo.id, { title: title });',
    '        });',
    "        var cancel = actionButton('取消');",
    '        cancel.addEventListener(\'click\', function () { editingId = null; load(); });',
    '        li.appendChild(input);',
    '        li.appendChild(save);',
    '        li.appendChild(cancel);',
    '        return li;',
    '      }',
    '',
    '      function actionButton(text) {',
    "        var button = document.createElement('button');",
    '        button.type = \'button\';',
    '        button.textContent = text;',
    "        button.className = 'rounded-full px-3 py-1.5 text-xs text-neutral-500 transition hover:bg-neutral-100';",
    '        return button;',
    '      }',
    '',
    '      function load() {',
    '        markBusy(1);',
    '        fetch(API)',
    '          .then(function (res) { return res.json(); })',
    '          .then(function (payload) {',
    '            markBusy(-1);',
    '            render((payload && payload.data) || []);',
    '            if (firstLoad) { firstLoad = false; loadingEl.classList.add(\'hidden\'); }',
    '          })',
    '          .catch(fail(\'加载\'));',
    '      }',
    '',
    '      function create(title) {',
    '        markBusy(1);',
    "        fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title }) })",
    '          .then(function (res) { return res.json(); })',
    '          .then(done)',
    '          .catch(fail(\'新增\'));',
    '      }',
    '',
    '      function update(id, patch) {',
    '        markBusy(1);',
    "        fetch(API + '/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })",
    '          .then(function (res) { return res.json(); })',
    '          .then(function () { editingId = null; done(); })',
    '          .catch(fail(\'更新\'));',
    '      }',
    '',
    '      function remove(id) {',
    '        markBusy(1);',
    "        fetch(API + '/' + id, { method: 'DELETE' })",
    '          .then(function (res) { return res.json(); })',
    '          .then(done)',
    '          .catch(fail(\'删除\'));',
    '      }',
    '',
    '      formEl.addEventListener(\'submit\', function (event) {',
    '        event.preventDefault();',
    '        var title = inputEl.value.trim();',
    '        if (title.length === 0) { inputEl.placeholder = \'先写点内容再添加\'; return; }',
    '        create(title);',
    '        inputEl.value = \'\';',
    '      });',
    '',
    '      load();',
    '    })();',
    '  </script>',
    '</body>',
    '</html>',
    '',
  ];
  return lines.join('\n');
}

/** 仪表盘模板：只读统计卡片 + 完成度图表位 + 最近动态 + 刷新（无编辑/删除操作） */
function renderDashboardHtml(requirement: string, apiRoutes: string[]): string {
  const clean = requirement.trim();
  const title = escapeHtml(clean.slice(0, 24) || '数据看板');
  const subtitle = escapeHtml(clean.slice(0, 60) || '关键指标一览');
  const lines: string[] = [
    ...htmlHead(title, apiRoutes),
    '<body class="bg-[#F7F7F8] text-neutral-900 antialiased">',
    '  <main class="mx-auto max-w-2xl px-5 py-10">',
    '    <header class="flex items-end justify-between">',
    '      <div>',
    '        <p class="text-xs font-semibold tracking-widest text-[#3B82F6] uppercase">Atoms Demo</p>',
    `        <h1 class="mt-1 text-2xl font-semibold tracking-tight">${subtitle}</h1>`,
    '        <p class="mt-2 text-sm text-neutral-500">关键指标由内存态后端实时聚合，刷新页面即重置。</p>',
    '      </div>',
    '      <button id="refresh" type="button" class="rounded-full border border-[#3B82F6]/40 px-4 py-2 text-sm font-medium text-[#3B82F6] transition hover:bg-[#3B82F6]/10">刷新</button>',
    '    </header>',
    '',
    '    <section class="mt-6 grid grid-cols-3 gap-3">',
    '      <div class="rounded-xl border border-neutral-200 bg-white p-4">',
    '        <p class="text-xs text-neutral-400">总任务</p>',
    '        <p id="card-total" class="mt-1 font-mono text-2xl font-semibold">–</p>',
    '      </div>',
    '      <div class="rounded-xl border border-neutral-200 bg-white p-4">',
    '        <p class="text-xs text-neutral-400">已完成</p>',
    '        <p id="card-done" class="mt-1 font-mono text-2xl font-semibold">–</p>',
    '      </div>',
    '      <div class="rounded-xl border border-neutral-200 bg-white p-4">',
    '        <p class="text-xs text-neutral-400">完成率</p>',
    '        <p id="card-rate" class="mt-1 font-mono text-2xl font-semibold text-[#3B82F6]">–</p>',
    '      </div>',
    '    </section>',
    '',
    '    <section class="mt-5 rounded-xl border border-neutral-200 bg-white p-5">',
    '      <div class="flex items-center justify-between">',
    '        <p class="text-sm font-medium">完成度</p>',
    '        <span id="sync-badge" class="rounded-full bg-[#3B82F6]/10 px-2.5 py-1 text-xs font-medium text-[#3B82F6]">已同步</span>',
    '      </div>',
    '      <div class="mt-4 h-3 rounded-full bg-neutral-100" aria-label="完成度图表">',
    '        <div id="rate-bar" class="h-3 w-0 rounded-full bg-[#3B82F6] transition-all"></div>',
    '      </div>',
    '      <div class="mt-4 h-px bg-neutral-100"></div>',
    '      <p class="mt-4 text-sm font-medium">最近动态</p>',
    '      <div id="loading" class="mt-2 space-y-2" aria-label="加载中">',
    '        <div class="h-9 animate-pulse rounded-lg bg-neutral-100"></div>',
    '        <div class="h-9 animate-pulse rounded-lg bg-neutral-100"></div>',
    '      </div>',
    '      <ul id="recent-list" class="mt-2 space-y-2"></ul>',
    '      <p id="empty" class="mt-2 hidden rounded-lg border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-400">暂无数据</p>',
    '    </section>',
    '',
    '    <p class="mt-8 text-xs text-neutral-400">数据来自聚合接口（内存态），刷新页面即重置。</p>',
    '  </main>',
    '',
    '  <script>',
    "    (function () {",
    "      'use strict';",
    `      var API = '${DASHBOARD_ROUTE}';`,
    "      var totalEl = document.getElementById('card-total');",
    "      var doneEl = document.getElementById('card-done');",
    "      var rateEl = document.getElementById('card-rate');",
    "      var barEl = document.getElementById('rate-bar');",
    "      var listEl = document.getElementById('recent-list');",
    "      var emptyEl = document.getElementById('empty');",
    "      var loadingEl = document.getElementById('loading');",
    "      var badgeEl = document.getElementById('sync-badge');",
    "      var refreshEl = document.getElementById('refresh');",
    '      var firstLoad = true;',
    '',
    '      function markBusy(delta) {',
    '        if (delta > 0) {',
    "          badgeEl.textContent = '同步中…';",
    "          badgeEl.className = 'rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-500';",
    '        } else {',
    "          badgeEl.textContent = '已同步';",
    "          badgeEl.className = 'rounded-full bg-[#3B82F6]/10 px-2.5 py-1 text-xs font-medium text-[#3B82F6]';",
    '        }',
    '      }',
    '',
    '      function render(stats) {',
    '        totalEl.textContent = String(stats.total);',
    '        doneEl.textContent = String(stats.done);',
    '        rateEl.textContent = stats.rate + \'%\';',
    '        barEl.style.width = Math.min(100, Math.max(0, stats.rate)) + \'%\';',
    '        listEl.textContent = \'\';',
    '        var recent = stats.recent || [];',
    '        recent.forEach(function (item) {',
    "          var li = document.createElement('li');",
    "          li.className = 'flex items-center gap-3 rounded-lg border border-neutral-200 px-4 py-2';",
    "          var badge = document.createElement('span');",
    '          badge.textContent = item.done ? \'已完成\' : \'进行中\';',
    '          badge.className = item.done',
    "            ? 'rounded-full bg-[#3B82F6]/10 px-2 py-0.5 text-xs text-[#3B82F6]'",
    "            : 'rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500';",
    "          var title = document.createElement('span');",
    "          title.className = 'flex-1 truncate text-sm';",
    '          title.textContent = item.title;',
    '          li.appendChild(badge);',
    '          li.appendChild(title);',
    '          listEl.appendChild(li);',
    '        });',
    '        emptyEl.classList.toggle(\'hidden\', recent.length !== 0);',
    '      }',
    '',
    '      function load() {',
    '        markBusy(1);',
    '        fetch(API)',
    '          .then(function (res) { return res.json(); })',
    '          .then(function (payload) {',
    '            markBusy(-1);',
    '            render((payload && payload.data) || { total: 0, done: 0, rate: 0, recent: [] });',
    '            if (firstLoad) { firstLoad = false; loadingEl.classList.add(\'hidden\'); }',
    '          })',
    '          .catch(function (err) {',
    '            markBusy(-1);',
    "            console.error('加载指标失败', err);",
    "            badgeEl.textContent = '同步失败';",
    "            badgeEl.className = 'rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-500';",
    '          });',
    '      }',
    '',
    '      refreshEl.addEventListener(\'click\', load);',
    '',
    '      load();',
    '    })();',
    '  </script>',
    '</body>',
    '</html>',
    '',
  ];
  return lines.join('\n');
}

/** 落地页模板：需求 hero + 留资表单（POST /api/leads）+ 最新留资列表（只读） */
function renderLandingHtml(requirement: string, apiRoutes: string[]): string {
  const clean = requirement.trim();
  const title = escapeHtml(clean.slice(0, 24) || '产品落地页');
  const subtitle = escapeHtml(clean.slice(0, 60) || '一个正在打磨的产品');
  const lines: string[] = [
    ...htmlHead(title, apiRoutes),
    '<body class="bg-[#F7F7F8] text-neutral-900 antialiased">',
    '  <main class="mx-auto max-w-xl px-5 py-12">',
    '    <header class="text-center">',
    '      <p class="text-xs font-semibold tracking-widest text-[#3B82F6] uppercase">Atoms Demo</p>',
    `      <h1 class="mt-2 text-3xl font-semibold tracking-tight">${subtitle}</h1>`,
    '      <p class="mx-auto mt-3 max-w-md text-sm leading-6 text-neutral-500">如果你对它感兴趣，留下联系方式——第一时间收到进展与内测邀请。</p>',
    '      <a href="#lead" class="mt-6 inline-block rounded-full bg-[#3B82F6] px-6 py-2.5 text-sm font-medium text-white transition hover:opacity-90">立即留资</a>',
    '    </header>',
    '',
    '    <section id="lead" class="mt-10 rounded-xl border border-neutral-200 bg-white p-5">',
    '      <div class="flex items-center justify-between">',
    '        <p class="text-sm font-medium">留下联系方式</p>',
    '        <span id="sync-badge" class="rounded-full bg-[#3B82F6]/10 px-2.5 py-1 text-xs font-medium text-[#3B82F6]">已同步</span>',
    '      </div>',
    '      <form id="lead-form" class="mt-4 flex gap-2">',
    '        <input id="contact-input" autocomplete="off" placeholder="邮箱 / 微信 / 电话" class="flex-1 rounded-full border border-neutral-200 px-4 py-2.5 text-sm outline-none transition focus:border-[#3B82F6] focus:ring-2 focus:ring-[#3B82F6]/20" />',
    '        <button type="submit" class="rounded-full bg-[#3B82F6] px-5 py-2.5 text-sm font-medium text-white transition hover:opacity-90">提交留资</button>',
    '      </form>',
    '      <p class="mt-2 text-xs text-neutral-400">提交后展示在下方列表（内存态，刷新即重置）。</p>',
    '    </section>',
    '',
    '    <section class="mt-5">',
    '      <p class="text-sm font-medium">最新留资</p>',
    '      <div id="loading" class="mt-2 space-y-2" aria-label="加载中">',
    '        <div class="h-9 animate-pulse rounded-lg bg-white"></div>',
    '        <div class="h-9 animate-pulse rounded-lg bg-white"></div>',
    '      </div>',
    '      <ul id="lead-list" class="mt-0 space-y-2"></ul>',
    '      <p id="empty" class="mt-2 hidden rounded-xl border border-dashed border-neutral-300 bg-white/60 px-4 py-8 text-center text-sm text-neutral-400">还没有留资，第一条就是你</p>',
    '    </section>',
    '',
    '    <p class="mt-10 text-center text-xs text-neutral-400">留资数据保存在浏览器内内存态后端（api.js），刷新页面即重置。</p>',
    '  </main>',
    '',
    '  <script>',
    "    (function () {",
    "      'use strict';",
    `      var API = '${LANDING_ROUTE}';`,
    "      var listEl = document.getElementById('lead-list');",
    "      var emptyEl = document.getElementById('empty');",
    "      var loadingEl = document.getElementById('loading');",
    "      var badgeEl = document.getElementById('sync-badge');",
    "      var formEl = document.getElementById('lead-form');",
    "      var inputEl = document.getElementById('contact-input');",
    '      var firstLoad = true;',
    '',
    '      function markBusy(delta) {',
    '        if (delta > 0) {',
    "          badgeEl.textContent = '同步中…';",
    "          badgeEl.className = 'rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-500';",
    '        } else {',
    "          badgeEl.textContent = '已同步';",
    "          badgeEl.className = 'rounded-full bg-[#3B82F6]/10 px-2.5 py-1 text-xs font-medium text-[#3B82F6]';",
    '        }',
    '      }',
    '',
    '      function render(leads) {',
    '        listEl.textContent = \'\';',
    '        leads.forEach(function (lead, index) {',
    "          var li = document.createElement('li');",
    "          li.className = 'flex items-center gap-3 rounded-lg border border-neutral-200 bg-white px-4 py-2.5';",
    "          var no = document.createElement('span');",
    '          no.textContent = \'#\' + (index + 1);',
    "          no.className = 'font-mono text-xs text-[#3B82F6]';",
    "          var contact = document.createElement('span');",
    "          contact.className = 'flex-1 truncate text-sm';",
    '          contact.textContent = lead.contact;',
    '          li.appendChild(no);',
    '          li.appendChild(contact);',
    '          listEl.appendChild(li);',
    '        });',
    '        emptyEl.classList.toggle(\'hidden\', leads.length !== 0);',
    '      }',
    '',
    '      function load() {',
    '        markBusy(1);',
    '        fetch(API)',
    '          .then(function (res) { return res.json(); })',
    '          .then(function (payload) {',
    '            markBusy(-1);',
    '            render((payload && payload.data) || []);',
    '            if (firstLoad) { firstLoad = false; loadingEl.classList.add(\'hidden\'); }',
    '          })',
    '          .catch(function (err) {',
    '            markBusy(-1);',
    "            console.error('加载留资失败', err);",
    "            badgeEl.textContent = '同步失败';",
    "            badgeEl.className = 'rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-500';",
    '          });',
    '      }',
    '',
    '      function create(contact) {',
    '        markBusy(1);',
    "        fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact: contact }) })",
    '          .then(function (res) { return res.json(); })',
    '          .then(function () { markBusy(-1); load(); })',
    '          .catch(function (err) {',
    '            markBusy(-1);',
    "            console.error('提交留资失败', err);",
    "            badgeEl.textContent = '同步失败';",
    "            badgeEl.className = 'rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-500';",
    '          });',
    '      }',
    '',
    '      formEl.addEventListener(\'submit\', function (event) {',
    '        event.preventDefault();',
    '        var contact = inputEl.value.trim();',
    '        if (contact.length === 0) { inputEl.placeholder = \'先填个联系方式\'; return; }',
    '        create(contact);',
    '        inputEl.value = \'\';',
    '      });',
    '',
    '      load();',
    '    })();',
    '  </script>',
    '</body>',
    '</html>',
    '',
  ];
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 后端：分派入口 + 三套模板                                             */
/* ------------------------------------------------------------------ */

/**
 * 渲染内存态后端（api.js，CommonJS 无框架同构模块）：按路由清单分派模板。
 * @param routes 路由清单（决定模板种类与资源分桶）
 */
export function renderApiJs(routes: string[]): string {
  const kind = kindOfRoutes(routes);
  if (kind === 'dashboard') return renderDashboardApi();
  if (kind === 'landing') return renderLandingApi();
  return renderCrudApi(routes);
}

/** CRUD 后端：/api/<resource> 内存数组分桶，REST 增删改查（200/201/400/404/405） */
function renderCrudApi(routes: string[]): string {
  const list = routes.length > 0 ? routes : [DEFAULT_API_ROUTE];
  const primary = resourceOf(list[0] ?? DEFAULT_API_ROUTE);
  const lines: string[] = [
    "'use strict';",
    '/**',
    ' * 内存态后端（无框架、同构）：handle(method, path, body)',
    ' * 运行边界：浏览器沙箱内执行——禁 fs/net/本地存储，刷新页面即重置。',
    ` * 路由：${list.join(', ')}`,
    ' * 响应统一为 { code, data?, message? }；REST 状态码：200/201/400/404/405。',
    ' */',
    'var db = {};',
    'var nextId = 1;',
    '',
    'function seed() {',
    ...list.map((r) => `  db.${resourceOf(r)} = [{ id: nextId++, title: '示例任务', done: false }];`),
    '}',
    'seed();',
    '',
    'function bucket(resource) {',
    '  if (!Object.prototype.hasOwnProperty.call(db, resource)) return null;',
    '  return db[resource];',
    '}',
    '',
    'function findIndex(list, id) {',
    '  for (var i = 0; i < list.length; i++) { if (list[i].id === id) return i; }',
    '  return -1;',
    '}',
    '',
    '/** 同构入口：method=HTTP 方法，path=/api/<resource>[/id]，body=JSON 对象 */',
    'function handle(method, path, body) {',
    '  var parts = String(path || "").split("/").filter(Boolean);',
    `  var resource = parts[1] || '${primary}';`,
    '  var id = parts.length > 2 ? Number(parts[2]) : null;',
    '  var list = bucket(resource);',
    '  if (list === null) return { code: 404, message: "未知资源：" + resource };',
    '  var action = String(method || "GET").toUpperCase();',
    '',
    '  if (action === "GET" && id === null) return { code: 200, data: list };',
    '',
    '  if (action === "POST") {',
    '    var title = body && typeof body.title === "string" ? body.title.trim() : "";',
    '    if (title.length === 0) return { code: 400, message: "title 不能为空" };',
    '    var created = { id: nextId++, title: title, done: false };',
    '    list.unshift(created);',
    '    return { code: 201, data: created };',
    '  }',
    '',
    '  if (action !== "GET" && action !== "PUT" && action !== "PATCH" && action !== "DELETE") {',
    '    return { code: 405, message: "不支持的方法：" + action };',
    '  }',
    '  if (id === null) return { code: 404, message: "缺少资源 id" };',
    '  var at = findIndex(list, id);',
    '  if (at < 0) return { code: 404, message: "条目不存在" };',
    '',
    '  if (action === "GET") return { code: 200, data: list[at] };',
    '  if (action === "PUT" || action === "PATCH") {',
    '    var patch = body || {};',
    '    if (typeof patch.title === "string" && patch.title.trim().length > 0) list[at].title = patch.title.trim();',
    '    if (typeof patch.done === "boolean") list[at].done = patch.done;',
    '    return { code: 200, data: list[at] };',
    '  }',
    '  if (action === "DELETE") {',
    '    var removed = list.splice(at, 1)[0];',
    '    return { code: 200, data: { ok: true, id: removed.id } };',
    '  }',
    '  return { code: 405, message: "不支持的方法：" + action };',
    '}',
    '',
    'module.exports = { handle: handle };',
    '',
  ];
  return lines.join('\n');
}

/** 仪表盘后端：/api/stats 只读聚合（total/done/rate/recent），写方法一律 405 */
function renderDashboardApi(): string {
  const lines: string[] = [
    "'use strict';",
    '/**',
    ' * 内存态后端（无框架、同构）：handle(method, path, body)——仪表盘聚合（只读）。',
    ' * 运行边界：浏览器沙箱内执行——禁 fs/net/本地存储，刷新页面即重置。',
    ` * 路由：${DASHBOARD_ROUTE}；GET 返回聚合 { total, done, rate, recent }；写方法 405。`,
    ' * 响应统一为 { code, data?, message? }。',
    ' */',
    'var items = [',
    "  { id: 1, title: '需求梳理', done: true },",
    "  { id: 2, title: '原型设计', done: true },",
    "  { id: 3, title: '前端开发', done: false },",
    "  { id: 4, title: '联调验收', done: false },",
    '];',
    '',
    'function stats() {',
    '  var total = items.length;',
    '  var done = 0;',
    '  for (var i = 0; i < items.length; i++) { if (items[i].done) done += 1; }',
    '  var rate = total === 0 ? 0 : Math.round((done / total) * 100);',
    '  return { total: total, done: done, rate: rate, recent: items.slice(0, 7) };',
    '}',
    '',
    '/** 同构入口：method=HTTP 方法，path=/api/stats，body=JSON 对象（聚合只读，忽略） */',
    'function handle(method, path, body) {',
    '  var parts = String(path || "").split("/").filter(Boolean);',
    "  var resource = parts[1] || 'stats';",
    '  var action = String(method || "GET").toUpperCase();',
    '  if (resource !== \'stats\') return { code: 404, message: "未知资源：" + resource };',
    '  if (parts.length > 2) return { code: 404, message: "聚合资源不支持按 id 访问" };',
    '  if (action !== \'GET\') return { code: 405, message: "统计资源只读，不支持方法：" + action };',
    '  return { code: 200, data: stats() };',
    '}',
    '',
    'module.exports = { handle: handle };',
    '',
  ];
  return lines.join('\n');
}

/** 落地页后端：/api/leads 留资（GET 最近 20 条 / POST 201 / 其余 405） */
function renderLandingApi(): string {
  const lines: string[] = [
    "'use strict';",
    '/**',
    ' * 内存态后端（无框架、同构）：handle(method, path, body)——落地页留资。',
    ' * 运行边界：浏览器沙箱内执行——禁 fs/net/本地存储，刷新页面即重置。',
    ` * 路由：${LANDING_ROUTE}；GET 最近留资（新→旧，最多 20 条）；POST 留资 {contact} → 201。`,
    ' * 响应统一为 { code, data?, message? }；状态码：200/201/400/404/405。',
    ' */',
    'var leads = [',
    "  { id: 1, contact: 'demo@atoms.dev' },",
    "  { id: 2, contact: '微信 demo-atom' },",
    '];',
    'var nextId = 3;',
    '',
    '/** 同构入口：method=HTTP 方法，path=/api/leads，body=JSON 对象 */',
    'function handle(method, path, body) {',
    '  var parts = String(path || "").split("/").filter(Boolean);',
    "  var resource = parts[1] || 'leads';",
    '  var action = String(method || "GET").toUpperCase();',
    '  if (resource !== \'leads\') return { code: 404, message: "未知资源：" + resource };',
    '  if (action === "GET" && parts.length === 2) return { code: 200, data: leads.slice(0, 20) };',
    '  if (action === "POST") {',
    '    var contact = body && typeof body.contact === "string" ? body.contact.trim() : "";',
    '    if (contact.length === 0) return { code: 400, message: "contact 不能为空" };',
    '    var lead = { id: nextId++, contact: contact };',
    '    leads.unshift(lead);',
    '    return { code: 201, data: lead };',
    '  }',
    '  if (action === "GET") return { code: 404, message: "留资不支持按 id 访问" };',
    '  return { code: 405, message: "留资接口只支持 GET/POST：" + action };',
    '}',
    '',
    'module.exports = { handle: handle };',
    '',
  ];
  return lines.join('\n');
}

/** 渲染启动说明脚本（浏览器内全栈：无需安装依赖、无需本地 node 进程） */
export function renderStartSh(): string {
  const lines: string[] = [
    '#!/usr/bin/env sh',
    '# 生成应用启动说明（Atoms-Demo 浏览器内全栈）',
    '# 后端 = api.js 的 handle(method,path,body)，由平台 fetch 拦截垫片在浏览器内装配，',
    '# 因此前端与后端都无需安装依赖、无需启动本地服务。',
    'set -e',
    '',
    'echo "[atoms] 预览：在平台预览面板打开 app/frontend/index.html 即可运行。"',
    'echo "[atoms] 数据为内存态：刷新即重置；应用零依赖，不做 npm install。"',
    '',
  ];
  return lines.join('\n');
}
