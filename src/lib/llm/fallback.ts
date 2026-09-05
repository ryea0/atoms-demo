/**
 * 降级链（DESIGN §5① 增强，hify-provider 移植蓝图里缺失的一块，由本模块自建）：
 * 把一组 provider 工厂包成「按序尝试 + 可降级错误换下一个 + 全败抛最后一次错误」的单一 LlmProvider。
 *
 * 语义（DESIGN §5①）：
 * - 可降级：auth / rate_limited / timeout / network / bad_response（auth 在同一 provider 内不重试，但换 provider 正当）
 * - aborted 永不降级（用户停止/外部中止的意图，原样上抛）
 * - unknown 不降级：无法归因于服务商健康问题的错误（含 config_missing/unknown_provider 这类配置缺陷）
 *   换一个 provider 也解决不了，立即失败比静默换链更可诊断
 * - 构造失败（工厂抛错）一律降级：此刻尚未发出任何请求，尝试下一个候选零成本
 * - 全败抛最后一次的错误（同一对象，绝不包装——上层依赖错误同一性判中止）
 * - 流式已吐过增量即不再降级：中段换 provider 会把 A 的残句与 B 的全文拼进同一条流（内容损坏）
 * - 链空 = 显式 config_missing 错误（本包装必须显式 opt-in：默认链为空 = 现行为不变）
 *
 * 内存健康度：Map<providerKey, {failCount, lastLatencyMs}>，fail≥PROVIDER_FAIL_THRESHOLD 的 provider
 * 在链内排序靠后（仅重排链内顺序，不引入新依赖），成功一次即清零恢复原序。
 * providerKey 是身份而非名字（provider.name 无唯一性保证，见 FallbackOptions.keys），
 * 缺省退化为 `provider.name#<序号>`，同名候选的健康度互不污染。
 * 单实例内存态；多实例部署需外置健康状态（DESIGN §12 演进位）。
 * 服务端专用，不得进入客户端 bundle。
 */
import { LlmError } from '@/lib/llm/client';
import type { LlmProvider, LlmRequest, LlmResult } from '@/lib/llm/types';

/** 降级判定的错误分类（probe/fallback 共用的口径） */
export type FallbackCode = 'aborted' | 'auth' | 'rate_limited' | 'timeout' | 'network' | 'bad_response' | 'unknown';

/** 可降级集合：auth 也降级（换 provider 正当）；aborted/unknown 不在此列 */
const DEGRADABLE_CODES: ReadonlySet<FallbackCode> = new Set<FallbackCode>([
  'auth',
  'rate_limited',
  'timeout',
  'network',
  'bad_response',
]);

/** 连续失败阈值：达到即把该 provider 排到链尾（hify 的 fail≥3 → DOWN/DEGRADED 同一量级） */
export const PROVIDER_FAIL_THRESHOLD = 3;

/** 单个 provider 的内存健康度（providerKey = LlmProvider.name） */
export interface ProviderHealth {
  failCount: number;
  lastLatencyMs: number;
}

/** 模块级健康表：键为 provider.name（本仓库内 provider 名即身份）；单实例内存态 */
const healthByProvider = new Map<string, ProviderHealth>();

/**
 * 错误分类：LlmError 按结构化 code 映射（http_error 缺 rate_limited 码，按 status 判定 401/403→auth、
 * 429→rate_limited、其余→bad_response）；非 LLM 层错误按 Error.name 兜底，其余归 unknown。
 */
export function classifyLlmError(error: unknown): FallbackCode {
  if (error instanceof LlmError) {
    switch (error.code) {
      case 'aborted':
        return 'aborted';
      case 'timeout':
        return 'timeout';
      case 'network_error':
        return 'network';
      case 'bad_response':
        return 'bad_response';
      case 'http_error':
        if (error.status === 401 || error.status === 403) return 'auth';
        if (error.status === 429) return 'rate_limited';
        return 'bad_response';
      case 'config_missing':
      case 'unknown_provider':
        return 'unknown';
    }
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'aborted';
    if (error.name === 'TimeoutError') return 'timeout';
  }
  return 'unknown';
}

/** 读取某 provider 的健康度（未尝试过 = undefined）；T24 设置页可拿来做健康展示 */
export function getProviderHealth(providerName: string): ProviderHealth | undefined {
  return healthByProvider.get(providerName);
}

/** 清空健康表（测试隔离/运维复位用） */
export function resetProviderHealth(): void {
  healthByProvider.clear();
}

/** 取该 provider 的健康度条目（无则建零值条目） */
function healthOf(key: string): ProviderHealth {
  const existing = healthByProvider.get(key);
  if (existing !== undefined) return existing;
  const fresh: ProviderHealth = { failCount: 0, lastLatencyMs: 0 };
  healthByProvider.set(key, fresh);
  return fresh;
}

function recordSuccess(key: string, latencyMs: number): void {
  const health = healthOf(key);
  health.failCount = 0; // 成功即恢复信任：链序回到原位
  health.lastLatencyMs = latencyMs;
}

function recordFailure(key: string, latencyMs: number): void {
  const health = healthOf(key);
  health.failCount += 1;
  health.lastLatencyMs = latencyMs;
}

