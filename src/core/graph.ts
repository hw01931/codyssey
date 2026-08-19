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
  private edgeKeys = new Set<string>()

  addNode(n: GNode) {
    this.nodes.set(n.id, n)
  }

  addEdge(e: GEdge) {
    const key = [e.from, e.to, e.kind, e.via ?? ''].join(' ')
    if (this.edgeKeys.has(key)) return
    this.edgeKeys.add(key)
    push(this.outIdx, e.from, e)
    push(this.inIdx, e.to, e)
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

  private walk(start: string, dir: 'in' | 'out', { minConfidence, maxDepth = Infinity }: WalkOpts): Set<string> {
    const seen = new Set([start])
    let frontier = [start]
    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
      const next: string[] = []
      for (const cur of frontier) {
        for (const e of dir === 'out' ? this.out(cur) : this.in(cur)) {
          if (minConfidence === 'high' && e.confidence !== 'high') continue
          const other = dir === 'out' ? e.to : e.from
          if (seen.has(other)) continue
          seen.add(other)
          next.push(other)
        }
      }
      frontier = next
    }
    return seen
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
        .map(e => ({ from: e.from, to: e.to, kind: e.kind, confidence: e.confidence, ...(e.via ? { via: e.via } : {}) }))
        .sort(by(e => [e.from, e.to, e.kind, e.via ?? ''].join(' '))),
      unresolved: [...this.unresolved].sort(by(u => u.from + ' ' + u.spec)),
    }
  }
}

interface WalkOpts {
  minConfidence?: Confidence
  maxDepth?: number
}

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
