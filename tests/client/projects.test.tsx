/**
 * Task 25 R1 测试：卡片墙模板画廊行（seed 示例卡）。
 *
 * 语义：seed 行对所有会话可见（union 在服务端列表路由，见 tests/api/routes.test.ts），
 * 卡片层职责是「可识别 + 可打开 + 不可误操作」——示例角标、标题/菜单走
 * `/api/projects/[id]/open`（打开即克隆），不提供重命名/导出/删除。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProjectCard } from '@/components/projects/ProjectCard';
import type { ProjectListItem } from '@/lib/db/provider/types';

function makeProject(over: Partial<ProjectListItem> = {}): ProjectListItem {
  return {
    id: 7,
    sessionId: 'session-a',
    title: '待办清单应用',
    requirement: '做一个待办清单',
    mode: 'fast',
    status: 'done',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    fileCount: 6,
    totalTokens: 0,
    lastMessage: null,
    ...over,
  };
}

const noop = (): void => undefined;

/** 打开右上角操作菜单（radix DropdownMenu 以 pointerdown 触发） */
function openMenu(): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: /更多操作 / }), { button: 0, ctrlKey: false });
}

beforeEach(() => cleanup());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ProjectCard 模板画廊行', () => {
  it('seed 行：示例角标 + 打开动作走 open 端点（克隆后进入副本）', () => {
    render(createElement(ProjectCard, { project: makeProject(), isSeed: true, onChanged: noop, onDeleted: noop }));

    expect(screen.getByText('示例')).toBeInTheDocument();
    expect(screen.getByTitle('打开示例：会复制一份到你的项目里')).toHaveAttribute(
      'href',
      '/api/projects/7/open',
    );
  });

  it('seed 行菜单只有「打开示例」，不提供导出/删除；双击不进入重命名', () => {
    const openMock = vi.fn<(url?: string | URL, target?: string) => Window | null>().mockReturnValue(null);
    vi.stubGlobal('open', openMock);
    render(createElement(ProjectCard, { project: makeProject(), isSeed: true, onChanged: noop, onDeleted: noop }));

    openMenu();
    expect(screen.getByRole('menuitem', { name: /打开示例/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /进入工作台/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /导出 zip/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /删除项目/ })).not.toBeInTheDocument();

    // 双击标题不进入重命名（模板行不可改名）
    fireEvent.doubleClick(screen.getByTitle('打开示例：会复制一份到你的项目里'));
    expect(screen.queryByRole('textbox', { name: '项目标题' })).not.toBeInTheDocument();
  });

  it('普通行不受影响：状态徽章 + 进入工作台/导出/删除齐全，链接仍指向 /p/{id}', () => {
    render(
      createElement(ProjectCard, {
        project: makeProject({ status: 'running' }),
        onChanged: noop,
        onDeleted: noop,
      }),
    );

    expect(screen.queryByText('示例')).not.toBeInTheDocument();
    expect(screen.getByText('生成中')).toBeInTheDocument();
    expect(screen.getByTitle('双击重命名')).toHaveAttribute('href', '/p/7');

    openMenu();
    expect(screen.getByRole('menuitem', { name: /进入工作台/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /导出 zip/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /删除项目/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /打开示例/ })).not.toBeInTheDocument();
  });
});
