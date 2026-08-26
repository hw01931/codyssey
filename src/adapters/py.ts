import path from 'node:path'
import type { Node } from 'web-tree-sitter'
import { emptyParse, type LangAdapter, type ParseResult, type ResolveCtx } from '../core/ir.ts'
import { captures, extractSymbols, getQuery, parseSource } from '../index/parser.ts'
import { fileDoc } from '../core/doc.ts'

const G = 'python'
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])

/** from a.b import c  /  import a.b */
const IMPORT_Q = `
(import_from_statement module_name: [(dotted_name) (relative_import)] @mod) @stmt
(import_statement name: [(dotted_name) (aliased_import)] @mod) @stmt
`

/** router = APIRouter(prefix="/x")  /  app = FastAPI() */
const ROUTERDEF_Q = `
(assignment
  left: (identifier) @var
  right: (call function: [(identifier) (attribute attribute: (identifier))] @fn
               arguments: (argument_list) @args))
`

/** app.include_router(orders.router, prefix="/api/v1") */
const MOUNT_Q = `
(call
  function: (attribute object: (identifier) @on attribute: (identifier) @fn)
  arguments: (argument_list) @args
  (#eq? @fn "include_router"))
`

/** 이름을 부르는 자리 */
const USE_Q = `
(call function: (identifier) @use)
(call function: (attribute object: (identifier) @use))
`

/** @router.get("/orders") def handler(): ... */
const ROUTE_Q = `
(decorator
  (call
    function: (attribute object: (identifier) @owner attribute: (identifier) @method)
    arguments: (argument_list . (string) @path)))
`

export const pyAdapter: LangAdapter = {
  name: 'py',
  exts: ['.py'],
  grammar: G,

  async parse(src: string, rel: string): Promise<ParseResult> {
    void rel
    const root = await parseSource(G, src)
    const out = emptyParse()

    for (const m of captures(await getQuery(G, 'imports', IMPORT_Q), root)) {
      if (!m.mod) continue
      const spec = m.mod.text.trim()
      const line = m.mod.startPosition.row + 1
      if (m.stmt?.type === 'import_from_statement') {
        const names = importedNames(m.stmt)
        // `from a import b` 에서 b 는 a 의 심볼일 수도, 서브모듈 a.b 일 수도 있다.
        // 모듈 쪽 엣지에는 b 를 가져온 이름으로 달고, 서브모듈 쪽은 추측성으로 따로 시도한다.
        out.imports.push({ spec, line, names: names.length ? names : undefined })
        for (const name of names) {
          out.bindings[name] = `${spec}.${name}`
          out.imports.push({ spec: `${spec}.${name}`, line, speculative: true })
        }
      } else {
        out.imports.push({ spec, line })
        out.bindings[spec.split('.')[0]] = spec
      }
    }

    for (const m of captures(await getQuery(G, 'routerdef', ROUTERDEF_Q), root)) {
      if (!m.var || !m.fn) continue
      const ctor = m.fn.text
      if (ctor !== 'APIRouter' && ctor !== 'FastAPI' && ctor !== 'Flask') continue
      out.routerDefs.push({
        name: m.var.text,
        prefix: kwarg(m.args, 'prefix') ?? '',
        line: m.var.startPosition.row + 1,
      })
    }

    for (const m of captures(await getQuery(G, 'mount', MOUNT_Q), root)) {
      if (!m.args) continue
      const target = firstPositional(m.args)
      if (!target) continue
      // orders.router -> { spec: 'orders', attr: 'router' }
      const dot = target.lastIndexOf('.')
      out.routerMounts.push({
        on: m.on?.text ?? '',
        spec: dot > 0 ? target.slice(0, dot) : target,
        attr: dot > 0 ? target.slice(dot + 1) : 'router',
        prefix: kwarg(m.args, 'prefix') ?? '',
        line: m.args.startPosition.row + 1,
      })
    }

    for (const m of captures(await getQuery(G, 'route', ROUTE_Q), root)) {
      if (!m.owner || !m.method || !m.path) continue
      const method = m.method.text.toLowerCase()
      if (!HTTP_METHODS.has(method)) continue
      out.routes.push({
        method: method.toUpperCase(),
        path: strip(m.path.text),
        owner: m.owner.text,
        line: m.owner.startPosition.row + 1,
      })
    }

    out.symbols = await extractSymbols(G, root, src, { python: true })
    out.lines = src.split(String.fromCharCode(10)).length
    out.doc = fileDoc(src.split(String.fromCharCode(10)))

    const own = new Set(out.symbols.map(s => s.name))
    const imported = new Set(Object.keys(out.bindings))
    for (const m of captures(await getQuery(G, 'uses', USE_Q), root)) {
      const node = m.use
      if (!node) continue
      const name = node.text
      if (PY_RESERVED.has(name)) continue
      const from = enclosingSymbol(node)
      if (from === name) continue
      if (!own.has(name) && !imported.has(name)) continue
      out.calls.push({ from, to: name, line: node.startPosition.row + 1 })
    }
    return out
  },

  /**
   * Python 은 번들러도 alias 도 없어서 JS보다 해석이 쉽다.
   * 기준점은 sys.path 역할을 하는 프로젝트 루트 하나.
   */
  resolve(spec, fromRel, ctx) {
    const root = ctx.projectRootOf(fromRel)
    const bases: string[] = []

    if (spec.startsWith('.')) {
      // 상대 import: 점 개수만큼 올라간다
      const up = /^\.+/.exec(spec)![0].length
      let dir = path.posix.dirname(fromRel)
      for (let i = 1; i < up; i++) dir = path.posix.dirname(dir)
      bases.push(path.posix.join(dir, spec.slice(up).split('.').join('/')))
    } else {
      const asPath = spec.split('.').join('/')
      bases.push(path.posix.join(root, asPath))
      // src 레이아웃도 흔하다
      bases.push(path.posix.join(root, 'src', asPath))
    }

    for (const b of bases) {
      if (ctx.exists(`${b}.py`)) return { path: `${b}.py`, confidence: 'high' }
      if (ctx.exists(`${b}/__init__.py`)) return { path: `${b}/__init__.py`, confidence: 'high' }
    }
    return null
  },
}

