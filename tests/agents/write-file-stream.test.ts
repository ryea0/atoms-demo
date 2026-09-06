/**
 * write-file-stream 单元测试（工具参数流 → 文件打字机增量）。
 *
 * 被测行为：openai provider 的 tool_calls.arguments 增量流（真实模型写文件的通道）
 * 经本转发器增量解出 content 字段文本，以 delta 事件转发到 SSE——这是真模型下
 * 工程师文件打字机的唯一来源（content 正文通道只属于零工具角色）。
 */
import { describe, expect, it } from 'vitest';
import { createWriteFileDeltaForwarder } from '@/lib/agents/write-file-stream';
import type { ToolCallStreamDelta } from '@/lib/llm/types';
import type { StreamEvent } from '@/lib/agents/events';

type Emitted = Omit<StreamEvent, 'seq' | 'projectId'>;

/** 收集事件的测试桩 emit */
function collector(): { events: Emitted[]; emit: (e: Emitted) => void } {
  const events: Emitted[] = [];
  return { events, emit: (e) => events.push(e) };
}

/** 把一段文本按固定步长切片逐片喂给转发器（模拟 provider 分片边界任意） */
function feed(
  forwarder: (delta: ToolCallStreamDelta) => void,
  argsText: string,
  opts: { id?: string; name?: string; index?: number; step?: number } = {},
): void {
  const step = opts.step ?? 3;
  for (let i = 0; i < argsText.length; i += step) {
    forwarder({
      index: opts.index ?? 0,
      id: opts.id ?? 'call_test',
      name: opts.name ?? 'write_file',
      fragment: argsText.slice(i, i + step),
    });
  }
}

describe('createWriteFileDeltaForwarder', () => {
  it('单波次：解出 content 全文并逐段发 delta，首波不补发 file_start（编排器已发）', () => {
    const { events, emit } = collector();
    const forwarder = createWriteFileDeltaForwarder('app/a.js', 'engineer', emit);
    feed(forwarder, JSON.stringify({ path: 'app/a.js', content: 'console.log(1)\n' }));
    const deltas = events.filter((e) => e.event === 'delta');
    expect(deltas.map((e) => e.content ?? '').join('')).toBe('console.log(1)\n');
    expect(events.filter((e) => e.event === 'file_start')).toHaveLength(0);
    for (const d of deltas) {
      expect(d.path).toBe('app/a.js');
      expect(d.agent).toBe('engineer');
      expect(d.runId).toBeNull();
    }
  });

  it('转义跨片段断裂：\\n \\" \\\\ \\/ \\t 与 \\uXXXX 代理对在任意切片下拼接还原', () => {
    const { events, emit } = collector();
    const forwarder = createWriteFileDeltaForwarder('app/a.js', 'engineer', emit);
    // 手工构造含各类转义的 args（JSON.stringify 不转义非 ASCII，故手工拼 😀）
    const argsText = '{"path":"app/a.js","content":"a\\tb\\nc\\"d\\\\e\\/f\\uD83D\\uDE00end"}';
    feed(forwarder, argsText, { step: 2 });
    expect(events.filter((e) => e.event === 'delta').map((e) => e.content ?? '').join(''))
      .toBe('a\tb\nc"d\\e/f😀end');
  });

  it('键值带空格（真机 doubao 形态 ", \\"content\\": \\"）同样解出', () => {
    const { events, emit } = collector();
    const forwarder = createWriteFileDeltaForwarder('hello.js', 'engineer', emit);
    feed(forwarder, '{"path": "hello.js", "content": "console.log(\\"hi\\")"}');
    expect(events.filter((e) => e.event === 'delta').map((e) => e.content ?? '').join(''))
      .toBe('console.log("hi")');
  });

  it('content 值内出现字面量 \\"content\\": 不误导提取（只认第一个键）', () => {
    const { events, emit } = collector();
    const forwarder = createWriteFileDeltaForwarder('app/a.js', 'engineer', emit);
    feed(forwarder, '{"path":"app/a.js","content":"x \\"content\\": y"}');
    expect(events.filter((e) => e.event === 'delta').map((e) => e.content ?? '').join(''))
      .toBe('x "content": y');
  });

  it('content 闭合后的尾部片段（"} 等）不再产生增量', () => {
    const { events, emit } = collector();
    const forwarder = createWriteFileDeltaForwarder('app/a.js', 'engineer', emit);
    feed(forwarder, '{"path":"app/a.js","content":"hi"}');
    const after = events.length;
    feed(forwarder, '}', { id: 'call_test' }); // 同一调用的收尾残片
    expect(events.length).toBe(after);
  });

  it('第二波 write_file（新 call id，覆写修正/重试）先补发 file_start 重置再流新文', () => {
    const { events, emit } = collector();
    const forwarder = createWriteFileDeltaForwarder('app/a.js', 'engineer', emit);
    feed(forwarder, JSON.stringify({ path: 'app/a.js', content: '第一版' }));
    feed(forwarder, JSON.stringify({ path: 'app/a.js', content: '第二版' }), { id: 'call_rewrite' });
    const names = events.map((e) => e.event);
    expect(names).toEqual(['delta', 'file_start', 'delta']);
    expect(events[2]?.content).toBe('第二版');
  });

  it('非 write_file 工具的参数流不产生任何事件', () => {
    const { events, emit } = collector();
    const forwarder = createWriteFileDeltaForwarder('app/a.js', 'engineer', emit);
    feed(forwarder, JSON.stringify({ path: 'app/a.js' }), { name: 'read_file' });
    expect(events).toHaveLength(0);
  });

  it('未到 content 字段的片段（只有 path 键）不产生事件', () => {
    const { events, emit } = collector();
    const forwarder = createWriteFileDeltaForwarder('app/a.js', 'engineer', emit);
    feed(forwarder, '{"path":"app/a.js",');
    expect(events).toHaveLength(0);
  });
});
