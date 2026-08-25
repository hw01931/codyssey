import fs from 'node:fs'
import path from 'node:path'
import { en } from './en.ts'
import { ko } from './ko.ts'

/**
 * 쓰는 말.
 *
 * 이 도구는 한국어로 먼저 만들어졌는데, npm 에 올리는 순간 그건 결함이 된다.
 * 설치한 사람 대부분은 한국어를 못 읽는다.
 *
 * 두 가지를 구분해야 한다.
 *   1. 메시지   "실행 중", "보호된 파일입니다" — 고정 문자열. 여기서 번역한다.
 *   2. 레이블   'api/services' -> '서버 처리 로직' — 코드에서 뽑아낸 이름.
 *              이건 core/labels.ts 가 맡는다. 영어 사용자에게는 경로 자체가
 *              이미 영어라서 사전이 거의 필요 없다. 사전이 존재하는 이유가
 *              "코드는 영어인데 읽는 사람은 한국인" 이기 때문이다.
 *
 * 기본값은 영어다. npm 패키지의 기본이 특정 나라 말이면 안 된다.
 * 대신 OS 로케일이 한국어면 알아서 한국어로 간다. 명시 설정이 언제나 이긴다.
 */
export type Lang = 'en' | 'ko'

const CATALOGS = { en, ko } as const
export const LANGS = Object.keys(CATALOGS) as Lang[]

export const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANGS as string[]).includes(v)

let current: Lang = 'en'
let pinned = false

export const getLang = (): Lang => current

/**
 * 쓸 말을 정한다.
 *
 * `explicit` 은 사람이 `--lang` 으로 직접 시킨 경우다. 한 번 그렇게 정하면
 * 그 뒤의 추측은 무시한다. 안 그러면 CLI 가 `--lang en` 을 받아 영어로 맞춰놓고,
 * 곧이어 데몬이 rules.yaml 을 읽으면서 다시 한국어로 되돌린다. 실제로 그랬다 —
 * `codyssey map --lang en` 이 한국어로 나왔다.
 *
 * 우선순위는 resolveLang 이 적어둔 그대로여야 한다: 명시 > 파일 > 환경 > 영어.
 */
export function setLang(lang: Lang | undefined, explicit = false) {
  if (!isLang(lang)) return
  if (pinned && !explicit) return
  current = lang
  if (explicit) pinned = true
}

/** 테스트에서 상태를 되돌리기 위한 것. 제품 코드에서는 쓰지 않는다. */
export function unpinLang() {
  pinned = false
}

/** OS 로케일에서 말을 추측한다. `ko_KR.UTF-8`, `ko-KR`, `ko` 전부 받는다. */
export function langFromEnv(env: NodeJS.ProcessEnv = process.env): Lang | undefined {
  const raw = env.CODYSSEY_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || env.LANGUAGE
  if (raw) {
    const head = raw.split(/[._:,]/)[0].replace('-', '_').split('_')[0].toLowerCase()
    if (isLang(head)) return head
  }
  // 윈도우는 LANG 을 안 준다. Intl 이 OS 설정을 그대로 들고 있다.
  try {
    const head = new Intl.DateTimeFormat().resolvedOptions().locale.split('-')[0].toLowerCase()
    if (isLang(head)) return head
  } catch {}
  return undefined
}

/**
 * 이 저장소에서 쓸 말을 정한다.
 * 우선순위: 명시 인자 > .codyssey/rules.yaml 의 lang > 환경 > 영어.
 * rules.yaml 은 YAML 파서 없이 한 줄만 읽는다. 이 함수는 파서가 준비되기 전,
 * 아주 이른 시점에도 불리기 때문이다.
 */
export function resolveLang(repoRoot?: string, explicit?: string): Lang {
  if (isLang(explicit)) return explicit
  if (repoRoot) {
    try {
      const text = fs.readFileSync(path.join(repoRoot, '.codyssey', 'rules.yaml'), 'utf8')
      const m = /^lang:\s*["']?([A-Za-z_-]+)["']?\s*$/m.exec(text)
      const head = m?.[1].replace('-', '_').split('_')[0].toLowerCase()
      if (isLang(head)) return head
    } catch {}
  }
  return langFromEnv() ?? 'en'
}

export type Key = keyof typeof en

/**
 * 번역된 문자열. `{name}` 자리를 채운다.
 *
 * 키가 없으면 던지지 않고 키 자체를 돌려준다. 이 도구는 실패해도 막지 않는 게
 * 원칙이라(P5), 번역 하나 빠졌다고 사용자의 작업을 멈추면 안 된다.
 * 빠진 키는 테스트가 잡는다.
 */
export function t(key: Key, vars?: Record<string, string | number>): string {
  const table = CATALOGS[current] as Record<string, string>
  const raw = table[key] ?? (en as Record<string, string>)[key] ?? String(key)
  const filled = vars
    ? raw.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole))
    : raw
  return applyJosa(filled)
}

const JOSA_SLOT = /\{(은는|이가|을를|과와|으로로)\}/g

/**
 * `{name}{은는}` 처럼 조사 자리를 남겨두면 앞 글자를 보고 채운다.
 * 호출하는 쪽이 조사를 신경 쓰지 않아도 되게 하려는 것이다.
 * 영어 카탈로그에는 이 자리가 아예 없으므로 아무 일도 일어나지 않는다.
 */
function applyJosa(s: string): string {
  return s.replace(JOSA_SLOT, (whole, pair, at: number) => {
    const before = s.slice(0, at).trimEnd()
    return before ? josa(before, pair as Parameters<typeof josa>[1]) : ''
  })
}

/**
 * 영문자·숫자를 한 글자씩 읽었을 때 받침이 있는지.
 * 'l'(엘), 'm'(엠), 'n'(엔), 'r'(알), '1'(일) 처럼 끝소리가 자음인 것만 참이다.
 * 파일 이름은 대부분 영어라서 이게 없으면 `api.ts은` 같은 말이 나온다.
 */
const LATIN_BATCHIM = new Set(['l', 'm', 'n', 'r', '0', '1', '3', '6', '7', '8'])

/**
 * 한국어 조사. `앱 은(는)` 같은 표기를 없앤다.
 * 받침이 있으면 앞것, 없으면 뒷것.
 */
export function josa(word: string, pair: '은는' | '이가' | '을를' | '과와' | '으로로'): string {
  const [withBatchim, without] = (
    { 은는: ['은', '는'], 이가: ['이', '가'], 을를: ['을', '를'], 과와: ['과', '와'], 으로로: ['으로', '로'] } as const
  )[pair]
  const last = word.trim().slice(-1).toLowerCase()
  const code = last.charCodeAt(0)

  if (Number.isNaN(code)) return withBatchim
  if (code < 0xac00 || code > 0xd7a3) {
    if (!/[a-z0-9]/.test(last)) return withBatchim // 기호로 끝나면 판단할 근거가 없다
    // 'ㄹ' 로 끝나는 소리는 '으로/로' 에서만 받침 없는 쪽을 따른다 ('파일로')
    if (!LATIN_BATCHIM.has(last)) return without
    return pair === '으로로' && (last === 'l' || last === 'r' || last === '1') ? without : withBatchim
  }

  const jong = (code - 0xac00) % 28
  if (pair === '으로로' && jong === 8) return without // 'ㄹ' 받침 ('서울로')
  return jong === 0 ? without : withBatchim
}
