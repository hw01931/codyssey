import type { Graph } from '../core/graph.ts'
import { featuresOf, type Features } from '../core/features.ts'
import { consumerModules, type Modules } from '../core/modules.ts'
import type { Rules } from '../core/rules.ts'
import { t } from '../i18n/index.ts'

/**
 * AI 에게 넣어줄 문구를 만든다.
 *
 * 원칙은 하나다: **할 말이 없으면 아무것도 넣지 않는다.**
 * 편집마다 200토큰씩 붙이면 대화 하나에 수만 토큰이 사라지고,
 * 그러면 도움이 아니라 방해가 된다.
 */
export interface CtxInput {
  graph: Graph
  features: Features
  modules: Modules
  rules: Rules
  lockedFiles: Set<string>
  port: number
}

/** 세션이 시작될 때 한 번. 이 프로젝트가 무엇인지 가장 짧게. */
export function sessionBrief(c: CtxInput): string {
  const L: string[] = []
  const feats = c.features.roots.map(r => r.id)
  if (feats.length) {
    L.push(t('ctx.features', { count: feats.length, list: feats.slice(0, 8).join(', ') + (feats.length > 8 ? ' ' + t('ctx.andMore') : '') }))
  }
  if (c.lockedFiles.size) {
    const list = [...c.lockedFiles].sort()
    L.push(t('ctx.lockedList', { count: list.length, list: list.slice(0, 6).join(', ') + (list.length > 6 ? ' ' + t('ctx.andMore') : '') }))
    L.push(t('ctx.lockedNote'))
  }
  if (c.rules.autolock.mode === 'ask') {
    L.push(t('ctx.sharedNote'))
  }
  if (!L.length) return ''
  return [
    t('ctx.title'),
    ...L,
    t('ctx.seeStructure', { url: `http://127.0.0.1:${c.port}` }),
  ].join('\n')
}

/**
 * 사용자 프롬프트에서 언급된 파일/기능이 있으면 그 주변 정보만 넣는다.
 * 못 찾으면 빈 문자열. 추측해서 넣지 않는다.
 */
export function promptBrief(c: CtxInput, prompt: string): string {
  const hits = matchFiles(c.graph, prompt).slice(0, 3)
  if (!hits.length) return ''

  const L = [t('ctx.mentioned')]
  for (const file of hits) {
    const feats = featuresOf(c.features, file)
    const mods = consumerModules(c.graph, c.modules, file)
    const deps = c.graph.dependents(file).size - 1
    const lockNote = c.lockedFiles.has(file) ? ' ' + t('ctx.lockedTag') : ''
    L.push(`${file}${lockNote}`)
    if (feats.length) L.push('  ' + t('ctx.affects', { list: feats.slice(0, 5).join(', ') }))
    else if (mods.length) L.push('  ' + t('ctx.usedByModules', { list: mods.slice(0, 5).join(', ') }))
    if (deps > 0) L.push('  ' + t('ctx.usedBy', { count: deps }))
  }
  return L.join('\n')
}

/** 편집 뒤 연결이 실제로 바뀐 것만. 안 바뀌었으면 침묵. */
export function deltaBrief(before: EdgeSnapshot, after: EdgeSnapshot, file: string): string {
  const added = [...after].filter(x => !before.has(x))
  const removed = [...before].filter(x => !after.has(x))
  if (!added.length && !removed.length) return ''
  const L = [t('ctx.linksChanged', { file })]
  for (const x of added.slice(0, 5)) L.push(`  + ${x}`)
  for (const x of removed.slice(0, 5)) L.push(`  - ${x}`)
  return L.join('\n')
}

export type EdgeSnapshot = Set<string>

export function snapshotEdges(graph: Graph, file: string): EdgeSnapshot {
  const out = new Set<string>()
  for (const e of graph.out(file)) out.add(`-> ${e.to}${e.via ? ` (${e.via})` : ''}`)
  for (const e of graph.in(file)) out.add(`<- ${e.from}`)
  return out
}

/**
 * 프롬프트에 나온 경로/파일명을 그래프에서 찾는다.
 * 너무 짧은 조각(3글자 미만)은 오탐이 많아서 버린다.
 */
function matchFiles(graph: Graph, prompt: string): string[] {
  const ids = [...graph.nodes.keys()]
  const found = new Set<string>()

  // 1) 경로 그대로 (a/b/c.ts)
  for (const m of prompt.matchAll(/[\w./-]*[\w-]+\.(ts|tsx|js|jsx|mjs|cjs|py)\b/g)) {
    const frag = m[0].replace(/^\.?\//, '')
    for (const id of ids) if (id === frag || id.endsWith('/' + frag)) found.add(id)
  }

  // 2) 확장자 없는 파일명 (payment, OrderTable)
  if (found.size < 3) {
    for (const m of prompt.matchAll(/[A-Za-z_][\w-]{2,}/g)) {
      const word = m[0].toLowerCase()
      if (STOP.has(word)) continue
      for (const id of ids) {
        const base = (id.split('/').pop() ?? '').replace(/\.\w+$/, '').toLowerCase()
        if (base === word) found.add(id)
      }
    }
  }
  return [...found].sort()
}

/** 흔한 단어가 파일명과 겹쳐서 생기는 오탐을 막는다. */
const STOP = new Set([
  'the', 'and', 'for', 'you', 'this', 'that', 'with', 'from', 'into', 'code', 'file', 'test',
  'add', 'fix', 'new', 'use', 'get', 'set', 'run', 'make', 'app', 'src', 'lib', 'api', 'web',
  'index', 'main', 'utils', 'types', 'config',
])
