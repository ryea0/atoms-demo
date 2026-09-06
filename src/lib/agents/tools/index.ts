/**
 * 工具层公共出口：路径沙箱 + FS 工具集 + bash 自检工具 + 工具契约类型。
 * AgentRunner（Task 8）从这里 import Tool/ToolContext/fsTools；角色层按需挑选工具子集。
 */
export { normalizeProjectPath, type PathCheckResult } from './sandbox';
export {
  MAX_CONTENT_BYTES,
  formatZodIssues,
  fsTools,
  type JSONSchema,
  type Tool,
  type ToolContext,
} from './fs-tools';
export { BASH_MAX_CALLS_PER_RUN, bashTool } from './bash';
