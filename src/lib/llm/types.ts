/**
 * LLM 层类型契约（DESIGN §12「类型即文档」）。
 * 编排器/角色只依赖本文件 + usage.ts 的计量入口，不感知具体 provider——
 * 切换 mock ↔ OpenAI 兼容实现时本文件不变。
 */

/** 一次工具调用（args 已解析为对象；解析失败时可能是原始字符串） */
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** 对话消息；tool 角色必须带 toolCallId，assistant 可带 toolCalls（工具循环历史） */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

/** 工具定义（JSON Schema 形式，透传给 OpenAI 兼容接口） */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * 思考流增量回调（T31，仅 stream 路径有意义，complete 不回调）：
   * OpenAI 兼容接口在 delta.reasoning_content（部分网关叫 delta.reasoning）里吐思考片段，
   * provider 解析到即回调；两者都没有则一次也不回调。
   *
   * 刻意挂在请求对象上（而非给 stream 加第三个参数）：计量装饰器/测试桩对 req 原样透传即可，
   * LlmProvider 的全部实现与调用面零改动（与 signal 同类的「通道型」请求字段）。
   *
   * 计量口径：思考流**不进 content、不进估算公式**——completion tokens 只算正文（DESIGN §4.4
   * 口径不变）；服务端 usage 里若已含思考 token 属 provider 侧口径，本层不做二次修正。
   */
  onReasoning?: (text: string) => void;
  /**
   * 工具调用参数的流式增量回调（仅 stream 路径有意义，complete 不回调）：
   * OpenAI 兼容接口把工具参数放 delta.tool_calls[].function.arguments 里增量下发——
   * 真实模型写文件的全文走这条通道（正文 content 在工具轮基本为空），mock 也按同一
   * 语义分片回调。provider 只透传原始分片（含 id/name/分片序号），不做语义解析——
   * 「参数流 → 文件打字机」的增量提取由角色/编排器侧消费（write-file-stream.ts）。
   *
   * 与 onReasoning 同为「通道型」请求字段：计量装饰器/测试桩对 req 原样透传即可。
   * 计量口径：参数分片**不进 content、不进估算公式**（usage 已由最终 toolCalls 聚合体
   * 覆盖，DESIGN §4.4 口径不变）。
   *
   * 前置条件：分片所在调用已有稳定 id（网关首个分片带 id+name、后续只带 arguments）；
   * id 未知的分片不回调（打字机缺一段，不影响最终聚合结果）。
   */
  onToolCallDelta?: (delta: ToolCallStreamDelta) => void;
}

/**
 * 工具调用参数流的一个分片（openai 兼容流道）：
 * - index：同一条 assistant 消息内的工具调用序号（多工具并发分片靠它区分）
 * - id：调用 id（跨消息重试时是新 id——消费方以此识别「第二波覆写」）
 * - name：工具名（首个分片携带；消费方按名过滤，如只关心 write_file）
 * - fragment：arguments JSON 的原始文本分片（未解码，未聚合）
 */
export interface ToolCallStreamDelta {
  index: number;
  id: string;
  name: string;
  fragment: string;
}

export interface LlmResult {
  content: string;
  toolCalls: ToolCall[];
  /** 服务端返回的真实用量；缺失（null）由 usage.ts 走字符公式估算并标 estimated=1 */
  usage: { promptTokens: number; completionTokens: number } | null;
}

/** Provider 抽象：complete（一次性）与 stream（增量回调 + 最终结果） */
export interface LlmProvider {
  name: string;
  complete(req: LlmRequest): Promise<LlmResult>;
  stream(req: LlmRequest, onDelta: (text: string) => void): Promise<LlmResult>;
}
