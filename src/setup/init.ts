import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import YAML from 'yaml'
import { scan } from '../index/scan.ts'
import { computeFeatures, autolockCandidates } from '../core/features.ts'
import { defaultRules } from '../core/rules.ts'
import { resolvePort, savePort } from './port.ts'
import { resolveLang, setLang, getLang, type Lang } from '../i18n/index.ts'
import { rulesHeader, gitHookHeader } from '../i18n/template.ts'

export interface InitResult {
  repoRoot: string
  port: number
  files: number
  features: number
  suggestions: number
  wrote: string[]
  skipped: string[]
}

/**
 * Bash 가 빠지면 안 된다. 에이전트는 `sed -i`, heredoc, `python -c` 로 파일을 쓴다.
 * Edit/Write 만 걸어두면 도구를 바꾸는 것만으로 잠금이 통째로 우회된다.
 */
export const HOOK_MATCHER = 'Edit|Write|NotebookEdit|Bash'

export async function init(repoRoot: string, requestedPort?: number, requestedLang?: string): Promise<InitResult> {
  const root = path.resolve(repoRoot)
  // 쓸 말을 가장 먼저 정한다. 이 아래 모든 안내문이 여기에 따른다.
  const lang = resolveLang(root, requestedLang)
  setLang(lang)
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
    fs.writeFileSync(rulesPath, renderRules(lang))
    wrote.push(rel(root, rulesPath))
  }

  // 2) Claude Code 훅
  const settingsPath = path.join(root, '.claude', 'settings.json')
  const changed = mergeHooks(settingsPath, port)
  if (changed) wrote.push(rel(root, settingsPath))
  else skipped.push(rel(root, settingsPath) + ' (이미 설정됨)')

  // 3) MCP 서버 등록 (에이전트가 구조를 물어볼 창구)
  if (registerMcp(root, port)) wrote.push('.mcp.json')
  else skipped.push('.mcp.json (이미 있음)')

  // 4) 커밋할 때 구조도를 자동 갱신하는 git 훅
  const hookMsg = installGitHook(root)
  if (hookMsg === 'wrote') wrote.push('.git/hooks/pre-commit')
  else if (hookMsg) skipped.push(`.git/hooks/pre-commit (${hookMsg})`)

  // 5) gitignore
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

