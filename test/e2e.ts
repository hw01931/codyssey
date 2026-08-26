/**
 * 데몬을 실제로 띄우고 훅을 그대로 때려서 검증한다.
 * 픽스처를 임시 폴더로 복사해서 돌리므로 몇 번을 돌려도 같은 결과가 나온다.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Daemon } from '../src/daemon/server.ts'
import { projectPort, samePath } from '../src/setup/port.ts'
import { init } from '../src/setup/init.ts'
import { setLang } from '../src/i18n/index.ts'

// 이 테스트는 한국어 문장을 직접 확인한다. 기본값은 영어이므로 명시한다.
// 말에 따라 결과가 달라지는 것 자체가 검사 대상이 아니다.
setLang('ko')

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

/** Bash 훅. 파일 인자가 없고 명령문만 온다 - 데몬이 직접 대상을 뽑아내야 한다. */
const bash = (command: string) =>
  fetch(`${BASE}/pre`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
  }).then(r => r.json() as Promise<any>)

const daemonState = () => fetch(`${BASE}/api/state`).then(r => r.json() as Promise<any>)

const decision = (r: any) => r?.hookSpecificOutput?.permissionDecision ?? 'allow'
const reason = (r: any) => r?.hookSpecificOutput?.permissionDecisionReason ?? ''
const ctxOf = (r: any) => r?.hookSpecificOutput?.additionalContext ?? ''

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
// 코드를 모르는 사람이 읽는다. 'PAGE /admin' 이 아니라 '관리자 화면' 이어야 한다.
ok('어느 화면이 같이 바뀌는지 사람 말로 알려준다', reason(shared).includes('관리자 화면'), reason(shared))
ok('무엇을 할 수 있는지도 말해준다', ctxOf(shared).includes('잠금 풀어줘'), ctxOf(shared).split(String.fromCharCode(10))[0])
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
ok('몇 곳이 함께 쓰는지 알려준다', /\d+곳에서 함께 씁니다/.test(reason(byModule)), reason(byModule))
eq('한 모듈만 쓰는 파일은 통과', decision(await pre('web/components/PriceRow.tsx')), 'allow')

setRules(`version: 1
protect: []
features: []
layers: []
autolock: { minFeatures: 99, minModules: 99, mode: block }
`)
eq('기준을 올리면 아무것도 안 막는다', decision(await pre('api/services/money.py')), 'allow')

// ---------------------------------------------------------------- Bash 우회

// 이 절이 제품의 핵심 주장을 지킨다. Edit/Write 만 막던 시절에는
// `sed -i` 한 줄로 잠긴 파일이 조용히 덮어써졌고 활동 기록에도 안 남았다.
console.log('\n[Bash 로 우회하기]')
setRules(`version: 1
protect:
  - path: api/services/payment.py
    reason: 결제 코어. 사람 승인 필요
features: []
layers: []
autolock: { minFeatures: 99, minModules: 99, mode: off }
`)

eq('sed -i 로 못 고친다', decision(await bash(`sed -i 's/a/b/' api/services/payment.py`)), 'deny')
eq('heredoc 으로 못 덮어쓴다', decision(await bash(`cat > api/services/payment.py <<'EOF'\nx = 1\nEOF`)), 'deny')
eq('>> 로 못 덧붙인다', decision(await bash('echo x >> api/services/payment.py')), 'deny')
eq('tee 로 못 쓴다', decision(await bash('echo x | tee api/services/payment.py')), 'deny')
eq('mv 로 못 치운다', decision(await bash('mv api/services/payment.py /tmp/bak.py')), 'deny')
eq('rm 으로 못 지운다', decision(await bash('rm -f api/services/payment.py')), 'deny')
eq('cp 로 못 덮어쓴다', decision(await bash('cp /tmp/x.py api/services/payment.py')), 'deny')
eq('절대경로로 와도 막는다', decision(await bash(`sed -i s/a/b/ "${tmp.split(path.sep).join('/')}/api/services/payment.py"`)), 'deny')
eq('bash -c 안에 숨겨도 막는다', decision(await bash(`bash -c "sed -i s/a/b/ api/services/payment.py"`)), 'deny')
eq('글롭으로 뭉뚱그려도 막는다', decision(await bash('rm -f api/services/*.py')), 'deny')

