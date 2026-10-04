import fs from 'node:fs'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import type { Graph } from './graph.ts'
import type { Features } from './features.ts'
import { testsFor } from './contract.ts'

/**
 * 테스트를 우리가 직접 돌리고 결과를 적어둔다.
 *
 * "테스트 돌렸습니다" 는 모델의 자기보고다. 벤치마크에서 '해결' 로 집계된 패치의
 * 7.8% 가 전체 테스트를 깨뜨렸고, 모델이 테스트를 지우거나 느슨하게 고치는 일은
 * 측정된 피해 중 가장 흔하다. 그래서 '검증됨' 은 우리가 실행해서 본 결과만 뜻한다.
 *
 * 결과는 테스트 파일 단위로 적고, 기능 단위 상태는 읽을 때 만든다.
 *   PASS          그 커밋에서 이 테스트들이 통과했다
 *   FAIL          하나라도 실패했다
 *   NOT_RUN       아직 안 돌렸거나, 돌릴 러너가 없다
 *   INCONCLUSIVE  시간 초과·러너 자체 오류. 통과도 실패도 아니다
 *
 * '검증됨' 이 '그 기능이 정상이다' 는 뜻은 아니다. '그 코드 상태에서 그 테스트들이
 * 통과했다' 는 뜻이다. 테스트가 안 다루는 동작은 모른다. 화면에도 그렇게 적는다.
 *
 * 테스트 실행은 신뢰할 수 없는 코드를 실행하는 것이다. 시간 제한을 두고,
 * 비밀처럼 보이는 환경 변수는 넘기지 않는다.
 */

export type TestStatus = 'PASS' | 'FAIL' | 'NOT_RUN' | 'INCONCLUSIVE'

export interface TestResult {
  file: string
  status: TestStatus
  /** 실제로 실행한 명령. NOT_RUN 이면 없다 */
  command?: string
  ms?: number
  /** 출력 끝부분. 실패 원인을 보려면 이걸로 충분하다 */
  output?: string
  /** NOT_RUN / INCONCLUSIVE 의 이유 */
  reason?: string
}

export interface VerifyRun {
  at: number
  /** HEAD 커밋. git 이 아니면 null */
  commit: string | null
  /** 커밋 안 한 변경이 있었다. 그러면 '그 커밋에서 통과' 라고 말할 수 없다 */
  dirty: boolean
  results: TestResult[]
}

export interface FeatureVerification {
  feature: string
  status: TestStatus
  /** 이 기능에 닿는 테스트들 */
  tests: string[]
  /** 그 중 실패한 것 */
  failing: string[]
  /** 마지막으로 돌린 때·커밋 */
  at?: number
  commit?: string | null
  dirty?: boolean
}

/** 저장 형식. 테스트 파일마다 마지막 결과. */
interface Store {
  version: 1
  tests: Record<string, { status: TestStatus; at: number; commit: string | null; dirty: boolean; reason?: string }>
}

const STORE = path.join('.codyssey', 'verified.json')

export function loadStore(repoRoot: string): Store {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(repoRoot, STORE), 'utf8'))
    if (s?.version === 1 && s.tests) return s
  } catch {
    /* 처음이다 */
  }
  return { version: 1, tests: {} }
}

export function saveStore(repoRoot: string, store: Store) {
  fs.mkdirSync(path.join(repoRoot, '.codyssey'), { recursive: true })
  fs.writeFileSync(path.join(repoRoot, STORE), JSON.stringify(store, null, 2) + '\n')
}

// ---------------------------------------------------------------- 러너 감지

interface Runner {
  /** 사람에게 보여줄 이름 */
  name: string
  /** 실행 파일과 인자. 파일 목록은 뒤에 붙는다 */
  command: string
  args: string[]
  /** 실행 디렉터리 (프로젝트 루트, 저장소 기준 상대) */
  cwd: string
}

/** 가장 가까운 package.json / pyproject.toml 이 있는 폴더 */
function runnerRootOf(repoRoot: string, rel: string): string {
  let dir = path.posix.dirname(rel)
  while (true) {
    const abs = path.join(repoRoot, dir)
    for (const m of ['package.json', 'pyproject.toml', 'setup.cfg', 'pytest.ini', 'setup.py']) {
      if (fs.existsSync(path.join(abs, m))) return dir === '.' ? '' : dir
    }
    const up = path.posix.dirname(dir)
    if (up === dir || dir === '.' || dir === '') return ''
    dir = up
  }
}

