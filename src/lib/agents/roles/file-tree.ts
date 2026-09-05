/**
 * 文件树共享类型（Task 12 架构师 / Task 13 工程师并行声明，控制器裁决：
 * 先在本文件落一份共享声明，T12 在 roles/architect.ts 的副本合并时统一去重到此处）。
 * 与 src/lib/agents/context.ts 的 FileTreeNode 逐字段一致（{path, desc, depends}），
 * 结构兼容即可互换，不做 re-export 环。
 */

/** file_tree.json 单节点：路径 + 职责描述 + 依赖声明（拓扑序数组的一员） */
export interface FileTreeNode {
  path: string;
  desc: string;
  depends: string[];
}

/** file_tree.json 顶层结构：节点数组（按拓扑序排列，编排器按序逐文件派发） */
export type FileTree = FileTreeNode[];
