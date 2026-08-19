import fs from 'node:fs'
import path from 'node:path'
import type { LangAdapter, ParseResult, ResolveCtx } from '../core/ir.ts'
import { Graph } from '../core/graph.ts'
import { tsAdapter } from '../adapters/ts.ts'
import { pyAdapter } from '../adapters/py.ts'

const ADAPTERS: LangAdapter[] = [tsAdapter, pyAdapter]

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
  '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.codyssey',
])

/** 프로젝트 루트 마커. 이게 sys.path / baseUrl 의 기준점이 된다. */
const ROOT_MARKERS = ['tsconfig.json', 'jsconfig.json', 'package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'manage.py']

interface FileInfo {
  rel: string
  adapter: LangAdapter
  projectRoot: string
  parsed: ParseResult
}

export interface ScanResult {
  graph: Graph
  files: Map<string, FileInfo>
  ms: number
}

export type { FileInfo }

/** 이 경로를 우리가 다루는가 */
export function adapterFor(rel: string) {
  return ADAPTERS.find(a => a.exts.includes(path.extname(rel)))
}

export function listFiles(repoRoot: string): string[] {
  return walk(repoRoot).filter(r => adapterFor(r))
}

/** 파일 하나 파싱. 실패하면 null (P5: 못 읽은 파일에 대해서는 아무 주장도 하지 않는다). */
export async function parseFile(repoRoot: string, rel: string, ctx: ResolveCtx): Promise<FileInfo | null> {
  const adapter = adapterFor(rel)
  if (!adapter) return null
  try {
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8')
    return { rel, adapter, projectRoot: ctx.projectRootOf(rel), parsed: await adapter.parse(src, rel) }
  } catch {
    return null
  }
}

export function createCtx(repoRoot: string): ResolveCtx {
  return makeCtx(repoRoot)
}

/**
 * 파싱 결과들로 그래프를 만든다. I/O 없이 순수 계산이라 파일 하나 바뀔 때 다시 돌려도 싸다.
 * (파싱만 증분으로 하고 빌드는 통째로 다시 하는 게 훨씬 단순하고 충분히 빠르다)
 */
export function buildGraph(files: Map<string, FileInfo>, ctx: ResolveCtx, repoRoot = '.'): Graph {
  const graph = new Graph()
  for (const f of files.values()) {
    graph.addNode({ id: f.rel, lang: f.adapter.name, symbols: f.parsed.symbols })
  }

  // 2) import 엣지
  for (const f of files.values()) {
    for (const imp of f.parsed.imports) {
      const hit = f.adapter.resolve(imp.spec, f.rel, ctx)
      if (!hit) {
        // 외부 패키지도 추측성 spec 도 아닌, '풀었어야 하는데 못 푼' 것만 기록한다
        if (!imp.speculative && (imp.spec.startsWith('.') || looksLocal(imp.spec, f, files, ctx))) {
          graph.unresolved.push({ from: f.rel, spec: imp.spec, line: imp.line })
        }
        continue
      }
      if (hit.path === f.rel || !files.has(hit.path)) continue
      graph.addEdge({
        from: f.rel,
        to: hit.path,
        kind: 'import',
        confidence: hit.confidence,
        line: imp.line,
        names: imp.names,
      })
    }
  }

  // 3) 라우트 진입점 (prefix 합성)
  addRouteEntries(graph, files, ctx)
  addPageEntries(graph, files)
  addPackageEntries(graph, files, repoRoot)

  // 4) FE -> BE 경계
  linkHttpCalls(graph, files)

  // 5) 그래도 진입점이 하나도 없으면 그래프의 뿌리를 쓴다.
  //    라우트도 페이지도 없는 CLI/라이브러리에서 기능이 0개가 되면 도구 전체가 무의미해진다.
  if (graph.entries.size === 0) addRootEntries(graph, files)

  return graph
}

export async function scan(repoRoot: string): Promise<ScanResult> {
  const t0 = performance.now()
  const ctx = makeCtx(repoRoot)
  const files = new Map<string, FileInfo>()
  for (const rel of listFiles(repoRoot)) {
    const info = await parseFile(repoRoot, rel, ctx)
    if (info) files.set(rel, info)
  }
  return { graph: buildGraph(files, ctx, repoRoot), files, ms: performance.now() - t0 }
}

// ---------------------------------------------------------------- 라우트 합성

function addRouteEntries(graph: Graph, files: Map<string, FileInfo>, ctx: ResolveCtx) {
  // (대상파일, router변수) <- 이 라우터를 마운트한 곳들
  type MountEdge = { fromFile: string; on: string; prefix: string }
  const mounts = new Map<string, MountEdge[]>()

  for (const f of files.values()) {
    for (const m of f.parsed.routerMounts) {
      const spec = f.parsed.bindings[m.spec] ?? m.spec
      const hit = f.adapter.resolve(spec, f.rel, ctx)
      if (!hit || !files.has(hit.path)) continue
      const key = `${hit.path} ${m.attr}`
      const arr = mounts.get(key)
      const edge = { fromFile: f.rel, on: m.on, prefix: m.prefix }
      if (arr) arr.push(edge)
      else mounts.set(key, [edge])
    }
  }

  const memo = new Map<string, string>()
  /** 이 파일의 이 router 변수가 최종적으로 갖는 prefix. 중첩 마운트를 재귀로 접는다. */
  const prefixOf = (file: string, varName: string, seen = new Set<string>()): string => {
    const key = `${file} ${varName}`
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    if (seen.has(key)) return '' // 순환 방어
    seen.add(key)

    const own = files.get(file)?.parsed.routerDefs.find(d => d.name === varName)?.prefix ?? ''
    const up = mounts.get(key)
    const parent = up?.length ? prefixOf(up[0].fromFile, up[0].on, seen) + up[0].prefix : ''
    const result = parent + own
    memo.set(key, result)
    return result
  }

  for (const f of files.values()) {
    for (const r of f.parsed.routes) {
      const full = normPath(prefixOf(f.rel, r.owner) + r.path)
      graph.addEntry({
        id: `${r.method} ${full}`,
        kind: 'route',
        method: r.method,
        path: full,
        file: f.rel,
        line: r.line,
      })
    }
  }
}

function addPageEntries(graph: Graph, files: Map<string, FileInfo>) {
  for (const f of files.values()) {
    const r = f.adapter.routeFromPath?.(f.rel, f.projectRoot)
    if (!r) continue
    graph.addEntry({ id: `${r.method} ${r.path}`, kind: 'page', method: r.method, path: r.path, file: f.rel, line: r.line })
  }
}

/** package.json 이 선언한 진입점 (bin / main / exports). 라이브러리와 CLI 의 '기능'. */
function addPackageEntries(graph: Graph, files: Map<string, FileInfo>, repoRoot: string) {
  const roots = new Set([...files.values()].map(f => f.projectRoot))
  for (const projectRoot of roots) {
    const pkgPath = path.join(projectRoot === '.' ? '' : projectRoot, 'package.json')
    let pkg: Record<string, unknown>
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, pkgPath), 'utf8'))
    } catch {
      continue
    }

    const specs = new Set<string>()
    const collect = (v: unknown) => {
      if (typeof v === 'string') specs.add(v)
      else if (v && typeof v === 'object') for (const x of Object.values(v)) collect(x)
    }
    collect(pkg.bin)
    collect(pkg.main)
    collect(pkg.exports)

    for (const spec of specs) {
      // package.json 은 빌드 결과(dist/lib)를 가리키는 일이 많다. 소스로 되돌린다.
      const candidates = [spec, spec.replace(/^\.?\/?(dist|lib|build|out)\//, 'src/')]
      for (const c of candidates) {
        const rel = path.posix.join(projectRoot === '.' ? '' : projectRoot, c.replace(/^\.\//, ''))
        const hit = tsResolveLike(rel, files)
        if (!hit) continue
        graph.addEntry({ id: `ENTRY ${hit}`, kind: 'entry', method: 'ENTRY', path: hit, file: hit, line: 1 })
        break
      }
    }
  }
}

/** 어떤 진입점도 못 찾았을 때: 아무도 import 하지 않는 파일이 곧 시작점이다. */
function addRootEntries(graph: Graph, files: Map<string, FileInfo>) {
  const isTest = (p: string) => /(^|\/)(tests?|__tests__|spec)\//.test(p) || /\.(test|spec)\.\w+$/.test(p)
  for (const id of graph.nodes.keys()) {
    if (graph.in(id).length) continue
    if (isTest(id)) continue
    if (!files.get(id)?.parsed.symbols.length) continue
    graph.addEntry({ id: `ENTRY ${id}`, kind: 'entry', method: 'ENTRY', path: id, file: id, line: 1 })
  }
}

/** package.json 의 경로 문자열을 실제 소스 파일로 맞춰본다. */
function tsResolveLike(rel: string, files: Map<string, FileInfo>): string | null {
  if (files.has(rel)) return rel
  const stem = rel.replace(/\.(js|mjs|cjs|jsx)$/, '')
  for (const e of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) {
    if (files.has(stem + e)) return stem + e
    if (files.has(`${stem}/index${e}`)) return `${stem}/index${e}`
  }
  return null
}

// ---------------------------------------------------------------- FE <-> BE

function linkHttpCalls(graph: Graph, files: Map<string, FileInfo>) {
  const routes = [...graph.entries.values()].filter(e => e.kind === 'route')
  for (const f of files.values()) {
    for (const call of f.parsed.httpCalls) {
      for (const route of routes) {
        if (route.method !== call.method) continue
        const m = matchUrl(call.url, route.path)
        if (!m) continue
        graph.addEdge({
          from: f.rel,
          to: route.file,
          kind: 'http',
          // 호출 URL 이 보간을 포함하면(low) 링크도 low 로 내려간다. (P4)
          confidence: call.confidence === 'high' && m === 'exact' ? 'high' : 'low',
          via: route.id,
          line: call.line,
          fromSymbol: call.inSymbol,
        })
      }
    }
  }
}

/** 호출 URL 과 라우트 패턴 매칭. '*' 는 보간 자리, {id}/:id 는 경로 파라미터. */
function matchUrl(callUrl: string, routePath: string): 'exact' | 'fuzzy' | null {
  const call = normPath(callUrl.split('?')[0])
  const route = normPath(routePath)
  if (call === route) return 'exact'
  const rx = new RegExp(
    '^' +
      route
        .split('/')
        .map(seg => (/^[:{].*/.test(seg) ? '[^/]+' : escapeRe(seg)))
        .join('/') +
      '$',
  )
  if (rx.test(call)) return 'exact'
  if (call.includes('*')) {
    const loose = new RegExp('^' + call.split('*').map(escapeRe).join('[^/]*') + '$')
    if (loose.test(route)) return 'fuzzy'
  }
  return null
}

// ---------------------------------------------------------------- 유틸

function makeCtx(repoRoot: string): ResolveCtx {
  const existsCache = new Map<string, boolean>()
  const rootCache = new Map<string, string>()
  const aliasCache = new Map<string, Record<string, string[]>>()

  const exists = (rel: string) => {
    const hit = existsCache.get(rel)
    if (hit !== undefined) return hit
    const v = fs.existsSync(path.join(repoRoot, rel)) && fs.statSync(path.join(repoRoot, rel)).isFile()
    existsCache.set(rel, v)
    return v
  }

  return {
    exists,
    projectRootOf(rel) {
      let dir = path.posix.dirname(rel)
      const cached = rootCache.get(dir)
      if (cached !== undefined) return cached
      let cur = dir
      while (true) {
        const abs = path.join(repoRoot, cur)
        if (ROOT_MARKERS.some(m => fs.existsSync(path.join(abs, m)))) break
        const up = path.posix.dirname(cur)
        if (up === cur || cur === '.' || cur === '') { cur = '.'; break }
        cur = up
      }
      rootCache.set(dir, cur)
      return cur
    },
    aliasesOf(projectRoot) {
      const cached = aliasCache.get(projectRoot)
      if (cached) return cached
      let out: Record<string, string[]> = {}
      for (const f of ['tsconfig.json', 'jsconfig.json']) {
        const p = path.join(repoRoot, projectRoot, f)
        if (!fs.existsSync(p)) continue
        try {
          const json = JSON.parse(fs.readFileSync(p, 'utf8').replace(/\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'))
          const paths = json?.compilerOptions?.paths
          if (paths) out = paths
        } catch {
          /* tsconfig 가 깨져도 스캔은 계속된다 (P5) */
        }
      }
      aliasCache.set(projectRoot, out)
      return out
    },
  }
}

/** 외부 패키지인지, 풀었어야 하는 로컬 모듈인지 구분. 후자만 unresolved 로 기록. */
function looksLocal(spec: string, f: FileInfo, files: Map<string, FileInfo>, ctx: ResolveCtx): boolean {
  if (f.adapter.name !== 'py') {
    // 'paths': { '*': [...] } 처럼 접두어가 없는 별칭은 모든 패키지 이름과 매칭된다.
    // 그러면 외부 패키지가 전부 '못 푼 로컬 모듈'로 잡혀서 진단이 소음이 된다.
    return Object.keys(ctx.aliasesOf(f.projectRoot))
      .map(p => p.replace('*', ''))
      .filter(prefix => prefix.length > 0)
      .some(prefix => spec.startsWith(prefix))
  }
  const top = spec.split('.')[0]
  const base = path.posix.join(f.projectRoot, top)
  return files.has(`${base}.py`) || files.has(`${base}/__init__.py`)
}

function walk(root: string, rel = '', acc: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.') {
      if (IGNORE_DIRS.has(e.name)) continue
    }
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue
      walk(root, rel ? `${rel}/${e.name}` : e.name, acc)
    } else if (e.isFile()) {
      acc.push(rel ? `${rel}/${e.name}` : e.name)
    }
  }
  return acc
}

const normPath = (p: string) => ('/' + p.split('/').filter(Boolean).join('/')) || '/'
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
