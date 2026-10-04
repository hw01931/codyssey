import { execFileSync } from 'node:child_process'

/**
 * git 이력에서 읽는 신호. LLM 도, 실행도 없다. 커밋 로그만 본다.
 *
 * import 그래프는 '무엇이 무엇에 닿는가' 를 안다. 이력은 '실제로 어디가 자주 깨지는가' 를 안다.
 * 결함 예측 연구에서 상대 churn 은 중심성보다 강한 신호였고(Nagappan & Ball, ICSE 2005),
 * 함께 바뀌는 파일 쌍은 import 없이 이어진 숨은 결합을 드러낸다(Zimmermann et al., ICSE 2004).
 *
 * 둘을 합치면 "기능 23개가 공유" 라는 평평한 목록이 "그중 지난 90일에 12번 바뀌었고,
 * 바뀔 때마다 users.py 도 같이 바뀐 파일" 로 좁혀진다.
 *
 * 한계를 그대로 적는다:
 *   - 커밋이 작업 단위라고 가정한다. 커밋 하나에 파일 40개면 전부 '함께 바뀜' 이 된다.
 *     그래서 큰 커밋은 공변경 계산에서 뺀다.
 *   - 이름이 바뀐 파일은 이어 보지 않는다 (--follow 는 파일 하나씩만 된다).
 *   - 얕은 clone 이면 보이는 범위만 센다. 그 사실을 함께 돌려준다.
 */

export interface FileHistory {
  file: string
  /** 기간 안에 이 파일을 바꾼 커밋 수 */
  commits: number
  /** 마지막으로 바뀐 때 (epoch ms) */
  lastChanged: number | null
  /** 함께 바뀐 파일. 같은 커밋에 든 횟수가 많은 순 */
  coChanges: { file: string; together: number }[]
}

export interface History {
  /** 본 기간 (일) */
  days: number
  /** 본 커밋 수 */
  commits: number
  /** 저장소가 얕아서(shallow) 이력이 잘려 있다 */
  shallow: boolean
  /** git 저장소가 아니거나 git 이 없다 */
  unavailable: boolean
  files: Map<string, FileHistory>
}

export interface HistoryOptions {
  /** 기본 90일 */
  days?: number
  /** 이보다 많은 파일을 건드린 커밋은 공변경 계산에서 뺀다. 기본 30 */
  maxFilesPerCommit?: number
  /** 파일마다 남길 공변경 상위 개수. 기본 5 */
  topCoChanges?: number
}

export function emptyHistory(days = 90): History {
  return { days, commits: 0, shallow: false, unavailable: true, files: new Map() }
}

export function readHistory(repoRoot: string, opts: HistoryOptions = {}): History {
  const days = opts.days ?? 90
  const maxFiles = opts.maxFilesPerCommit ?? 30
  const top = opts.topCoChanges ?? 5

  let raw: string
  let shallow = false
  try {
    raw = execFileSync(
      'git',
      ['log', `--since=${days} days ago`, '--name-only', '--no-merges', '--pretty=format:%x00%ct', '--', '.'],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
    ).toString('utf8')
    shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() === 'true'
  } catch {
    return emptyHistory(days)
  }

  const files = new Map<string, FileHistory>()
  const pairs = new Map<string, Map<string, number>>()
  const bump = (a: string, b: string) => {
    const m = pairs.get(a) ?? new Map<string, number>()
    m.set(b, (m.get(b) ?? 0) + 1)
    pairs.set(a, m)
  }

  // 커밋마다: \0<epoch>\n<file>\n<file>...
  let commits = 0
  for (const chunk of raw.split('\u0000')) {
    if (!chunk.trim()) continue
    const lines = chunk.split('\n').map(l => l.trim()).filter(Boolean)
    const at = Number(lines.shift()) * 1000
    if (!Number.isFinite(at)) continue
    const touched = [...new Set(lines.map(l => l.split('\\').join('/')))]
    if (!touched.length) continue
    commits++
    for (const f of touched) {
      const h = files.get(f) ?? { file: f, commits: 0, lastChanged: null, coChanges: [] }
      h.commits++
      if (h.lastChanged === null || at > h.lastChanged) h.lastChanged = at
      files.set(f, h)
    }
    // 큰 커밋(포맷터, 대량 이동)은 모든 파일을 '함께 바뀜' 으로 만든다. 신호가 아니라 소음이다.
    if (touched.length > maxFiles) continue
    for (const a of touched) for (const b of touched) if (a !== b) bump(a, b)
  }

  for (const [f, m] of pairs) {
    const h = files.get(f)
    if (!h) continue
    h.coChanges = [...m.entries()]
      .map(([file, together]) => ({ file, together }))
      .sort((x, y) => y.together - x.together || (x.file < y.file ? -1 : 1))
      .slice(0, top)
  }

  return { days, commits, shallow, unavailable: false, files }
}

/**
 * 이 저장소에서 '자주 바뀐다' 의 기준. 절대 횟수는 저장소마다 다르다.
 * 바뀐 파일들의 커밋 수 분포에서 상위 20% 경계를 쓴다. 최소 3.
 */
export function hotThreshold(h: History): number {
  const counts = [...h.files.values()].map(f => f.commits).sort((a, b) => a - b)
  if (!counts.length) return Infinity
  const q = counts[Math.floor(counts.length * 0.8)] ?? counts[counts.length - 1]
  return Math.max(3, q)
}
