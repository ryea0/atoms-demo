/**
 * /settings（Task 24 / P3.5）：模型服务商、角色绑定与用量。
 * 服务端组件直调服务层取初始快照（.claude/rules/02：读不走自家 HTTP API），
 * 交互交给 SettingsWorkbench（client）。读库页面必须 force-dynamic（不预渲染、不缓存）。
 */
import type { Metadata } from 'next';
import { SettingsWorkbench } from '@/components/settings/SettingsWorkbench';
import { loadSettingsSnapshot } from '@/lib/settings/service';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '设置 · Atoms-Demo',
  description: '管理模型服务商、按角色绑定模型与查看用量',
};

export default async function SettingsPage() {
  const snapshot = await loadSettingsSnapshot();
  return <SettingsWorkbench initialSnapshot={snapshot} />;
}
