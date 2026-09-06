/**
 * 领域类型 + StorageProvider 契约（DESIGN §12「类型即文档」）
 * 业务代码（编排器/角色/API）只 import 本文件，不感知具体 dialect 实现——
 * 切换存储（sqlite → postgres）时本文件不变。
 */

/** agent 角色：领导/产品/架构/工程师/数据分析师/SEO/广告 */
export type AgentRole = 'leader'|'pm'|'architect'|'engineer'|'analyst'|'seo'|'ads';

/** 项目状态 */
export type ProjectStatus = 'draft'|'running'|'paused'|'done'|'failed';

/** 任务运行状态（rolled_back=检查点回滚后标记，DESIGN §3.10） */
export type RunStatus = 'pending'|'running'|'done'|'failed'|'stopped'|'rolled_back';

export interface Project { id:number; sessionId:string; title:string; requirement:string;
  mode:'fast'|'full'; status:ProjectStatus; createdAt:number; updatedAt:number; }

/**
 * 消息元数据：mentions=@ 指定成员；kind 标记特殊聊天卡片（softlock=软锁裁决 / restore=回滚通知 /
 * agent-report=@直派成员的自身汇报，T32）、path 为关联文件路径、targetTask 为干预注入边界对应的
 * 任务键（`engineer:{path}`，T25）、agent 为消息归属角色（agent-report 据此渲染成员徽章）——
 * 随消息落库（T23/T25/T32），刷新后前端仍能还原裁决卡片、「已注入 {文件}」队列卡与成员徽章。
 */
export interface MessageMeta { mentions?:AgentRole[]; kind?:string; path?:string; targetTask?:string; agent?:AgentRole; }

export interface Message { id:number; projectId:number; role:'user'|'assistant'|'intervention'|'system';
  content:string; meta?:MessageMeta|null; deliveredAt:number|null; createdAt:number; }
export interface AgentRun { id:number; projectId:number; taskKey:string; agent:AgentRole; task:string;
  status:RunStatus; summary:string|null; startedAt:number|null; endedAt:number|null; error:string|null; }
/** 文件写入者域：agent 角色名 / human（人机共编）/ seed（预置演示） */
export type FileEditor = AgentRole|'human'|'seed';

export interface FileRow { id:number; projectId:number; path:string; content:string;
  producedBy:FileEditor; lastEditor:AgentRole|'human'|'seed'; editingBy:string|null; editingExpiresAt:number|null;
  version:number; createdAt:number; updatedAt:number; }
export interface FileVersion { id:number; fileId:number; version:number; content:string; editor:string; createdAt:number; }
export interface Checkpoint { id:number; projectId:number; label:string; agentRunId:number|null;
  /** 打点时刻本项目最大 agent_runs.id：restore 后 id > afterRunId 的任务标 rolled_back（回滚边界） */
  afterRunId:number; createdAt:number; }
export interface CheckpointFile { checkpointId:number; path:string; content:string; }
export interface LlmCall { id:number; projectId:number; agentRole:AgentRole; model:string;
  promptTokens:number; completionTokens:number; estimated:number; cost:number; latencyMs:number; createdAt:number; }

/** createProject 入参（id/status/时间戳由存储层与库默认值生成） */
export interface CreateProjectInput { sessionId:string; title:string; requirement:string; mode:'fast'|'full'; }

/** addMessage 入参（id/deliveredAt/createdAt 由存储层生成） */
export interface AddMessageInput { projectId:number; role:Message['role']; content:string;
  meta?:Message['meta']; }

/** createAgentRun 入参（id/status/时间戳由存储层与库默认值生成：status=pending、started_at 由编排器开跑时补） */
export interface CreateAgentRunInput { projectId:number; taskKey:string; agent:AgentRole; task:string; }

/**
 * updateAgentRun 入参：只推进调用方出现的字段。
 * summary/error/时间戳传 null = 显式清空（如中断后重算降级摘要）；缺省键一律不动库里既有值。
 */
export interface UpdateAgentRunPatch { status?:RunStatus; summary?:string|null; error?:string|null;
  startedAt?:number|null; endedAt?:number|null; }

