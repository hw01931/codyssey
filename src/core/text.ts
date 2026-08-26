/**
 * 글자를 화면에 놓을 때 쓰는 것들.
 *
 * 글자 수와 화면에서 차지하는 칸 수는 다르다. 한글·한자·가나는 한 글자가 두 칸이다.
 * 이걸 안 세면 도움말 정렬이 어긋나고, 이름이 상자 밖으로 삐져나간다.
 * 실제로 '61자' 라서 통과시켰는데 화면에서는 122칸이었다.
 */

/** 터미널·상자에서 차지하는 칸 수. */
export function width(s: string): number {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    n +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
        ? 2
        : 1
  }
  return n
}

/** 오른쪽을 채워 `to` 칸으로 맞춘다. 색을 입히기 전에 써야 한다 - ANSI 는 칸을 안 먹는다. */
export const pad = (s: string, to: number) => s + ' '.repeat(Math.max(0, to - width(s)))

/**
 * `max` 칸을 넘으면 자르고 말줄임을 붙인다. 말줄임도 한 칸을 먹는다.
 * 넘지 않으면 원문 그대로 돌려준다.
 */
export function truncate(s: string, max: number): string {
  if (width(s) <= max) return s
  let out = ''
  let n = 0
  for (const ch of s) {
    const w = width(ch)
    if (n + w > max - 1) break
    out += ch
    n += w
  }
  return out.trimEnd() + '…'
}
