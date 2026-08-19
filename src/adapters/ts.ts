import path from 'node:path'
import type { Node } from 'web-tree-sitter'
import { emptyParse, type LangAdapter, type ParseResult, type ResolveCtx, type RouteDecl } from '../core/ir.ts'
import { captures, extractSymbols, getQuery, parseSource } from '../index/parser.ts'

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

const grammarFor = (rel: string) =>
  rel.endsWith('.tsx') || rel.endsWith('.jsx') ? 'tsx' : rel.endsWith('.ts') ? 'typescript' : 'javascript'

/** import / export-from / dynamic import / require 를 한 번에 잡는다. */
const IMPORT_Q = `
(import_statement source: (string (string_fragment) @spec)) @stmt
(export_statement source: (string (string_fragment) @spec)) @stmt
((call_expression
   function: [(import) (identifier) @fn]
   arguments: (arguments (string (string_fragment) @spec)))
 (#match? @fn "^(require)?$"))
`

/** fetch(...) 호출. FE->BE 경계의 유일한 단서. */
const FETCH_Q = `
(call_expression
  function: (identifier) @fn
  arguments: (arguments . [(string) (template_string)] @url) @args
  (#eq? @fn "fetch"))
`

export const tsAdapter: LangAdapter = {
  name: 'ts',
  exts: EXTS,
  grammar: 'typescript',

  async parse(src: string, rel: string): Promise<ParseResult> {
    const grammar = grammarFor(rel)
    const root = await parseSource(grammar, src)
    const out = emptyParse()

    for (const m of captures(await getQuery(grammar, 'imports', IMPORT_Q), root)) {
      if (!m.spec) continue
      out.imports.push({
        spec: m.spec.text,
        line: m.spec.startPosition.row + 1,
        names: m.stmt ? importedNames(m.stmt) : undefined,
      })
    }

    for (const m of captures(await getQuery(grammar, 'fetch', FETCH_Q), root)) {
      const url = literalUrl(m.url)
      if (!url) continue
      out.httpCalls.push({
        method: methodOf(m.args),
        url: url.text,
        line: m.url.startPosition.row + 1,
        confidence: url.confidence,
        inSymbol: enclosingSymbol(m.url),
      })
    }

    out.symbols = await extractSymbols(grammar, root)

    return out
  },

  resolve(spec, fromRel, ctx) {
    // 패키지 import 는 그래프에 안 넣는다 (외부 의존은 관심사가 아님)
    const projectRoot = ctx.projectRootOf(fromRel)
    let base: string | null = null

    if (spec.startsWith('.')) {
      base = posix(path.posix.join(path.posix.dirname(fromRel), spec))
    } else {
      for (const [pattern, targets] of Object.entries(ctx.aliasesOf(projectRoot))) {
        const hit = matchAlias(pattern, spec)
        if (hit === null) continue
        for (const t of targets) {
          const cand = posix(path.posix.join(projectRoot, t.replace('*', hit).replace(/^\.\//, '')))
          const found = tryExts(cand, ctx)
          if (found) return { path: found, confidence: 'high' }
        }
      }
      return null // 외부 패키지
    }

    const found = tryExts(base, ctx)
    return found ? { path: found, confidence: 'high' } : null
  },

  /** 파일 경로가 곧 라우트인 프레임워크들. 파싱 불필요. */
  routeFromPath(rel, projectRoot) {
    const inProject = projectRoot === '.' ? rel : rel.slice(projectRoot.length + 1)

    // Next.js app router: app/**/page.tsx
    const next = /^(?:src\/)?app\/(.*\/)?page\.(tsx|ts|jsx|js)$/.exec(inProject)
    if (next) return page(segments(next[1]))

    // Next.js pages router: pages/**/*.tsx
    const pages = /^(?:src\/)?pages\/(.+)\.(tsx|ts|jsx|js)$/.exec(inProject)
    if (pages && !pages[1].startsWith('api/') && !/(^|\/)_/.test(pages[1])) {
      return page(segments(pages[1].replace(/\/?index$/, '')))
    }

    // TanStack Router / SvelteKit 류: routes/**/*.tsx
    const routes = /^(?:src\/)?routes\/(.+)\.(tsx|ts|jsx|js)$/.exec(inProject)
    if (routes) {
      const raw = routes[1]
      // __root, routeTree.gen 은 라우트가 아니다
      if (/^__/.test(raw.split('/').pop() ?? '') || raw.endsWith('.gen')) return null
      // _layout 처럼 밑줄로 시작하는 조각은 경로에 안 나타난다 (pathless)
      const segs = segments(raw.replace(/\/?index$/, ''))
        .filter(x => !x.startsWith('_'))
      return page(segs)
    }

    return null
  },
}

/**
 * 이 import 로 가져온 이름들.  `import { a, b } from 'x'` => ['a','b']
 * default / namespace / side-effect import 는 모듈 전체를 가져온 것이라 undefined.
 */
function importedNames(stmt: Node): string[] | undefined {
  const names: string[] = []
  let wholeModule = false

  const visit = (n: Node) => {
    switch (n.type) {
      case 'import_specifier':
      case 'export_specifier': {
        const name = n.childForFieldName('name') ?? n.namedChildren[0]
        if (name) names.push(name.text)
        return
      }
      case 'namespace_import':
      case 'namespace_export':
        wholeModule = true
        return
    }
    for (const c of n.namedChildren) if (c) visit(c)
  }

  const clause = stmt.namedChildren.find(c => c?.type === 'import_clause' || c?.type === 'export_clause')
  if (!clause) return undefined // side-effect import
  // import_clause 바로 아래의 identifier 는 default import
  if (clause.type === 'import_clause' && clause.namedChildren.some(c => c?.type === 'identifier')) wholeModule = true
  visit(clause)

  return wholeModule || !names.length ? undefined : names
}

const DECL_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'method_definition',
  'variable_declarator',
])

/**
 * 이 노드를 감싼 **최상위** 심볼 이름. 심볼 게이팅의 출발점.
 * 가장 가까운 선언이 아니라 제일 바깥 선언을 잡아야 한다.
 * `function fetchOrders() { const res = await fetch(..) }` 에서 답은 res 가 아니라 fetchOrders 다.
 */
function enclosingSymbol(node: Node): string | undefined {
  let outermost: string | undefined
  for (let n: Node | null = node.parent; n && n.type !== 'program'; n = n.parent) {
    if (!DECL_TYPES.has(n.type)) continue
    const name = n.childForFieldName('name')
    if (name) outermost = name.text
  }
  return outermost
}

/** 라우트 그룹 `(marketing)` 은 URL 에 안 나타난다. */
const segments = (raw?: string) =>
  (raw ?? '').split('/').filter(Boolean).filter(s => !/^\(.*\)$/.test(s))

const page = (segs: string[]): RouteDecl => ({
  method: 'PAGE',
  path: '/' + segs.join('/'),
  owner: '',
  line: 1,
})

function matchAlias(pattern: string, spec: string): string | null {
  const star = pattern.indexOf('*')
  if (star < 0) return spec === pattern ? '' : null
  const head = pattern.slice(0, star)
  const tail = pattern.slice(star + 1)
  if (!spec.startsWith(head) || !spec.endsWith(tail)) return null
  return spec.slice(head.length, spec.length - tail.length)
}

/**
 * TypeScript ESM 은 `.ts` 파일을 `'./x.js'` 로 import 한다 (출력 기준으로 쓰기 때문).
 * 요즘 TS 프로젝트에서 제일 흔한 형태라, 이걸 못 풀면 그래프가 통째로 비어버린다.
 */
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts', '.ts'],
  '.cjs': ['.cts', '.ts'],
}