/**
 * 이 테스트 파일을 돌릴 러너. 설정에서 읽는다. 추측해서 틀리면 실패가 '테스트 실패' 로
 * 보여서 더 나쁘다. 모르면 null 을 돌려주고 NOT_RUN 으로 적는다.
 */
export function detectRunner(repoRoot: string, testFile: string): Runner | null {
  const cwd = runnerRootOf(repoRoot, testFile)
  const abs = (f: string) => path.join(repoRoot, cwd, f)

  if (/\.py$/.test(testFile)) {
    // pytest 가 실제로 있는지는 돌려보기 전엔 모른다. 없으면 실행 단계에서 INCONCLUSIVE 가 된다
    return { name: 'pytest', command: 'python3', args: ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'], cwd }
  }

  let pkg: any = null
  try {
    pkg = JSON.parse(fs.readFileSync(abs('package.json'), 'utf8'))
  } catch {
    return null
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const script = String(pkg.scripts?.test ?? '')
  const bin = (name: string) => (fs.existsSync(abs(path.join('node_modules', '.bin', name))) ? abs(path.join('node_modules', '.bin', name)) : null)

  if (deps.vitest && bin('vitest')) return { name: 'vitest', command: bin('vitest')!, args: ['run', '--reporter=dot'], cwd }
  if (deps.jest && bin('jest')) return { name: 'jest', command: bin('jest')!, args: ['--silent'], cwd }
  if (deps.mocha && bin('mocha')) return { name: 'mocha', command: bin('mocha')!, args: [], cwd }
  // 이 저장소처럼 node 로 직접 돌리는 경우. 스크립트가 쓰는 플래그를 그대로 가져간다.
  if (/\bnode\b/.test(script)) {
    const flags = script.match(/--experimental-strip-types|--test|--import\S*|--loader\S*|--require\S*/g) ?? []
    const uniq = [...new Set(flags)]
    if (!uniq.includes('--test') && !/\.(test|spec)\./.test(testFile)) uniq.push('--test')
    return { name: 'node', command: process.execPath, args: uniq, cwd }
  }
  return null
}

// ---------------------------------------------------------------- 실행

/** 비밀처럼 보이는 환경 변수는 테스트 프로세스에 넘기지 않는다 */
function safeEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE/i.test(k)) continue
    out[k] = v
  }
  out.CI = '1'
  out.NODE_ENV ??= 'test'
  return out
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string; timedOut: boolean; error?: string }> {
  return new Promise(resolve => {
    let out = ''
    const child = execFile(cmd, args, { cwd, env: safeEnv(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      out = `${stdout ?? ''}${stderr ?? ''}`
      const e = err as (Error & { code?: unknown; killed?: boolean; signal?: string }) | null
      if (e && (e.killed || e.signal === 'SIGTERM')) return resolve({ code: null, out, timedOut: true })
      if (e && typeof e.code !== 'number') return resolve({ code: null, out, timedOut: false, error: e.message })
      resolve({ code: e ? (e.code as number) : 0, out, timedOut: false })
    })
    child.on('error', e => resolve({ code: null, out, timedOut: false, error: e.message }))
  })
}

const tail = (s: string, lines = 40) => s.trim().split(/\r?\n/).slice(-lines).join('\n')

function gitState(repoRoot: string): { commit: string | null; dirty: boolean } {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, stdio: 'pipe' }).toString().trim().length > 0
    return { commit, dirty }
  } catch {
    return { commit: null, dirty: true }
  }
}

export interface VerifyOptions {
  /** 테스트 파일 하나당 제한. 기본 2분 */
  timeoutMs?: number
}

/**
 * 테스트 파일들을 돌리고 결과를 적는다.
 * 같은 러너·같은 프로젝트의 파일은 한 번에 돌린다. 러너를 파일마다 띄우면 느리다.
 */
