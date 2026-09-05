'use client';

/**
 * 服务商管理面板（Task 24 / P3.5，DESIGN §5①）：
 * 预设下拉（豆包/ARK、DeepSeek、GLM、Kimi、OpenAI、自定义）→ 填 base_url / key（password 态）/ enabled；
 * 列表只显脱敏尾 4 位；「测试连接」显延迟与模型数（失败显脱敏错误）；「导入模型」把探测清单去重落库。
 * 该 provider 名下的模型清单在 ProviderModelsTable 内就地编辑（显示名/单价/启用/删除）。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  createProvider,
  deleteProvider,
  importProviderModels,
  probeProvider,
  updateProvider,
} from '@/lib/settings/client';
import { providerPresets } from '@/lib/settings/presets';
import type { ModelView, ProviderView } from '@/lib/settings/types';
import { ProviderModelsTable } from './ProviderModelsTable';
import { FieldLabel } from './field-label';

export interface ProvidersPanelProps {
  providers: ProviderView[];
  models: ModelView[];
  /** 任一写操作成功后由父级刷新快照（重新拉列表） */
  onChanged: () => Promise<void>;
}

export function ProvidersPanel({ providers, models, onChanged }: ProvidersPanelProps) {
  const firstPreset = providerPresets[0];
  const [presetKey, setPresetKey] = useState<string>(firstPreset?.key ?? 'custom');
  const [name, setName] = useState<string>(firstPreset?.name ?? '');
  const [baseUrl, setBaseUrl] = useState<string>(firstPreset?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState<string>('');
  const [enabled, setEnabled] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);

  /** 选预设即预填（用户仍可改名/改地址；自定义预设清空） */
  function applyPreset(key: string): void {
    setPresetKey(key);
    const preset = providerPresets.find((item) => item.key === key);
    if (preset === undefined) return;
    setName(preset.name);
    setBaseUrl(preset.baseUrl);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (apiKey.trim() === '') {
      toast.error('api key 必填');
      return;
    }
    setSubmitting(true);
    const ok = await createProvider({ name, baseUrl, apiKey, enabled });
    setSubmitting(false);
    if (!ok) return;
    toast.success(`已添加服务商「${name}」`);
    setApiKey('');
    await onChanged();
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 新增表单 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">添加服务商</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={submit}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <FieldLabel htmlFor="preset">预设服务商</FieldLabel>
                <select
                  id="preset"
                  aria-label="预设服务商"
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={presetKey}
                  onChange={(event) => applyPreset(event.target.value)}
                >
                  {providerPresets.map((preset) => (
                    <option key={preset.key} value={preset.key}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel htmlFor="provider-name">名称</FieldLabel>
                <Input
                  id="provider-name"
                  value={name}
                  maxLength={60}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="服务商名称"
                  required
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="provider-base-url">Base URL（OpenAI 兼容地址）</FieldLabel>
              <Input
                id="provider-base-url"
                className="font-mono"
                value={baseUrl}
                maxLength={300}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://ark.cn-beijing.volces.com/api/v3"
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="provider-api-key">API Key</FieldLabel>
              <Input
                id="provider-api-key"
                type="password"
                autoComplete="new-password"
                className="font-mono"
                value={apiKey}
                maxLength={400}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="仅服务端保存，列表只显示尾 4 位"
                required
              />
            </div>
            <div className="flex items-center justify-between">
              <FieldLabel htmlFor="provider-enabled" className="text-muted-foreground">
                启用后才会被角色绑定选用
              </FieldLabel>
              <Switch id="provider-enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>
            <Button type="submit" disabled={submitting} className="self-start">
              添加服务商
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* 已有服务商列表 */}
      {providers.length === 0 ? (
        <p className="text-muted-foreground text-sm">还没有服务商，先用上方表单添加一个。</p>
      ) : (
        providers.map((provider) => (
          <ProviderCard key={provider.id} provider={provider} models={models} onChanged={onChanged} />
        ))
      )}
    </div>
  );
}

/** 单个服务商卡片：连接信息（脱敏）、启停、测试连接、导入模型、删除 */
function ProviderCard(props: {
  provider: ProviderView;
  models: ModelView[];
  onChanged: () => Promise<void>;
}) {
  const { provider, models, onChanged } = props;
  const [probing, setProbing] = useState<boolean>(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [importing, setImporting] = useState<boolean>(false);
  const [removing, setRemoving] = useState<boolean>(false);

  async function testConnection(): Promise<void> {
    setProbing(true);
    const probe = await probeProvider(provider.id);
    setProbing(false);
    if (probe === null) {
      setProbeResult(null);
      return;
    }
    setProbeResult(
      probe.ok
        ? `✓ ${probe.latencyMs}ms · ${probe.modelCount} 个模型${probe.models.length > 0 ? `：${probe.models.join('、')}` : ''}`
        : `✗ ${probe.error ?? '探测失败'}`,
    );
  }

  async function importModels(): Promise<void> {
    setImporting(true);
    const result = await importProviderModels(provider.id);
    setImporting(false);
    if (result === null) return;
    toast.success(`导入完成：发现 ${result.discovered} 个，新增 ${result.imported} 个，跳过 ${result.skipped} 个`);
    await onChanged();
  }

  async function remove(): Promise<void> {
    setRemoving(true);
    const ok = await deleteProvider(provider.id);
    setRemoving(false);
    if (!ok) return;
    toast.success(`已删除「${provider.name}」（其下模型与绑定一并清除）`);
    await onChanged();
  }

  async function toggleEnabled(next: boolean): Promise<void> {
    const ok = await updateProvider(provider.id, { enabled: next });
    if (!ok) return;
    toast.success(next ? `已启用「${provider.name}」` : `已停用「${provider.name}」`);
    await onChanged();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {provider.name}
          <Badge variant={provider.enabled ? 'default' : 'secondary'}>{provider.enabled ? '已启用' : '已停用'}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="text-muted-foreground flex flex-col gap-1 text-xs">
          <span className="font-mono break-all">{provider.baseUrl}</span>
          <span className="flex items-center gap-2">
            密钥
            {/* 脱敏值独立成节点：只显示尾 4 位，原始 key 不在前端任何位置 */}
            <span className="font-mono">{provider.apiKeyMasked}</span>
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={testConnection} disabled={probing}>
            测试连接
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={importModels} disabled={importing}>
            导入模型
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={remove} disabled={removing}>
            删除
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-muted-foreground text-xs">启用</span>
            <Switch checked={provider.enabled} onCheckedChange={toggleEnabled} aria-label={`启用 ${provider.name}`} />
          </div>
        </div>

        {probeResult !== null ? <p className="text-muted-foreground text-xs break-all">{probeResult}</p> : null}

        <ProviderModelsTable
          models={models.filter((model) => model.providerId === provider.id)}
          onChanged={onChanged}
        />
      </CardContent>
    </Card>
  );
}