function renderRules(lang: Lang): string {
  // lang 을 파일에 적어둔다. 그래야 다음부터 환경과 무관하게 같은 말로 나온다.
  return rulesHeader(lang) + YAML.stringify({ lang, ...defaultRules() })
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
      // 대소문자를 가리면 안 된다. 개발 모드에서는 명령에 저장소 경로가 그대로 들어가는데
      // 그 경로가 대문자면(D:/workspace/CODYSSEY) 매번 '없다' 고 판정해서 훅이 중복 추가됐다.
      if (typeof h.command !== 'string' || !isStarter(h.command)) continue
      if (hasStarter) {
        // 이미 예전 버그로 중복된 게 있으면 표시해뒀다가 아래에서 걷어낸다
        h.__dup = true
        changed = true
        continue
      }
      hasStarter = true
      const next = starterCommand(port)
      if (h.command !== next) {
        h.command = next
        changed = true
      }
    }
  }
  if (hasStarter) {
    settings.hooks.SessionStart = settings.hooks.SessionStart
      .map((g: any) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !h.__dup) }))
      .filter((g: any) => g.hooks.length)
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
    ['SessionStart', 'session'],
    ['UserPromptSubmit', 'prompt'],
  ] as const) {
    const url = `http://127.0.0.1:${port}/${endpoint}`
    settings.hooks[event] ??= []

    const isToolEvent = event === 'PreToolUse' || event === 'PostToolUse'

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
        // matcher 도 갱신한다. 예전 설치본은 Bash 가 빠진 matcher 를 그대로 들고 있어서,
        // 다시 init 을 돌려도 셸 우회가 계속 열려 있었다.
        if (isToolEvent && group.matcher !== HOOK_MATCHER) {
          group.matcher = HOOK_MATCHER
          changed = true
        }
      }
    }
    if (found) continue

    settings.hooks[event].push({
      ...(isToolEvent ? { matcher: HOOK_MATCHER } : {}),
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

/** 우리가 심은 데몬 기동 훅인가. 경로 대소문자에 걸리면 안 된다. */
const isStarter = (cmd: string) => /codyssey/i.test(cmd) && /\bensure\b/.test(cmd)

/**
 * 지금 돌고 있는 CLI 의 실제 경로.
 *
 * `new URL('../cli.ts', import.meta.url)` 로 추측하면 안 된다. 번들된 배포본에서는
 * `dist/cli.js` 가 실행되는데 그 계산은 없는 경로(`../cli.ts`)를 가리킨다.
 * 그래서 배포본에서 데몬이 영영 안 떴고, SessionStart 훅도 무력이었다.
 * 실행 중인 파일을 그대로 쓰는 게 유일하게 안전하다.
 */
function selfEntry(): { path: string; isSource: boolean } | null {
  const p = process.argv[1]
  if (!p || !fs.existsSync(p)) return null
  return { path: path.resolve(p), isSource: p.endsWith('.ts') }
}

/** 실행 명령을 만든다. 소스면 타입 스트립 플래그가 필요하고, 번들이면 그냥 실행한다. */
function selfCommand(args: string[]): { command: string; args: string[] } {
  const self = selfEntry()
  if (!self) return { command: 'npx', args: ['-y', 'codyssey', ...args] }
  return {
    command: process.execPath,
    args: self.isSource ? ['--experimental-strip-types', self.path, ...args] : [self.path, ...args],
  }
}

const quoted = (s: string) => (/[\s"]/.test(s) ? `"${s.split(path.sep).join('/')}"` : s)

/**
 * 훅에서 실행할 명령. 지금 돌고 있는 CLI 를 그대로 다시 부른다.
 * 이미 떠 있으면 아무것도 안 하고 즉시 끝난다.
 */
function starterCommand(port: number): string {
  const target = '"${CLAUDE_PROJECT_DIR}"'
  const { command, args } = selfCommand(['ensure', '--root', '__TARGET__', '--port', String(port)])
  return [quoted(command), ...args.map(a => (a === '__TARGET__' ? target : quoted(a)))].join(' ')
}

/** Claude Code 가 읽는 프로젝트 MCP 설정. 기존 서버는 건드리지 않는다. */
function registerMcp(root: string, port: number): boolean {
  const p = path.join(root, '.mcp.json')
  let cfg: Record<string, any> = {}
  if (fs.existsSync(p)) {
    try {
      cfg = JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch {
      return false // 남의 설정을 덮어쓰지 않는다
    }
  }
  cfg.mcpServers ??= {}
  const entry = mcpEntry(port)
  if (JSON.stringify(cfg.mcpServers.codyssey) === JSON.stringify(entry)) return false
  cfg.mcpServers.codyssey = entry
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n')
  return true
}

function mcpEntry(port: number) {
  return selfCommand(['mcp', '--port', String(port)])
}

/**
 * 커밋할 때마다 .codyssey/ARCHITECTURE.md 를 다시 만들어 같이 커밋한다.
 * 그러면 GitHub 에서 아무것도 안 띄우고 최신 구조도를 볼 수 있다.
 *
 * 이미 pre-commit 훅이 있으면 절대 덮어쓰지 않는다. 남의 훅을 날리면 안 된다.
 */
function installGitHook(root: string): 'wrote' | string | null {
  const dir = path.join(root, '.git', 'hooks')
  if (!fs.existsSync(path.join(root, '.git'))) return null
  const p = path.join(dir, 'pre-commit')
  if (fs.existsSync(p)) {
    const cur = fs.readFileSync(p, 'utf8')
    return cur.includes('codyssey') ? '이미 설정됨' : '이미 다른 훅이 있음'
  }
  const { command, args } = selfCommand(['scan'])
  const cmd = [quoted(command), ...args.map(quoted)].join(' ')
  const script = [
    '#!/bin/sh',
    ...gitHookHeader(getLang()),
    `${cmd} >/dev/null 2>&1 || exit 0`,
    'git add .codyssey/ARCHITECTURE.md 2>/dev/null || true',
    '',
  ].join('\n')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(p, script, { mode: 0o755 })
  return 'wrote'
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
  const { command, args } = selfCommand(['start', '--root', repoRoot, '--port', String(port), '--no-open'])
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    cwd: repoRoot,
    shell: command === 'npx',
  })
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
