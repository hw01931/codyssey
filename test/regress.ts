/**
 * 외부 검증에서 발견된 문제들.
 *
 * 다른 사람이 taskodyssey 라는 별도 프로젝트를 만들어 codyssey 를 검증한 리포트에서
 * 나온 것들이다. 전부 "기능이 없다" 가 아니라 "있다고 믿었는데 안 되고 있었다" 쪽이라
 * 가드레일 도구에서는 기능 부재보다 위험하다. 하나씩 테스트로 고정한다.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Daemon } from '../src/daemon/server.ts'
import { brokenContracts } from '../src/core/contract.ts'

const NL = String.fromCharCode(10)
const PORT = 7794
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0
let fail = 0
const c = { g: (s: string) => `\x1b[32m${s}\x1b[0m`, r: (s: string) => `\x1b[31m${s}\x1b[0m`, d: (s: string) => `\x1b[2m${s}\x1b[0m` }

function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    pass++
    console.log(`  ${c.g('ok')}   ${label}`)
  } else {
    fail++
    console.log(`  ${c.r('FAIL')} ${label}${NL}         받음: ${g}${NL}         기대: ${w}`)
  }
}
function ok(label: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
    console.log(`  ${c.g('ok')}   ${label}${detail ? c.d('  ' + detail) : ''}`)
  } else {
    fail++
    console.log(`  ${c.r('FAIL')} ${label} ${detail}`)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-regress-'))
fs.cpSync('fixtures/shop', tmp, { recursive: true })
fs.rmSync(path.join(tmp, '.codyssey'), { recursive: true, force: true })
fs.rmSync(path.join(tmp, '.claude'), { recursive: true, force: true })

const daemon = new Daemon(tmp, PORT)
await daemon.start() // 감시 켜고 (설정 파일 반영을 봐야 하므로)

const post = (p: string, body: unknown) =>
  fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: (await r.json()) as any }))

const decide = (f: string) => daemon.decide('Edit', { file_path: f })

// ---------------------------------------------------------------- 1. rules.yaml 직접 편집

console.log(`${NL}[손으로 쓴 rules.yaml 이 반영되나]`)
// README 가 "직접 써도 됩니다" 라고 안내한다. 반영이 안 되면
// 잠갔다고 믿는데 실제로는 무방비인 상태가 된다.
eq('편집 전에는 안 막힌다', decide('api/services/payment.py').action, 'ask')

fs.mkdirSync(path.join(tmp, '.codyssey'), { recursive: true })
fs.writeFileSync(
  path.join(tmp, '.codyssey', 'rules.yaml'),
  [
    'version: 1',
    'protect:',
    '  - path: api/services/payment.py',
    '    reason: 손으로 적은 규칙',
    'features: []',
    'layers: []',
    'autolock: { minFeatures: 99, minModules: 99, mode: off }',
    '',
  ].join(NL),
)
await new Promise(r => setTimeout(r, 1200))

const afterEdit = decide('api/services/payment.py')
eq('파일을 쓰면 다시 시작 없이 반영된다', afterEdit.action, 'block')
ok('사유도 그대로 전달된다', String(afterEdit.reason).includes('손으로 적은 규칙'), String(afterEdit.reason))

// ---------------------------------------------------------------- 2. 잠금 API 입력 검증

console.log(`${NL}[잘못된 잠금 요청을 거른다]`)
// 검증이 없으면 path: "undefined" 가 rules.yaml 에 그대로 저장되고
// SessionStart 브리핑에 "잠긴 파일: undefined" 로 새어나간다.
eq('경로가 없으면 거절', (await post('/api/lock', { locked: true })).status, 400)
eq('없는 파일이면 거절', (await post('/api/lock', { file: 'nope/nope.ts', locked: true })).status, 400)
eq('프로젝트 밖이면 거절', (await post('/api/lock', { file: '../outside.ts', locked: true })).status, 400)
eq('없는 기능이면 거절', (await post('/api/lock-feature', { id: '없는기능', locked: true })).status, 400)

const good = await post('/api/lock', { file: 'web/lib/money.ts', locked: true, reason: '돈 계산은 함부로 못 바꿈' })
eq('정상 요청은 통과', good.status, 200)
await new Promise(r => setTimeout(r, 400))
const saved = fs.readFileSync(path.join(tmp, '.codyssey', 'rules.yaml'), 'utf8')
ok('쓰레기 값이 파일에 안 남는다', !saved.includes('undefined'), saved.includes('undefined') ? '남음' : '')
ok('한글 사유가 파일 왕복 후에도 온전하다', saved.includes('돈 계산은 함부로 못 바꿈'))

// ---------------------------------------------------------------- 7. 말이 파일에 박제되지 않는다

console.log(`${NL}[사람이 안 적은 사유는 말을 따라간다]`)
// 잠글 때 사유를 안 주면 기본 문구가 붙는데, 그걸 그대로 rules.yaml 에 저장하면
// 저장한 시점의 말로 얼어붙는다. 실제로 "App.jsx is protected. 수동 잠금" 이 나왔다.
// 사람이 적은 사유는 그대로 두어야 하지만, 우리가 만든 문구는 보여줄 때 정한다.
{
  const { setLang } = await import('../src/i18n/index.ts')
  await post('/api/lock', { file: 'web/lib/money.ts', locked: false })
  await post('/api/lock', { file: 'web/app/admin/page.tsx', locked: true }) // 사유 없이
  await new Promise(r => setTimeout(r, 400))
  const yaml = fs.readFileSync(path.join(tmp, '.codyssey', 'rules.yaml'), 'utf8')
  ok('잠금이 실제로 걸렸다', yaml.includes('web/app/admin/page.tsx'), yaml.split(NL).filter(l => l.includes('path')).join(' | '))
  ok('사유를 안 주면 파일에 문구를 안 박는다', !/수동 잠금|locked by hand/.test(yaml), yaml.split(NL).filter(l => l.includes('reason')).join(' | '))

  setLang('en')
  const en = decide('web/app/admin/page.tsx')
  ok('영어로 보면 영어로 나온다', !/[가-힣]/.test(String(en.reason)), String(en.reason))
  setLang('ko')
  const ko = decide('web/app/admin/page.tsx')
  ok('한국어로 보면 한국어로 나온다', /[가-힣]/.test(String(ko.reason)), String(ko.reason))

  await post('/api/lock', { file: 'api/services/order.py', locked: true, reason: 'Payment core' })
  await new Promise(r => setTimeout(r, 400))
  const kept = fs.readFileSync(path.join(tmp, '.codyssey', 'rules.yaml'), 'utf8')
  ok('사람이 적은 사유는 그대로 남는다', kept.includes('Payment core'))
}

// ---------------------------------------------------------------- 6. export 만 떼는 계약 파괴

console.log(`${NL}[export 만 떼어내는 것도 잡는다]`)
// 이름 존재 여부만 보면 통과해버린다. 리네임보다 오히려 흔한 사고다.
const cs = [{ name: 'renderStats', users: ['a.ts', 'b.ts'] }]
const broke = (e: { before?: string; after?: string; whole?: boolean }) => brokenContracts(cs, e).length > 0

eq('export 만 떼면 깨진 것으로 본다', broke({ before: 'export function renderStats() {}', after: 'function renderStats() {}' }), true)
eq('export 를 유지하면 통과', broke({ before: 'export function renderStats() {}', after: 'export function renderStats(x) {}' }), false)
eq('export { } 형태도 본다', broke({ before: 'export { renderStats }', after: 'const renderStats = 1' }), true)
eq('export default 도 본다', broke({ before: 'export default renderStats', after: 'const renderStats = 1' }), true)
eq('전체 재작성에서 export 가 빠지면 잡는다', broke({ after: 'function renderStats() {}', whole: true }), true)
eq('파이썬 def 는 원래 공개라 통과', broke({ before: 'def renderStats(): pass', after: 'def renderStats(x): pass' }), false)

// ---------------------------------------------------------------- 5. 지표 일치

console.log(`${NL}[CLI 와 MCP 가 같은 숫자를 말한다]`)
// 같은 이름의 지표가 표면마다 다르면 신뢰가 깎인다.
const state = daemon.state()
const cliUsers = [...daemon.graph.dependents('api/services/money.py')].filter(f => f !== 'api/services/money.py')
const mcpUsers = (() => {
  const inn = new Map<string, string[]>()
  for (const e of state.edges) inn.set(e.to, [...(inn.get(e.to) ?? []), e.from])
  const seen = new Set(['api/services/money.py'])
  const stack = ['api/services/money.py']
  while (stack.length) {
    const cur = stack.pop()!
    for (const from of inn.get(cur) ?? []) {
      if (seen.has(from)) continue
      seen.add(from)
      stack.push(from)
    }
  }
  seen.delete('api/services/money.py')
  return [...seen]
})()
eq('전이적으로 세는 값이 같다', mcpUsers.sort(), cliUsers.sort())

// ---------------------------------------------------------------- 8. 배포본 실행 경로

console.log(`${NL}[훅이 실제로 존재하는 파일을 부른다]`)
// 자기 위치를 new URL('../cli.ts', import.meta.url) 로 추측하면 번들된 배포본에서
// 없는 경로가 나온다. 그러면 데몬이 영영 안 뜨는데 에러는 하나도 안 난다.
// 개발 중에는 100% 통과하므로 여기서 고정한다.
{
  const homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-entry-'))
  fs.cpSync('fixtures/vibe', homeTmp, { recursive: true })
  fs.mkdirSync(path.join(homeTmp, '.git', 'hooks'), { recursive: true }) // git 훅을 심으려면 .git 이 있어야 한다
  const { init } = await import('../src/setup/init.ts')
  await init(homeTmp, 7795)

  const settings = JSON.parse(fs.readFileSync(path.join(homeTmp, '.claude', 'settings.json'), 'utf8'))
  const mcp = JSON.parse(fs.readFileSync(path.join(homeTmp, '.mcp.json'), 'utf8'))

  /**
   * 명령줄에서 실행될 진입 파일을 꺼낸다.
   * 테스트로 돌 때는 test/regress.ts, 배포본에서는 dist/cli.js 라 이름을 못 박으면 안 된다.
   * 확장자만 보고 고른다.
   */
  const entryOf = (argv: string[]) =>
    argv.map(a => a.replace(/"/g, '')).find(a => !a.startsWith('--') && /\.(ts|js|mjs|cjs)$/.test(a))

  const hookCmd: string = settings.hooks.SessionStart[0].hooks[0].command
  const hookEntry = entryOf(hookCmd.split(/\s+/))
  ok('SessionStart 훅이 진입 파일을 지목한다', !!hookEntry, hookCmd.slice(0, 80))
  ok(
    'SessionStart 훅이 부르는 파일이 실제로 있다',
    !!hookEntry && fs.existsSync(hookEntry.replace(/"/g, '')),
    hookEntry ?? '',
  )

  const mcpEntry = entryOf(mcp.mcpServers.codyssey.args ?? [])
  ok('MCP 가 부르는 파일이 실제로 있다', !!mcpEntry && fs.existsSync(mcpEntry.replace(/"/g, '')), mcpEntry ?? '')

  const gitHook = fs.readFileSync(path.join(homeTmp, '.git', 'hooks', 'pre-commit'), 'utf8')
  const gitEntry = entryOf(gitHook.split(/\s+/))
  ok('git 훅이 부르는 파일이 실제로 있다', !!gitEntry && fs.existsSync(gitEntry.replace(/"/g, '')), gitEntry ?? '')

  ok('경로를 추측하지 않는다', !hookCmd.includes('../cli.'), hookCmd.includes('../cli.') ? '상대경로 추측 발견' : '')

  fs.rmSync(homeTmp, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 정리

await daemon.stop()
fs.rmSync(tmp, { recursive: true, force: true })

console.log(`${NL}${fail === 0 ? c.g('통과') : c.r('실패')}  ${pass}개 성공, ${fail}개 실패${NL}`)
process.exit(fail === 0 ? 0 : 1)
