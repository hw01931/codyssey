/**
 * 정의 위(파이썬은 아래)에 붙은 주석에서 '이게 뭐 하는 건지' 한 줄을 뽑는다.
 *
 * 왜 하냐면, 이름을 얻을 출처가 하나 더 생기기 때문이다. 지금은 경로 조각을
 * 사전으로 옮기는 게 전부인데(`api/services` -> '처리 로직'), 그건 추측이다.
 * 저자가 직접 쓴 주석이 있으면 그게 더 정확하다.
 *
 * 실제로 재본 값(최상위 정의 기준):
 *   바이브코딩 결과물  89%   <- 폴더 구조가 없어 사전이 아무 도움이 안 되는 바로 그 경우
 *   flask              65%
 *   codyssey 자기 코드  51%
 *   repomix            45%
 *
 * 절반만 붙어 있어도 손해가 없다. 없으면 지금처럼 사전으로 떨어질 뿐이다.
 *
 * 다만 주석이라고 다 이름은 아니다. 라이선스 머리말, `eslint-disable`, `@param`,
 * `====` 구분선이 그대로 이름이 되면 안 하느니만 못하다.
 *
 * **애매하면 버린다.** 이름이 없으면 사전으로 떨어지지만, 틀린 이름은 사람을
 * 잘못 이끈다. 그래서 처음 만난 '내용 있는 줄' 하나로 판정하고, 그게 쓸 수 없는
 * 것이면 아래를 더 뒤지지 않는다. 그러지 않으면 `// Copyright` 다음의 `// MIT` 가
 * 이름이 된다.
 *
 * LLM 은 부르지 않는다(P1). 전부 문자열 처리다.
 */

/** 이름으로 쓰면 안 되는 것들. 도구 지시문, 법적 머리말, 할 일 표시. */
const JUNK = [
  /^@\w/, // @param, @returns, @ts-ignore ...
  /^eslint[-\w]*/i,
  /^prettier[-\w]*/i,
  /^ts-\w+/i,
  /^type:\s*ignore/i,
  /^noqa\b/i,
  /^(pylint|flake8|mypy|ruff|istanbul|c8|biome-ignore)\b/i,
  /^copyright\b/i,
  /^spdx[-\w]*/i,
  /^licen[sc]ed?\b/i,
  /^all rights reserved/i,
  /^!\//, // 셔뱅
  /^-\*-/, // 에디터 지시문
  // `-*- coding: utf-8 -*-` 는 꾸밈을 벗기고 나면 `coding: utf-8` 만 남아
  // 위 규칙을 빠져나간다. 벗긴 뒤 모양으로도 한 번 더 본다.
  /^coding[:=]/i,
  /^vim?:/i,
  /^(todo|fixme|xxx|hack)\b/i,
  /^\/\//, // 마커가 남았다면 우리가 못 벗긴 것이다. 이름으로 쓰지 않는다
]

/**
 * 이름 한 줄의 최대 **칸 수**. 상자 안이나 한 줄 메시지에 들어간다.
 * 글자 수로 재면 안 된다 - 한글 61자는 화면에서 122칸이다.
 */
const MAX = 60

