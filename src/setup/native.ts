import fs from 'node:fs'
import path from 'node:path'
import type { ProtectRule } from '../core/rules.ts'

/**
 * 사람이 잠근 파일을 Claude Code 가 스스로 아는 형태로도 적어둔다.
 *
 * 우리 훅은 데몬이 떠 있고 포트가 맞을 때만 막는다. Claude Code 의
 * `permissions.deny` 는 그런 조건이 없다. 세션 시작 때 읽히고, `sed`·`tee`·
 * 리다이렉션으로 쓰는 것까지 같은 규칙으로 막고, 샌드박스가 켜져 있으면
 * 스크립트 안에서 쓰는 것도 막는다. 우리 Bash 해석기가 못 보는 영역이다.
 *
 * 그래서 잠금은 두 곳에 적는다. 훅은 '왜 막혔고 대신 뭘 하라' 를 말해주고,
 * deny 규칙은 훅이 죽어 있어도 막는다.
 *
 * 규칙 모양: `Edit(/api/services/**)`. 앞의 `/` 가 프로젝트 루트 기준이라는 뜻이다.
 * Edit 규칙은 Write·NotebookEdit 에도 적용된다 (공식 문서).
 *
 * 우리가 쓴 항목만 갈아끼운다. 사람이 손으로 넣은 deny 는 건드리지 않는다.
 * 그러려면 지난번에 뭘 썼는지 기억해야 하므로 .codyssey/native.json 에 적어둔다.
 */

const MARK = path.join('.codyssey', 'native.json')

export const denyRule = (p: string) => `Edit(/${p.replace(/^\.?\//, '')})`

export function syncNativeDeny(root: string, protect: ProtectRule[]): boolean {
  const settingsPath = path.join(root, '.claude', 'settings.json')
  const markPath = path.join(root, MARK)

  let settings: Record<string, any> = {}
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    } catch {
      return false // 깨진 설정은 건드리지 않는다. doctor 가 알려준다.
    }
  }
  let previous: string[] = []
  try {
    previous = JSON.parse(fs.readFileSync(markPath, 'utf8')).deny ?? []
  } catch {
    /* 처음이다 */
  }

  const want = [...new Set(protect.map(p => denyRule(p.path)))].sort()
  const current: string[] = Array.isArray(settings.permissions?.deny) ? settings.permissions.deny : []
  const mine = new Set(previous)
  const kept = current.filter(r => !mine.has(r))
  const next = [...kept, ...want.filter(r => !kept.includes(r))]

  const same = JSON.stringify(next) === JSON.stringify(current) && JSON.stringify(previous) === JSON.stringify(want)
  if (same) return false

  settings.permissions ??= {}
  if (next.length) settings.permissions.deny = next
  else delete settings.permissions.deny
  if (!Object.keys(settings.permissions).length) delete settings.permissions

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  fs.mkdirSync(path.dirname(markPath), { recursive: true })
  fs.writeFileSync(markPath, JSON.stringify({ deny: want }, null, 2) + '\n')
  return true
}
