import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { scan } from '../index/scan.ts'
import { computeFeatures } from '../core/features.ts'
import { computeModules, crossModuleShared } from '../core/modules.ts'
import { findViolations, type Rules } from '../core/rules.ts'

export interface ArchDiff {
  base: string
  head: string
  entriesAdded: string[]
  entriesRemoved: string[]
  edgesAdded: string[]
  edgesRemoved: string[]
  sharedAdded: string[]
  violationsAdded: string[]
  lockedTouched: string[]
  empty: boolean
}

/**
 * 두 시점의 아키텍처를 비교한다.
 *
 * 이게 성립하려면 그래프가 결정적이어야 한다(P2). LLM 으로 구조를 추론했다면
 * 같은 코드에서도 매번 다른 그림이 나와서 diff 가 소음이 된다.
 * 처음부터 LLM 을 안 쓴 이유 중 하나가 이것이다.
 */
export async function archDiff(repoRoot: string, baseRef: string, rules: Rules, lockedFiles: Set<string>): Promise<ArchDiff> {
  const root = path.resolve(repoRoot)
  const head = await snapshot(root, rules)

  // base 를 임시 worktree 로 꺼낸다. 작업 트리를 건드리지 않는다.
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-base-'))
  let base: Snapshot
  try {
    git(root, ['worktree', 'add', '--detach', '-q', wt, baseRef])
    base = await snapshot(wt, rules)
  } finally {
    try {
      git(root, ['worktree', 'remove', '--force', wt])
    } catch {
      fs.rmSync(wt, { recursive: true, force: true })
    }
  }

  const changed = changedFiles(root, baseRef)
  const d: ArchDiff = {
    base: baseRef,
    head: 'HEAD',
    entriesAdded: minus(head.entries, base.entries),
    entriesRemoved: minus(base.entries, head.entries),
    edgesAdded: minus(head.edges, base.edges),
    edgesRemoved: minus(base.edges, head.edges),
    sharedAdded: minus(head.shared, base.shared),
    violationsAdded: minus(head.violations, base.violations),
    lockedTouched: changed.filter(f => lockedFiles.has(f)).sort(),
    empty: false,
  }
  d.empty =
    !d.entriesAdded.length &&
    !d.entriesRemoved.length &&
    !d.edgesAdded.length &&
    !d.edgesRemoved.length &&
    !d.sharedAdded.length &&
    !d.violationsAdded.length &&
    !d.lockedTouched.length
  return d
}

interface Snapshot {
  entries: Set<string>
  edges: Set<string>
  shared: Set<string>
  violations: Set<string>
}

async function snapshot(dir: string, rules: Rules): Promise<Snapshot> {
  const { graph, files } = await scan(dir)
  const feat = computeFeatures(graph)
  const mods = computeModules(graph, id => files.get(id)?.projectRoot ?? '.')
  return {
    entries: new Set(feat.roots.map(r => r.id)),
    // 모듈 간 연결만 본다. 파일 하나 옮긴 걸로 수백 줄이 나오면 아무도 안 읽는다.
    edges: new Set(
      graph.edges
        .map(e => {
          const a = mods.of.get(e.from)
          const b = mods.of.get(e.to)
          return a && b && a !== b ? `${a} -> ${b}${e.kind === 'http' ? ' (HTTP)' : ''}` : ''
        })
        .filter(Boolean),
    ),
    // 파일 경로만 담는다. 공유 모듈 개수까지 넣으면 숫자가 1 바뀐 것도 '새로 공유'로 잡힌다.
    shared: new Set(crossModuleShared(graph, mods, rules.autolock.minModules ?? 3).map(c => c.file)),
    violations: new Set(findViolations(rules, graph).map(v => `${v.from} -> ${v.to}`)),
  }
}

export function renderDiff(d: ArchDiff): string {
  if (d.empty) return `## 아키텍처 변화 없음\n\n\`${d.base}\` 대비 구조가 그대로입니다.`

  const L = [`## 아키텍처 변화 (\`${d.base}\` 대비)`, '']
  const block = (title: string, items: string[], mark = '') => {
    if (!items.length) return
    L.push(`### ${title}`, '')
    for (const x of items.slice(0, 20)) L.push(`- ${mark}\`${x}\``)
    if (items.length > 20) L.push(`- ... 외 ${items.length - 20}개`)
    L.push('')
  }

  if (d.lockedTouched.length) {
    L.push('### 잠긴 파일이 바뀌었습니다', '')
    for (const f of d.lockedTouched) L.push(`- \`${f}\``)
    L.push('', '사람 승인이 필요한 파일입니다. 의도한 변경인지 확인해 주세요.', '')
  }
  block('새 규칙 위반', d.violationsAdded)
  block('새 진입점', d.entriesAdded)
  block('사라진 진입점', d.entriesRemoved)
  block('새 모듈 간 연결', d.edgesAdded)
  block('끊어진 모듈 간 연결', d.edgesRemoved)
  block('새로 여러 곳이 공유하게 된 파일', d.sharedAdded)

  L.push('<sub>codyssey · 정적 분석, LLM 호출 없음</sub>')
  return L.join('\n')
}

/** 이 diff 가 CI 를 실패시켜야 하나 */
export function shouldFail(d: ArchDiff): boolean {
  return d.violationsAdded.length > 0 || d.lockedTouched.length > 0
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function changedFiles(root: string, baseRef: string): string[] {
  try {
    return git(root, ['diff', '--name-only', `${baseRef}...HEAD`])
      .split(/\r?\n/)
      .filter(Boolean)
  } catch {
    return []
  }
}

const minus = (a: Set<string>, b: Set<string>) => [...a].filter(x => !b.has(x)).sort()
