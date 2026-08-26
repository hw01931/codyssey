import { Parser, Language, Query } from 'web-tree-sitter'
import type { Node } from 'web-tree-sitter'
import fs from 'node:fs'
import { getWasmPath, getQueryPath } from 'tree-sitter-wasm'
import { docAt, type DocOptions } from '../core/doc.ts'
import type { Sym } from '../core/ir.ts'

let inited = false
const langs = new Map<string, Language>()
const parsers = new Map<string, Parser>()
/** P7: 쿼리 컴파일 캐시. 편집마다 도는 경로라 필수. */
const queries = new Map<string, Query>()

export async function initParsers() {
  if (inited) return
  await Parser.init()
  inited = true
}

export async function loadGrammar(grammar: string): Promise<Language> {
  await initParsers()
  const cached = langs.get(grammar)
  if (cached) return cached
  const lang = await Language.load(getWasmPath(grammar))
  langs.set(grammar, lang)
  return lang
}

export async function parseSource(grammar: string, src: string): Promise<Node> {
  const lang = await loadGrammar(grammar)
  let p = parsers.get(grammar)
  if (!p) {
    p = new Parser()
    p.setLanguage(lang)
    parsers.set(grammar, p)
  }
  const tree = p.parse(src)
  if (!tree) throw new Error(`parse failed for grammar '${grammar}'`)
  return tree.rootNode
}

export async function getQuery(grammar: string, name: string, source: string): Promise<Query> {
  const key = `${grammar}:${name}`
  const cached = queries.get(key)
  if (cached) return cached
  const q = new Query(await loadGrammar(grammar), source)
  queries.set(key, q)
  return q
}

/**
 * tags.scm 은 문법 상속을 따른다. typescript/tsx 의 tags.scm 은 JS 문법 위에 얹는
 * '증분분'이라 function_declaration 같은 JS 노드가 없다. 체인으로 합쳐야 한다.
 */
const TAGS_CHAIN: Record<string, string[]> = {
  typescript: ['javascript', 'typescript'],
  tsx: ['javascript', 'tsx'],
  javascript: ['javascript'],
}

/** nvim 전용 디렉티브. web-tree-sitter 는 모르는 predicate 를 거부하므로 제거한다. */
const stripNvimDirectives = (scm: string) =>
  scm.replace(/^\s*\(#(strip|select-adjacent)!.*$/gm, '')

/** 문법에 동봉된 tags.scm. 심볼 추출은 이걸로 끝난다 - 직접 구현할 게 없다. */
export async function getTagsQuery(grammar: string): Promise<Query | null> {
  const chain = TAGS_CHAIN[grammar] ?? [grammar]
  const parts: string[] = []
  for (const g of chain) {
    try {
      const file = getQueryPath(g, 'tags')
      if (fs.existsSync(file)) parts.push(fs.readFileSync(file, 'utf8'))
    } catch {
      /* 해당 문법에 tags 없음 */
    }
  }
  if (!parts.length) return null
  return getQuery(grammar, 'tags', stripNvimDirectives(parts.join('\n')))
}

/** 캡처 이름 → 노드들 (매치 단위로 묶어서 반환) */
export function captures(q: Query, root: Node): Record<string, Node>[] {
  return q.matches(root).map(m => {
    const out: Record<string, Node> = {}
    for (const c of m.captures) out[c.name] = c.node
    return out
  })
}

/**
 * tags.scm 은 (@name = 이름 노드, @definition.<kind> = 정의 노드) 형태로 캡처한다.
 * github 스타일(@name.definition.x)이 아니라 nvim 스타일이라 이렇게 읽어야 한다.
 */
/**
 * 이 파일이 정의하는 심볼들.
 *
 * `src` 를 받으면 정의가 끝나는 줄과 주석에서 뽑은 설명까지 채운다.
 * 안 주면 예전처럼 이름·종류·줄만 낸다 - 부르는 쪽이 소스를 안 들고 있을 수 있다.
 */
export async function extractSymbols(grammar: string, root: Node, src?: string, opts: DocOptions = {}) {
  const q = await getTagsQuery(grammar)
  if (!q) return []
  const lines = src?.split(String.fromCharCode(10))
  const out: Sym[] = []
  for (const m of captures(q, root)) {
    const nameNode = m['name']
    if (!nameNode) continue
    const defKey = Object.keys(m).find(k => k.startsWith('definition.'))
    if (!defKey) continue
    const defNode = m[defKey]
    const line = nameNode.startPosition.row + 1
    const sym: Sym = { name: nameNode.text, kind: defKey.slice('definition.'.length), line }
    if (defNode) sym.endLine = defNode.endPosition.row + 1
    if (lines) {
      const d = docAt(lines, line, opts)
      if (d) sym.doc = d
    }
    out.push(sym)
  }
  return out
}