/** usageByProject 聚合行：tokens=prompt+completion 之和（设置页/卡片墙统计用） */
export interface LlmUsageRow { agentRole:AgentRole; model:string; tokens:number; calls:number; }

/**
 * 全局用量聚合行（T24 设置页用量卡片）：不按项目过滤——设置页看的是整个平台的花费。
 * estimatedCalls>0 表示该组里有按 DESIGN §4.4 公式估算的调用（UI 显示「含估算」标记）。
 */
export interface LlmUsageGlobalRow { agentRole:AgentRole; model:string; tokens:number; calls:number; estimatedCalls:number; }

/**
 * recordLlmCall 入参（llm 层 meteredCall 结构化落库，字段与 src/lib/llm/usage.ts 的 MeteringSink 一一对应）。
 * estimated=1 表示 usage 缺失按 DESIGN §4.4 公式估算；cost 默认 0（单价未配置时不计费）。
 */
export interface RecordLlmCallInput { projectId:number; agentRole:AgentRole; model:string;
  promptTokens:number; completionTokens:number; estimated:number; cost:number; latencyMs:number; }

/** 偏好作用域：demo 只用 session 级（DESIGN §4.2），user 级为 schema 预留 */
export type PreferenceScope = 'session'|'user';

/** 项目卡片 DTO（列表页一次查询聚合取齐，禁 N+1——.claude/rules/05） */
export type ProjectListItem = Project & {
  /** files 表行数 */
  fileCount:number;
  /** llm_calls 的 prompt+completion 之和（无调用=0） */
  totalTokens:number;
  /** 最后一条消息内容（无消息=null） */
  lastMessage:string|null;
};

/**
 * 卡片墙行（路由层 DTO）：用户项目 + seed 模板行（isSeed=true，T25 R1 模板画廊）。
 * 仓库层 listProjects 恒不置 isSeed；由 GET /api/projects 追加 seed 行时标记——
 * 前端据此显示「示例」角标并把打开动作改走 /api/projects/[id]/open（打开即克隆）。
 */
export type ProjectCardItem = ProjectListItem & { isSeed?: boolean };

/** 项目仓库：全部查询强制 sessionId/projectId 过滤（CLAUDE.md 规则 9） */
export interface ProjectsRepo {
  createProject(input: CreateProjectInput): Promise<Project>;
  /** 项目总数（不分会话）：seed 幂等守卫用（projects 表空才插预置项目，T25） */
  countProjects(): Promise<number>;
  listProjects(sessionId: string): Promise<ProjectListItem[]>;
  getProject(projectId: number): Promise<Project|null>;
  renameProject(projectId: number, title: string): Promise<void>;
  /** 级联删除：files/messages/llm_calls/checkpoints 等随外键 onDelete cascade 一起删 */
  deleteProject(projectId: number): Promise<void>;
  updateProjectStatus(projectId: number, status: ProjectStatus): Promise<void>;
  /** 最近会话（updatedAt 倒序），默认取 8 条 */
  getRecentSessions(sessionId: string, limit?: number): Promise<Project[]>;
}

/** 消息/干预队列仓库：干预队列 = role='intervention' AND delivered_at IS NULL（CLAUDE.md 规则 9） */
export interface MessagesRepo {
  addMessage(input: AddMessageInput): Promise<Message>;
  listMessages(projectId: number): Promise<Message[]>;
  takePendingInterventions(projectId: number): Promise<Message[]>;
  /**
   * projectId 提供时强制项目级作用域（规则 9）；缺省则按裸 ids 生效（调用方须已自行校验归属）。
   * meta 提供时一并覆盖该批消息的 meta（注入打戳写回 targetTask 用，T25）——调用方负责带上
   * 原 meta 字段（仓库层不做合并），不传则 meta 保持原值。
   */
  markDelivered(messageIds: number[], projectId?: number, meta?: MessageMeta): Promise<void>;
}

/** upsertFile 入参（统一写入口：agent/seed 生成、人工新建同走此 API） */
export interface UpsertFileInput { projectId:number; path:string; content:string; editor:FileEditor; }

