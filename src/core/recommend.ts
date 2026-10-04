import fs from 'node:fs'
import path from 'node:path'
import type { Graph } from './graph.ts'
import { autolockCandidates, isGenerated, type Features } from './features.ts'
import { crossModuleShared, type Modules } from './modules.ts'
import { contractsOf } from './contract.ts'
import { alternativesFor, shortList, type Rules, type Say } from './rules.ts'
import { t } from '../i18n/index.ts'

/**
 * 잠금 추천.
 *
 * 예전에는 "여러 기능이 함께 쓰는 파일 9개 - 화면에서 골라주세요" 로 끝났다.
 * 이유가 숫자 하나고, 잠그면 무슨 일이 생기는지도 없었다. 코드를 모르는 사람은
 * 거기서 멈춘다.
 *
 * 추천 하나는 네 가지를 같이 말한다.
 *   무엇을        파일
 *   왜            근거 목록. 종류마다 실제 값(기능 이름, 쓰는 곳 수)을 붙인다
 *   잠그면        AI 에게 무슨 일이 생기는지
 *   얼마나 확실한가  import 관계만 봤다는 것. 실제 동작 영향은 테스트가 안다
 *
 * 그리고 '추천하지 않는 것' 도 이유와 함께 보여준다. 생성 파일, 빈 파일, 진입점.
 * 조용히 빼면 왜 빠졌는지 몰라서 판단을 믿을 수 없다.
 *
 * LLM 은 없다. 전부 그래프와 파일 이름에서 나온다.
 */

export type Level = 'ask' | 'block'
export type ReasonKind = 'shared-features' | 'shared-modules' | 'contract' | 'secret'

export interface Reason {
  kind: ReasonKind
  /** 사람 말로 */
  text: string
  /** 기계가 쓸 근거값 */
  evidence: { list?: string[]; count?: number; name?: string }
}

export interface Recommendation {
  file: string
  label: string
  /** ask: 고칠 때 사람 확인. block: 읽기도 쓰기도 막음 (비밀) */
  level: Level
  reasons: Reason[]
  /** 잠그면 AI 에게 무슨 일이 생기는가 */
  effect: string
  /** 근거의 한계 */
  basis: string
  /** 한 기능에만 필요한 변경을 대신 할 수 있는 파일 */
  alternatives: string[]
  /** 정렬용. 공유 기능 수 + 공유 모듈 수 + 계약 사용자 수 */
  score: number
}

export type SkipKind = 'generated' | 'empty' | 'locked' | 'entry'

export interface Skipped {
  file: string
  why: SkipKind
  text: string
}

export interface Recommendations {
  recommend: Recommendation[]
  skipped: Skipped[]
}

export interface RecommendInput {
  repoRoot: string
  graph: Graph
  features: Features
  modules: Modules
  rules: Rules
  lockedFiles: Set<string>
  say: Say
}

/** 비밀로 보이는 파일 이름. `.env.example` 은 비밀이 아니다. */
const SECRET_FILE = /^(\.env(\..+)?|.*\.(pem|key|p12|pfx)|credentials\.json|service[-_]account.*\.json|secrets?\.(json|ya?ml|toml))$/i
const NOT_SECRET = /\.(example|sample|template|dist)$/i
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__', '.venv', 'venv', '.codyssey'])

