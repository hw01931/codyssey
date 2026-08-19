import type { Confidence, Sym } from './ir.ts'

export type EdgeKind = 'import' | 'http'

export interface GNode {
  id: string // 레포 루트 기준 상대경로 (posix)
  lang: string
  symbols: Sym[]
}

export interface GEdge {
  from: string
  to: string
  kind: EdgeKind
  confidence: Confidence
  via?: string // http 엣지의 'GET /api/v1/orders'
  line?: number
  /** `from` 이 `to` 에서 실제로 가져다 쓴 이름들. undefined = 모듈 전체 */
  names?: string[]
  /** 이 엣지가 `from` 의 어느 최상위 심볼에서 나왔는지. undefined = 모듈 레벨 */
  fromSymbol?: string
}

export interface Entry {
  id: string // 'GET /api/v1/orders' | 'PAGE /checkout'
  kind: 'route' | 'page'
  method: string
  path: string
  file: string
  line: number
}

/**
 * P3: 순수 데이터 + 인덱스만. 알고리즘은 전부 바깥(core/features, core/rules).
 * P7: 역방향 인덱스를 day 1 부터 유지 - blast radius 가 주기능이라 나중에 붙이면 늦다.
 */
export class Graph {
  nodes = new Map<string, GNode>()
  entries = new Map<string, Entry>()
  /** 해석 실패한 import. 차단 근거로는 안 쓰고 진단에만 쓴다. (P4) */
  unresolved: { from: string; spec: string; line: number }[] = []

  private outIdx = new Map<string, GEdge[]>()
  private inIdx = new Map<string, GEdge[]>()
  private edgeKeys = new Map<string, GEdge>()

  addNode(n: GNode) {
    this.nodes.set(n.id, n)
  }

  addEdge(e: GEdge) {
    const key = [e.from, e.to, e.kind, e.via ?? '', e.fromSymbol ?? ''].join(' ')
    const existing = this.edgeKeys.get(key)
    if (existing) {
      // 같은 쌍을 여러 번 가져오면 이름을 합친다. 한쪽이라도 모듈 전체면 전체로 승격.
      existing.names = !existing.names || !e.names ? undefined : uniqSorted([...existing.names, ...e.names])
      return
    }
    const copy: GEdge = { ...e, names: e.names ? uniqSorted(e.names) : undefined }
    this.edgeKeys.set(key, copy)
    push(this.outIdx, e.from, copy)
    push(this.inIdx, e.to, copy)
  }

  addEntry(e: Entry) {
    this.entries.set(e.id, e)
  }

  out(id: string): GEdge[] {
    return this.outIdx.get(id) ?? []
  }

  in(id: string): GEdge[] {
    return this.inIdx.get(id) ?? []
  }

  get edges(): GEdge[] {
    return [...this.outIdx.values()].flat()
  }

  /** 전방 도달 집합(자기 포함). minConfidence='high' 면 low 엣지 무시. */
  reachable(start: string, opts: WalkOpts = {}): Set<string> {
    return this.walk(start, 'out', opts)
  }

  /** 역방향 도달 집합 = blast radius. */
  dependents(start: string, opts: WalkOpts = {}): Set<string> {
    return this.walk(start, 'in', opts)
  }

  /**
   * 심볼 게이팅 탐색.
   *
   * 파일 단위 그래프는 과대추정한다. `lib/api.ts` 한 파일에 fetch 세 개가 있으면
   * 이 파일을 import 하는 순간 백엔드 세 곳에 전부 닿아버린다.
   *
   * 그래서 노드마다 '지금 관심 있는 심볼 집합'을 들고 다닌다.
   *   - 정방향: 엣지가 나온 심볼(fromSymbol)이 관심 집합에 없으면 안 따라간다
   *   - 역방향: 상대가 가져간 이름(names)이 관심 집합과 안 겹치면 안 따라간다
   * 집합이 null 이면 '전부'라는 뜻이고, 그때는 게이팅하지 않는다.
   *
   * gated:false 로 끄면 예전(과대추정) 동작. 차단 판정처럼 안전하게 넓게 봐야 할 때 쓴다.
   */
  private walk(
    start: string,
    dir: 'in' | 'out',
    { minConfidence, maxDepth = Infinity, gated = true }: WalkOpts,
  ): Set<string> {
    const scope = new Map<string, Set<string> | null>([[start, null]])
    let frontier = [start]

    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
      const next: string[] = []
      for (const cur of frontier) {
        const curScope = scope.get(cur)
        for (const e of dir === 'out' ? this.out(cur) : this.in(cur)) {
          if (minConfidence === 'high' && e.confidence !== 'high') continue

          let otherScope: Set<string> | null = null
          if (dir === 'out') {
            if (gated && curScope && e.fromSymbol && !curScope.has(e.fromSymbol)) continue
            if (gated && e.names) otherScope = new Set(e.names)
          } else {
            if (gated && curScope && e.names && !e.names.some(n => curScope.has(n))) continue
            if (gated && e.fromSymbol) otherScope = new Set([e.fromSymbol])
          }

          const other = dir === 'out' ? e.to : e.from
          if (widen(scope, other, otherScope)) next.push(other)
        }
      }
      frontier = next
    }
    return new Set(scope.keys())
  }

  /** P2/P8: 정렬 고정 - 같은 코드면 바이트까지 같은 출력. */
  toJSON() {
    return {
      version: 1,
      nodes: [...this.nodes.values()]
        .sort(by(n => n.id))
        .map(n => ({ ...n, symbols: [...n.symbols].sort(by(s => `${s.line}`.padStart(6, '0') + s.name)) })),
      entries: [...this.entries.values()].sort(by(e => e.id)),
      edges: this.edges
        .map(e => ({
          from: e.from,
          to: e.to,
          kind: e.kind,
          confidence: e.confidence,
          ...(e.via ? { via: e.via } : {}),
          ...(e.names ? { names: e.names } : {}),
          ...(e.fromSymbol ? { fromSymbol: e.fromSymbol } : {}),
        }))
        .sort(by(e => [e.from, e.to, e.kind, e.via ?? ''].join(' '))),
      unresolved: [...this.unresolved].sort(by(u => u.from + ' ' + u.spec)),
    }
  }
}

interface WalkOpts {
  minConfidence?: Confidence
  maxDepth?: number
  /** 기본 true. false 면 파일 단위 과대추정(안전하지만 넓음) */
  gated?: boolean
}

/**
 * 노드의 관심 심볼 범위를 넓힌다. 실제로 넓어졌으면 true (다시 펼쳐야 한다).
 * null 은 '전부'라서 가장 넓은 상태다.
 */
function widen(scope: Map<string, Set<string> | null>, node: string, add: Set<string> | null): boolean {
  if (!scope.has(node)) {
    scope.set(node, add)
    return true
  }
  const cur = scope.get(node)!
  if (cur === null) return false
  if (add === null) {
    scope.set(node, null)
    return true
  }
  let grew = false
  for (const n of add) if (!cur.has(n)) { cur.add(n); grew = true }
  return grew
}

const uniqSorted = (xs: string[]) => [...new Set(xs)].sort()

function push<T>(m: Map<string, T[]>, k: string, v: T) {
  const arr = m.get(k)
  if (arr) arr.push(v)
  else m.set(k, [v])
}

function by<T>(key: (x: T) => string) {
  return (a: T, b: T) => {
    const ka = key(a)
    const kb = key(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  }
}
