/**
 * 테스트를 우리가 직접 돌리고 결과를 적는다. '검증됨' 은 모델의 말이 아니라 우리가 본 결과다.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Codyssey } from '../src/api.ts'
import { detectRunner, loadStore } from '../src/core/verify.ts'
import { setLang } from '../src/i18n/index.ts'

setLang('ko', true)
const NL = String.fromCharCode(10)
let pass = 0
let fail = 0
const c = { g: (s: string) => `\x1b[32m${s}\x1b[0m`, r: (s: string) => `\x1b[31m${s}\x1b[0m`, d: (s: string) => `\x1b[2m${s}\x1b[0m` }
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log(`  ${c.g('ok')}   ${label}`) }
  else { fail++; console.log(`  ${c.r('FAIL')} ${label}${NL}         받음: ${g}${NL}         기대: ${w}`) }
}
function ok(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ${c.g('ok')}   ${label}${detail ? c.d('  ' + detail) : ''}`) }
  else { fail++; console.log(`  ${c.r('FAIL')} ${label} ${detail}`) }
}
const write = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-verify-'))
fs.cpSync('fixtures/shop', tmp, { recursive: true })
fs.rmSync(path.join(tmp, '.codyssey'), { recursive: true, force: true })
fs.rmSync(path.join(tmp, '.claude'), { recursive: true, force: true })
// 이 저장소처럼 node 로 직접 돌리는 프로젝트. 실제로 돌아가는 테스트 두 개: 하나는 통과, 하나는 실패.
write(tmp, 'package.json', JSON.stringify({ name: 'shop', type: 'module', scripts: { test: 'node --experimental-strip-types --test' } }))
write(tmp, 'web/__tests__/money.test.ts', [
  "import { test } from 'node:test'",
  "import assert from 'node:assert/strict'",
  "import { formatMoney } from '../lib/money.ts'",
  "test('formats cents', () => assert.equal(formatMoney(1234), '$12.34'))",
  '',
].join(NL))
write(tmp, 'web/__tests__/api.test.ts', [
  "import { test } from 'node:test'",
  "import assert from 'node:assert/strict'",
  "import { fetchOrders } from '../lib/api.ts'",
  "test('wrong on purpose', () => assert.equal(typeof fetchOrders, 'number'))",
  '',
].join(NL))
// git 저장소로 만들어서 커밋을 기록할 수 있게
execFileSync('git', ['init', '-q'], { cwd: tmp })
execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: tmp })
execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: tmp })

console.log(`${NL}[러너 감지]`)
const node = detectRunner(tmp, 'web/__tests__/money.test.ts')
eq('package.json 의 test 스크립트에서 node 러너를 읽는다', node?.name, 'node')
ok('스크립트의 플래그를 그대로 가져간다', !!node && node.args.includes('--experimental-strip-types') && node.args.includes('--test'), node?.args.join(' '))
eq('파이썬 테스트는 pytest', detectRunner(tmp, 'api/tests/test_x.py')?.name, 'pytest')
eq('설정이 없는 폴더는 모른다 (추측하지 않는다)', detectRunner(os.tmpdir(), 'x/y.test.ts'), null)

const cx = await Codyssey.open(tmp, { watch: false })

console.log(`${NL}[돌리고 적는다]`)
eq('돌리기 전엔 안 돌림', cx.features().find(f => f.id === 'PAGE /checkout')?.verification.status, 'NOT_RUN')
const { run, features } = await cx.verify(['web/lib/money.ts'])
eq('고친 파일을 검증하는 테스트만 돈다', run.results.map(r => r.file), ['web/__tests__/money.test.ts'])
eq('통과한다', run.results[0].status, 'PASS')
ok('실제 명령을 적어둔다', String(run.results[0].command).includes('money.test.ts'), run.results[0].command)
ok('커밋을 적어둔다', typeof run.commit === 'string' && run.commit.length === 40)
eq('커밋 안 한 변경이 없다', run.dirty, false)
eq('저장된다', loadStore(tmp).tests['web/__tests__/money.test.ts']?.status, 'PASS')
// 결제 화면은 money.ts 와 api.ts 를 둘 다 쓴다. 테스트 하나만 돌았으면 기능은 아직 '안 돌림' 이다.
// 반쪽만 보고 PASS 라고 하면 그게 바로 자기보고다.
const checkout = features.find(v => v.feature === 'PAGE /checkout')
eq('기능의 테스트 일부만 돌았으면 기능은 아직 NOT_RUN', checkout?.status, 'NOT_RUN')
eq('어떤 테스트가 걸려 있는지 다 보여준다', checkout?.tests, ['web/__tests__/api.test.ts', 'web/__tests__/money.test.ts'])

console.log(`${NL}[실패는 실패로]`)
const all = await cx.verify()
const badR = all.run.results.find(r => r.file === 'web/__tests__/api.test.ts')
eq('실패한 테스트는 FAIL', badR?.status, 'FAIL')
ok('실패 출력 끝부분을 준다', !!badR?.output && /wrong on purpose|AssertionError|not ok/.test(badR.output))
eq('api.ts 를 쓰는 기능은 FAIL', all.features.find(v => v.feature === 'PAGE /checkout')?.status, 'FAIL')
eq('실패한 테스트 이름을 든다', all.features.find(v => v.feature === 'PAGE /checkout')?.failing, ['web/__tests__/api.test.ts'])
ok('money 쪽 기록은 그대로 PASS', loadStore(tmp).tests['web/__tests__/money.test.ts']?.status === 'PASS')

console.log(`${NL}[고치면 PASS 가 된다]`)
write(tmp, 'web/__tests__/api.test.ts', [
  "import { test } from 'node:test'",
  "import assert from 'node:assert/strict'",
  "import { fetchOrders } from '../lib/api.ts'",
  "test('fixed', () => assert.equal(typeof fetchOrders, 'function'))",
  '',
].join(NL))
const fixed = await cx.verify(['web/lib/api.ts'])
eq('고친 뒤엔 통과', fixed.run.results[0].status, 'PASS')
eq('이제 결제 화면은 PASS', fixed.features.find(v => v.feature === 'PAGE /checkout')?.status, 'PASS')
ok('커밋 안 한 변경이 있다고 적는다 (테스트 파일을 고쳤다)', fixed.run.dirty === true)
eq('다시 열어도 남아 있다', (await Codyssey.open(tmp, { watch: false })).features().find(f => f.id === 'PAGE /checkout')?.verification.status, 'PASS')

console.log(`${NL}[검증된 기능은 잠금 추천 이유가 된다]`)
const recs = cx.recommendations()
const verifiedRec = recs.recommend.find(r => r.reasons.some(x => x.kind === 'verified'))
ok("추천에 '검증된 기능' 이유가 붙는다", !!verifiedRec, verifiedRec ? `${verifiedRec.file}: ${verifiedRec.reasons.map(x => x.text).join(' | ')}` : '')
ok('근거 설명이 테스트 기반으로 바뀐다', !!verifiedRec && verifiedRec.basis.includes('테스트'))
ok('테스트 없는 파일은 그 사실을 말한다', recs.recommend.some(r => r.basis.includes('테스트가 없습니다')), recs.recommend.map(r => `${r.file}: ${r.basis.slice(0, 20)}`).join(' | '))

console.log(`${NL}[못 돌리는 건 모른다고 한다]`)
write(tmp, 'api/tests/test_payment.py', 'from services.payment import charge\n\ndef test_x():\n    assert charge\n')
await cx.reindex(['api/tests/test_payment.py'])
const py = await cx.verify(['api/services/payment.py'])
const pyR = py.run.results.find(r => r.file === 'api/tests/test_payment.py')
ok('pytest 가 없으면 FAIL 이 아니라 판정 불가', pyR?.status === 'INCONCLUSIVE' || pyR?.status === 'PASS', `${pyR?.status} ${pyR?.reason ?? ''}`)
ok('판정 불가는 예전 기록을 덮지 않는다', loadStore(tmp).tests['web/__tests__/money.test.ts']?.status === 'PASS')
// 결제 화면은 fetch 로 결제 API 에 닿는다. 그 API 의 테스트가 판정 불가면 화면도 판정 불가다.
// 반쪽 근거로 PASS 를 유지하지 않는다.
eq('기능에 걸린 테스트 하나가 판정 불가면 기능도 판정 불가', py.features.find(v => v.feature === 'PAGE /checkout')?.status, 'INCONCLUSIVE')

console.log(`${NL}[Stop 훅과 이어진다]`)
{
  // 데몬 쪽: 편집 → 기다리는 테스트 → verify 가 돌면 Stop 이 조용히 끝난다
  const { Daemon } = await import('../src/daemon/server.ts')
  const d = new Daemon(tmp, 7797)
  await d.start({ watch: false })
  const post = (p: string, body: unknown) =>
    fetch(`http://127.0.0.1:7797${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json() as any)
  await post('/post', { session_id: 'v', tool_name: 'Edit', tool_input: { file_path: path.join(tmp, 'web/lib/money.ts'), old_string: 'x', new_string: 'y' } })
  const stop1 = await post('/stop', { session_id: 'v' })
  ok('안 돌렸으면 되돌리고, 우리에게 돌리게 하라고 말한다', stop1.decision === 'block' && /verify/.test(String(stop1.reason)), String(stop1.reason).slice(0, 80))
  await post('/post', { session_id: 'v', tool_name: 'Edit', tool_input: { file_path: path.join(tmp, 'web/lib/money.ts'), old_string: 'x', new_string: 'y' } })
  await post('/api/verify', { files: ['web/lib/money.ts'] })
  eq('우리가 돌렸으면 조용히 끝낸다', await post('/stop', { session_id: 'v' }), {})
  await d.stop()
}

await cx.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`${NL}${fail === 0 ? c.g('통과') : c.r('실패')}  ${pass}개 성공, ${fail}개 실패${NL}`)
process.exit(fail === 0 ? 0 : 1)
