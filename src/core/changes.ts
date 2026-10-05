import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * 변경 묶음을 반영 전에 검사하기 위한 입력.
 *
 * 작업자가 격리된 작업 공간에서 만든 변경을 정식 코드에 합치기 직전에 본다.
 * 훅은 편집 하나하나를 보지만, 여기서는 묶음 전체를 작업 계약과 대조한다.
 */
export interface Change {
  file: string
  status: 'added' | 'modified' | 'deleted'
  /** 기준점(base)의 내용. 추가된 파일은 없다 */
  before?: string
  /** 지금 내용. 지운 파일은 없다 */
  after?: string
}

/**
 * 작업 계약. 오케스트레이터가 작업을 만들 때 적는 "변경 허용 / 변경 금지".
 *
 *   allow   이 안의 파일만 바꿔야 한다 (glob). 비어 있으면 범위 검사를 안 한다
 *   deny    이건 절대 바꾸지 않는다 (glob). allow 보다 세다
 *   tests   테스트 파일을 어떻게 다룰까
 *             'keep'   (기본) 기존 테스트 수정·삭제는 확인을 거친다. 추가는 자유
 *             'free'   테스트도 작업 범위에 포함. allow/deny 만 본다
 *
 * 범위는 작업마다 다르다. 그래서 규칙 파일이 아니라 호출 인자다.
 */
export interface TaskContract {
  allow?: string[]
  deny?: string[]
  tests?: 'keep' | 'free'
}

const git = (root: string, args: string[]) =>
  execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString('utf8')

/**
 * 기준 커밋 이후 바뀐 파일과 전후 내용. 작업 트리(커밋 안 한 것 포함) 기준.
 * 이름이 바뀐 파일은 '지움 + 추가' 로 본다. 바이너리는 내용 없이 상태만.
 */
export function changesSince(repoRoot: string, baseRef: string): Change[] {
  const root = path.resolve(repoRoot)
  const out: Change[] = []
  const seen = new Set<string>()
  const push = (c: Change) => {
    if (seen.has(c.file)) return
    seen.add(c.file)
    out.push(c)
  }
  const read = (rel: string): string | undefined => {
    try {
      const buf = fs.readFileSync(path.join(root, rel))
      return buf.includes(0) ? undefined : buf.toString('utf8')
    } catch {
      return undefined
    }
  }
  const show = (rel: string): string | undefined => {
    try {
      const buf = execFileSync('git', ['show', `${baseRef}:${rel}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
      return buf.includes(0) ? undefined : buf.toString('utf8')
    } catch {
      return undefined
    }
  }

  // 커밋된 것 + 스테이지 + 작업 트리. --no-renames 로 이름 변경을 지움+추가로 받는다.
  for (const line of git(root, ['diff', '--name-status', '--no-renames', baseRef]).split('\n')) {
    const [st, ...rest] = line.split('\t')
    const file = rest.join('\t').split(path.sep).join('/')
    if (!st || !file) continue
    if (st.startsWith('A')) push({ file, status: 'added', after: read(file) })
    else if (st.startsWith('D')) push({ file, status: 'deleted', before: show(file) })
    else push({ file, status: 'modified', before: show(file), after: read(file) })
  }
  // 추적되지 않은 새 파일
  for (const file of git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').map(s => s.trim()).filter(Boolean)) {
    push({ file: file.split(path.sep).join('/'), status: 'added', after: read(file) })
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1))
}
