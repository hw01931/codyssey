import type { Graph } from './graph.ts'
import { allFilesOf, autolockCandidates, exclusiveOf, featuresOf, isGenerated, type Features } from './features.ts'
import { consumerModules, type Modules } from './modules.ts'
import { t, setLang, type Lang } from '../i18n/index.ts'

export interface ProtectRule {
  path: string
  reason?: string
}

export interface LayerRule {
  /** "web/components/** -> web/lib/api.ts" */
  deny: string
  reason?: string
}

/**
 * 기능 단위 잠금.
 *   exclusive - 이 기능만 쓰는 파일을 잠근다 (기본). 공유 파일은 안 건드린다
 *   all       - 이 기능이 닿는 파일 전부를 잠근다. 공유 파일 때문에 넓게 막히니 주의
 */
export interface FeatureRule {
  id: string
  scope?: 'exclusive' | 'all'
  reason?: string
}

export interface Rules {
  version: number
  /** codyssey 가 쓰는 말. 없으면 환경에서 추측한다. */
  lang?: Lang
  protect: ProtectRule[]
  features: FeatureRule[]
  layers: LayerRule[]
  autolock: { minFeatures: number; minModules: number; mode: 'off' | 'note' | 'ask' | 'block' }
  /**
   * 밖에서 이름으로 가져다 쓰는 export 를 없앨 때. 기본은 확인 요청.
   * 이름을 바꾸는 리팩터링 자체는 정상이므로 막기(block)를 기본으로 하지 않는다.
   */
  contracts: { mode: 'off' | 'ask' | 'block' }
}

export const defaultRules = (): Rules => ({
  version: 1,
  protect: [],
  features: [],
  layers: [],
  autolock: { minFeatures: 3, minModules: 3, mode: 'note' },
  contracts: { mode: 'ask' },
})

/**
 * 아무것도 막지 않는 규칙.
 * 설정 파일을 못 읽었을 때 기본값(ask)으로 넘어가면, 읽지도 못한 설정을 근거로
 * 질문을 하기 시작한다. 판단 근거가 없으면 아무 주장도 하지 않아야 한다. (P4/P5)
 */
export const inertRules = (): Rules => ({
  version: 1,
  protect: [],
  features: [],
  layers: [],
  autolock: { minFeatures: 3, minModules: 3, mode: 'off' },
  contracts: { mode: 'off' },
})

/**
 * note  통과시키되 에이전트에게 사실을 알려준다. 사람은 방해받지 않는다.
 *       공유 파일의 기본값이다. 사람에게 매번 물으면 93% 는 그냥 승인하고
 *       나머지는 훅을 끈다. 모델에게 "이 파일은 기능 8개가 쓴다" 를 알려주는 쪽이
 *       실제로 회귀를 줄인다 (TDAD, 2026).
 */
export type Verdict =
  | { action: 'allow' }
  | { action: 'note' | 'ask' | 'block'; reason: string; hint?: string; rule: string }

/** 기능·모듈·파일을 사람이 읽는 이름으로. 없으면 원문 그대로 쓴다. */
export interface Say {
  feature: (id: string) => string
  module: (m: string) => string
  file: (f: string) => string
}

const RAW: Say = { feature: x => x, module: x => x, file: x => x }

export interface EditCheck {
  /** 레포 루트 기준 상대경로 */
  file: string
  /** 이 편집으로 새로 들어가는 텍스트 (import 검사용). 없으면 import 검사는 건너뛴다. */
  added?: string
  /**
   * import spec 을 실제 파일 경로로 바꾼다.
   * 규칙은 실제 경로(`web/lib/api.ts`)로 쓰는데 코드는 별칭(`@/lib/api`)으로 쓰기 때문에
   * 해석 없이는 둘이 절대 안 만난다.
   */
  resolve?: (spec: string, fromFile: string) => string | null
}

/**
 * 편집 한 건에 대한 판정. 훅이 5ms 안에 답해야 하므로 그래프는 이미 메모리에 있다고 가정한다.
 *
 * P4: 확신 없는 근거로는 차단하지 않는다.
 * P5: 판단이 안 서면 allow. 막는 건 확실할 때만.
 */