/** saveHuman 入参：baseVersion 为编辑器打开时的版本号，不匹配即冲突（CAS，DESIGN §3.9） */
export interface SaveHumanInput { projectId:number; fileId:number; content:string; baseVersion:number; }

/**
 * saveHuman 结果：失败时带回服务端当前内容与**当前版本号**，前端渲染冲突对话框
 * （用我的版本/用 agent 版本/并排 diff）。version 让「用我的版本」在 SSE 断连、
 * 客户端拿不到最新版本号时也能一次重发成功（T25）。
 */
export type SaveHumanResult = { ok:true; version:number } | { ok:false; conflict:true; current:string; version:number };

/** file_tree 行（树形 UI 只需路径+版本+最后编辑者，不背内容） */
export interface FileListItem { path:string; version:number; lastEditor:AgentRole|'human'|'seed'; }

/**
 * 虚拟文件系统仓库（CLAUDE.md 规则 6/11、DESIGN §3.9/§3.10）：
 * - 所有方法强制 project_id 过滤；file_versions 表无 project_id，归属经 files 回查/联表保证
 * - 覆盖写（agent/人工/恢复）统一归档旧版本到 file_versions——diff、回滚、可再撤销都靠它
 * - 乐观锁：更新条件带 version，影响行数=0 即冲突；事务短小（事务内只有纯 DB 写）
 */
export interface FilesRepo {
  /** 新路径插入 v1（produced_by=editor）；已存在则旧版本入档并 version+1，返回 {fileId, version} */
  upsertFile(input: UpsertFileInput): Promise<{ fileId:number; version:number }>;
  getFile(projectId:number, path:string): Promise<FileRow|null>;
  getFileById(projectId:number, fileId:number): Promise<FileRow|null>;
  /** file_tree 用（路径升序稳定排序） */
  listFiles(projectId:number): Promise<FileListItem[]>;
  /** 人工保存（CAS）：版本不匹配 → {ok:false,conflict:true,current=服务端最新内容}；文件不存在亦按冲突返回（current 为空串） */
  saveHuman(input: SaveHumanInput): Promise<SaveHumanResult>;
  /** 版本历史（新→旧倒序，供查看器版本侧栏） */
  listFileVersions(projectId:number, fileId:number): Promise<FileVersion[]>;
  /** 恢复=以该历史版本内容写一个新版本（可再撤销），返回新版本号；历史版本不存在则抛错 */
  restoreFileVersion(projectId:number, fileId:number, version:number): Promise<number>;
  /** 声明式软锁：on=人开始编辑（TTL 10min），off=释放；软锁检查在编排器步骤边界做，仓库不拦截写入 */
  setSoftLock(projectId:number, fileId:number, on:boolean): Promise<void>;
  /** 当前仍持有软锁的文件（只含未过期） */
  getSoftLockedFiles(projectId:number): Promise<FileRow[]>;
  /** 全量文件行（快照/导出/预览装配用） */
  readAllFiles(projectId:number): Promise<FileRow[]>;
}

/**
 * agent_runs 仓库：summary 是子任务间唯一交接物（CLAUDE.md 规则 7），回滚时统一标 rolled_back（DESIGN §3.10）。
 */
export interface RunsRepo {
  createAgentRun(input: CreateAgentRunInput): Promise<AgentRun>;
  /** 按 id 推进；projectId 提供时叠加项目级作用域（规则 9），缺省按裸 id 生效（调用方须已自行校验归属） */
  updateAgentRun(id: number, patch: UpdateAgentRunPatch, projectId?: number): Promise<void>;
  /** 任务时间线（created_at 正序，并列按 id 稳定排序） */
  listAgentRuns(projectId: number): Promise<AgentRun[]>;
  /**
   * 检查点回滚配套：id > sinceRunId 的本项目任务（含已 done/failed/stopped）全部改标
   * rolled_back——检查点之后的任务才是被回滚撤销的工作；≤ sinceRunId（仍然成立的工作）不动。
   * sinceRunId 通常取检查点行上的 afterRunId（打点时刻的最大 run id）。
   */
  markRunsRolledBack(projectId: number, sinceRunId: number): Promise<void>;
  /** 本项目当前最大 agent_runs.id（无任务返回 0）：打检查点时捕获回滚边界（afterRunId）用 */
  latestRunId(projectId: number): Promise<number>;
}

