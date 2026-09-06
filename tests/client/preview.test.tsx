/**
 * Task 22 测试：预览面板（E1 全栈预览，DESIGN §3.7 / rules 07 预览隔离）。
 *
 * 隔离红线逐字断言：iframe 只带 sandbox="allow-scripts"（绝不允许 allow-same-origin），
 * src 指向服务端装配路由（fetch 垫片与 CSP 都由服务端下发，客户端不重复实现）。
 * 行为断言聚焦：占位条件（files 无 app/frontend/index.html）、设备宽度切换
 * （切宽度不重载 iframe——生成应用的内存态不能丢）、刷新=iframe 重挂（src 重设）、
 * 新窗口参数（noopener/noreferrer）。占位态工具动作必须禁用（避免打开 404 装配页）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FRONTEND_INDEX_PATH, PreviewPane } from '@/components/preview/PreviewPane';
// 服务端镜像常量（服务端专用模块，但无服务端依赖——仅类型 import，测试内引用安全）
import { PREVIEW_INDEX_PATH } from '@/lib/preview/assemble';

const PROJECT_ID = 12;
const PREVIEW_PATH = `/api/projects/${PROJECT_ID}/preview`;

function mountPane(hasFrontend: boolean): void {
  render(createElement(PreviewPane, { projectId: PROJECT_ID, hasFrontend }));
}

function previewIframe(): HTMLIFrameElement {
  const node = screen.getByTitle('应用预览');
  if (!(node instanceof HTMLIFrameElement)) throw new TypeError('应用预览不是 iframe');
  return node;
}

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* 契约常量一致性                                                       */
/* ------------------------------------------------------------------ */

describe('前端入口路径镜像常量', () => {
  it('客户端 FRONTEND_INDEX_PATH 与服务端 PREVIEW_INDEX_PATH 逐字一致（漂移即预览占位误判）', () => {
    expect(FRONTEND_INDEX_PATH).toBe(PREVIEW_INDEX_PATH);
  });
});

/* ------------------------------------------------------------------ */
/* 占位与 iframe 隔离                                                   */
/* ------------------------------------------------------------------ */

describe('占位与 iframe 隔离', () => {
  it(`files 无 ${FRONTEND_INDEX_PATH}：显示占位「工程师完成 frontend 后可预览」，不渲染 iframe，工具动作禁用`, () => {
    mountPane(false);

    expect(screen.getByText('工程师完成 frontend 后可预览')).toBeInTheDocument();
    expect(screen.queryByTitle('应用预览')).not.toBeInTheDocument();

    // 尚无生成物：刷新/新窗口只会得到 404 装配页，必须禁用
    expect(screen.getByRole('button', { name: '刷新预览' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '新窗口打开预览' })).toBeDisabled();
    for (const label of ['手机', '平板', '全宽']) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled();
    }
  });

  it('frontend 就绪：iframe 指向同源装配路由，sandbox 仅 allow-scripts（无 allow-same-origin），满幅铺满', () => {
    mountPane(true);

    const iframe = previewIframe();
    expect(iframe).toHaveAttribute('src', PREVIEW_PATH);
    // rules 07 逐字：不带 allow-same-origin（生成应用因此不可用 localStorage/cookie）
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe.className).toContain('h-full');
    expect(iframe.className).toContain('w-full');
  });
});

/* ------------------------------------------------------------------ */
/* 设备宽度切换                                                          */
/* ------------------------------------------------------------------ */

describe('设备宽度切换', () => {
  it('默认全宽；切手机 375 / 平板 768 时容器宽度与选中态联动，容器居中且带设备框', () => {
    mountPane(true);
    const frameClassName = (): string => previewIframe().parentElement?.className ?? '';

    expect(frameClassName()).toContain('w-full');
    expect(frameClassName()).toContain('mx-auto');
    expect(frameClassName()).toContain('border-border');
    expect(screen.getByRole('button', { name: '全宽' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: '手机' }));
    expect(frameClassName()).toContain('w-[375px]');
    expect(frameClassName()).not.toContain('w-[768px]');
    expect(screen.getByRole('button', { name: '手机' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '全宽' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: '平板' }));
    expect(frameClassName()).toContain('w-[768px]');
    expect(frameClassName()).not.toContain('w-[375px]');
  });

  it('切宽度不重载 iframe（DOM 节点保持，生成应用的内存态不丢）', () => {
    mountPane(true);
    const before = previewIframe();

    fireEvent.click(screen.getByRole('button', { name: '手机' }));

    expect(previewIframe()).toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* 工具条（刷新 / 新窗口）                                               */
/* ------------------------------------------------------------------ */

describe('工具条', () => {
  it('刷新：iframe 重新挂载（src 重设 → 重新拉最新装配产物），沙箱属性保持', () => {
    mountPane(true);
    const before = previewIframe();

    fireEvent.click(screen.getByRole('button', { name: '刷新预览' }));

    const after = previewIframe();
    expect(after).not.toBe(before);
    expect(after).toHaveAttribute('src', PREVIEW_PATH);
    expect(after).toHaveAttribute('sandbox', 'allow-scripts');
  });

  it('新窗口：以 _blank + noopener,noreferrer 打开同源预览地址', () => {
    const openMock = vi.fn<(url: string, target: string, features: string) => void>();
    vi.stubGlobal('open', openMock);
    mountPane(true);

    fireEvent.click(screen.getByRole('button', { name: '新窗口打开预览' }));

    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock).toHaveBeenCalledWith(PREVIEW_PATH, '_blank', 'noopener,noreferrer');
  });

  it('触控目标：<lg 档位扩到 ≥44px（jsdom 不套 CSS，断言响应式标记类）', () => {
    mountPane(true);

    expect(screen.getByRole('button', { name: '刷新预览' }).className).toContain('max-lg:size-11');
    expect(screen.getByRole('button', { name: '新窗口打开预览' }).className).toContain('max-lg:size-11');
    for (const label of ['手机', '平板', '全宽']) {
      expect(screen.getByRole('button', { name: label }).className).toContain('max-lg:h-11');
    }
  });
});