export function checkEdit(
  rules: Rules,
  graph: Graph,
  features: Features,
  edit: EditCheck,
  modules?: Modules,
  say: Say = RAW,
): Verdict {
  const file = norm(edit.file)

  // 1) 명시적 보호
  for (const p of rules.protect) {
    if (!matches(p.path, file)) continue
    return {
      action: 'block',
      rule: `protect: ${p.path}`,
      // 사유가 없으면 지금 쓰는 말의 기본 문구를 붙인다. 파일에 박아두면
      // 그때의 말로 얼어붙기 때문에, 보여줄 때 정한다.
      reason: t('rule.protected', { name: say.file(file), reason: p.reason ?? t('rule.lockedByHand') }).trim(),
      hint: nextStep(graph, features, file, say),
    }
  }

  // 2) 기능 단위 잠금
  for (const fr of rules.features ?? []) {
    const scope = fr.scope ?? 'exclusive'
    const inScope = scope === 'all' ? allFilesOf(features, fr.id) : exclusiveOf(features, fr.id)
    if (!inScope.includes(file)) continue
    return {
      action: 'block',
      rule: `feature: ${fr.id} (${scope})`,
      reason: `${t('rule.featureLocked', { name: say.feature(fr.id), reason: fr.reason ?? '' })}`.trim(),
      hint:
        scope === 'exclusive'
          ? t('rule.featureExclusive', { id: fr.id })
          : undefined,
    }
  }

  // 3) 레이어 위반 (이 편집이 새로 들여오는 import 만 본다)
  if (edit.added) {
    for (const spec of importSpecs(edit.added)) {
      const resolved = edit.resolve?.(spec, file) ?? null
      for (const l of rules.layers) {
        const arrow = splitArrow(l.deny)
        if (!arrow) continue
        if (!matches(arrow.from, file)) continue
        const hit = resolved ? matches(arrow.to, resolved) : specMatches(arrow.to, spec)
        if (!hit) continue
        return {
          action: 'block',
          rule: `layers: ${l.deny}`,
          reason: l.reason ?? t('rule.layerDenied', { from: arrow.from, to: arrow.to }),
          hint: t('rule.layerHint', { spec }),
        }
      }
    }
  }

  // 4) 자동 잠금. 도구가 만든 파일은 사람이 고치는 파일이 아니라서 묻지 않는다.
  if (rules.autolock.mode !== 'off' && !isGenerated(file)) {
    // 4-a) 여러 기능이 공유 (사용자 관점)
    const feats = featuresOf(features, file)
    const note = rules.autolock.mode === 'note'
    if (feats.length >= rules.autolock.minFeatures) {
      return {
        action: rules.autolock.mode,
        rule: `autolock: >=${rules.autolock.minFeatures} features`,
        reason: t(note ? 'rule.sharedFeaturesNote' : 'rule.sharedFeatures', { list: shortList(feats.map(f => say.feature(f))), count: feats.length }),
        hint: note ? extensionHint(graph, features, file) : nextStep(graph, features, file, say),
      }
    }

    // 4-b) 여러 모듈이 공유 (코드 관점).
    //      진입점이 없는 라이브러리/CLI 에서는 이쪽만 신호를 낸다.
    if (modules) {
      const ms = consumerModules(graph, modules, file)
      const min = rules.autolock.minModules ?? rules.autolock.minFeatures
      if (ms.length >= min) {
        return {
          action: rules.autolock.mode,
          rule: `autolock: >=${min} modules`,
          reason: t(note ? 'rule.sharedModulesNote' : 'rule.sharedModules', { list: shortList(ms.map(m => say.module(m))), more: '', count: ms.length }),
          hint: note ? extensionHint(graph, features, file) : nextStep(graph, features, file, say),
        }
      }
    }
  }

  return { action: 'allow' }
}

/** 그래프 전체에 대한 레이어 위반 목록. UI/CI 에서 쓴다. */
export function findViolations(rules: Rules, graph: Graph) {
  const out: { from: string; to: string; rule: string; reason: string }[] = []
  for (const e of graph.edges) {
    if (e.kind !== 'import') continue
    for (const l of rules.layers) {
      const arrow = splitArrow(l.deny)
      if (!arrow) continue
      if (matches(arrow.from, e.from) && matches(arrow.to, e.to)) {
        out.push({ from: e.from, to: e.to, rule: l.deny, reason: l.reason ?? t('rule.layerViolation') })
      }
    }
  }
  return out.sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1))
}

/** rules.yaml 초안. 사람은 이걸 지우거나 주석 해제만 하면 된다. */
export function suggestRules(features: Features, minFeatures = 3): Rules {
  const r = defaultRules()
  r.protect = autolockCandidates(features, minFeatures).map(c => ({
    path: c.file,
    reason: t('rule.sharedBy', { count: c.features.length, list: c.features.join(', ') }),
  }))
  return r
}