export function recommend(input: RecommendInput): Recommendations {
  const { graph, features, modules, rules, lockedFiles, say } = input
  const recs = new Map<string, Recommendation>()
  const skipped: Skipped[] = []
  const entryFiles = new Set(features.entries.map(e => e.file))

  const skip = (file: string, why: SkipKind) => {
    if (skipped.some(s => s.file === file)) return
    skipped.push({ file, why, text: t(`rec.skip.${why}` as any) })
  }

  /** 추천에 넣을 수 있는 파일인가. 안 되면 '추천하지 않는 것' 에 이유를 적는다. */
  const eligible = (file: string): boolean => {
    if (lockedFiles.has(file)) return skip(file, 'locked'), false
    if (isGenerated(file)) return skip(file, 'generated'), false
    if (entryFiles.has(file)) return skip(file, 'entry'), false
    if ((graph.nodes.get(file)?.symbols.length ?? 0) === 0) return skip(file, 'empty'), false
    return true
  }

  const get = (file: string): Recommendation => {
    let r = recs.get(file)
    if (!r) {
      r = {
        file,
        label: say.file(file),
        level: 'ask',
        reasons: [],
        effect: t('rec.effect.ask'),
        basis: t('rec.basis.static'),
        alternatives: alternativesFor(graph, features, file),
        score: 0,
      }
      recs.set(file, r)
    }
    return r
  }

  // 1) 여러 기능이 공유 (사용자 관점)
  for (const c of autolockCandidates(features, rules.autolock.minFeatures)) {
    if (!eligible(c.file)) continue
    const names = [...new Set(c.features.map(f => say.feature(f)))]
    const r = get(c.file)
    r.reasons.push({
      kind: 'shared-features',
      text: t('rec.sharedFeatures', { count: c.features.length, list: shortList(names, 4) }),
      evidence: { list: c.features, count: c.features.length },
    })
    r.score += c.features.length
  }

  // 2) 여러 모듈이 공유 (코드 관점). 진입점이 없는 라이브러리에서는 이것만 신호를 낸다
  for (const c of crossModuleShared(graph, modules, rules.autolock.minModules ?? rules.autolock.minFeatures)) {
    if (!eligible(c.file)) continue
    const r = get(c.file)
    r.reasons.push({
      kind: 'shared-modules',
      text: t('rec.sharedModules', { count: c.modules.length, list: shortList(c.modules.map(m => say.module(m)), 3) }),
      evidence: { list: c.modules, count: c.modules.length },
    })
    r.score += c.modules.length
  }

  // 3) 밖에 약속한 이름. 이미 추천에 오른 파일에만 덧붙인다 - 계약 하나로 잠금을 권하진 않는다.
  //    이름 하나가 5곳 이상에서 쓰이면 그건 별도 근거다.
  for (const r of recs.values()) {
    const heavy = contractsOf(graph, r.file).filter(k => k.users.length >= 3).sort((a, b) => b.users.length - a.users.length)
    for (const k of heavy.slice(0, 2)) {
      r.reasons.push({ kind: 'contract', text: t('rec.contract', { name: k.name, count: k.users.length }), evidence: { name: k.name, count: k.users.length } })
      r.score += k.users.length
    }
  }

  // 4) 비밀 파일. 그래프에 없다 (코드가 아니다). 파일 이름으로만 본다.
  for (const file of findSecrets(input.repoRoot)) {
    if (lockedFiles.has(file)) {
      skip(file, 'locked')
      continue
    }
    recs.set(file, {
      file,
      label: file,
      level: 'block',
      reasons: [{ kind: 'secret', text: t('rec.secret'), evidence: {} }],
      effect: t('rec.effect.block'),
      basis: t('rec.basis.name'),
      alternatives: [],
      score: 1000, // 항상 맨 위
    })
  }

  const recommend = [...recs.values()].sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : 1))
  skipped.sort((a, b) => (a.file < b.file ? -1 : 1))
  return { recommend, skipped }
}

/** 루트와 두 단계 아래까지만 본다. 더 깊은 비밀 파일은 보통 설정이 아니라 데이터다. */
export function findSecrets(repoRoot: string, maxDepth = 2): string[] {
  const out: string[] = []
  const walk = (rel: string, depth: number) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(repoRoot, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name)) walk(p, depth + 1)
      } else if (SECRET_FILE.test(e.name) && !NOT_SECRET.test(e.name)) {
        out.push(p)
      }
    }
  }
  walk('', 0)
  return out.sort()
}

/** 터미널용. CLI 와 MCP 가 같은 모양을 쓴다. */
export function renderRecommendations(r: Recommendations, opts: { max?: number; dim?: (s: string) => string } = {}): string[] {
  const dim = opts.dim ?? ((s: string) => s)
  const L: string[] = []
  const top = r.recommend.slice(0, opts.max ?? 8)
  if (!top.length) {
    L.push('  ' + t('rec.none'))
  }
  top.forEach((x, i) => {
    L.push(`  ${i + 1}. ${x.file}  ${dim(t(x.level === 'block' ? 'rec.level.block' : 'rec.level.ask'))}`)
    for (const reason of x.reasons) L.push(`     ${t('rec.why')} ${reason.text}`)
    L.push(`     ${t('rec.ifLocked')} ${x.effect}`)
    if (x.alternatives.length) L.push(`     ${dim(t('rec.alternatives', { list: x.alternatives.slice(0, 3).join(', ') }))}`)
    L.push(`     ${dim(x.basis)}`)
  })
  if (r.recommend.length > top.length) L.push('  ' + dim(t('rec.more', { count: r.recommend.length - top.length })))
  if (r.skipped.length) {
    L.push('', '  ' + t('rec.skippedTitle'))
    for (const s of r.skipped.slice(0, 6)) L.push(`     ${s.file}  ${dim(s.text)}`)
    if (r.skipped.length > 6) L.push('     ' + dim(t('rec.more', { count: r.skipped.length - 6 })))
  }
  return L
}
