/**
 * Task 19 测试：@ 成员提及解析（纯函数，DESIGN §3.1「@ 成员浮层数据源=RoleRegistry」）。
 *
 * - parseMention：光标前 @ 触发判定（浮层开关 + 过滤词 + 精确命中）
 * - matchRoles：候选前缀过滤（role id 不区分大小写 / 注册表中文名）
 * - applyMention：候选回填（替换 @ 片段、返回新光标）
 * - extractMentions：发送前全文兜底收集（与 chips 取并集）
 */
import { describe, expect, it } from 'vitest';
import { roleOrder } from '@/lib/agents/registry';
import { applyMention, extractMentions, matchRoles, parseMention } from '@/lib/client/mentions';

describe('parseMention', () => {
  it('无 @ 或 @ 不在词首：返回 null（浮层关闭）', () => {
    expect(parseMention('')).toBeNull();
    expect(parseMention('做一个番茄钟')).toBeNull();
    // 邮箱里的 @ 前面是单词字符，不算触发
    expect(parseMention('邮箱 a@b.com')).toBeNull();
    expect(parseMention('@a@b', 4)).toBeNull();
  });

  it('光标前 @ 触发：返回过滤词与 @ 下标（默认光标在文末）', () => {
    expect(parseMention('@')).toEqual({ query: '', start: 0, activeAgent: null });
    expect(parseMention('@产')).toEqual({ query: '产', start: 0, activeAgent: null });
    // 「做番茄钟 @工」：@ 在下标 5
    expect(parseMention('做番茄钟 @工')).toEqual({ query: '工', start: 5, activeAgent: null });
  });

  it('精确命中角色（role id 不区分大小写 / 中文名）时给出 activeAgent', () => {
    expect(parseMention('@工程师')).toEqual({ query: '工程师', start: 0, activeAgent: 'engineer' });
    expect(parseMention('@PM', 3)).toEqual({ query: 'PM', start: 0, activeAgent: 'pm' });
    expect(parseMention('@产品经理')).toEqual({ query: '产品经理', start: 0, activeAgent: 'pm' });
    expect(parseMention('@产')).toEqual({ query: '产', start: 0, activeAgent: null });
  });

  it('过滤词里出现空白或第二个 @：触发态结束', () => {
    expect(parseMention('@工 程', 5)).toBeNull();
    expect(parseMention('@工\n程', 5)).toBeNull();
  });

  it('光标只看之前的内容；越界光标判为不触发', () => {
    expect(parseMention('@工程师 帮忙', 4)).toEqual({ query: '工程师', start: 0, activeAgent: 'engineer' });
    expect(parseMention('@工程师 帮忙', 5)).toBeNull();
    expect(parseMention('@工程师', 99)).toBeNull();
  });

  it('超长过滤词不触发（防把整段文本当过滤词）', () => {
    expect(parseMention(`@${'x'.repeat(25)}`)).toBeNull();
    expect(parseMention(`@${'x'.repeat(24)}`)).not.toBeNull();
  });
});

describe('matchRoles', () => {
  it('空过滤词返回注册表全量（稳定顺序）', () => {
    expect(matchRoles('')).toEqual([...roleOrder]);
  });

  it('按 role id（不区分大小写）与中文名前缀过滤', () => {
    expect(matchRoles('PM')).toEqual(['pm']);
    expect(matchRoles('seo')).toEqual(['seo']);
    expect(matchRoles('工')).toEqual(['engineer']);
    expect(matchRoles('产品')).toEqual(['pm']);
  });

  it('无命中返回空数组（浮层不弹空列表）', () => {
    expect(matchRoles('zzz')).toEqual([]);
  });
});

describe('applyMention', () => {
  it('替换 @ 触发片段为中文名；补全词后紧跟原有空白时不追加空格', () => {
    const result = applyMention('请 @产 帮忙', 4, 'pm');
    expect(result.text).toBe('请 @产品经理 帮忙');
    expect(result.caret).toBe('请 @产品经理'.length);
  });

  it('文末触发时补全并追加一个空格（方便继续输入）', () => {
    const result = applyMention('@工', 2, 'engineer');
    expect(result.text).toBe('@工程师 ');
    expect(result.caret).toBe(result.text.length);
  });

  it('补全后的文本能被 extractMentions 还原成同一角色', () => {
    const filled = applyMention('@架', 2, 'architect');
    expect(extractMentions(filled.text)).toEqual(['architect']);
  });
});

describe('extractMentions', () => {
  it('收集全文完整提及，按出现顺序去重', () => {
    expect(extractMentions('@产品经理 @工程师')).toEqual(['pm', 'engineer']);
    expect(extractMentions('@pm @PM 做需求')).toEqual(['pm']);
  });

  it('忽略不完整与未知的 @ 词', () => {
    expect(extractMentions('@产 @工程师')).toEqual(['engineer']);
    expect(extractMentions('@foo @工程师')).toEqual(['engineer']);
    expect(extractMentions('邮箱 a@b.com')).toEqual([]);
    expect(extractMentions('')).toEqual([]);
  });
});
