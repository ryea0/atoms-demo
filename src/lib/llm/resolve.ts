/**
 * 角色级模型路由（DESIGN §5① 三级路由）：agent_model_bindings（DB，storage 提供时）
 * → `LLM_MODEL_<ROLE>` → `LLM_MODEL` → DEFAULT_MODEL。
 *
 * 与 client.ts resolveModel 的关系：resolveModel 是纯 env 两级（签名/行为不变），
 * 本函数是其 DB 感知超集——env 分支直接复用 resolveModel，保证两级语义永远一致。
 *
 * DB 命中返回绑定 provider 的连接信息（providerConfig），调用方用它在该服务商上建 provider
 * （probe/withFallback 的输入）；env 路径无 providerConfig（继续走全局 env 的 getLlmProvider）。
 * 绑定不合法（provider/model 缺失或 disabled、model 不属该 provider）视为未命中，继续走 env。
 *
 * 只依赖结构类型 RoleModelSource（与 usage.ts 的 MeteringSink 同一思路），LLM 层不感知 db dialect。
 * 服务端专用，不得进入客户端 bundle。
 */
import { resolveModel } from '@/lib/llm/client';
import type {
  AgentModelBindingRow,
  AgentRole,
  LlmModelRow,
  LlmProviderRow,
} from '@/lib/db/provider/types';

/** 角色模型路由所需的存储只读面（StorageProvider 按结构满足；测试可传最小桩） */
export interface RoleModelSource {
  getAgentModelBinding(role: AgentRole): Promise<AgentModelBindingRow | null>;
  getLlmProviderById(providerId: number): Promise<LlmProviderRow | null>;
  getLlmModelById(modelId: number): Promise<LlmModelRow | null>;
}

/** DB 命中时带出的服务商连接信息（api_key 仅服务端流转，绝不进日志/前端/SSE——rules/07） */
export interface RoleModelProviderConfig {
  baseUrl: string;
  apiKey: string;
}

/** 路由结果：env 路径 providerConfig 为 undefined */
export interface RoleModelResolution {
  model: string;
  providerConfig?: RoleModelProviderConfig;
}

/** DB 读失败 → 留痕后降级 env（不静默吞，也不炸生成链路） */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 解析某角色应使用的模型：
 * ① storage 提供时先查 agent_model_bindings（一角色一绑定），命中且 provider/model 都 enabled
 *    （并校验 model 确属该 provider）→ 返回该 model + 该 provider 的连接信息；
 * ② 未命中/绑定不合法/读库失败 → env：`LLM_MODEL_<ROLE>` → `LLM_MODEL` → DEFAULT_MODEL。
 */
export async function resolveRoleModel(
  role: AgentRole,
  env: NodeJS.ProcessEnv = process.env,
  storage?: RoleModelSource,
): Promise<RoleModelResolution> {
  if (storage !== undefined) {
    try {
      const binding = await storage.getAgentModelBinding(role);
      if (binding !== null) {
        const [provider, model] = await Promise.all([
          storage.getLlmProviderById(binding.providerId),
          storage.getLlmModelById(binding.modelId),
        ]);
        if (provider?.enabled === true && model?.enabled === true && model.providerId === provider.id) {
          return {
            model: model.modelId,
            providerConfig: { baseUrl: provider.baseUrl, apiKey: provider.apiKey },
          };
        }
      }
    } catch (error) {
      console.error(`[llm] 角色模型绑定读取失败（role=${role}），降级 env：${describeError(error)}`);
    }
  }
  return { model: resolveModel(role, env) };
}
