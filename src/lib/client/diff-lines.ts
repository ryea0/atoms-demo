/**
 * 行级 diff（Task 21 冲突对话框「并排对比」用）。
 *
 * 口径刻意从简（DESIGN §3.9「行级差异高亮简化为整行红绿」）：不产出词级 patch、
 * 不区分「改/删/增」三类——先按 LCS 找出公共行，再把连续的差异段按行对齐成对照矩阵：
 * 左=我的版本、右=agent 版本，某侧缺行补 null（渲染为空槽），不同行整行着色。
 *
 * 纯函数、无依赖；行数超上限时退化为「按下标直接对照」，避免大文件 O(n·m) 卡顿。
 */

/** 并排对比的行数上限（超出即不做 LCS，保证大文件也不卡 UI） */
const MAX_DIFF_LINES = 2000;

/** 一行对照：left=我的版本行，right=agent 版本行；same=两侧完全一致 */
export interface DiffRow {
  left: string | null;
  right: string | null;
  same: boolean;
}

/** 差异方向：left=仅我的版本有，right=仅 agent 版本有 */
type DiffOp = { kind: 'same' | 'left' | 'right'; text: string };

function splitLines(text: string): string[] {
  if (text === '') return [];
  // split('\n') 会让末尾换行多出一个空串——按行展示时不应出现这个幽灵行
  return text.replace(/\n$/, '').split('\n');
}

/** LCS 长度表（动态规划；已由调用方保证行数不超上限）。table[i][j] = LCS(a[i..], b[j..]) */
function lcsLengths(a: readonly string[], b: readonly string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = table[i];
    const next = table[i + 1];
    if (row === undefined) continue; // 表按 length+1 建行，理论上不可达
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const ai: string | undefined = a[i];
      const bj: string | undefined = b[j];
      row[j] = ai !== undefined && bj !== undefined && ai === bj
        ? (next?.[j + 1] ?? 0) + 1
        : Math.max(next?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  return table;
}

/** 按 LCS 顺序展开成带方向的行序列（公共行 same，独有行 left/right） */
function toOps(left: readonly string[], right: readonly string[], table: number[][]): DiffOp[] {
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const li: string | undefined = left[i];
    const rj: string | undefined = right[j];
    if (li !== undefined && rj !== undefined && li === rj) {
      ops.push({ kind: 'same', text: li });
      i += 1;
      j += 1;
      continue;
    }
    // LCS 表指示往哪边推进能保住最长公共子序列
    if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      if (li !== undefined) ops.push({ kind: 'left', text: li });
      i += 1;
    } else {
      if (rj !== undefined) ops.push({ kind: 'right', text: rj });
      j += 1;
    }
  }
  while (i < left.length) {
    const li: string | undefined = left[i];
    if (li !== undefined) ops.push({ kind: 'left', text: li });
    i += 1;
  }
  while (j < right.length) {
    const rj: string | undefined = right[j];
    if (rj !== undefined) ops.push({ kind: 'right', text: rj });
    j += 1;
  }
  return ops;
}

/**
 * 两段文本的并排行对照：公共行配对；连续差异段按行对齐（短侧补 null）并整行标记 same=false。
 */
export function diffLines(mine: string, theirs: string): DiffRow[] {
  const left = splitLines(mine);
  const right = splitLines(theirs);

  if (left.length > MAX_DIFF_LINES || right.length > MAX_DIFF_LINES) {
    const rows: DiffRow[] = [];
    const total = Math.max(left.length, right.length);
    for (let index = 0; index < total; index += 1) {
      const l: string | undefined = left[index];
      const r: string | undefined = right[index];
      rows.push({ left: l ?? null, right: r ?? null, same: l !== undefined && l === r });
    }
    return rows;
  }

  const ops = toOps(left, right, lcsLengths(left, right));
  const rows: DiffRow[] = [];
  let index = 0;
  while (index < ops.length) {
    const op = ops[index];
    if (op === undefined) break;
    if (op.kind === 'same') {
      rows.push({ left: op.text, right: op.text, same: true });
      index += 1;
      continue;
    }
    // 连续差异段：两侧各自收集后按行对齐（短侧补 null）
    const leftRun: string[] = [];
    const rightRun: string[] = [];
    while (index < ops.length) {
      const current = ops[index];
      if (current === undefined || current.kind === 'same') break;
      (current.kind === 'left' ? leftRun : rightRun).push(current.text);
      index += 1;
    }
    const total = Math.max(leftRun.length, rightRun.length);
    for (let offset = 0; offset < total; offset += 1) {
      const l: string | undefined = leftRun[offset];
      const r: string | undefined = rightRun[offset];
      rows.push({ left: l ?? null, right: r ?? null, same: false });
    }
  }
  return rows;
}