// ---------------------------------------------------------------- 내부

/** 배럴/빈 파일은 대안이 될 수 없다. */
const IS_BARREL = /(^|\/)(__init__\.py|index\.(ts|tsx|js|jsx))$/

/**
 * 막고 끝내면 안 된다. 코드를 모르는 사람은 거기서 멈춘다.
 * 무엇을 할 수 있는지 항상 같이 말한다.
 */
function nextStep(graph: Graph, features: Features, file: string, say: Say): string {
  const lines = [t('rule.unlockHint', { name: say.file(file) })]
  const alt = extensionHint(graph, features, file)
  if (alt) lines.push(alt)
  return lines.join('\n')
}

/**
 * 대안 경로 제안: 이 파일을 '가져다 쓰는' 쪽 중에서 기능 하나에만 속한 파일.
 * 변경이 한 화면에만 필요하면 공유 파일 대신 거기서 고치면 된다.
 *
 * 예전에는 '같은 폴더의 다른 파일' 을 제안했다. 그러면 button.tsx 를 막고
 * avatar.tsx 를 고치라고 했다. 관계없는 파일로 유도하는 건 막는 것보다 나쁘다.
 * 엉뚱한 걸 제안하느니 아무 말도 안 하는 게 낫다. (P4)
 */
function extensionHint(graph: Graph, features: Features, file: string): string | undefined {
  const free = [...new Set(graph.in(file).filter(e => e.kind === 'import').map(e => e.from))]
    .filter(
      id =>
        !IS_BARREL.test(id) &&
        (graph.nodes.get(id)?.symbols.length ?? 0) > 0 &&
        featuresOf(features, id).length === 1,
    )
    .sort()
  if (!free.length) return undefined
  return t('rule.freeNeighbours', { list: free.slice(0, 3).join(', ') })
}

/** 새로 추가된 텍스트에서 import spec 을 뽑는다. 정규식으로 충분하다 - 확신 없으면 안 막으니까. */
function importSpecs(text: string): string[] {
  const out = new Set<string>()
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g, // js: from 'x'
    /\bimport\s+['"]([^'"]+)['"]/g, // js: import 'x'
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*from\s+([\w.]+)\s+import\b/gm, // py: from a.b import c
    /^\s*import\s+([\w.]+)/gm, // py: import a.b
  ]
  for (const re of patterns) for (const m of text.matchAll(re)) out.add(m[1])
  return [...out]
}

function splitArrow(deny: string): { from: string; to: string } | null {
  const i = deny.indexOf('->')
  if (i < 0) return null
  return { from: deny.slice(0, i).trim(), to: deny.slice(i + 2).trim() }
}

/** import spec 은 경로가 아니라 별칭일 수 있어서 끝부분 일치도 허용한다. */
function specMatches(pattern: string, spec: string): boolean {
  const p = norm(pattern).replace(/\.(ts|tsx|js|jsx|py)$/, '')
  const s = norm(spec).replace(/\.(ts|tsx|js|jsx|py)$/, '').replace(/\./g, '/')
  if (matches(pattern, spec)) return true
  return s.endsWith(p) || p.endsWith(s)
}

const globCache = new Map<string, RegExp>()

/** glob 매칭. `**` 는 경로 구분자 포함, `*` 는 한 세그먼트. P7: 컴파일 캐시. */
export function matches(pattern: string, target: string): boolean {
  const p = norm(pattern)
  const t = norm(target)
  if (p === t) return true
  let re = globCache.get(p)
  if (!re) {
    const body = p
      .split('**')
      .map(part =>
        part
          .split('*')
          .map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*'),
      )
      .join('.*')
    // 디렉토리 패턴(끝이 / 인 경우)은 하위 전체를 뜻한다
    re = new RegExp('^' + body + (p.endsWith('/') ? '.*' : '') + '$')
    globCache.set(p, re)
  }
  return re.test(t)
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '')

/**
 * 사람에게 보여줄 목록. 23개를 다 늘어놓으면 아무도 안 읽는다.
 * 같은 이름은 한 번만 (GET /items 와 GET /items/{id} 는 둘 다 'Items read API' 로 읽힌다).
 */
export function shortList(names: string[], max = 3): string {
  const uniq = [...new Set(names)]
  const head = uniq.slice(0, max).join(', ')
  return uniq.length > max ? head + t('rule.sharedModulesMore', { count: uniq.length - max }) : head
}
