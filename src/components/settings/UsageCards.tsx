'use client';

/**
 * 用量卡片（Task 24 / P3.5，DESIGN §5③）：usageAll 全局聚合（跨项目）按 agent+model 分组，
 * 展示 tokens / 调用数 / estimated 标记（estimatedCalls>0 = 该组含按公式估算的调用）。
 * 纯展示组件：分组在渲染期由 props 推导（.claude/rules/03 不派生可计算状态）。
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { roleRegistry } from '@/lib/agents/registry';
import type { AgentRole } from '@/lib/db/provider/types';
import type { UsageCardRow } from '@/lib/settings/types';

export function UsageCards(props: { usage: UsageCardRow[] }) {
  const { usage } = props;
  const totalTokens = usage.reduce((sum, row) => sum + row.tokens, 0);
  const totalCalls = usage.reduce((sum, row) => sum + row.calls, 0);
  const estimatedCalls = usage.reduce((sum, row) => sum + row.estimatedCalls, 0);

  // 按 agent 分组（服务端已按 role+model 排序，组内顺序稳定）
  const byRole = new Map<AgentRole, UsageCardRow[]>();
  for (const row of usage) {
    const rows = byRole.get(row.agentRole);
    if (rows === undefined) byRole.set(row.agentRole, [row]);
    else rows.push(row);
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">累计用量（全部项目）</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground flex gap-6 text-sm">
          <span>
            Tokens <span className="text-foreground font-mono">{totalTokens.toLocaleString('zh-CN')}</span>
          </span>
          <span>
            调用 <span className="text-foreground font-mono">{totalCalls.toLocaleString('zh-CN')}</span> 次
          </span>
          {estimatedCalls > 0 ? <span className="text-xs">其中 {estimatedCalls} 次为估算值（服务商未返回 usage）</span> : null}
        </CardContent>
      </Card>

      {usage.length === 0 ? (
        <p className="text-muted-foreground text-sm">还没有调用记录：跑一次生成后这里会出现按团队成员分组的用量。</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[...byRole.entries()].map(([role, rows]) => (
            <Card key={role}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <span aria-hidden>{roleRegistry[role].emoji}</span>
                  {roleRegistry[role].name}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {rows.map((row) => (
                  <div key={`${row.agentRole}-${row.model}`} className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-mono truncate" title={row.model}>
                      {row.model}
                    </span>
                    <span className="text-muted-foreground flex shrink-0 items-center gap-2">
                      <span className="font-mono">{row.tokens.toLocaleString('zh-CN')} tok</span>
                      <span className="font-mono">{row.calls} 次</span>
                      {row.estimatedCalls > 0 ? (
                        <span className="bg-secondary text-secondary-foreground rounded px-1 py-0.5 text-[10px]">
                          含估算
                        </span>
                      ) : null}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
