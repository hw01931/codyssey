/**
 * 진짜 오픈소스 레포들에 대고 점수를 낸다.
 *
 * 픽스처 하나만 보고 개발하다가 실제 레포에서 그래프가 통째로 비는 걸
 * 뒤늦게 발견했다. 그 일이 다시 없도록, 판단은 이 표를 보고 한다.
 *
 *   npm run bench            캐시된 레포로 측정
 *   npm run bench -- --pull  없는 레포는 받아온다
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { scan } from '../src/index/scan.ts'
import { computeFeatures, autolockCandidates, featuresOf } from '../src/core/features.ts'
import { computeModules, crossModuleShared } from '../src/core/modules.ts'

interface RepoSpec {
  name: string
  url: string
  shape: string
  why: string
}

interface Score {
  name: string
  shape: string
  files: number
  edges: number
  entries: number
  features: number
  /** import 중 실제로 파일까지 이어진 비율. 낮으면 그래프가 거짓말이다. */
  resolveRate: number
  /** 어느 기능에도 안 속한 파일 비율. 높으면 기능 모델이 그 프로젝트를 이해 못 한 것. */
  orphanRate: number
  /** 가장 큰 기능이 먹은 파일 비율. 높으면 기능이 한 덩어리라 구분이 무의미. */
  biggestFeature: number
  suggestions: number
  /** 폴더 기반 모듈 수 */
  modules: number
  /** 여러 모듈이 함께 쓰는 파일 수. 진입점이 없어도 나오는 신호 */
  shared: number
  ms: number
}

const CACHE = process.env.CODYSSEY_BENCH_DIR ?? path.join(os.tmpdir(), 'codyssey-bench')
const PULL = process.argv.includes('--pull')
const specs: RepoSpec[] = JSON.parse(fs.readFileSync('bench/repos.json', 'utf8'))

fs.mkdirSync(CACHE, { recursive: true })

const scores: Score[] = []
const missing: string[] = []

for (const spec of specs) {
  const dir = path.join(CACHE, spec.name)
  if (!fs.existsSync(dir)) {
    if (!PULL) {
      missing.push(spec.name)
      continue
    }
    process.stdout.write(`  받는 중 ${spec.name} ... `)
    try {
      execFileSync('git', ['clone', '--depth', '1', '-q', spec.url, dir], { stdio: 'ignore' })
      console.log('완료')
    } catch {
      console.log('실패 (건너뜀)')
      continue
    }
  }

  const { graph, files: fileInfos, ms } = await scan(dir)
  const feat = computeFeatures(graph)
  const mods = computeModules(graph, id => fileInfos.get(id)?.projectRoot ?? '.')
  const shared = crossModuleShared(graph, mods, 3)
  const files = graph.nodes.size
  const orphans = [...graph.nodes.keys()].filter(id => featuresOf(feat, id).length === 0).length
  const biggest = Math.max(0, ...feat.roots.map(r => feat.members.get(r.id)?.size ?? 0))
  const attempts = graph.edges.filter(e => e.kind === 'import').length + graph.unresolved.length

  scores.push({
    name: spec.name,
    shape: spec.shape,
    files,
    edges: graph.edges.length,
    entries: graph.entries.size,
    features: feat.roots.length,
    resolveRate: attempts ? 1 - graph.unresolved.length / attempts : 1,
    orphanRate: files ? orphans / files : 0,
    biggestFeature: files ? biggest / files : 0,
    modules: mods.members.size,
    shared: shared.length,
    suggestions: autolockCandidates(feat, 3).length,
    ms,
  })
}

// ---------------------------------------------------------------- 출력

const pct = (x: number) => `${Math.round(x * 100)}%`
const mark = (ok: boolean, warn = false) => (ok ? '\x1b[32mOK\x1b[0m' : warn ? '\x1b[33m!!\x1b[0m' : '\x1b[31mNG\x1b[0m')

if (missing.length) {
  console.log(`\n  받지 않은 레포: ${missing.join(', ')}`)
  console.log('  npm run bench -- --pull 로 받을 수 있습니다.')
}
if (!scores.length) {
  console.log('\n측정할 레포가 없습니다.\n')
  process.exit(0)
}

console.log(`\n캐시: ${CACHE}\n`)
const head = ['레포', '파일', '연결', '해석률', '기능', '고아율', '모듈', '공유파일', 'ms']
const rows = scores.map(s => [
  s.name,
  String(s.files),
  String(s.edges),
  pct(s.resolveRate),
  String(s.features),
  pct(s.orphanRate),
  String(s.modules),
  String(s.shared),
  String(Math.round(s.ms)),
])
const w = head.map((h, i) => Math.max(width(h), ...rows.map(r => width(r[i]))))
const line = (cells: string[]) => '  ' + cells.map((c, i) => pad(c, w[i])).join('  ')
console.log(line(head))
console.log('  ' + w.map(n => '-'.repeat(n)).join('  '))
for (const r of rows) console.log(line(r))

console.log('\n판정')
for (const s of scores) {
  const problems: string[] = []
  if (s.resolveRate < 0.9) problems.push(`import 해석률 ${pct(s.resolveRate)} - 그래프를 믿을 수 없음`)
  if (s.shared === 0) problems.push('공유 파일을 하나도 못 찾음 - 사용자에게 해줄 말이 없음')
  if (s.modules < 2) problems.push('모듈이 1개 - 폴더 구조를 못 읽음')
  // 고아율은 참고용이다. 테스트/문서/스크립트는 원래 어느 기능에도 안 속한다.
  if (s.orphanRate > 0.9 && s.features > 0) problems.push(`파일 ${pct(s.orphanRate)} 가 기능 밖 - 진입점 탐지가 부족할 수 있음`)

  console.log(`  ${mark(!problems.length, problems.length <= 1)} ${s.name} ${'\x1b[2m'}(${s.shape})\x1b[0m`)
  for (const p of problems) console.log(`       ${p}`)
}

const bad = scores.filter(s => s.resolveRate < 0.9 || s.shared === 0 || s.modules < 2 || (s.orphanRate > 0.9 && s.features > 0))
console.log(`\n  ${scores.length - bad.length} / ${scores.length} 통과\n`)

function width(s: string) {
  // 한글은 두 칸을 먹는다
  let n = 0
  for (const ch of s) n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠]/.test(ch) ? 2 : 1
  return n
}
function pad(s: string, n: number) {
  return s + ' '.repeat(Math.max(0, n - width(s)))
}