const PY_RESERVED = new Set([
  'print', 'len', 'range', 'int', 'str', 'float', 'bool', 'list', 'dict', 'set', 'tuple',
  'sum', 'min', 'max', 'sorted', 'enumerate', 'zip', 'open', 'isinstance', 'super', 'type',
  'getattr', 'setattr', 'hasattr', 'round', 'abs', 'any', 'all', 'map', 'filter',
])

/** 이 노드를 감싼 최상위 def/class. 파이썬은 들여쓰기가 곧 구조라 부모를 타고 올라간다. */
function enclosingSymbol(node: Node): string | undefined {
  let outermost: string | undefined
  for (let n: Node | null = node.parent; n && n.type !== 'module'; n = n.parent) {
    if (n.type !== 'function_definition' && n.type !== 'class_definition') continue
    const name = n.childForFieldName('name')
    if (name) outermost = name.text
  }
  return outermost
}

function importedNames(stmt: Node): string[] {
  const names: string[] = []
  let seenFrom = false
  for (const c of stmt.namedChildren) {
    if (!c) continue
    if (!seenFrom) { seenFrom = true; continue } // 첫 dotted_name 은 모듈명
    if (c.type === 'dotted_name') names.push(c.text)
    else if (c.type === 'aliased_import') {
      const orig = c.namedChildren[0]
      if (orig) names.push(orig.text)
    }
  }
  return names
}

/** prefix="/api/v1" 같은 키워드 인자. 리터럴이 아니면 null. */
function kwarg(args: Node | undefined, key: string): string | null {
  if (!args) return null
  for (const c of args.namedChildren) {
    if (c?.type !== 'keyword_argument') continue
    const [k, v] = c.namedChildren
    if (k?.text !== key) continue
    return v && v.type === 'string' ? strip(v.text) : null
  }
  return null
}

function firstPositional(args: Node): string | null {
  for (const c of args.namedChildren) {
    if (!c || c.type === 'keyword_argument' || c.type === 'comment') continue
    return c.text
  }
  return null
}

const strip = (s: string) => s.replace(/^[rbfu]*['"]{1,3}/i, '').replace(/['"]{1,3}$/, '')
