/**
 * token 字符估算（DESIGN §4.4「中文场景校准」）：
 * 中文 ≈1.2 token/字，英文/代码 ≈ chars/3.5，分段求和后 ceil。
 *
 * 注：§4.4 另提到「+20% 裕量」，按控制器裁决不在本函数内应用——
 * 校准契约以两条固定用例为准（'一二三四五'→6、'abcdefgh'→3），
 * 需要裕量的调用方自行在外层放大。
 */

/** CJK 汉字区间：扩展 A / 基本区 / 兼容表意文字（不用 \p{Script=Han}，规避 target ES2017 限制） */
const HAN_PATTERN = /[㐀-䶿一-鿿豈-﫿]/g;

/** 中文 1.2 token/字 */
const TOKENS_PER_HAN = 1.2;
/** 非中文 chars/3.5 token */
const CHARS_PER_TOKEN_OTHER = 3.5;

/** 估算文本 token 数（ceil；空串/纯空白为 0） */
export function estimateTokens(text: string): number {
  const hanMatches = text.match(HAN_PATTERN);
  const hanCount = hanMatches?.length ?? 0;
  const otherCount = text.length - hanCount;
  if (hanCount === 0 && otherCount === 0) return 0;
  return Math.ceil(hanCount * TOKENS_PER_HAN + otherCount / CHARS_PER_TOKEN_OTHER);
}
