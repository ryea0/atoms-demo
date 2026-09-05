/**
 * 检索层共享的行切分口径：与工具层 read_file/grep 完全相同的 CRLF→LF 归一，
 * 保证 grep 与 fts5 两种实现给出的行号、行文本逐字节一致。
 */

/** CRLF 归一：否则行号错位、行尾锚点正则（如 TODO$）会静默失配 */
export function toLf(content:string):string {
  return content.replace(/\r\n/g, '\n');
}

/** 先归一再按 LF 切行（末尾换行会产生一个空尾元素，与 grep 现行为一致） */
export function splitLfLines(content:string):string[] {
  return toLf(content).split('\n');
}
