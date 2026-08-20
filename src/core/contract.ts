import type { Graph } from './graph.ts'

/**
 * 계약(contract) = 다른 파일이 **이름을 지정해서** 가져다 쓰는 export.
 *
 * 심볼 게이팅을 만들 때 "누가 어떤 이름을 가져갔는지" 를 이미 엣지에 실어뒀다.
 * 그래서 이걸 공짜로 알 수 있다: 이 export 를 지우면 정확히 누가 깨지는가.
 *
 * AI 가 리팩터링하다 export 를 지우거나 이름을 바꾸는 건 가장 흔한 사고인데,
 * 파일 단위 잠금으로는 잡히지 않는다. 그 파일을 고쳐도 되는 경우가 대부분이고,
 * 문제는 '그 안의 특정 이름' 이기 때문이다.
 */
export interface Contract {
  name: string
  /** 이 이름을 가져다 쓰는 파일들 */
  users: string[]
}

/** 이 파일이 밖에 약속한 이름들. */
export function contractsOf(graph: Graph, file: string): Contract[] {
  const byName = new Map<string, Set<string>>()
  for (const e of graph.in(file)) {
    if (e.kind !== 'import' || !e.names) continue
    for (const n of e.names) {
      const s = byName.get(n) ?? new Set<string>()
      s.add(e.from)
      byName.set(n, s)
    }
  }
  return [...byName.entries()]
    .map(([name, users]) => ({ name, users: [...users].sort() }))
    .sort((a, b) => b.users.length - a.users.length || (a.name < b.name ? -1 : 1))
}

/**
 * 이 편집이 약속을 깨뜨리는가.
 *
 * Edit 은 파일 전체가 아니라 바뀌는 조각만 준다. 그래서 '결과 파일에 이름이 있나' 는
 * 알 수 없고, '없애는 중인가' 만 볼 수 있다.
 *   before 에 있고 after 에 없다  -> 지우거나 이름을 바꾸는 중
 * Write 는 파일 전체가 오므로 그냥 결과에 있는지 보면 된다.
 *
 * 확신이 없으면 아무 말도 하지 않는다(P4). 여기서 오탐이 나면
 * 멀쩡한 리팩터링이 계속 막혀서 도구가 제거당한다.
 */
export function brokenContracts(
  contracts: Contract[],
  { before, after, whole }: { before?: string; after?: string; whole?: boolean },
): Contract[] {
  if (!after && !whole) return []
  const out: Contract[] = []
  for (const c of contracts) {
    const inAfter = mentions(after ?? '', c.name)
    if (whole) {
      // 파일 전체를 새로 쓰는 중이다. 결과에 이름이 없으면 깨진다.
      if (!inAfter) out.push(c)
      continue
    }
    // 조각 편집이다. 사라지는 경우만 잡는다.
    if (before && mentions(before, c.name) && !inAfter) out.push(c)
  }
  return out
}

/** 파일이 통째로 사라질 때(rm/mv) 깨지는 것들. */
export function importersOf(graph: Graph, file: string): string[] {
  return graph
    .in(file)
    .filter(e => e.kind === 'import')
    .map(e => e.from)
    .sort()
}

// ---------------------------------------------------------------- 중복 구현

/**
 * 이 편집이 **이미 있는 이름을 새로 만드는가**.
 *
 * 이름 겹침 전체 목록은 소음이다. 실제 저장소에서 `run` 이 14곳, `add` 가 5곳에
 * 있는데 전부 정상이다. 하지만 "방금 만든 이름이 이미 있다" 는 다르다.
 * 바이브 코딩에서 제일 흔한 사고이고, 그 순간에만 알리면 정확하다.
 */
export function duplicateNames(
  index: Map<string, string[]>,
  file: string,
  { before = '', after = '' }: { before?: string; after?: string },
): { name: string; existing: string[] }[] {
  const out: { name: string; existing: string[] }[] = []
  for (const name of declaredNames(after)) {
    if (mentions(before, name)) continue // 원래 있던 것
    const existing = (index.get(name) ?? []).filter(f => f !== file)
    if (existing.length) out.push({ name, existing })
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1)).slice(0, 3)
}

/** 그래프의 모든 심볼 이름 -> 그게 있는 파일들. 흔한 이름은 애초에 뺀다. */
export function nameIndex(graph: Graph): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const n of graph.nodes.values()) {
    for (const s of n.symbols) {
      if (s.kind === 'constant' || COMMON.has(s.name) || s.name.length < 4) continue
      m.set(s.name, [...(m.get(s.name) ?? []), n.id])
    }
  }
  return m
}

/** 어디에나 있는 이름은 겹쳐도 사고가 아니다. */
const COMMON = new Set([
  'main', 'run', 'test', 'setup', 'init', 'start', 'stop', 'handler', 'index',
  'upgrade', 'downgrade', 'render', 'toString', 'toJSON', 'default', 'Props',
])

/** 새 텍스트에서 '선언되는' 이름만 뽑는다. 호출은 제외해야 오탐이 안 난다. */
function declaredNames(text: string): string[] {
  const out = new Set<string>()
  const pats = [
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w{3,})/g,
    /\b(?:export\s+)?class\s+([A-Za-z_]\w{3,})/g,
    /\b(?:export\s+)?(?:const|let)\s+([A-Za-z_]\w{3,})\s*=\s*(?:async\s*)?(?:\(|function)/g,
    /^\s*def\s+([A-Za-z_]\w{3,})/gm,
    /^\s*class\s+([A-Za-z_]\w{3,})/gm,
  ]
  for (const re of pats) for (const m of text.matchAll(re)) out.add(m[1])
  return [...out]
}

/** 단어 경계로 본다. `formatMoney` 를 찾을 때 `formatMoneyX` 에 걸리면 안 된다. */
function mentions(text: string, name: string): boolean {
  if (!text) return false
  return new RegExp(`(^|[^\\w$])${escapeRe(name)}([^\\w$]|$)`).test(text)
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---------------------------------------------------------------- 테스트 매핑

/**
 * 이 파일을 검증하는 테스트들.
 * 고치고 나서 뭘 돌려야 하는지 알면 AI 가 스스로 검증 루프를 돈다.
 */
export function testsFor(graph: Graph, file: string): string[] {
  return [...graph.dependents(file)]
    .filter(f => f !== file && isTest(f))
    .sort()
}

export const isTest = (p: string) =>
  /(^|\/)(tests?|__tests__|spec)\//.test(p) || /\.(test|spec)\.\w+$/.test(p)
