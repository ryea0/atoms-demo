/**
 * 设置页 API 入参 zod 校验（.claude/rules/02/07：所有 API 输入先过 schema；客户端也可复用）。
 * 约定：patch 类 schema 所有键可选（缺省键 = 不改库里既有值）；api_key 允许空串（= 未提供，不覆盖）。
 */
import { z } from 'zod';
import { agentRoles } from './types';

/** OpenAI 兼容根地址：容忍尾斜杠（probe 侧统一剥掉），但必须是 http(s) 绝对地址 */
const baseUrlSchema = z
  .string()
  .trim()
  .min(1, 'base_url 必填')
  .max(300, 'base_url 过长')
  .refine((value) => /^https?:\/\//i.test(value), 'base_url 需以 http(s):// 开头');

export const providerCreateSchema = z.object({
  name: z.string().trim().min(1, '名称必填').max(60, '名称过长'),
  baseUrl: baseUrlSchema,
  apiKey: z.string().trim().min(1, 'api key 必填').max(400, 'api key 过长'),
  enabled: z.boolean().optional(),
});

export const providerPatchSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(60, '名称过长').optional(),
  baseUrl: baseUrlSchema.optional(),
  apiKey: z.string().trim().max(400, 'api key 过长').optional(),
  enabled: z.boolean().optional(),
});

export const modelPatchSchema = z.object({
  displayName: z.string().trim().min(1, '显示名不能为空').max(120, '显示名过长').optional(),
  priceInput: z.number().min(0, '单价不能为负').optional(),
  priceOutput: z.number().min(0, '单价不能为负').optional(),
  enabled: z.boolean().optional(),
});

/** 绑定 PUT：providerId/modelId 同时提供 = 绑定，任一缺失 = 清除绑定（跟随全局默认） */
export const bindingPutSchema = z.object({
  role: z.enum(agentRoles),
  providerId: z.number().int().positive().optional(),
  modelId: z.number().int().positive().optional(),
});

/** 偏好 PUT（session 级）：所有键可选，缺省键 = 不改既有值（服务端合并后整体落库） */
export const preferencesPutSchema = z.object({
  editing_enabled: z.boolean().optional(),
  default_mode: z.enum(['fast', 'full']).optional(),
});

export type ProviderCreateInputDto = z.infer<typeof providerCreateSchema>;
export type ProviderPatchInputDto = z.infer<typeof providerPatchSchema>;
export type ModelPatchInputDto = z.infer<typeof modelPatchSchema>;
export type BindingPutInputDto = z.infer<typeof bindingPutSchema>;