function tryExts(base: string, ctx: ResolveCtx): string | null {
  if (/\.\w+$/.test(base)) {
    if (ctx.exists(base)) return base
    const ext = base.slice(base.lastIndexOf('.'))
    const stem = base.slice(0, base.length - ext.length)
    for (const alt of JS_TO_TS[ext] ?? []) if (ctx.exists(stem + alt)) return stem + alt
    // 확장자처럼 보이지만 실은 폴더/파일명의 일부일 수 있다 (예: config.prod -> config.prod.ts)
  }
  for (const e of RESOLVE_EXTS) if (ctx.exists(base + e)) return base + e
  for (const e of RESOLVE_EXTS) if (ctx.exists(`${base}/index${e}`)) return `${base}/index${e}`
  return null
}

/** 문자열 리터럴이면 high, 템플릿에 보간이 있으면 그 부분만 * 로 두고 low. */
function literalUrl(node: Node): { text: string; confidence: 'high' | 'low' } | null {
  if (node.type === 'string') {
    const frag = node.namedChildren.find(c => c?.type === 'string_fragment')
    return frag ? { text: frag.text, confidence: 'high' } : null
  }
  if (node.type === 'template_string') {
    let text = ''
    let clean = true
    for (const c of node.namedChildren) {
      if (!c) continue
      if (c.type === 'template_substitution') { text += '*'; clean = false } else text += c.text
    }
    // 보간이 없는 템플릿은 그냥 문자열과 동일
    if (!text) return null
    return { text, confidence: clean ? 'high' : 'low' }
  }
  return null
}

/** fetch(url, { method: 'POST' }) 의 두 번째 인자에서 메서드를 읽는다. 없으면 GET. */
function methodOf(args: Node | undefined): string {
  if (!args) return 'GET'
  const m = /\bmethod\s*:\s*['"`](\w+)['"`]/.exec(args.text)
  return m ? m[1].toUpperCase() : 'GET'
}

const posix = (p: string) => p.split(path.sep).join('/')
