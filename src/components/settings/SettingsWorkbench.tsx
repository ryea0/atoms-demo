'use client';

/**
 * 设置页工作台（Task 24 / P3.5）：RSC 初始快照 + 三个 tab（服务商与模型 / 角色绑定 / 用量）。
 * 写操作走 /api/settings/*，成功后重拉快照对齐状态（不自造缓存）；Toaster 挂在本页，不进根布局。
 */
import { useCallback, useState } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fetchBindings, fetchProviderList } from '@/lib/settings/client';
import type { SettingsSnapshot } from '@/lib/settings/types';
import { ModelBindPanel } from './ModelBindPanel';
import { ProvidersPanel } from './ProvidersPanel';
import { UsageCards } from './UsageCards';

export function SettingsWorkbench(props: { initialSnapshot: SettingsSnapshot }) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>(props.initialSnapshot);

  /** 任一面板写成功后重拉列表/绑定（失败已在 client 层 toast，本地状态保持不动） */
  const refresh = useCallback(async (): Promise<void> => {
    const [providerList, bindings] = await Promise.all([fetchProviderList(), fetchBindings()]);
    setSnapshot((prev) => ({
      ...prev,
      providers: providerList?.providers ?? prev.providers,
      models: providerList?.models ?? prev.models,
      bindings: bindings?.bindings ?? prev.bindings,
    }));
  }, []);

  return (
    <div className="bg-background text-foreground mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8">
      <Toaster position="top-center" richColors />
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">设置</h1>
        <p className="text-muted-foreground text-sm">
          管理模型服务商、按团队成员绑定模型，并查看平台累计用量（api key 只在服务端保存）。
        </p>
      </header>

      <Tabs defaultValue="providers">
        <TabsList>
          <TabsTrigger value="providers">服务商与模型</TabsTrigger>
          <TabsTrigger value="bindings">角色绑定</TabsTrigger>
          <TabsTrigger value="usage">用量</TabsTrigger>
        </TabsList>
        <TabsContent value="providers">
          <ProvidersPanel providers={snapshot.providers} models={snapshot.models} onChanged={refresh} />
        </TabsContent>
        <TabsContent value="bindings">
          <ModelBindPanel
            bindings={snapshot.bindings}
            models={snapshot.models}
            providers={snapshot.providers}
            onChanged={refresh}
          />
        </TabsContent>
        <TabsContent value="usage">
          <UsageCards usage={snapshot.usage} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
