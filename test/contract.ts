/**
 * 계약 보호 · 중복 이름 · 테스트 매핑.
 *
 * 파일 단위 잠금으로는 안 잡히는 사고들이다. 그 파일을 고치는 건 대부분 정상이고,
 * 문제는 '그 안의 특정 이름' 이거나 '고친 뒤에 뭘 확인해야 하는가' 다.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Daemon } from '../src/daemon/server.ts'
import { contractsOf, brokenContracts, duplicateNames, nameIndex, testsFor } from '../src/core/contract.ts'

const PORT = 7791
const BASE = `http://127.0.0.1:${PORT}`
const NL = String.fromCharCode(10)

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-contract-'))
fs.cpSync('fixtures/shop', tmp, { recursive: true })
fs.rmSync(path.join(tmp, '.codyssey'), { recursive: true, force: true })
fs.rmSync(path.join(tmp, '.claude'), { recursive: true, force: true })

const daemon = new Daemon(tmp, PORT)
await daemon.start({ watch: false })

const setRules = (yaml: string) => {
  fs.mkdirSync(path.join(tmp, '.codyssey'), { recursive: true })
  fs.writeFileSync(path.join(tmp, '.codyssey', 'rules.yaml'), yaml)
  daemon.loadRules()
}
const INERT = `version: 1
protect: []
features: []
layers: []
autolock: { minFeatures: 99, minModules: 99, mode: off }
contracts: { mode: ask }
`
setRules(INERT)

const post = (p: string, body: unknown) =>
  fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(r => r.json() as Promise<any>)

const edit = (file: string, old_string: string, new_string: string) =>
  post('/pre', { tool_name: 'Edit', tool_input: { file_path: file, old_string, new_string } })
const write = (file: string, content: string) =>
  post('/pre', { tool_name: 'Write', tool_input: { file_path: file, content } })

const decision = (r: any) => r?.hookSpecificOutput?.permissionDecision ?? 'allow'
const reason = (r: any) => r?.hookSpecificOutput?.permissionDecisionReason ?? ''
const ctx = (r: any) => r?.hookSpecificOutput?.additionalContext ?? ''

console.log(`${NL}${c.d('임시 폴더: ' + tmp)}`)

// ---------------------------------------------------------------- 계약 파악

console.log(`${NL}[누가 무슨 이름을 가져다 쓰나]`)
const money = contractsOf(daemon.graph, 'web/lib/money.ts')
eq('money.ts 는 formatMoney 를 약속했다', money.map(x => x.name), ['formatMoney'])
eq('세 곳이 쓴다', money[0].users, [
  'web/app/admin/page.tsx',
  'web/components/OrderTable.tsx',
  'web/components/PriceRow.tsx',
])
eq('아무도 안 쓰는 파일은 약속이 없다', contractsOf(daemon.graph, 'web/app/admin/page.tsx').length, 0)

// ---------------------------------------------------------------- 계약 깨기

console.log(`${NL}[약속한 이름을 없앨 때]`)
const removed = await edit(
  'web/lib/money.ts',
  'export function formatMoney(cents: number): string {',
  'export function formatCents(cents: number): string {',
)
eq('이름을 바꾸면 확인을 요청한다', decision(removed), 'escalate')
ok('몇 곳이 쓰는지 말해준다', reason(removed).includes('3곳'), reason(removed))
ok('어디서 쓰는지 알려준다', ctx(removed).includes('web/components/PriceRow.tsx'), ctx(removed))

eq(
  '이름을 그대로 두면 통과',
  decision(await edit('web/lib/money.ts', 'return `$${(cents / 100).toFixed(2)}`', 'return `${cents}원`')),
  'allow',
)
eq(
  '이름을 언급만 해도 통과 (없애는 게 아니다)',
  decision(await edit('web/lib/money.ts', 'formatMoney', 'formatMoney // 주석')),
  'allow',
)

console.log(`${NL}[파일을 통째로 새로 쓸 때]`)
eq(
  '결과에 이름이 없으면 확인 요청',
  decision(await write('web/lib/money.ts', 'export function nothing() {}' + NL)),
  'escalate',
)
eq(
  '결과에 이름이 있으면 통과',
  decision(await write('web/lib/money.ts', 'export function formatMoney(c: number) { return String(c) }' + NL)),
  'allow',
)

console.log(`${NL}[끄고 켜기]`)
setRules(INERT.replace('contracts: { mode: ask }', 'contracts: { mode: off }'))
eq('off 면 아무 말 안 한다', decision(await write('web/lib/money.ts', 'export function nothing() {}')), 'allow')
setRules(INERT.replace('contracts: { mode: ask }', 'contracts: { mode: block }'))
eq('block 이면 막는다', decision(await write('web/lib/money.ts', 'export function nothing() {}')), 'deny')
setRules(INERT)

// ---------------------------------------------------------------- 판정 단위

console.log(`${NL}[깨짐 판정 자체]`)
const cs = [{ name: 'formatMoney', users: ['a.ts', 'b.ts'] }]
eq('조각편집: 사라지면 깨짐', brokenContracts(cs, { before: 'formatMoney', after: 'x' }).length, 1)
eq('조각편집: 남아있으면 무사', brokenContracts(cs, { before: 'formatMoney', after: 'formatMoney2 formatMoney' }).length, 0)
eq('조각편집: 원래 없던 곳은 관심 없음', brokenContracts(cs, { before: 'other', after: 'x' }).length, 0)
eq('전체쓰기: 결과에 없으면 깨짐', brokenContracts(cs, { after: 'nothing', whole: true }).length, 1)
eq('부분 문자열에 속지 않는다', brokenContracts(cs, { before: 'formatMoney', after: 'formatMoneyDeluxe' }).length, 1)

// ---------------------------------------------------------------- 중복 이름

console.log(`${NL}[이미 있는 이름을 또 만들 때]`)
const idx = nameIndex(daemon.graph)
ok('이름 인덱스가 만들어진다', idx.has('formatMoney'), `formatMoney -> ${idx.get('formatMoney')?.join(', ')}`)

const dup = duplicateNames(idx, 'web/components/Badge.tsx', {
  before: '',
  after: 'export function formatMoney(x) { return x }',
})
eq('이미 있는 이름을 만들면 잡는다', dup.map(d => d.name), ['formatMoney'])
eq('원래 있던 이름은 안 잡는다', duplicateNames(idx, 'web/lib/money.ts', { before: 'formatMoney', after: 'formatMoney' }).length, 0)
eq('호출만 하는 건 안 잡는다', duplicateNames(idx, 'x.ts', { before: '', after: 'formatMoney(1)' }).length, 0)
eq('짧은 이름은 애초에 안 본다', duplicateNames(idx, 'x.ts', { before: '', after: 'function abc() {}' }).length, 0)

// ---------------------------------------------------------------- 테스트 매핑

console.log(`${NL}[고쳤으면 뭘 돌려야 하나]`)
fs.mkdirSync(path.join(tmp, 'web/__tests__'), { recursive: true })
fs.writeFileSync(
  path.join(tmp, 'web/__tests__/money.test.ts'),
  `import { formatMoney } from '../lib/money'${NL}formatMoney(1)${NL}`,
)
await daemon.reindex('web/__tests__/money.test.ts')

eq('그 파일을 쓰는 테스트를 찾는다', testsFor(daemon.graph, 'web/lib/money.ts'), ['web/__tests__/money.test.ts'])
eq('테스트가 없으면 빈 목록', testsFor(daemon.graph, 'api/db/models.py'), [])

const notes = await post('/post', {
  tool_name: 'Edit',
  tool_input: { file_path: 'web/lib/money.ts', old_string: 'x', new_string: 'y' },
})
ok('편집 뒤에 돌릴 테스트를 알려준다', ctx(notes).includes('money.test.ts'), ctx(notes).split(NL).join(' '))

// ---------------------------------------------------------------- 정리

await daemon.stop()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`${NL}${fail === 0 ? c.g('통과') : c.r('실패')}  ${pass}개 성공, ${fail}개 실패${NL}`)
process.exit(fail === 0 ? 0 : 1)