const opaque = await bash(`python -c "open('api/services/payment.py','w').write('')"`)
eq('해석 못 하는 명령도 잠긴 파일이 보이면 막는다', decision(opaque), 'deny')
ok('왜 막았는지 말해준다', reason(opaque).includes('api/services/payment.py'), reason(opaque))
eq('git checkout 도 막는다', decision(await bash('git checkout -- api/services/payment.py')), 'deny')

ok('활동 기록에 남는다', (await daemonState()).activity.some((a: any) => a.tool === 'Bash' && a.action === 'block'))

// ---------------------------------------------------------------- 파일 안
console.log(String.fromCharCode(10) + '[파일 안에 뭐가 들어 있나]')
// 한 파일에 몰아넣은 프로젝트에서는 '파일' 이 단위로 쓸모가 없다.
// 어디가 비대한지, 그 안에 뭐가 있는지는 심볼 단위로 봐야 보인다.
// 전부 /api/state 에 실으면 큰 레포에서 응답이 무거워지므로 따로 뗀다.
{
  const inside = (f: string) =>
    fetch(`${BASE}/api/file?path=${encodeURIComponent(f)}`).then(async r => ({ status: r.status, body: (await r.json()) as any }))

  const got = await inside('api/services/payment.py')
  eq('200 을 준다', got.status, 200)
  ok('줄 수를 준다', got.body.lines > 0, String(got.body.lines))
  ok('심볼 목록을 준다', Array.isArray(got.body.symbols) && got.body.symbols.length > 0, JSON.stringify(got.body.symbols?.slice(0, 2)))
  ok(
    '심볼마다 줄 범위가 있다',
    got.body.symbols.every((x: any) => x.line > 0 && (x.endLine ?? x.line) >= x.line),
    JSON.stringify(got.body.symbols[0]),
  )
  ok('큰 것부터 준다', got.body.symbols.every((x: any, i: number, a: any[]) => i === 0 || size(a[i - 1]) >= size(x)))

  eq('없는 파일은 404', (await inside('nope/nope.ts')).status, 404)
  eq('프로젝트 밖은 404', (await inside('../outside.ts')).status, 404)
  eq('경로가 없으면 400', (await fetch(`${BASE}/api/file`)).status, 400)
}

function size(x: any) {
  return (x.endLine ?? x.line) - x.line
}

// 여기부터가 반대쪽이다. 셸을 통째로 막으면 하루 만에 제거당한다. (D9)
console.log('\n[Bash 는 필요 이상으로 막지 않는다]')
eq('읽기는 통과', decision(await bash('cat api/services/payment.py')), 'allow')
eq('grep 은 통과', decision(await bash('grep -rn charge api/')), 'allow')
eq('sed -n (출력 전용) 은 통과', decision(await bash(`sed -n '1,20p' api/services/payment.py`)), 'allow')
eq('git status 는 통과', decision(await bash('git status --short')), 'allow')

// 아래 셋은 이 도구를 만들다가 실제로 막혔던 명령이다. 전부 읽기만 한다.
// 잠긴 파일 이름이 명령문 어딘가에 보이기만 하면 막던 규칙에 걸렸다.
// 읽기 전용까지 막으면 사람이 도구를 끈다. 그게 D9 에서 걱정한 실패다.
eq(
  '잠긴 파일을 grep 하는 건 통과',
  decision(await bash('grep -n charge api/services/payment.py')),
  'allow',
)
eq(
  '잠긴 파일이 든 폴더를 훑는 것도 통과',
  decision(await bash('grep -rn charge api/ --include=*.py')),
  'allow',
)
eq(
  '해석 못 하는 명령과 같이 있어도, 읽기 쪽 인자는 근거가 안 된다',
  decision(await bash('python build.py; grep -n charge api/services/payment.py')),
  'allow',
)
eq('여러 줄로 이어져도 마찬가지', decision(await bash([
  'node scripts/gen.js',
  'head -20 api/services/payment.py',
].join(String.fromCharCode(10)))), 'allow')

