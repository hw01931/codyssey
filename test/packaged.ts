/**
 * 배포본으로 전 과정을 돌린다.
 *
 * 두 번 같은 사고가 났다. 둘 다 "개발 중에는 100% 되는데 배포본에서만 안 되는"
 * 것이었고, 둘 다 에러 하나 없이 조용히 실패했다.
 *
 *   1. spawnDaemon 이 `new URL('../cli.ts', import.meta.url)` 로 자기 위치를 추측
 *      -> 배포본에서 없는 파일을 spawn -> 데몬이 영영 안 뜸
 *   2. UI_DIR 이 같은 방식으로 계산됨
 *      -> 개발 중엔 src/ui, 배포본에선 dist/ui 인데 한쪽만 계산 -> 웹 화면 404
 *
 * 원인은 매번 "경로를 추측했다" 이고, 단위 테스트는 전부 통과했다.
 * 소스로 부르니까 추측이 우연히 맞았기 때문이다.
 *
 * 그래서 여기서는 소스를 부르지 않는다. `node dist/cli.js` 를 실제로 띄우고
 * 설치부터 차단까지 한 바퀴 돈다. 느리지만 이 한 파일이 그 두 사고를 다 잡는다.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NL = String.fromCharCode(10)
let pass = 0
let fail = 0
const c = {
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  d: (s: string) => `\x1b[2m${s}\x1b[0m`,
}
function ok(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ${c.g('ok')}   ${label}${detail ? c.d('  ' + detail) : ''}`) }
  else { fail++; console.log(`  ${c.r('FAIL')} ${label} ${detail}`) }
}

const CLI = path.resolve('dist/cli.js')

console.log(`${NL}[배포본을 만든다]`)
const built = spawnSync(process.execPath, ['build.mjs'], { encoding: 'utf8' })
ok('빌드가 성공한다', built.status === 0, built.stderr?.slice(0, 200) ?? '')
ok('dist/cli.js 가 있다', fs.existsSync(CLI))
ok('dist/ui/index.html 이 같이 들어간다', fs.existsSync(path.resolve('dist/ui/index.html')))
if (fail) { console.log(`${NL}${c.r('실패')}  빌드가 안 되면 나머지는 볼 수 없다${NL}`); process.exit(1) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-pkg-'))
fs.cpSync('fixtures/vibe', tmp, { recursive: true })
// 손으로 실험하다 남긴 설정이 fixture 에 섞여 있으면 테스트가 더러운 상태에서 시작한다.
// 실제로 그래서 이 테스트가 엉뚱한 결과를 냈다. 새로 설치하는 사람과 같은 조건을 만든다.
for (const junk of ['.codyssey', '.claude', '.mcp.json']) {
  fs.rmSync(path.join(tmp, junk), { recursive: true, force: true })
}
fs.mkdirSync(path.join(tmp, '.git', 'hooks'), { recursive: true })

/** 배포본 CLI 를 부른다. 소스는 절대 부르지 않는다 — 그게 이 테스트의 요점이다. */
const cli = (args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args, '--root', tmp], { encoding: 'utf8', timeout: 90_000 })

console.log(`${NL}[설치하면 데몬이 실제로 뜬다]`)
const out = cli(['init', '--no-open', '--lang', 'en'])
ok('init 이 끝난다', out.status === 0, out.stderr?.slice(0, 200) ?? '')
const portMatch = /127\.0\.0\.1:(\d+)/.exec(out.stdout ?? '')
ok('주소를 알려준다', !!portMatch, portMatch?.[0] ?? out.stdout?.slice(-200) ?? '')
const port = Number(portMatch?.[1])
const BASE = `http://127.0.0.1:${port}`

/** 데몬이 뜰 때까지 잠깐 기다린다. init 이 방금 spawn 했으므로 금방 온다. */
async function waitHealth(): Promise<any> {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) })
      if (r.ok) return r.json()
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  return null
}
const h = await waitHealth()
ok('데몬이 살아 있다', !!h?.ok, h ? '' : '10초 안에 안 떴다 — 배포본에서 데몬이 안 뜨는 문제')
ok('자기가 어느 프로젝트인지 안다', h?.repoRoot === fs.realpathSync(tmp) || h?.repoRoot === tmp, h?.repoRoot ?? '')

console.log(`${NL}[init 이 알려준 주소에 화면이 뜬다]`)
// 배포본에서 dist/ui 를 못 찾아 404 가 났었다. 주소를 알려주면서 404 면
// 사용자 입장에서는 그냥 고장난 도구다.
const uiRes = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) })
const uiBody = await uiRes.text()
ok('/ 가 200 을 준다', uiRes.status === 200, `HTTP ${uiRes.status}`)
ok('내용이 HTML 이다', /<html|<!doctype|<body/i.test(uiBody), uiBody.slice(0, 80))
ok('빈 껍데기가 아니다', uiBody.length > 5000, `${uiBody.length} bytes`)

