import fs from 'node:fs'
import path from 'node:path'

/**
 * tsconfig/jsconfig 에서 경로 별칭을 읽는다.
 *
 * 예전에는 `//` 만 지우고 JSON.parse 했다. 실제 프로젝트 tsconfig 에는
 * `/* Bundler mode *\/` 같은 블록 주석과 `"$schema": "https://..."` 가 흔하고,
 * 그러면 파싱이 조용히 실패해서 `@/` import 가 전부 '외부 패키지' 로 빠졌다.
 * FastAPI 풀스택 템플릿에서 프론트 페이지가 전부 '파일 1개' 로 나온 원인이다.
 *
 * 그래서 여기서는
 *   - 문자열을 건드리지 않고 주석과 끝 쉼표만 지운다
 *   - extends 를 따라간다 (상대 경로만. 패키지 tsconfig 는 별칭을 안 준다)
 *   - references 도 본다 (Vite 템플릿은 별칭을 tsconfig.app.json 에 둔다)
 *   - baseUrl 기준을 반영한다
 * 돌려주는 대상 경로는 전부 '프로젝트 루트 기준 상대 경로' 다.
 */

/** 주석과 끝 쉼표를 지운다. 문자열 안의 `//`, `/*` 는 그대로 둔다. */
export function stripJsonc(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1
      out += src.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? src.length : end + 2
    } else {
      out += c
      i++
    }
  }
  // 끝 쉼표. 문자열은 이미 통과시켰으니 여기서 걸리는 건 진짜 구분자뿐이다
  // (문자열 안에 `,}` 가 있을 수는 있지만 tsconfig 에서는 사실상 없다)
  return out.replace(/,(\s*[}\]])/g, '$1')
}

interface Loaded {
  paths?: Record<string, string[]>
  /** paths 대상이 붙는 기준 폴더 (절대 경로) */
  pathsBase?: string
  references: string[]
}

function readConfig(abs: string, seen: Set<string>): Loaded | null {
  if (seen.has(abs) || !fs.existsSync(abs)) return null
  seen.add(abs)
  let json: any
  try {
    json = JSON.parse(stripJsonc(fs.readFileSync(abs, 'utf8')))
  } catch {
    return null // 깨진 설정은 건너뛴다 (P5)
  }
  const dir = path.dirname(abs)

  // extends 먼저 읽고 내 설정으로 덮는다
  let base: Loaded = { references: [] }
  const ext = ([] as unknown[]).concat(json?.extends ?? [])
  for (const e of ext) {
    if (typeof e !== 'string' || !e.startsWith('.')) continue
    const p = path.resolve(dir, e.endsWith('.json') ? e : `${e}.json`)
    const got = readConfig(p, seen)
    if (got) base = { ...base, ...pick(got) }
  }

  const co = json?.compilerOptions ?? {}
  const baseUrl = typeof co.baseUrl === 'string' ? path.resolve(dir, co.baseUrl) : undefined
  const own: Loaded = { references: [] }
  if (co.paths && typeof co.paths === 'object') {
    own.paths = co.paths
    own.pathsBase = baseUrl ?? dir
  } else if (base.paths && baseUrl) {
    // 물려받은 paths 는 내 baseUrl 기준으로 다시 붙는다 (tsc 와 같은 규칙)
    own.pathsBase = baseUrl
  } else if (baseUrl && !base.paths) {
    // baseUrl 만 있으면 'components/Foo' 같은 맨 이름이 그 아래에서 풀린다
    own.paths = { '*': ['*'] }
    own.pathsBase = baseUrl
  }

  for (const r of Array.isArray(json?.references) ? json.references : []) {
    if (typeof r?.path !== 'string') continue
    const p = path.resolve(dir, r.path)
    own.references.push(p.endsWith('.json') ? p : path.join(p, 'tsconfig.json'))
  }
  return { ...base, ...pick(own), references: own.references }
}

function pick(l: Loaded): Partial<Loaded> {
  const o: Partial<Loaded> = {}
  if (l.paths) o.paths = l.paths
  if (l.pathsBase) o.pathsBase = l.pathsBase
  return o
}

/**
 * 프로젝트 폴더의 별칭 맵. 대상은 프로젝트 루트 기준 상대 경로.
 * 여러 설정에 같은 별칭이 있으면 먼저 찾은 쪽이 이긴다.
 */
export function loadAliases(projectAbs: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const seen = new Set<string>()
  const queue = ['tsconfig.json', 'jsconfig.json'].map(f => path.join(projectAbs, f))
  while (queue.length) {
    const cfg = readConfig(queue.shift()!, seen)
    if (!cfg) continue
    queue.push(...cfg.references)
    if (!cfg.paths || !cfg.pathsBase) continue
    for (const [pattern, targets] of Object.entries(cfg.paths)) {
      if (out[pattern] || !Array.isArray(targets)) continue
      out[pattern] = targets
        .filter((t): t is string => typeof t === 'string')
        .map(t => path.relative(projectAbs, path.resolve(cfg.pathsBase!, t)).split(path.sep).join('/'))
    }
  }
  return out
}