// 그래도 진짜로 쓸 수 있는 쪽은 계속 막아야 한다.
eq(
  '해석 못 하는 명령이 그 파일을 직접 들고 있으면 막는다',
  decision(await bash(`python -c "open('api/services/payment.py','a')"`)),
  'deny',
)
eq(
  '한 줄 안에서 읽고 나서 쓰면 막는다',
  decision(await bash('cat api/services/payment.py | python patch.py > api/services/payment.py')),
  'deny',
)

// 읽기 전용 목록에 잘못 넣으면 그때부터 잠금이 무력해진다.
// '읽는 것처럼 생겼는데 쓰는' 것들을 일부러 넣어본다.
eq('echo 리다이렉션은 여전히 막힌다', decision(await bash('echo x > api/services/payment.py')), 'deny')
eq('echo 이어쓰기도 막힌다', decision(await bash('echo x >> api/services/payment.py')), 'deny')
eq('sort -o 는 파일을 쓴다', decision(await bash('sort -o api/services/payment.py api/services/payment.py')), 'deny')
eq('yq -i 는 제자리 편집이다', decision(await bash('yq -i .a=1 api/services/payment.py')), 'deny')
eq('grep 결과를 잠긴 파일로 흘려도 막힌다', decision(await bash('grep -n x api/main.py > api/services/payment.py')), 'deny')
eq('env 뒤에 숨겨도 막힌다', decision(await bash('env sed -i s/a/b/ api/services/payment.py')), 'deny')
eq('cat 으로 덮어써도 막힌다', decision(await bash('cat /tmp/x > api/services/payment.py')), 'deny')
eq('테스트 실행은 통과', decision(await bash('npm test -- --watch=false')), 'allow')
eq('빌드 산출물 리다이렉션은 통과', decision(await bash('node build.mjs > dist/out.txt')), 'allow')
eq('잠기지 않은 파일은 통과', decision(await bash(`sed -i 's/a/b/' api/services/order.py`)), 'allow')
eq('빈 명령은 통과', decision(await bash('')), 'allow')

// 잠금은 글롭이다. 아직 그래프에 없는 새 파일도 패턴에 걸리면 막아야 한다.
console.log('\n[아직 그래프에 없는 파일]')
setRules('version: 1\nprotect:\n  - path: api/services/**\n    reason: 서비스 계층 보호\nfeatures: []\nlayers: []\nautolock: { minFeatures: 99, minModules: 99, mode: off }\n')
eq('패턴 안의 새 파일도 막는다 (Bash)', decision(await bash('echo x > api/services/brand_new.py')), 'deny')
eq('패턴 안의 새 파일도 막는다 (Write)', decision(await pre('api/services/brand_new.py', 'x = 1', 'Write')), 'deny')
eq('패턴 밖의 새 파일은 통과', decision(await bash('echo x > api/routes/brand_new.py')), 'allow')

// 자동 잠금과 레이어 규칙도 Bash 에 그대로 걸려야 한다
console.log('\n[Bash 에도 나머지 규칙이 걸린다]')
setRules('version: 1\nprotect: []\nfeatures: []\nlayers: []\nautolock: { minFeatures: 3, mode: ask }\n')
eq('공유 파일은 Bash 에서도 확인 요청', decision(await bash(`sed -i 's/a/b/' web/lib/money.ts`)), 'escalate')

