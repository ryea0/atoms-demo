'use client';

/**
 * 预览面板（Task 22，DESIGN §3.7 全栈预览 / rules 07 预览隔离）。
 *
 * 职责：把服务端装配好的全栈预览装进 iframe——垫片注入、CSP 下发都在
 * `GET /api/projects/[id]/preview`（服务端行为，客户端不重复实现）；本组件只负责
 * 入口 iframe、设备宽度切换（375 / 768 / 100%）、刷新（重挂 iframe=重设 src）与新窗口。
 *
 * 隔离红线：iframe 只带 sandbox="allow-scripts"，绝无 allow-same-origin——
 * 生成应用因此不可用 localStorage/cookie，后端全部走被拦截的 /api/* 同源请求。
 * 数据来源：由 Workspace 从 useWorkspace 的 files Map 判断 hasFrontend 传入；
 * 本组件不订阅 store（避免第二条 SSE 连接）。
 */
import { useCallback, useState } from 'react';
import { Maximize2, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PaneEmpty } from '@/components/workspace/PaneShell';
import { openProjectPreview, projectPreviewPath } from '@/lib/client/session';
import { cn } from '@/lib/utils';

/**
 * 前端入口契约路径（服务端 `PREVIEW_INDEX_PATH` 的客户端镜像常量；
 * assemble.ts 是服务端专用模块，不从客户端 import 以免进 bundle）。
 */
export const FRONTEND_INDEX_PATH = 'app/frontend/index.html';

/** 设备宽度档位：className 必须是 Tailwind 字面量（JIT 扫描源码文本） */
const DEVICE_PRESETS: readonly { key: string; label: string; className: string }[] = [
  { key: 'mobile', label: '手机', className: 'w-[375px]' },
  { key: 'tablet', label: '平板', className: 'w-[768px]' },
  { key: 'full', label: '全宽', className: 'w-full' },
] as const;

export interface PreviewPaneProps {
  /** 预览装配路由的项目 id（同源路径） */
  projectId: number;
  /** files Map 是否已产出 app/frontend/index.html（false → 占位，工具动作禁用） */
  hasFrontend: boolean;
}

export function PreviewPane({ projectId, hasFrontend }: PreviewPaneProps) {
  const [deviceKey, setDeviceKey] = useState('full');
  // 刷新 = 重设 src：递增 token 作为 key 让 React 重挂 iframe（jsdom 与真浏览器都成立）
  const [reloadToken, setReloadToken] = useState(0);

  const activeDevice = DEVICE_PRESETS.find((preset) => preset.key === deviceKey);
  const handleReload = useCallback(() => setReloadToken((token) => token + 1), []);
  const handleOpenWindow = useCallback(() => openProjectPreview(projectId), [projectId]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* 工具条：设备宽度 + 刷新 + 新窗口全屏 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-2 sm:px-3">
        <div role="group" aria-label="设备宽度" className="flex items-center gap-0.5">
          {DEVICE_PRESETS.map((preset) => {
            const isActive = preset.key === deviceKey;
            return (
              <Button
                key={preset.key}
                size="sm"
                variant={isActive ? 'secondary' : 'ghost'}
                aria-pressed={isActive}
                onClick={() => setDeviceKey(preset.key)}
                disabled={!hasFrontend}
                title={`视口宽度 ${preset.label}`}
                /* 桌面保持紧凑条高；<lg 扩到 44px 触控目标（规则 04） */
                className="h-7 px-2 text-xs max-lg:h-11"
              >
                {preset.label}
              </Button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新预览"
            title="刷新预览"
            onClick={handleReload}
            disabled={!hasFrontend}
            className="size-9 max-lg:size-11"
          >
            <RotateCw className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="新窗口打开预览"
            title="新窗口全屏打开"
            onClick={handleOpenWindow}
            disabled={!hasFrontend}
            className="size-9 max-lg:size-11"
          >
            <Maximize2 className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      {hasFrontend && activeDevice !== undefined ? (
        /* 舞台：设备框居中（375/768 时示意宽度），仅宽度变化不重载 iframe（内存态保留） */
        <div className="min-h-0 flex-1 overflow-auto bg-panel p-3 sm:p-4">
          <div
            className={cn(
              'mx-auto h-full overflow-hidden rounded-xl border border-border bg-background',
              activeDevice.className,
            )}
          >
            <iframe
              key={reloadToken}
              src={projectPreviewPath(projectId)}
              sandbox="allow-scripts"
              title="应用预览"
              className="h-full w-full border-0"
            />
          </div>
        </div>
      ) : (
        <PaneEmpty
          hint="工程师完成 frontend 后可预览"
          sub={`生成出 ${FRONTEND_INDEX_PATH} 后，这里会加载服务端装配的全栈应用`}
        />
      )}
    </div>
  );
}
