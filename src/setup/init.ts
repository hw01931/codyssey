import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { scan } from '../index/scan.ts'
import { computeFeatures, autolockCandidates } from '../core/features.ts'
import { defaultRules } from '../core/rules.ts'
import { resolvePort, savePort } from './port.ts'

export interface InitResult {
  repoRoot: string
  port: number
  files: number
  features: number
  suggestions: number
  wrote: string[]
  skipped: string[]
}

const HOOK_MATCHER = 'Edit|Write|NotebookEdit'

export async function init(repoRoot: string, requestedPort?: number): Promise<InitResult> {
  const root = path.resolve(repoRoot)
  const wrote: string[] = []
  const skipped: string[] = []

  // 프로젝트마다 다른 포트를 쓴다. 남이 잡고 있는 포트는 절대 안 고른다.
  const port = await resolvePort(root, requestedPort)
  savePort(root, port)

  const { graph, files } = await scan(root)
  const features = computeFeatures(graph)
  const suggestions = autolockCandidates(features, 3)

  // 1) rules.yaml - 처음에는 비워둔다. 잠금은 사람이 UI 에서 고른다.
  const rulesPath = path.join(root, '.codyssey', 'rules.yaml')
  fs.mkdirSync(path.dirname(rulesPath), { recursive: true })
  if (fs.existsSync(rulesPath)) {
    skipped.push(rel(root, rulesPath) + ' (이미 있음)')
  } else {
    fs.writeFileSync(rulesPath, renderRules())
    wrote.push(rel(root, rulesPath))
  }

  // 2) Claude Code 훅
  const settingsPath = path.join(root, '.claude', 'settings.json')
  const changed = mergeHooks(settingsPath, port)
  if (changed) wrote.push(rel(root, settingsPath))
  else skipped.push(rel(root, settingsPath) + ' (이미 설정됨)')

  // 3) gitignore
  if (ensureGitignore(root)) wrote.push('.gitignore')

  return {
    repoRoot: root,
    port,
    files: files.size,
    features: features.roots.length,
    suggestions: suggestions.length,
    wrote,
    skipped,
  }
}

function renderRules(): string {
  const r = defaultRules()
  return (
    `# CODYSSEY 규칙\n` +
    `#\n` +
    `# protect  여기 적힌 파일은 AI 가 못 고칩니다. (웹 화면에서 클릭으로 추가하는 걸 권장)\n` +
    `# layers   특정 폴더에서 특정 파일을 import 하지 못하게 막습니다.\n` +
    `# autolock 여러 기능이 함께 쓰는 파일을 고치려 할 때 확인을 요청합니다.\n` +
    `#            mode: off(끔) | ask(물어봄) | block(막음)\n` +
    `#\n` +
    `# 예시:\n` +
    `# protect:\n` +
    `#   - path: api/services/payment.py\n` +
    `#     reason: 결제 코어. 바꾸려면 사람 승인 필요\n` +
    `# layers:\n` +
    `#   - deny: web/components/** -> web/lib/api.ts\n` +
    `#     reason: 데이터 가져오기는 페이지에서만\n\n` +
    YAML.stringify(r)
  )
}

/** 기존 settings.json 을 건드리지 않고 우리 훅만 끼워 넣는다. */
function mergeHooks(settingsPath: string, port: number): boolean {
  let settings: Record<string, any> = {}
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    } catch {
      // 깨진 설정을 덮어쓰지 않는다. 사람이 고쳐야 한다.
      throw new Error(`${settingsPath} 를 읽을 수 없습니다. JSON 문법을 확인해 주세요.`)
    }
  }
  settings.hooks ??= {}

  let changed = false

  // 세션이 시작될 때 데몬이 꺼져 있으면 알아서 띄운다. 사용자는 아무것도 안 해도 된다.
  settings.hooks.SessionStart ??= []
  let hasStarter = false
  for (const group of settings.hooks.SessionStart) {
    for (const h of group.hooks ?? []) {
      if (typeof h.command !== 'string' || !h.command.includes('codyssey')) continue
      hasStarter = true
      const next = starterCommand(port)
      if (h.command !== next) {
        h.command = next
        changed = true
      }
    }
  }
  if (!hasStarter) {
    settings.hooks.SessionStart.push({
      hooks: [
        {
          type: 'command',
          command: starterCommand(port),
          async: true,
          timeout: 20,
          statusMessage: 'codyssey 준비 중...',
        },
      ],
    })
    changed = true
  }

  for (const [event, endpoint] of [
    ['PreToolUse', 'pre'],
    ['PostToolUse', 'post'],
  ] as const) {
    const url = `http://127.0.0.1:${port}/${endpoint}`
    settings.hooks[event] ??= []

    // 이미 우리 훅이 있으면 URL 을 현재 포트로 고쳐준다.
    // 예전에는 그냥 건너뛰어서, 포트가 바뀌어도 옛 포트를 계속 가리켰다.
    let found = false
    for (const group of settings.hooks[event]) {
      for (const h of group.hooks ?? []) {
        if (typeof h.url !== 'string' || !h.url.includes('127.0.0.1') || !h.url.endsWith('/' + endpoint)) continue
        found = true
        if (h.url !== url) {
          h.url = url
          changed = true
        }
      }
    }
    if (found) continue

    settings.hooks[event].push({
      matcher: HOOK_MATCHER,
      hooks: [{ type: 'http', url, timeout: 3 }],
    })
    changed = true
  }

  if (changed) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  }
  return changed
}

/**
 * 훅에서 실행할 명령. 개발 중에는 이 저장소의 cli.ts 를, 배포 후에는 npx 를 쓴다.
 * 어느 쪽이든 이미 떠 있으면 아무것도 안 하고 즉시 끝난다.
 */
function starterCommand(port: number): string {
  const entry = fileURLToPath(new URL('../cli.ts', import.meta.url))
  const target = '"${CLAUDE_PROJECT_DIR}"'
  return fs.existsSync(entry)
    ? `node --experimental-strip-types "${entry.split(path.sep).join('/')}" ensure --root ${target} --port ${port}`
    : `npx -y codyssey ensure --root ${target} --port ${port}`
}

function ensureGitignore(root: string): boolean {
  const p = path.join(root, '.gitignore')
  const line = '.codyssey/graph.json'
  const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
  if (cur.split(/\r?\n/).some(l => l.trim() === line)) return false
  fs.writeFileSync(p, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + `\n# codyssey (생성물)\n${line}\n`)
  return true
}

/** 데몬이 살아있나. 훅에서 쓰므로 빠르게 포기한다. */
export async function isAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(600) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * 데몬을 백그라운드로 띄우고 부모는 바로 빠진다.
 * SessionStart 훅에서 부르면 사용자가 아무것도 실행할 필요가 없다.
 */
export function spawnDaemon(repoRoot: string, port: number) {
  const entry = fileURLToPath(new URL('../cli.ts', import.meta.url))
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', entry, 'start', '--root', repoRoot, '--port', String(port), '--no-open'],
    { detached: true, stdio: 'ignore', cwd: repoRoot },
  )
  child.unref()
}

export function openBrowser(url: string) {
  const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    spawn(cmd, [url], { shell: process.platform === 'win32', detached: true, stdio: 'ignore' }).unref()
  } catch {
    /* 브라우저를 못 열어도 데몬은 돈다 */
  }
}

const rel = (root: string, p: string) => path.relative(root, p).split(path.sep).join('/')
