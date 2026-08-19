/**
 * 데몬을 실제로 띄우고 훅을 그대로 때려서 검증한다.
 * 픽스처를 임시 폴더로 복사해서 돌리므로 몇 번을 돌려도 같은 결과가 나온다.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Daemon } from '../src/daemon/server.ts'
import { projectPort, samePath } from '../src/setup/port.ts'

const PORT = 7788
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
    console.log(`  ${c.r('FAIL')} ${label}\n         받음: ${g}\n         기대: ${w}`)
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

// ---------------------------------------------------------------- 준비

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-e2e-'))
fs.cpSync('fixtures/shop', tmp, { recursive: true })
fs.rmSync(path.join(tmp, '.codyssey'), { recursive: true, force: true })
fs.rmSync(path.join(tmp, '.claude'), { recursive: true, force: true })

const daemon = new Daemon(tmp, PORT)
await daemon.start({ watch: false })

const pre = (file: string, added = '', tool = 'Edit') =>
  fetch(`${BASE}/pre`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool_name: tool, tool_input: { file_path: file, new_string: added } }),
  }).then(r => r.json() as Promise<any>)

const decision = (r: any) => r?.hookSpecificOutput?.permissionDecision ?? 'allow'
const reason = (r: any) => r?.hookSpecificOutput?.permissionDecisionReason ?? ''

const setRules = (yaml: string) => {
  fs.mkdirSync(path.join(tmp, '.codyssey'), { recursive: true })
  fs.writeFileSync(path.join(tmp, '.codyssey', 'rules.yaml'), yaml)
  daemon.loadRules()
}

console.log(`\n${c.d('임시 폴더: ' + tmp)}`)

// ---------------------------------------------------------------- 기본

console.log('\n[데몬]')
const health = (await (await fetch(`${BASE}/health`)).json()) as any
eq('살아있고 파일을 읽었다', { ok: health.ok, files: health.files }, { ok: true, files: 19 })
ok('웹 화면이 뜬다', (await (await fetch(`${BASE}/`)).text()).includes('CODYSSEY'))

// ---------------------------------------------------------------- 통과해야 하는 것

console.log('\n[통과해야 하는 편집]')
setRules('version: 1\nprotect: []\nlayers: []\nautolock: { minFeatures: 3, mode: off }\n')
eq('기능 하나만 쓰는 파일', decision(await pre('web/components/PriceRow.tsx', 'const x = 1')), 'allow')
eq('그래프에 없는 파일', decision(await pre('README.md', 'hello')), 'allow')
eq('빈 응답이라 컨텍스트 0토큰', await pre('web/components/PriceRow.tsx'), {})

// ---------------------------------------------------------------- 명시적 잠금

console.log('\n[명시적 잠금]')
setRules(`version: 1
protect:
  - path: api/services/payment.py
    reason: 결제 코어. 사람 승인 필요
layers: []
autolock: { minFeatures: 3, mode: off }
`)
const locked = await pre('api/services/payment.py', 'def charge(): pass')
eq('잠긴 파일은 차단', decision(locked), 'deny')
ok('한글 사유가 안 깨진다', reason(locked).includes('결제 코어. 사람 승인 필요'), reason(locked))
eq('다른 파일은 여전히 통과', decision(await pre('api/services/order.py')), 'allow')

console.log('\n[잠금 글롭]')
setRules('version: 1\nprotect:\n  - path: api/services/**\n    reason: 서비스 계층 보호\nlayers: []\nautolock: { minFeatures: 3, mode: off }\n')
eq('폴더 패턴으로 잠금', decision(await pre('api/services/money.py')), 'deny')
eq('패턴 밖은 통과', decision(await pre('api/routes/orders.py')), 'allow')

// ---------------------------------------------------------------- 레이어 규칙

console.log('\n[레이어 규칙]')
setRules(`version: 1
protect: []
layers:
  - deny: web/components/** -> web/lib/api.ts
    reason: 데이터 가져오기는 페이지에서만
autolock: { minFeatures: 3, mode: off }
`)
const layer = await pre('web/components/OrderTable.tsx', "import { fetchOrders } from '@/lib/api'")
eq('금지된 import 를 추가하면 차단', decision(layer), 'deny')
ok('사유가 규칙 그대로', reason(layer).includes('데이터 가져오기는 페이지에서만'))
eq('허용된 import 는 통과', decision(await pre('web/components/OrderTable.tsx', "import { formatMoney } from '@/lib/money'")), 'allow')
eq('같은 import 라도 페이지에서는 통과', decision(await pre('web/app/orders/page.tsx', "import { fetchOrders } from '@/lib/api'")), 'allow')

// ---------------------------------------------------------------- 자동 잠금

console.log('\n[자동 잠금]')
setRules('version: 1\nprotect: []\nlayers: []\nautolock: { minFeatures: 3, mode: ask }\n')
const shared = await pre('web/lib/money.ts', 'export const x = 1')
eq('공유 파일은 확인 요청', decision(shared), 'escalate')
ok('몇 개 기능이 쓰는지 알려준다', reason(shared).includes('기능 3개'), reason(shared))
eq('단일 기능 파일은 그대로 통과', decision(await pre('web/components/PriceRow.tsx')), 'allow')

setRules('version: 1\nprotect: []\nlayers: []\nautolock: { minFeatures: 3, mode: block }\n')
eq('block 모드면 차단', decision(await pre('web/lib/money.ts')), 'deny')

// ---------------------------------------------------------------- 모듈 기반 자동 잠금

console.log('\n[모듈 기반 자동 잠금]')
// 진입점이 없는 프로젝트에서도 신호가 나와야 한다. 여기가 라이브러리/CLI 를 살리는 부분.
setRules(`version: 1
protect: []
features: []
layers: []
autolock: { minFeatures: 99, minModules: 2, mode: block }
`)
const byModule = await pre('api/services/money.py')
eq('여러 모듈이 쓰는 파일은 차단', decision(byModule), 'deny')
ok('모듈 개수를 알려준다', /모듈 \d+곳/.test(reason(byModule)), reason(byModule))
eq('한 모듈만 쓰는 파일은 통과', decision(await pre('web/components/PriceRow.tsx')), 'allow')

setRules(`version: 1
protect: []
features: []
layers: []
autolock: { minFeatures: 99, minModules: 99, mode: block }
`)
eq('기준을 올리면 아무것도 안 막는다', decision(await pre('api/services/money.py')), 'allow')

// ---------------------------------------------------------------- 안전장치 (P4/P5)

console.log('\n[안전장치]')
setRules('this: is: not: valid: yaml: [[[\n')
eq('룰 파일이 깨져도 아무것도 안 막는다', decision(await pre('api/services/payment.py')), 'allow')

setRules('version: 1\nprotect: []\nlayers: []\nautolock: { minFeatures: 3, mode: block }\n')
const bad = await fetch(`${BASE}/pre`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{{{ 망가진 JSON',
}).then(r => r.json())
eq('요청이 망가져도 통과', decision(bad), 'allow')
eq('경로가 없어도 통과', decision(await pre('')), 'allow')

// ---------------------------------------------------------------- 잠금 편집 API

console.log('\n[웹 화면에서 잠그기]')
setRules('version: 1\nprotect: []\nlayers: []\nautolock: { minFeatures: 3, mode: off }\n')
await fetch(`${BASE}/api/lock`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ file: 'web/lib/money.ts', locked: true, reason: '돈 계산은 함부로 못 바꿈' }),
})
const afterLock = await pre('web/lib/money.ts')
eq('클릭 한 번으로 잠긴다', decision(afterLock), 'deny')
ok('한글 사유가 파일까지 왕복해도 안 깨진다', reason(afterLock).includes('돈 계산은 함부로 못 바꿈'), reason(afterLock))
ok(
  'rules.yaml 에 실제로 기록된다',
  fs.readFileSync(path.join(tmp, '.codyssey', 'rules.yaml'), 'utf8').includes('돈 계산은 함부로 못 바꿈'),
)

await fetch(`${BASE}/api/lock`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ file: 'web/lib/money.ts', locked: false }),
})
eq('해제도 된다', decision(await pre('web/lib/money.ts')), 'allow')

// ---------------------------------------------------------------- 기능 단위 잠금

console.log('\n[기능 단위 잠금]')
setRules(`version: 1
protect: []
features: []
layers: []
autolock: { minFeatures: 3, mode: off }
`)
await fetch(`${BASE}/api/lock-feature`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'PAGE /checkout', locked: true, scope: 'exclusive', reason: '결제 흐름 동결' }),
})
eq('그 기능 전용 파일은 차단', decision(await pre('web/components/CartSummary.tsx')), 'deny')
eq('그 기능 전용 라우트도 차단', decision(await pre('api/routes/payments.py')), 'deny')
ok('사유가 전달된다', reason(await pre('api/routes/payments.py')).includes('결제 흐름 동결'))
eq('공유 파일은 안 막는다 (exclusive)', decision(await pre('web/lib/money.ts')), 'allow')
eq('다른 기능 파일은 안 막는다', decision(await pre('web/components/OrderTable.tsx')), 'allow')

await fetch(`${BASE}/api/lock-feature`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'PAGE /checkout', locked: true, scope: 'all' }),
})
eq('scope: all 이면 공유 파일까지 막는다', decision(await pre('web/lib/money.ts')), 'deny')
eq('그래도 무관한 기능은 통과', decision(await pre('web/app/orders/page.tsx')), 'allow')

await fetch(`${BASE}/api/lock-feature`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'PAGE /checkout', locked: false }),
})
eq('기능 잠금 해제', decision(await pre('web/components/CartSummary.tsx')), 'allow')

// ---------------------------------------------------------------- 화면에 뿌릴 상태

console.log('\n[웹 화면 데이터]')
const state = await (await fetch(`${BASE}/api/state`)).json()
eq('기능 4개', state.counts.features, 4)
ok('노드마다 소속 기능이 붙어있다', state.nodes.find((n: any) => n.id === 'web/lib/money.ts')?.features.length === 3)
ok('프론트->백엔드 연결이 보인다', state.edges.filter((e: any) => e.kind === 'http').length === 3)
ok('잠금 제안이 나온다', state.suggestions.length > 0, `${state.suggestions.length}건`)
ok(
  '기능마다 전용 파일 수가 붙어있다',
  state.features.find((f: any) => f.id === 'PAGE /checkout')?.exclusive === 4,
  `checkout=${state.features.find((f: any) => f.id === 'PAGE /checkout')?.exclusive}`,
)

// ---------------------------------------------------------------- 컨텍스트 주입

console.log('\n[AI 에게 미리 알려주기]')
setRules(`version: 1
protect:
  - path: api/services/payment.py
    reason: 결제 코어
features: []
layers: []
autolock: { minFeatures: 3, minModules: 3, mode: ask }
`)
const hook = (p: string, body: unknown) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json() as Promise<any>)
const ctx = (r: any) => r?.hookSpecificOutput?.additionalContext ?? ''

const firstLineOf = (s: string) => s.split(String.fromCharCode(10))[1] ?? ''

const brief = ctx(await hook('/session', { session_id: 'a' }))
ok('세션 시작에 기능 목록을 넣는다', brief.includes('기능 4개'), firstLineOf(brief))
ok('잠긴 파일을 알려준다', brief.includes('api/services/payment.py'))
ok('짧다 (600자 미만)', brief.length < 600, `${brief.length}자`)

eq('관련 없는 프롬프트에는 아무것도 안 넣는다', ctx(await hook('/prompt', { session_id: 'a', prompt: '오늘 날씨 어때' })), '')
const p1 = ctx(await hook('/prompt', { session_id: 'a', prompt: 'payment.py 에 환불 추가해' }))
ok('언급된 파일의 영향 범위를 넣는다', p1.includes('api/services/payment.py') && p1.includes('영향 기능'), firstLineOf(p1))
eq('같은 이야기를 두 번 넣지 않는다', ctx(await hook('/prompt', { session_id: 'a', prompt: 'payment.py 에 환불 추가해' })), '')

// 편집 뒤 연결 변화만 알린다
const NL = String.fromCharCode(10)
const badge = path.join(tmp, 'web/components/Badge2.tsx')
fs.writeFileSync(badge, `export function Badge2(){ return null }${NL}`)
await daemon.reindex('web/components/Badge2.tsx')
fs.writeFileSync(badge, `import { formatMoney } from '@/lib/money'${NL}export function Badge2(){ return formatMoney(1) }${NL}`)
const delta = ctx(await hook('/post', { tool_name: 'Edit', tool_input: { file_path: 'web/components/Badge2.tsx' } }))
ok('새 연결이 생기면 알려준다', delta.includes('web/lib/money.ts'), delta.split(NL).join(' '))
eq('연결이 안 바뀌면 침묵', ctx(await hook('/post', { tool_name: 'Edit', tool_input: { file_path: 'web/components/Badge2.tsx' } })), '')
fs.rmSync(badge)
await daemon.reindex('web/components/Badge2.tsx')

// ---------------------------------------------------------------- 포트 충돌 (실제로 당한 버그)

console.log('\n[포트 충돌 방어]')
const h2 = (await (await fetch(`${BASE}/health`)).json()) as any
ok('health 가 어느 폴더인지 알려준다', samePath(h2.repoRoot, tmp), h2.repoRoot)
ok('프로젝트마다 포트가 다르다', projectPort(tmp) !== projectPort(path.join(tmp, 'web')))
ok('같은 폴더면 항상 같은 포트', projectPort(tmp) === projectPort(tmp))

setRules(`version: 1
protect:
  - path: api/services/payment.py
    reason: 잠김
features: []
layers: []
autolock: { minFeatures: 3, mode: block }
`)
const outsideBefore = (await (await fetch(`${BASE}/api/state`)).json()).foreign
const outside = await pre(path.join(tmp, '..', 'somewhere-else', 'app.ts'))
eq('내 폴더 밖 파일은 통과시킨다 (P5)', decision(outside), 'allow')
const outsideAfter = (await (await fetch(`${BASE}/api/state`)).json()) as any
ok('대신 눈에 보이게 센다', outsideAfter.foreign > outsideBefore, `foreign=${outsideAfter.foreign}`)
ok(
  '활동 기록에도 남는다',
  outsideAfter.activity.some((a: any) => a.action === 'foreign'),
)

// ---------------------------------------------------------------- 증분 갱신

console.log('\n[파일이 바뀌면]')
const newFile = path.join(tmp, 'web/components/Badge.tsx')
fs.writeFileSync(newFile, "import { formatMoney } from '@/lib/money'\nexport function Badge(){ return null }\n")
await daemon.reindex('web/components/Badge.tsx')
ok('새 파일이 그래프에 들어온다', daemon.graph.nodes.has('web/components/Badge.tsx'))
ok(
  '새 파일의 의존도 잡힌다',
  daemon.graph.out('web/components/Badge.tsx').some(e => e.to === 'web/lib/money.ts'),
)
fs.rmSync(newFile)
await daemon.reindex('web/components/Badge.tsx')
ok('지우면 빠진다', !daemon.graph.nodes.has('web/components/Badge.tsx'))

// ---------------------------------------------------------------- 속도

console.log('\n[속도]')
setRules('version: 1\nprotect:\n  - path: api/services/payment.py\nlayers: []\nautolock: { minFeatures: 3, mode: ask }\n')
const N = 300
const t0 = performance.now()
for (let i = 0; i < N; i++) daemon.decide('Edit', { file_path: 'api/services/payment.py' })
const perCall = (performance.now() - t0) / N
ok('판정 자체는 0.1ms 미만', perCall < 0.1, `${perCall.toFixed(4)}ms/건`)

const t1 = performance.now()
for (let i = 0; i < 50; i++) await pre('api/services/payment.py')
const perHttp = (performance.now() - t1) / 50
ok('HTTP 왕복까지 5ms 미만', perHttp < 5, `${perHttp.toFixed(2)}ms/건`)

const t2 = performance.now()
await daemon.reindex('web/lib/money.ts')
ok('파일 하나 재인덱싱 50ms 미만', performance.now() - t2 < 50, `${(performance.now() - t2).toFixed(1)}ms`)

// ---------------------------------------------------------------- 정리

await daemon.stop()
fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n${fail === 0 ? c.g('통과') : c.r('실패')}  ${pass}개 성공, ${fail}개 실패\n`)
process.exit(fail === 0 ? 0 : 1)