export async function runTests(repoRoot: string, testFiles: string[], opts: VerifyOptions = {}): Promise<VerifyRun> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  const { commit, dirty } = gitState(repoRoot)
  const results: TestResult[] = []

  // 러너별로 묶는다
  const groups = new Map<string, { runner: Runner; files: string[] }>()
  for (const f of [...new Set(testFiles)].sort()) {
    const runner = detectRunner(repoRoot, f)
    if (!runner) {
      results.push({ file: f, status: 'NOT_RUN', reason: 'no-runner' })
      continue
    }
    const key = `${runner.name} ${runner.cwd}`
    const g = groups.get(key) ?? { runner, files: [] }
    g.files.push(f)
    groups.set(key, g)
  }

  for (const { runner, files } of groups.values()) {
    const cwdAbs = path.join(repoRoot, runner.cwd)
    const relToCwd = files.map(f => path.relative(cwdAbs, path.join(repoRoot, f)).split(path.sep).join('/'))
    // node 러너는 파일마다 따로 돈다 (스크립트 하나가 파일 하나). 나머지는 한 번에.
    const batches = runner.name === 'node' ? relToCwd.map(f => [f]) : [relToCwd]
    for (const batch of batches) {
      const t0 = Date.now()
      const r = await run(runner.command, [...runner.args, ...batch], cwdAbs, timeoutMs * batch.length)
      const ms = Date.now() - t0
      const command = [path.basename(runner.command), ...runner.args, ...batch].join(' ')
      const batchFiles = batch.map(b => path.posix.normalize(path.posix.join(runner.cwd, b)).replace(/^\.\//, ''))
      let status: TestStatus
      let reason: string | undefined
      if (r.timedOut) { status = 'INCONCLUSIVE'; reason = 'timeout' }
      else if (r.error) { status = 'INCONCLUSIVE'; reason = r.error }
      else if (r.code === 0) status = 'PASS'
      // pytest: 5 = 수집된 테스트 없음, 4 = 사용법 오류. 둘 다 '실패' 가 아니다
      else if (runner.name === 'pytest' && (r.code === 4 || r.code === 5)) { status = 'INCONCLUSIVE'; reason = `pytest exit ${r.code}` }
      // 모듈 없음(python -m pytest 가 pytest 를 못 찾음)도 실패가 아니다
      else if (/No module named|command not found|ENOENT/.test(r.out)) { status = 'INCONCLUSIVE'; reason = 'runner-missing' }
      else status = 'FAIL'
      for (const f of batchFiles) results.push({ file: f, status, command, ms, output: tail(r.out), ...(reason ? { reason } : {}) })
    }
  }

  const store = loadStore(repoRoot)
  const at = Date.now()
  for (const r of results) {
    // 못 돌린 건 예전 기록을 지우지 않는다. '모른다' 가 '예전엔 통과했다' 를 덮으면 안 된다.
    if (r.status === 'NOT_RUN') continue
    store.tests[r.file] = { status: r.status, at, commit, dirty, ...(r.reason ? { reason: r.reason } : {}) }
  }
  saveStore(repoRoot, store)
  return { at, commit, dirty, results }
}

// ---------------------------------------------------------------- 기능 단위 상태

/** 이 기능에 닿는 테스트. 기능의 어느 파일이든 import 하는 테스트 파일 전부. */
export function testsOfFeature(graph: Graph, features: Features, featureId: string): string[] {
  const members = features.members.get(featureId)
  if (!members) return []
  const out = new Set<string>()
  for (const f of members) for (const tf of testsFor(graph, f)) out.add(tf)
  return [...out].sort()
}

/**
 * 기능의 검증 상태. 저장된 테스트 결과에서 만든다.
 *   테스트가 없다            NOT_RUN  (지킬 근거가 없다는 뜻. 추천에서도 그렇게 말한다)
 *   하나라도 FAIL            FAIL
 *   하나라도 안 돌림         NOT_RUN
 *   하나라도 INCONCLUSIVE    INCONCLUSIVE
 *   전부 PASS               PASS
 */
export function verificationOf(repoRoot: string, graph: Graph, features: Features, featureId: string, store = loadStore(repoRoot)): FeatureVerification {
  const tests = testsOfFeature(graph, features, featureId)
  const recs = tests.map(t => ({ t, r: store.tests[t] }))
  const failing = recs.filter(x => x.r?.status === 'FAIL').map(x => x.t)
  let status: TestStatus
  if (!tests.length || recs.some(x => !x.r)) status = 'NOT_RUN'
  else if (failing.length) status = 'FAIL'
  else if (recs.some(x => x.r.status === 'INCONCLUSIVE')) status = 'INCONCLUSIVE'
  else status = 'PASS'
  const latest = recs.map(x => x.r).filter(Boolean).sort((a, b) => b.at - a.at)[0]
  return {
    feature: featureId,
    status,
    tests,
    failing,
    ...(latest ? { at: latest.at, commit: latest.commit, dirty: latest.dirty } : {}),
  }
}

export function allVerifications(repoRoot: string, graph: Graph, features: Features): FeatureVerification[] {
  const store = loadStore(repoRoot)
  return features.roots.map(r => verificationOf(repoRoot, graph, features, r.id, store))
}
