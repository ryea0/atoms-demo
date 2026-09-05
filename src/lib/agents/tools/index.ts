/**
 * 工具层公共出口：路径沙箱 + FS 工具集 + 工具契约类型。
 * AgentRunner（Task 8）从这里 import Tool/ToolContext/fsTools；角色层按需挑选工具子集。
 */
export { normalizeProjectPath, type PathCheckResult } from './sandbox';
export { formatZodIssues, fsTools, type JSONSchema, type Tool, type ToolContext } from './fs-tools';