console.log(`${NL}[훅이 실제로 있는 파일을 가리킨다]`)
const settings = JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf8'))
const mcp = JSON.parse(fs.readFileSync(path.join(tmp, '.mcp.json'), 'utf8'))
const entryOf = (argv: string[]) =>
  argv.map(a => a.replace(/"/g, '')).find(a => !a.startsWith('--') && /\.(ts|js|mjs|cjs)$/.test(a))

const hookEntry = entryOf((settings.hooks.SessionStart[0].hooks[0].command as string).split(/\s+/))
ok('SessionStart 훅이 dist 를 가리킨다', hookEntry === CLI, hookEntry ?? '')
ok('MCP 도 dist 를 가리킨다', entryOf(mcp.mcpServers.codyssey.args ?? []) === CLI)
const gitHook = fs.readFileSync(path.join(tmp, '.git', 'hooks', 'pre-commit'), 'utf8')
ok('git 훅도 dist 를 가리킨다', entryOf(gitHook.split(/\s+/)) === CLI)

console.log(`${NL}[잠그면 실제로 막힌다]`)
const post = (p: string, body: unknown) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  }).then(r => r.json() as Promise<any>)

await post('/api/lock', { file: 'App.jsx', locked: true, reason: 'screen code' })
await new Promise(r => setTimeout(r, 700))
const decide = (tool: string, input: unknown) =>
  post('/pre', { tool_name: tool, tool_input: input }).then(j => j.hookSpecificOutput?.permissionDecision ?? 'pass')

ok('잠긴 파일 Edit 은 막힌다', (await decide('Edit', { file_path: 'App.jsx', new_string: 'x' })) === 'deny')
ok('Bash 우회도 막힌다', (await decide('Bash', { command: 'echo hi > App.jsx' })) === 'deny')
ok('안 잠근 파일은 통과', (await decide('Edit', { file_path: 'server.py', new_string: 'x' })) === 'pass')

console.log(`${NL}[--lang 이 배포본에서도 먹는다]`)
// 카탈로그가 번들에 안 실리면 키 이름이 그대로 새어나온다.
const reason: string = (await post('/pre', { tool_name: 'Edit', tool_input: { file_path: 'App.jsx' } }))
  .hookSpecificOutput?.permissionDecisionReason ?? ''
ok('영어로 나온다', /is protected/.test(reason), reason)
ok('번역 키가 새어나오지 않는다', !/rule\.\w+/.test(reason), reason)

console.log(`${NL}[이미 설정된 프로젝트에 --lang 을 주면 먹는다]`)
// rules.yaml 이 있으면 init 이 그 파일을 건드리지 않는다. 그건 맞다 —
// 사람이 쓴 규칙을 덮으면 안 되니까. 하지만 그것 때문에 사용자가 명시한
// --lang 까지 조용히 무시되면, 시킨 대로 안 됐는데 아무 말도 안 하는 셈이다.
const again = cli(['init', '--no-open', '--lang', 'ko'])
ok('두 번째 init 도 끝난다', again.status === 0, again.stderr?.slice(0, 200) ?? '')
ok(
  'rules.yaml 의 lang 이 바뀐다',
  /^lang:\s*ko\s*$/m.test(fs.readFileSync(path.join(tmp, '.codyssey', 'rules.yaml'), 'utf8')),
  fs.readFileSync(path.join(tmp, '.codyssey', 'rules.yaml'), 'utf8').split(NL).find(l => l.startsWith('lang')) ?? '(lang 줄 없음)',
)
ok('바뀐 말이 무시된다고 조용히 넘어가지 않는다', /ko|한국어|Korean/.test(again.stdout ?? ''), (again.stdout ?? '').slice(-160))

await new Promise(r => setTimeout(r, 900)) // 설정 감시가 파일 변경을 집을 때까지
const koReason: string = (await post('/pre', { tool_name: 'Edit', tool_input: { file_path: 'App.jsx' } }))
  .hookSpecificOutput?.permissionDecisionReason ?? ''
ok('데몬도 다시 안 켜고 말을 바꾼다', /보호된 파일입니다/.test(koReason), koReason)

// -------------------------------------------------------------- 정리
await fetch(`${BASE}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {})
await new Promise(r => setTimeout(r, 500))
fs.rmSync(tmp, { recursive: true, force: true })

console.log(`${NL}${fail === 0 ? c.g('통과') : c.r('실패')}  ${pass}개 성공, ${fail}개 실패${NL}`)
process.exit(fail === 0 ? 0 : 1)