export interface FallbackOptions {
  /** 降级回调：from/to = 候选身份键（opts.keys 提供，缺省 `provider.name#<序号>`），code = 分类码；供日志与 T24 用量展示 */
  onFallback?: (from: string, to: string, code: FallbackCode) => void;
  /**
   * 候选身份键（与 chain 平行）：健康度的归属主键。provider.name 不构成身份——
   * llm_providers.name 无唯一约束、openai 工厂又硬编码 name='openai'，同名候选若共用一条
   * 健康记录会互相冤枉（A 的失败把 B 排到链尾）。缺省退化为 `provider.name#<序号>`（天然隔离），
   * 调用方建议传稳定业务键（如 `provider-<行id>`）；缺项/越界处同样退化。
   */
  keys?: string[];
}

/** 链内一个候选：provider=null 表示工厂构造失败（error 为原始异常） */
interface Attempt {
  key: string;
  provider: LlmProvider | null;
  error: unknown;
}

/** 健康度排序键：fail≥阈值的候选排后 */
function rank(key: string): number {
  const health = healthByProvider.get(key);
  return health !== undefined && health.failCount >= PROVIDER_FAIL_THRESHOLD ? 1 : 0;
}

/**
 * 构造全部候选并按健康度稳定重排（fail≥阈值排后，其余保持声明顺序）。
 * 工厂约定为廉价纯构造（本仓库 createOpenAiProvider/createMockProvider 均如此），
 * 因此每次调用全部构造一遍：既拿到 provider.name 参与默认身份键，也保留 env 晚绑定。
 */
function planAttempts(chain: ReadonlyArray<() => LlmProvider>, keys?: ReadonlyArray<string>): Attempt[] {
  const built: Attempt[] = chain.map((factory, index) => {
    // 身份键：调用方提供者优先；否则 name#<序号>（构造失败拿不到 name 时退化为序号）
    const fallbackKey = keys?.[index] ?? `provider#${index}`;
    try {
      const provider = factory();
      return { key: keys?.[index] ?? `${provider.name}#${index}`, provider, error: undefined };
    } catch (error) {
      return { key: fallbackKey, provider: null, error };
    }
  });
  return built
    .map((attempt, order) => ({ attempt, order }))
    .sort((a, b) => rank(a.attempt.key) - rank(b.attempt.key) || a.order - b.order)
    .map((entry) => entry.attempt);
}

/** 按序执行一次调用（complete/stream 二合一）；onDelta 提供即走流式 */
async function runChain(
  chain: ReadonlyArray<() => LlmProvider>,
  opts: FallbackOptions,
  req: LlmRequest,
  onDelta?: (text: string) => void,
): Promise<LlmResult> {
  const attempts = planAttempts(chain, opts.keys);
  let lastError: unknown;
  // 流式已向调用方吐过增量就不能再换 provider：中段降级会把 A 的残句与 B 的全文拼进同一条流（内容损坏）
  let sawDelta = false;
  const guardedOnDelta =
    onDelta === undefined
      ? undefined
      : (text: string): void => {
          sawDelta = true;
          onDelta(text);
        };

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    if (attempt === undefined) break; // 不可达（长度由 chain 决定），noUncheckedIndexedAccess 收窄
    const next = attempts[index + 1];

    if (attempt.provider === null) {
      // 构造失败：尚未发请求 → 一律降级
      lastError = attempt.error;
      if (next === undefined) throw attempt.error;
      opts.onFallback?.(attempt.key, next.key, classifyLlmError(attempt.error));
      continue;
    }

    const provider = attempt.provider;
    const startedAt = Date.now();
    try {
      const result =
        guardedOnDelta === undefined
          ? await provider.complete(req)
          : await provider.stream(req, guardedOnDelta);
      recordSuccess(attempt.key, Date.now() - startedAt);
      return result;
    } catch (error) {
      const code = classifyLlmError(error);
      // aborted 是用户意图而非服务商健康问题，不计入失败（否则停止一次就冤枉好 provider）
      if (code !== 'aborted') recordFailure(attempt.key, Date.now() - startedAt);
      if (sawDelta) throw error; // 已吐增量：流中段不再降级，原样上抛由上层决定重试/重生成
      if (next === undefined) throw error; // 全败：抛最后一次的错误（原对象）
      if (!DEGRADABLE_CODES.has(code)) throw error; // aborted 永不降级；unknown 立即失败
      opts.onFallback?.(attempt.key, next.key, code);
    }
  }

  // 防御性收口：每个候选要么 return 要么 throw，理论上不可达
  throw lastError ?? new LlmError('bad_response', 'fallback 链未产生任何结果');
}

/** 包装一组 provider 工厂为带降级语义的单一 provider（显式 opt-in，默认链为空=现行为） */
export function withFallback(chain: Array<() => LlmProvider>, opts: FallbackOptions = {}): LlmProvider {
  if (chain.length === 0) {
    const emptyChainError = (): LlmError =>
      new LlmError('config_missing', 'fallback 链为空：withFallback 需要至少一个 provider 工厂');
    return {
      name: 'fallback',
      async complete(): Promise<LlmResult> {
        throw emptyChainError();
      },
      async stream(): Promise<LlmResult> {
        throw emptyChainError();
      },
    };
  }

  return {
    // 实际 provider 逐次变化，对外统一以 fallback 标识（编排器/计量不感知链内具体是谁）
    name: 'fallback',
    async complete(req: LlmRequest): Promise<LlmResult> {
      return runChain(chain, opts, req);
    },
    async stream(req: LlmRequest, onDelta: (text: string) => void): Promise<LlmResult> {
      return runChain(chain, opts, req, onDelta);
    },
  };
}
