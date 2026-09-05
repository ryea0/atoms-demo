/**
 * 文件树结构纯函数（Task 20）：虚拟 FS 路径列表 → 可渲染树。
 *
 * 职责边界：只做「路径 → 结构」的确定性变换，不感知 store/网络/DOM——组件层
 * （src/components/tree/FileTree.tsx）负责角标、流式态与交互。排序、过滤、默认展开
 * 三条规则都在这里收口，保证「搜索框里的过滤」与「展开态推导」行为可全量单测。
 *
 * 路径来源是 files 表的 path（写入前已过沙箱校验：相对路径、无 `../`、无空段），
 * 这里仍做防御性归一化（去空段、去重），不信任输入。
 */

/** 树节点：目录 children 恒为数组（可能为空），文件 children 恒为空数组 */
export interface TreeNode {
  /** 完整路径（目录不带尾斜杠；文件即虚拟 FS path，可直接用于 onSelect/读取） */
  readonly path: string;
  /** 展示名（最后一段） */
  readonly name: string;
  readonly kind: 'dir' | 'file';
  /** 目录的后代；文件恒为 []（统一形状，渲染层无需判型） */
  readonly children: readonly TreeNode[];
}

export interface BuildTreeOptions {
  /**
   * 搜索过滤词：不区分大小写的路径子串。命中文件保留（连带其全部祖先目录）；
   * 命中目录名 → 整棵子树保留。空/纯空白视同不过滤。
   */
  readonly filter?: string;
}

/** 顶层默认展开目录（DESIGN §2：常用目录生成后直接可见，其余折叠） */
export const DEFAULT_EXPANDED_TOP_LEVEL: readonly string[] = ['.atoms', 'docs', 'app'];

/** 路径分段：容忍空段（防御性归一化，沙箱本不应产出） */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/** 大小写不敏感比较（相等时回退原始码点序，保证排序全序且确定） */
function compareName(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al !== bl) return al < bl ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 树内排序：目录在前、文件在后，组内按名称 */
function compareNode(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
  return compareName(a.name, b.name);
}

/** 目录工作节点（构建期可变，出口冻结为只读树） */
interface DraftDir {
  readonly path: string;
  readonly name: string;
  readonly dirs: Map<string, DraftDir>;
  readonly files: TreeNode[];
}

function draftDirAt(root: DraftDir, segments: readonly string[]): DraftDir {
  let current = root;
  let prefix = '';
  for (const segment of segments) {
    prefix = prefix === '' ? segment : `${prefix}/${segment}`;
    const existing = current.dirs.get(prefix);
    if (existing !== undefined) {
      current = existing;
      continue;
    }
    const created: DraftDir = { path: prefix, name: segment, dirs: new Map(), files: [] };
    current.dirs.set(prefix, created);
    current = created;
  }
  return current;
}

/** 目录工作节点 → 只读树节点（子目录 + 直属文件，排序后冻结） */
function freezeDir(draft: DraftDir): TreeNode {
  const children: TreeNode[] = [];
  for (const child of draft.dirs.values()) children.push(freezeDir(child));
  children.push(...draft.files);
  children.sort(compareNode);
  return { path: draft.path, name: draft.name, kind: 'dir', children };
}

/** 命中祖先目录 → 整棵子树保留；只命中文件 → 只保留该文件与其祖先链 */
function isKept(path: string, query: string): boolean {
  const segments = segmentsOf(path);
  for (let end = 1; end <= segments.length; end += 1) {
    const candidate = segments.slice(0, end).join('/');
    if (candidate.toLowerCase().includes(query)) return true;
  }
  return false;
}

/** 目录工作节点 → 只读树节点（子目录 + 直属文件，排序后冻结） */
function freezeChildren(draft: DraftDir): TreeNode[] {
  const children: TreeNode[] = [];
  for (const child of draft.dirs.values()) children.push(freezeDir(child));
  children.push(...draft.files);
  return children.sort(compareNode);
}

/**
 * 路径列表 → 树。重复路径去重；空串/无有效段（如尾斜杠）跳过。
 * 出口按「目录先、文件后、名称字母序（大小写不敏感）」排序，顺序稳定可测。
 */
export function buildTree(paths: readonly string[], options?: BuildTreeOptions): TreeNode[] {
  const query = (options?.filter ?? '').trim().toLowerCase();

  const root: DraftDir = { path: '', name: '', dirs: new Map(), files: [] };
  const seen = new Set<string>();

  for (const raw of paths) {
    const segments = segmentsOf(raw);
    if (segments.length === 0) continue;
    const path = segments.join('/');
    if (seen.has(path)) continue;
    seen.add(path);
    if (query !== '' && !isKept(path, query)) continue;

    const dirSegments = segments.slice(0, -1);
    const name = segments[segments.length - 1];
    if (name === undefined) continue;
    draftDirAt(root, dirSegments).files.push({ path, name, kind: 'file', children: [] });
  }

  return freezeChildren(root);
}

/**
 * 默认展开目录集合：DEFAULT_EXPANDED_TOP_LEVEL 白名单顶层目录（.atoms/docs/app）
 * **整棵子树**展开——生成的文件都在深层（如 app/frontend/index.html），只展开顶层
 * 会露出空目录，违背「生成后文件直接可见」的意图。白名单之外的目录（如 src/lib）默认折叠。
 */
export function defaultExpandedDirs(paths: readonly string[]): ReadonlySet<string> {
  const expanded = new Set<string>();
  for (const raw of paths) {
    const segments = segmentsOf(raw);
    const top = segments[0];
    if (top === undefined || segments.length < 2) continue; // 首段本身是文件：无目录可展开
    if (!DEFAULT_EXPANDED_TOP_LEVEL.includes(top)) continue;
    for (let end = 1; end < segments.length; end += 1) {
      const dirPath = segments.slice(0, end).join('/');
      expanded.add(dirPath);
    }
  }
  return expanded;
}

/** 行数计数（流式文件展示「N 行」）：按换行分段；忽略单个尾换行，空内容为 0 行 */
export function countLines(content: string): number {
  if (content === '') return 0;
  return content.replace(/\n$/, '').split('\n').length;
}