const COMMENT_START = /^(\/\/|#|\/\*|\*)/
const TRIPLE = /^("""|''')/

const isComment = (t: string) => COMMENT_START.test(t)
const isTriple = (t: string) => TRIPLE.test(t)

/**
 * 주석 마커와 꾸밈만 벗긴다. 판정은 하지 않는다.
 *
 * `==================== 로그인 ====================` -> `로그인`
 * 바이브코딩 결과물에서 제일 흔한 모양이라 반드시 벗겨야 한다.
 * 꾸밈뿐이면 빈 문자열이 되고, 부르는 쪽이 '내용 없는 줄' 로 넘긴다.
 */
function strip(raw: string): string {
  let s = raw.trim()
  s = s.replace(/^\/\*+/, '').replace(/\*+\/$/, '')
  s = s.replace(/^(\/\/+|#+|\*+|--+|;+)/, '')
  s = s.replace(/^("""|''')/, '').replace(/("""|''')$/, '')
  // 양쪽 꾸밈. 마침표는 여기 넣지 않는다 - 문장 부호까지 지워버린다.
  s = s.replace(/^[\s=*\-_~#·•]+/, '').replace(/[\s=*\-_~#·•]+$/, '')
  s = s.trim()
  // 꾸밈을 벗기고 나서 글자가 하나도 없으면 구분선이었던 것이다 ('...', '====')
  return /[\p{L}\p{N}]/u.test(s) ? s : ''
}

/**
 * 주석 한 줄을 이름으로 쓸 수 있게 다듬는다. 못 쓰겠으면 undefined.
 * 마커를 벗기고, 쓰면 안 되는 것을 거르고, 첫 문장만 남기고, 길면 자른다.
 */
export function cleanDocLine(raw: string): string | undefined {
  let s = strip(raw)
  if (!s) return undefined
  for (const j of JUNK) if (j.test(s)) return undefined

  // 첫 문장에서 끊는다. 뒤 문장은 이름이 아니라 설명이다.
  const stop = s.search(/[.!?。](\s|$)/)
  if (stop > 0) s = s.slice(0, stop + 1).trim()
  if (!s) return undefined

  return truncate(s, MAX)
}

export interface DocOptions {
  /** 파이썬은 정의 **아래** 독스트링이 먼저다 */
  python?: boolean
}

/**
 * `line`(1부터) 에 있는 정의의 설명 한 줄.
 * 파이썬은 독스트링을 먼저 보고, 없으면 위 주석으로 떨어진다.
 */
export function docAt(lines: string[], line: number, opts: DocOptions = {}): string | undefined {
  if (!lines.length || line < 1 || line > lines.length) return undefined
  if (opts.python) {
    const d = docstringBelow(lines, line)
    if (d) return d
  }
  return commentAbove(lines, line)
}

/**
 * 파일 맨 앞 주석. 그 파일이 통째로 무엇인지에 해당한다.
 * 셔뱅과 빈 줄은 건너뛴다. 코드를 먼저 만나면 머리말이 없는 것이다.
 */
export function fileDoc(lines: string[]): string | undefined {
  let i = 0
  while (i < lines.length && (!lines[i].trim() || lines[i].trim().startsWith('#!'))) i++
  if (i >= lines.length) return undefined
  const t = lines[i].trim()
  if (!isComment(t) && !isTriple(t)) return undefined
  return firstUsable(lines.slice(i, i + 8))
}

// ---------------------------------------------------------------- 안쪽

/**
 * 내용이 있는 첫 줄 하나로 판정한다.
 *
 * 꾸밈뿐인 줄(`/**`, `====`)은 건너뛰지만, 내용이 있는데 쓸 수 없는 것이면
 * 거기서 끝낸다. 계속 뒤지면 `// Copyright` 다음 `// MIT` 가 이름이 되고,
 * `@param` 블록에서는 인자 설명이 함수 이름이 된다.
 */
function firstUsable(block: string[]): string | undefined {
  for (const raw of block) {
    if (!strip(raw)) continue
    return cleanDocLine(raw)
  }
  return undefined
}

/**
 * 정의 바로 위에 붙은 주석 덩어리.
 *
 * 빈 줄이 하나라도 끼면 그 주석은 이 정의의 것이 아니다. 위 함수의 꼬리이거나
 * 파일 머리말이다. 그걸 가져오면 엉뚱한 이름이 붙는다.
 */

import { truncate } from './text.ts'
function commentAbove(lines: string[], line: number): string | undefined {
  let i = line - 2 // line 은 1부터 세고, 그 바로 위
  if (i < 0) return undefined
  // 데코레이터는 정의의 일부로 본다 (@app.get(...), @Entity())
  while (i >= 0 && /^\s*@\w/.test(lines[i])) i--
  let top = -1
  while (i >= 0) {
    const t = lines[i].trim()
    if (!t || !isComment(t)) break
    top = i
    i--
  }
  if (top < 0) return undefined
  return firstUsable(lines.slice(top, line - 1))
}

/** 정의 다음 줄부터 시작하는 독스트링. */
function docstringBelow(lines: string[], line: number): string | undefined {
  // 정의가 여러 줄일 수 있다. `def f(\n  a,\n):` 를 만나면 `:` 로 끝나는 줄까지 간다
  let i = line - 1
  for (let guard = 0; i < lines.length && guard < 30 && !/:\s*(#.*)?$/.test(lines[i]); guard++) i++
  i++
  while (i < lines.length && !lines[i].trim()) i++
  if (i >= lines.length || !isTriple(lines[i].trim())) return undefined

  // 여는 따옴표와 같은 줄에 내용이 있으면 그것, 아니면 다음 줄부터.
  // 독스트링 안은 주석 마커가 없으므로 닫는 따옴표까지를 범위로 준다.
  const body: string[] = []
  for (let j = i; j < lines.length && j < i + 8; j++) {
    const t = lines[j].trim()
    if (j > i && TRIPLE.test(t)) break
    body.push(t)
  }
  return firstUsable(body)
}
