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
(import_statement source: (string (string_fragment) @spec))
(export_statement source: (string (string_fragment) @spec))
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
      out.imports.push({ spec: m.spec.text, line: m.spec.startPosition.row + 1 })
    }

    for (const m of captures(await getQuery(grammar, 'fetch', FETCH_Q), root)) {
      const url = literalUrl(m.url)
      if (!url) continue
      out.httpCalls.push({
        method: methodOf(m.args),
        url: url.text,
        line: m.url.startPosition.row + 1,
        confidence: url.confidence,
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

  /** Next.js app router: 파일 경로가 곧 라우트. 파싱 불필요. */
  routeFromPath(rel, projectRoot) {
    const inProject = rel.slice(projectRoot.length + 1)
    const m = /^app\/(.*\/)?page\.(tsx|ts|jsx|js)$/.exec(inProject)
    if (!m) return null
    const segs = (m[1] ?? '').split('/').filter(Boolean).filter(s => !/^\(.*\)$/.test(s))
    return { method: 'PAGE', path: '/' + segs.join('/'), owner: '', line: 1 } satisfies RouteDecl
  },
}

function matchAlias(pattern: string, spec: string): string | null {
  const star = pattern.indexOf('*')
  if (star < 0) return spec === pattern ? '' : null
  const head = pattern.slice(0, star)
  const tail = pattern.slice(star + 1)
  if (!spec.startsWith(head) || !spec.endsWith(tail)) return null
  return spec.slice(head.length, spec.length - tail.length)
}

function tryExts(base: string, ctx: ResolveCtx): string | null {
  if (/\.\w+$/.test(base) && ctx.exists(base)) return base
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
