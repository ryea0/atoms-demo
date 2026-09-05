'use client';

/**
 * 服务商名下的模型清单（Task 24 / P3.5）：就地编辑显示名/输入输出单价/启停，可删除。
 * 每行独立持草稿态（state 放最小子树），保存成功后由父级刷新快照。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { deleteModel, updateModel } from '@/lib/settings/client';
import type { ModelView } from '@/lib/settings/types';

export function ProviderModelsTable(props: { models: ModelView[]; onChanged: () => Promise<void> }) {
  if (props.models.length === 0) {
    return <p className="text-muted-foreground text-xs">该服务商还没有模型，点「导入模型」从服务商拉取。</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1.5 pr-3 font-normal">model_id</th>
            <th className="py-1.5 pr-3 font-normal">显示名</th>
            <th className="py-1.5 pr-3 font-normal">输入单价</th>
            <th className="py-1.5 pr-3 font-normal">输出单价</th>
            <th className="py-1.5 pr-3 font-normal">启用</th>
            <th className="py-1.5 font-normal">操作</th>
          </tr>
        </thead>
        <tbody>
          {props.models.map((model) => (
            <ModelRow key={model.id} model={model} onChanged={props.onChanged} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 单行：草稿态仅在该行内，避免整表重渲染（.claude/rules/03 状态就近） */
function ModelRow(props: { model: ModelView; onChanged: () => Promise<void> }) {
  const { model } = props;
  const [displayName, setDisplayName] = useState<string>(model.displayName);
  const [priceInput, setPriceInput] = useState<string>(String(model.priceInput));
  const [priceOutput, setPriceOutput] = useState<string>(String(model.priceOutput));
  const [saving, setSaving] = useState<boolean>(false);

  async function save(): Promise<void> {
    const parsedInput = Number(priceInput);
    const parsedOutput = Number(priceOutput);
    if (!Number.isFinite(parsedInput) || parsedInput < 0 || !Number.isFinite(parsedOutput) || parsedOutput < 0) {
      toast.error('单价需为不小于 0 的数字');
      return;
    }
    setSaving(true);
    const ok = await updateModel(model.id, {
      displayName,
      priceInput: parsedInput,
      priceOutput: parsedOutput,
    });
    setSaving(false);
    if (!ok) return;
    toast.success(`已保存「${displayName}」`);
    await props.onChanged();
  }

  async function remove(): Promise<void> {
    const ok = await deleteModel(model.id);
    if (!ok) return;
    toast.success(`已删除模型「${model.modelId}」`);
    await props.onChanged();
  }

  async function toggleEnabled(next: boolean): Promise<void> {
    const ok = await updateModel(model.id, { enabled: next });
    if (!ok) return;
    await props.onChanged();
  }

  const cellClass = 'py-1.5 pr-3 align-middle';
  return (
    <tr className="border-border border-t">
      <td className={`${cellClass} font-mono`}>{model.modelId}</td>
      <td className={cellClass}>
        <Input
          aria-label={`显示名 ${model.modelId}`}
          className="h-7 w-36 text-xs"
          value={displayName}
          maxLength={120}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </td>
      <td className={cellClass}>
        <Input
          aria-label={`输入单价 ${model.modelId}`}
          className="h-7 w-20 font-mono text-xs"
          type="number"
          min={0}
          step="0.0001"
          value={priceInput}
          onChange={(event) => setPriceInput(event.target.value)}
        />
      </td>
      <td className={cellClass}>
        <Input
          aria-label={`输出单价 ${model.modelId}`}
          className="h-7 w-20 font-mono text-xs"
          type="number"
          min={0}
          step="0.0001"
          value={priceOutput}
          onChange={(event) => setPriceOutput(event.target.value)}
        />
      </td>
      <td className={cellClass}>
        <Switch size="sm" checked={model.enabled} onCheckedChange={toggleEnabled} aria-label={`启用 ${model.modelId}`} />
      </td>
      <td className={cellClass}>
        <div className="flex gap-1">
          <Button type="button" variant="outline" size="sm" onClick={save} disabled={saving}>
            保存
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={remove}>
            删除
          </Button>
        </div>
      </td>
    </tr>
  );
}
