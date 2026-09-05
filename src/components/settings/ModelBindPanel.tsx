'use client';

/**
 * 角色级模型绑定面板（Task 24 / P3.5，DESIGN §5①三级路由）：
 * 7 个角色各一行，下拉选该角色的模型；「跟随全局默认」= 清除绑定（resolveRoleModel 回退 env）。
 * 选项按服务商分组（optgroup），值为 `providerId:modelId`，改动即保存。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { roleRegistry } from '@/lib/agents/registry';
import { putBinding } from '@/lib/settings/client';
import type { BindingView, ModelView, ProviderView } from '@/lib/settings/types';

export interface ModelBindPanelProps {
  bindings: BindingView[];
  models: ModelView[];
  providers: ProviderView[];
  /** 保存成功后由父级刷新快照 */
  onChanged: () => Promise<void>;
}

/** 下拉选项值：`${providerId}:${modelId}`（空串 = 跟随全局默认） */
function optionValue(binding: BindingView): string {
  return binding.providerId !== null && binding.modelId !== null ? `${binding.providerId}:${binding.modelId}` : '';
}

export function ModelBindPanel({ bindings, models, providers, onChanged }: ModelBindPanelProps) {
  const [savingRole, setSavingRole] = useState<string | null>(null);

  const available = providers.filter(
    (provider) => provider.enabled && models.some((model) => model.providerId === provider.id),
  );

  async function change(binding: BindingView, value: string): Promise<void> {
    const [providerId, modelId] = value === '' ? [undefined, undefined] : value.split(':').map(Number);
    setSavingRole(binding.role);
    const saved = await putBinding({
      role: binding.role,
      providerId: providerId !== undefined && Number.isInteger(providerId) ? providerId : undefined,
      modelId: modelId !== undefined && Number.isInteger(modelId) ? modelId : undefined,
    });
    setSavingRole(null);
    if (saved === null) return;
    toast.success(
      saved.modelLabel === null
        ? `${roleRegistry[binding.role].name} 将跟随全局默认模型`
        : `${roleRegistry[binding.role].name} 已绑定 ${saved.modelLabel}`,
    );
    await onChanged();
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-muted-foreground text-xs">
          <tr>
            <th className="py-2 pr-3 font-normal">团队成员</th>
            <th className="py-2 pr-3 font-normal">使用模型</th>
          </tr>
        </thead>
        <tbody>
          {bindings.map((binding) => {
            const meta = roleRegistry[binding.role];
            return (
              <tr key={binding.role} className="border-border border-t">
                <td className="py-2 pr-3 align-middle">
                  <span className="flex items-center gap-2">
                    <span aria-hidden>{meta.emoji}</span>
                    <span>{meta.name}</span>
                    <span className="text-muted-foreground hidden text-xs sm:inline">{binding.modelLabel ?? ''}</span>
                  </span>
                </td>
                <td className="py-2 pr-3 align-middle">
                  <select
                    aria-label={`${meta.name}使用模型`}
                    className="h-9 w-full max-w-72 rounded-md border border-input bg-background px-3 text-sm"
                    value={optionValue(binding)}
                    disabled={savingRole === binding.role}
                    onChange={(event) => change(binding, event.target.value)}
                  >
                    <option value="">跟随全局默认</option>
                    {available.map((provider) => (
                      <optgroup key={provider.id} label={provider.name}>
                        {models
                          .filter((model) => model.providerId === provider.id)
                          .map((model) => (
                            <option key={model.id} value={`${provider.id}:${model.id}`}>
                              {model.displayName === model.modelId
                                ? model.displayName
                                : `${model.displayName}（${model.modelId}）`}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {available.length === 0 ? (
        <p className="text-muted-foreground mt-3 text-xs">
          还没有可用的模型：先在「服务商与模型」里添加服务商并导入模型，再回到这里绑定。
        </p>
      ) : null}
    </div>
  );
}