/**
 * 杂项仓库：项目级检查点（DESIGN §3.10）+ llm_calls 计量（CLAUDE.md 规则 10）+ 个人偏好（DESIGN §3.9/§4.2）。
 * 检查点快照/恢复必须在一个短事务内完成（事务里只有纯 DB 读写，无 await/IO/LLM 调用）。
 */
export interface MiscRepo {
  /** 打点：当前全部 files 全量快照入 checkpoint_files（读快照与落库同事务），返回 checkpoint id；
   *  afterRunId = 打点时刻本项目最大 agent_runs.id（回滚标记边界，编排器用 latestRunId 取） */
  createCheckpoint(projectId: number, label: string, agentRunId: number|null, afterRunId: number): Promise<number>;
  /**
   * 恢复：当前内容先各入 file_versions（回滚可撤销），再按快照 upsert 回 files——
   * 快照内已有文件行覆盖内容并 version+1、已消失的行重建；快照外的文件（打点后新增）一律不动。
   * 返回受影响 fileId（按快照路径升序）。checkpointId 不存在或归属不符时抛错。
   */
  restoreCheckpoint(projectId: number, cpId: number): Promise<number[]>;
  /** 打点列表（新→旧，时间线「回到此任务前」用） */
  listCheckpoints(projectId: number): Promise<Checkpoint[]>;
  recordLlmCall(input: RecordLlmCallInput): Promise<void>;
  /** 按 agentRole+model 聚合 tokens/calls（单条 SQL groupBy，禁 N+1） */
  usageByProject(projectId: number): Promise<LlmUsageRow[]>;
  /** 未命中返回 null；data 已由 text({mode:'json'}) 反序列化 */
  getPreference(scope: PreferenceScope, targetId: string): Promise<unknown|null>;
  /** upsert on (scope,target_id)：同键二次写覆盖（编辑能力开关等只存最新值） */
  setPreference(scope: PreferenceScope, targetId: string, data: Record<string, unknown>): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* 模型管理全局表（DESIGN §7/§5①）：provider → model → 角色绑定            */
/* ------------------------------------------------------------------ */

/** LLM 服务商行（全局表）；api_key 仅服务端使用，绝不进日志/前端/SSE（.claude/rules/07） */
export interface LlmProviderRow { id:number; name:string; baseUrl:string; apiKey:string; enabled:boolean; createdAt:number; }

/** 模型行（全局表）：price_input/output 用于 llm_calls 成本核算（DESIGN §5③），默认 0 */
export interface LlmModelRow { id:number; providerId:number; modelId:string; displayName:string;
  priceInput:number; priceOutput:number; enabled:boolean; createdAt:number; }

/** 角色绑定行（全局表，role 唯一）：一角色一绑定（DESIGN §5①） */
export interface AgentModelBindingRow { id:number; role:AgentRole; providerId:number; modelId:number; createdAt:number; }

/**
 * 模型管理只读仓库（DESIGN §5①）：T27 的 resolveRoleModel（三级路由）消费。
 * 刻意只读且最小——写侧在 LlmAdminRepo（T24 设置页）。
 */
export interface LlmReadRepo {
  /** 角色绑定（role 唯一，无绑定返回 null） */
  getAgentModelBinding(role: AgentRole): Promise<AgentModelBindingRow|null>;
  getLlmProviderById(providerId: number): Promise<LlmProviderRow|null>;
  getLlmModelById(modelId: number): Promise<LlmModelRow|null>;
}

/* ---------------- 模型管理写侧入参（T24 设置页；缺省键不动库里既有值） ---------------- */

export interface CreateLlmProviderInput { name:string; baseUrl:string; apiKey:string; enabled:boolean; }
export interface PatchLlmProviderInput { name?:string; baseUrl?:string; apiKey?:string; enabled?:boolean; }
export interface CreateLlmModelInput { providerId:number; modelId:string; displayName:string;
  priceInput:number; priceOutput:number; enabled:boolean; }
export interface PatchLlmModelInput { displayName?:string; priceInput?:number; priceOutput?:number; enabled?:boolean; }
export interface UpsertAgentModelBindingInput { role:AgentRole; providerId:number; modelId:number; }

/**
 * 模型管理写仓库（T24 设置页 CRUD，DESIGN §5①/§7 全局表）。
 * 三张表都无 project_id（全局配置），不存在项目级作用域问题；api_key 只进不出（rules/07）。
 * 删除走外键级联：删 provider → 其下 llm_models → 引用它们的 agent_model_bindings 一并清除。
 */
export interface LlmAdminRepo {
  createLlmProvider(input: CreateLlmProviderInput): Promise<LlmProviderRow>;
  /** 全部服务商（id 升序，输出稳定可断言） */
  listLlmProviders(): Promise<LlmProviderRow[]>;
  /** 局部更新：patch 里出现的键才落库；未命中返回 null */
  updateLlmProvider(providerId: number, patch: PatchLlmProviderInput): Promise<LlmProviderRow|null>;
  deleteLlmProvider(providerId: number): Promise<boolean>;
  createLlmModel(input: CreateLlmModelInput): Promise<LlmModelRow>;
  /** 模型清单（providerId 缺省 = 全部；providerId 升序 + model_id 升序稳定排序） */
  listLlmModels(providerId?: number): Promise<LlmModelRow[]>;
  updateLlmModel(modelId: number, patch: PatchLlmModelInput): Promise<LlmModelRow|null>;
  deleteLlmModel(modelId: number): Promise<boolean>;
  /** role 唯一约束 upsert：同角色重复绑定覆盖旧行 */
  upsertAgentModelBinding(input: UpsertAgentModelBindingInput): Promise<AgentModelBindingRow>;
  /** 清除绑定 = 「跟随全局默认」（resolveRoleModel 随之回退 env） */
  deleteAgentModelBinding(role: AgentRole): Promise<boolean>;
  listAgentModelBindings(): Promise<AgentModelBindingRow[]>;
  /** 全局用量聚合（settings 用量卡片）：单条 SQL groupBy，禁 N+1 */
  usageAll(): Promise<LlmUsageGlobalRow[]>;
}

/* ------------------------------------------------------------------ */
/* 检索扩展点（DESIGN §12「检索」行，Task 28）：方言专属全文索引能力        */
/* ------------------------------------------------------------------ */

/** FTS5 检索行：score = -bm25（越大越相关），同分按 path 升序；content 供检索层投影出行级命中 */
export interface FtsRankedFile { fileId:number; path:string; content:string; score:number; }

/**
 * 全文索引检索仓库（可选能力）：`searchFtsFiles` 为**可选成员**——只有具备全文索引的实现提供
 * （当前是 SQLite 的 files_fts 虚表），Postgres 等实现整体省略即可。检索层（src/lib/retrieval）
 * 探测到缺失即回退默认 grep——实现者既不必伪造方法抛错，也不会静默把 grep 语义变成「未命中」。
 * 查询按字面短语解释（转义由实现负责），limit=null 取全量；实现必须强制 project_id 过滤（规则 9）。
 */
export interface FtsSearchRepo {
  searchFtsFiles?(projectId:number, query:string, limit:number|null):Promise<FtsRankedFile[]>;
}

/**
 * 存储抽象（DESIGN §12）：按仓库分组继承（Task 5 已补齐全部仓库组，Task 28 补检索能力组）。
 * 实现侧约定：所有查询强制 project_id 过滤（CLAUDE.md 规则 9）、更新走乐观锁（规则 05）。
 */
export interface StorageProvider extends ProjectsRepo, MessagesRepo, FilesRepo, RunsRepo, MiscRepo, LlmReadRepo, LlmAdminRepo, FtsSearchRepo {
  /**
   * 关闭底层连接（幂等；关闭后本实例不可再用，需重新走工厂）。
   * 文件库实例按 dbFile 路径 memoize——业务侧在模块层调用一次 createStorage() 并持有即可，
   * 切勿每请求新建（否则句柄泄漏、WAL 写者叠加，SQLite 单写者模型会互相阻塞）。
   */
  close(): void;
}
