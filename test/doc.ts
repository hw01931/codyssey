/**
 * 정의 위에 붙은 주석에서 '이게 뭐 하는 건지' 한 줄을 뽑는다.
 *
 * 실제로 재보니 최상위 정의의 45~65% 에 주석이 붙어 있고, 바이브코딩 결과물은
 * 89% 였다. 폴더 구조가 없는 한 파일짜리 프로젝트에서 이름을 얻을 유일한 단서다.
 *
 * 다만 주석이라고 다 이름은 아니다. 라이선스 머리말, `eslint-disable`,
 * `@param`, `====` 구분선 같은 게 그대로 이름이 되면 안 하느니만 못하다.
 * 여기서 걸러내는 규칙을 못 박는다.
 */
import { docAt, cleanDocLine, fileDoc } from '../src/core/doc.ts'

const NL = String.fromCharCode(10)
let pass = 0
let fail = 0
const c = {
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  d: (s: string) => `\x1b[2m${s}\x1b[0m`,
}
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) { pass++; console.log(`  ${c.g('ok')}   ${label}`) }
  else { fail++; console.log(`  ${c.r('FAIL')} ${label}${NL}         받음: ${g}${NL}         기대: ${w}`) }
}
function ok(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ${c.g('ok')}   ${label}${detail ? c.d('  ' + detail) : ''}`) }
  else { fail++; console.log(`  ${c.r('FAIL')} ${label} ${detail}`) }
}

/** 소스를 줄 배열로. 테스트에서 읽기 좋게 쓰려고 둔다. */
const src = (...lines: string[]) => lines

console.log(`${NL}[한 줄 주석에서 뽑는다]`)
eq(
  '// 위에 있으면 가져온다',
  docAt(src('// 돈 계산만 모아둔 곳', 'export function formatMoney() {}'), 2),
  '돈 계산만 모아둔 곳',
)
eq(
  '# 도 마찬가지',
  docAt(src('# 주문을 만든다', 'def create_order():'), 2),
  '주문을 만든다',
)
eq(
  '여러 줄이면 첫 줄만',
  docAt(src('// 결제를 시작한다', '// 실패하면 롤백한다', 'export function charge() {}'), 3),
  '결제를 시작한다',
)
eq('주석이 없으면 없다', docAt(src('export function x() {}'), 1), undefined)
eq(
  '빈 줄로 떨어져 있으면 그 주석이 아니다',
  docAt(src('// 위 함수 설명', '', 'export function x() {}'), 3),
  undefined,
)

console.log(`${NL}[블록 주석]`)
eq(
  '/** */ 의 첫 문장',
  docAt(src('/**', ' * 그래프의 핵심. 사람 승인 필요.', ' * 두 번째 줄', ' */', 'export class Graph {}'), 5),
  '그래프의 핵심.',
)
eq(
  '한 줄짜리 /** */',
  docAt(src('/** 장바구니 화면 */', 'function Cart() {}'), 2),
  '장바구니 화면',
)
eq(
  '@param 만 있으면 이름으로 못 쓴다',
  docAt(src('/**', ' * @param a 첫 인자', ' */', 'function f(a) {}'), 4),
  undefined,
)
eq(
  '설명 다음에 @param 이 오면 설명만',
  docAt(src('/**', ' * 두 값을 더한다.', ' * @param a 첫 인자', ' */', 'function f(a) {}'), 5),
  '두 값을 더한다.',
)

console.log(`${NL}[파이썬은 정의 아래 독스트링이 먼저다]`)
eq(
  '독스트링 한 줄',
  docAt(src('def charge():', '    """결제를 시작한다."""', '    pass'), 1, { python: true }),
  '결제를 시작한다.',
)
eq(
  '여러 줄 독스트링의 첫 줄',
  docAt(src('def charge():', '    """', '    결제를 시작한다.', '    실패하면 롤백.', '    """'), 1, { python: true }),
  '결제를 시작한다.',
)
eq(
  '독스트링이 없으면 위 주석으로 떨어진다',
  docAt(src('# 결제 진입점', 'def charge():', '    pass'), 2, { python: true }),
  '결제 진입점',
)

console.log(`${NL}[이름으로 쓰면 안 되는 것들]`)
// 이걸 못 거르면 화면 가득 'eslint-disable' 이 뜬다. 안 하느니만 못하다.
for (const junk of [
  'eslint-disable-next-line no-console',
  'prettier-ignore',
  '@ts-ignore',
  'type: ignore',
  'noqa: E501',
  'Copyright (c) 2024 Someone',
  'SPDX-License-Identifier: MIT',
  'Licensed under the Apache License, Version 2.0',
  '!/usr/bin/env node',
  'TODO',
  'FIXME: 나중에',
  '-*- coding: utf-8 -*-',
]) {
  eq(`'${junk.slice(0, 28)}' 는 버린다`, docAt(src('// ' + junk, 'function f() {}'), 2), undefined)
}

console.log(`${NL}[꾸밈은 벗긴다]`)
// 바이브코딩 결과물에서 제일 흔한 모양이다.
eq('==== 구분선', cleanDocLine('==================== 로그인 ===================='), '로그인')
eq('---- 구분선', cleanDocLine('-------- 상품 목록 --------'), '상품 목록')
eq('#### 머리말', cleanDocLine('#### 결제 ####'), '결제')
eq('별표', cleanDocLine('***** 장바구니 *****'), '장바구니')
eq('꾸밈만 있으면 버린다', cleanDocLine('================'), undefined)
eq('점만 있어도 버린다', cleanDocLine('...'), undefined)

console.log(`${NL}[길면 자른다]`)
// 이름은 상자 안이나 한 줄 메시지에 들어간다. 길면 화면이 망가진다.
{
  const long = docAt(
    src('// 이 함수는 주문을 만들고 재고를 줄이고 결제를 걸고 메일을 보내고 로그를 남기고 통계를 갱신하고 캐시를 지운다', 'function f() {}'),
    2,
  )
  ok('72자를 넘지 않는다', (long?.length ?? 0) <= 72, `${long?.length}자`)
  ok('잘렸으면 표시가 있다', long!.endsWith('…'), long!)
}
eq(
  '첫 문장에서 끊는다',
  docAt(src('// 주문을 만든다. 재고는 건드리지 않는다. 결제도 따로다.', 'function f() {}'), 2),
  '주문을 만든다.',
)

console.log(`${NL}[파일 머리말]`)
eq(
  '파일 첫 주석을 파일 설명으로',
  fileDoc(src('/**', ' * 그래프. 순수 데이터.', ' */', '', 'export class Graph {}')),
  '그래프.',
)
eq(
  '셔뱅 다음 주석도 본다',
  fileDoc(src('#!/usr/bin/env node', '// 명령줄 진입점', 'main()')),
  '명령줄 진입점',
)
eq('머리말이 없으면 없다', fileDoc(src('import x from "y"', 'export const a = 1')), undefined)
eq('라이선스 머리말은 파일 설명이 아니다', fileDoc(src('// Copyright (c) 2024', '// MIT', 'export const a = 1')), undefined)

console.log(`${NL}[망가진 입력에도 안 죽는다]`)
// P5: 이름 하나 못 뽑았다고 스캔이 멈추면 안 된다.
eq('범위 밖', docAt(src('a'), 99), undefined)
eq('0줄', docAt(src('a'), 0), undefined)
eq('빈 파일', docAt([], 1), undefined)
eq('빈 파일 머리말', fileDoc([]), undefined)

console.log(`${NL}${fail === 0 ? c.g('통과') : c.r('실패')}  ${pass}개 성공, ${fail}개 실패${NL}`)
process.exit(fail === 0 ? 0 : 1)
