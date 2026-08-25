import type { FileInfo } from '../index/scan.ts'
import type { LangAdapter, ResolveCtx } from './ir.ts'

/**
 * 심볼 단위 그래프.
 *
 * 파일 단위 그래프는 바이브코딩 결과물에서 아무것도 못 본다. 실측:
 *   App.jsx 174줄에 화면 6개 + server.py 21줄
 *   -> 파일 2개, 기능 1개, 모듈 1개, 잠금 제안 0개
 *
 * 위험이 없어진 게 아니라 파일 안으로 숨은 것이다. 같은 파일에서
 * `formatPrice` 를 5곳이 부르고 있었다. 파일이 2개든 400개든
 * "이걸 고치면 어디가 같이 바뀌나" 는 똑같이 답할 수 있어야 한다.
 *
 * 파일 그래프를 대체하지 않고 그 위에 얹는다. 잘 나뉜 저장소에서는
 * 파일 그래프가 더 읽기 쉽고, 한 파일짜리에서는 이쪽만 신호를 낸다.
 */
export interface SymbolNode {
  /** 'App.jsx#formatPrice' */
  id: string
  file: string
  name: string
  kind: string
  line: number
}

export interface SymbolGraph {
  nodes: Map<string, SymbolNode>
  /** 심볼 id -> 이걸 부르는 심볼 id들 */
  callers: Map<string, Set<string>>
  /** 심볼 id -> 이게 부르는 심볼 id들 */
  callees: Map<string, Set<string>>
}

export const symId = (file: string, name: string) => `${file}#${name}`

export function buildSymbolGraph(files: Map<string, FileInfo>, ctx: ResolveCtx): SymbolGraph {
  const nodes = new Map<string, SymbolNode>()
  const callers = new Map<string, Set<string>>()
  const callees = new Map<string, Set<string>>()

  // 1) 노드
  for (const f of files.values()) {
    for (const s of f.parsed.symbols) {
      const id = symId(f.rel, s.name)
      if (nodes.has(id)) continue // 같은 이름이 여러 번 선언되면 첫 것만
      nodes.set(id, { id, file: f.rel, name: s.name, kind: s.kind, line: s.line })
    }
  }

  // 2) 이름 -> 어느 파일의 심볼인지 (import 를 따라간다)
  const resolveName = (f: FileInfo, name: string): string | null => {
    const own = symId(f.rel, name)
    if (nodes.has(own)) return own
    // import 로 들여온 이름이면 그 파일에서 찾는다
    for (const imp of f.parsed.imports) {
      if (!imp.names?.includes(name)) continue
      const hit = f.adapter.resolve(imp.spec, f.rel, ctx)
      if (!hit) continue
      const target = symId(hit.path, name)
      if (nodes.has(target)) return target
    }
    return null
  }

  // 3) 엣지
  for (const f of files.values()) {
    for (const c of f.parsed.calls) {
      const to = resolveName(f, c.to)
      if (!to) continue
      // 모듈 레벨에서 부른 건 파일 자체가 부른 것으로 본다
      const from = c.from ? symId(f.rel, c.from) : `${f.rel}#(module)`
      if (from === to) continue
      push(callers, to, from)
      push(callees, from, to)
    }
  }

  return { nodes, callers, callees }
}

function push(m: Map<string, Set<string>>, k: string, v: string) {
  const s = m.get(k)
  if (s) s.add(v)
  else m.set(k, new Set([v]))
}

/**
 * 여러 곳이 함께 쓰는 심볼.
 *
 * 파일이 하나뿐인 프로젝트에서 유일하게 나오는 위험 신호다.
 * 부르는 쪽이 몇 '군데' 인지로 센다. 같은 심볼이 열 번 불러도 한 군데다.
 */
export function sharedSymbols(g: SymbolGraph, min = 3): { id: string; callers: string[] }[] {
  const out: { id: string; callers: string[] }[] = []
  for (const [id, from] of g.callers) {
    if (from.size < min) continue
    if (!g.nodes.has(id)) continue
    out.push({ id, callers: [...from].sort() })
  }
  return out.sort((a, b) => b.callers.length - a.callers.length || (a.id < b.id ? -1 : 1))
}

/** 이 심볼을 고치면 영향받는 심볼들 (전이) */
export function symbolImpact(g: SymbolGraph, id: string, maxDepth = 4): string[] {
  const seen = new Set([id])
  let frontier = [id]
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next: string[] = []
    for (const cur of frontier) {
      for (const c of g.callers.get(cur) ?? []) {
        if (seen.has(c)) continue
        seen.add(c)
        next.push(c)
      }
    }
    frontier = next
  }
  seen.delete(id)
  return [...seen].sort()
}

/** 이 파일 안에서 제일 많이 쓰이는 심볼들. 파일 하나짜리 프로젝트의 '모듈' 역할. */
export function hotSymbolsIn(g: SymbolGraph, file: string, min = 2): { name: string; callers: number }[] {
  const out: { name: string; callers: number }[] = []
  for (const [id, from] of g.callers) {
    const node = g.nodes.get(id)
    if (!node || node.file !== file) continue
    if (from.size < min) continue
    out.push({ name: node.name, callers: from.size })
  }
  return out.sort((a, b) => b.callers - a.callers || (a.name < b.name ? -1 : 1))
}