setRules(`version: 1
protect: []
features: []
layers:
  - deny: web/components/** -> web/lib/api.ts
    reason: 데이터 가져오기는 페이지에서만
autolock: { minFeatures: 99, minModules: 99, mode: off }
`)
eq(
  'heredoc 으로 몰래 넣는 import 도 잡는다',
  decision(await bash(`cat > web/components/Sneaky.tsx <<'EOF'\nimport { fetchOrders } from '@/lib/api'\nEOF`)),
  'deny',
)

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

// ---------------------------------------------------------------- init

// 설치가 잘못되면 데몬이 아무리 정확해도 호출조차 안 된다. D17 이 그 사고였다.
console.log('\n[설치가 실제로 막을 수 있는 상태인가]')
{
  const itmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-init-'))
  fs.cpSync('fixtures/shop', itmp, { recursive: true })
  fs.rmSync(path.join(itmp, '.claude'), { recursive: true, force: true })

  await init(itmp, PORT + 2)
  const read = () => JSON.parse(fs.readFileSync(path.join(itmp, '.claude', 'settings.json'), 'utf8'))
  const matchers = (s: any) =>
    ['PreToolUse', 'PostToolUse'].flatMap((ev: string) => (s.hooks[ev] ?? []).map((g: any) => g.matcher))

  ok('Bash 가 matcher 에 들어간다', matchers(read()).every((m: string) => /(^|\|)Bash(\||$)/.test(m)), matchers(read()).join(', '))

  // 예전 설치본을 흉내낸다. 다시 init 을 돌리면 스스로 고쳐져야 한다.
  const old = read()
  for (const ev of ['PreToolUse', 'PostToolUse']) for (const g of old.hooks[ev]) g.matcher = 'Edit|Write|NotebookEdit'
  fs.writeFileSync(path.join(itmp, '.claude', 'settings.json'), JSON.stringify(old, null, 2))
  await init(itmp, PORT + 2)
  ok('예전 설치본도 다시 init 하면 고쳐진다', matchers(read()).every((m: string) => /(^|\|)Bash(\||$)/.test(m)))

  // 개발 모드에서는 명령에 저장소 경로가 들어간다. 그 경로가 대문자면 예전에는
  // '아직 없다' 고 판정해서 훅이 매번 하나씩 늘었다.
  const before = JSON.stringify(read())
  await init(itmp, PORT + 2)
  await init(itmp, PORT + 2)
  eq('여러 번 돌려도 훅이 안 늘어난다', JSON.stringify(read()), before)

  fs.rmSync(itmp, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 워처

// 디바운스 타이머 하나에 파일 하나만 실으면, 여러 파일이 한꺼번에 바뀔 때
// 마지막 하나만 남고 나머지가 조용히 사라진다. 그래프가 낡으면 판정도 낡는다.
console.log('\n[여러 파일이 한꺼번에 바뀔 때]')
{
  const wtmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-watch-'))
  fs.writeFileSync(path.join(wtmp, 'a.ts'), 'export const a = 1\n')
  const wd = new Daemon(wtmp, PORT + 1)
  await wd.start({ watch: true })
  await new Promise(r => setTimeout(r, 300))

  for (const n of ['b', 'c', 'd', 'e']) fs.writeFileSync(path.join(wtmp, `${n}.ts`), `export const ${n} = 1\n`)
  await new Promise(r => setTimeout(r, 1500))
  eq('4개를 동시에 만들면 4개 다 들어온다', wd.graph.nodes.size, 5)

  for (const n of ['b', 'c', 'd']) fs.rmSync(path.join(wtmp, `${n}.ts`))
  await new Promise(r => setTimeout(r, 1500))
  eq('한꺼번에 지워도 다 빠진다', wd.graph.nodes.size, 2)

  await wd.stop()
  fs.rmSync(wtmp, { recursive: true, force: true })
}

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
