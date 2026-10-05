/**
 * 변경 묶음을 작업 계약과 대조한다. 합치기 직전의 마지막 문이다.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Codyssey } from '../src/api.ts'
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-changes-'))
fs.cpSync('fixtures/shop', tmp, { recursive: true })
fs.rmSync(path.join(tmp, '.codyssey'), { recursive: true, force: true })
fs.rmSync(path.join(tmp, '.claude'), { recursive: true, force: true })
write(tmp, 'web/__tests__/money.test.ts', "import { formatMoney } from '../lib/money'\nexport const ok = formatMoney(1) === '$0.01'\n")
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: tmp, stdio: 'pipe' })
git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'base')

const cx = await Codyssey.open(tmp, { watch: false })

console.log(`${NL}[기준 커밋 이후 변경을 읽는다]`)
// 작업: 결제 화면 수정. 그런데 작업자가 범위 밖까지 손댔다.
fs.appendFileSync(path.join(tmp, 'web/app/checkout/page.tsx'), `${NL}export const tweak = 1${NL}`)            // 범위 안
fs.appendFileSync(path.join(tmp, 'web/app/admin/page.tsx'), `${NL}export const sneaky = 1${NL}`)              // 범위 밖
write(tmp, 'web/__tests__/money.test.ts', "export const ok = true\n")                                          // 기존 테스트를 느슨하게
write(tmp, 'web/lib/money.ts', "export function formatMoney(cents: number, currency: string): string {\n  return `${currency}${(cents / 100).toFixed(2)}`\n}\n") // 시그니처 변경
fs.rmSync(path.join(tmp, 'web/lib/api.ts'))                                                                    // 쓰이는 파일 삭제
write(tmp, 'web/lib/new.ts', 'export const fresh = 1\n')                                                       // 새 파일 (범위 밖)
const changes = cx.changesSince('HEAD')
eq('바뀐 파일을 전부 본다 (커밋 안 한 것, 새 파일 포함)',
  changes.map(ch => `${ch.file}:${ch.status}`),
  ['web/__tests__/money.test.ts:modified', 'web/app/admin/page.tsx:modified', 'web/app/checkout/page.tsx:modified', 'web/lib/api.ts:deleted', 'web/lib/money.ts:modified', 'web/lib/new.ts:added'])
ok('전후 내용을 담는다', changes.find(ch => ch.file === 'web/lib/money.ts')!.before!.includes('(cents: number)') && changes.find(ch => ch.file === 'web/lib/money.ts')!.after!.includes('currency'))

console.log(`${NL}[계약 없이: 코드 자체의 문제만]`)
const plain = cx.checkChanges(changes)
const by = (r: typeof plain, f: string) => r.results.find(x => x.file === f)
eq('시그니처가 바뀐 공유 파일은 ask (계약 파손)', by(plain, 'web/lib/money.ts')?.because, 'contract-broken')
eq('쓰이는 파일 삭제는 ask', by(plain, 'web/lib/api.ts')?.verdict.action, 'ask')
eq('기존 테스트 수정은 계약 없이도 ask', by(plain, 'web/__tests__/money.test.ts')?.because, 'test-touched')
ok('범위 개념이 없으니 admin 수정은 걸리지 않는다', !by(plain, 'web/app/admin/page.tsx') || by(plain, 'web/app/admin/page.tsx')!.verdict.action === 'note')
eq('합쳐도 되나: 아니다', plain.ok, false)

console.log(`${NL}[작업 계약과 대조]`)
const report = cx.checkChanges(changes, { allow: ['web/app/checkout/**', 'web/lib/money.ts'], deny: ['web/lib/api.ts'] })
eq('범위 안 변경은 걸리지 않는다', by(report, 'web/app/checkout/page.tsx'), undefined)
eq('범위 밖 수정은 ask: 요청하지 않은 변경', by(report, 'web/app/admin/page.tsx')?.because, 'out-of-scope')
eq('범위 밖 새 파일도', by(report, 'web/lib/new.ts')?.because, 'out-of-scope')
eq('금지한 파일은 block (삭제도 변경이다)', by(report, 'web/lib/api.ts')?.verdict.action, 'block')
eq('금지가 다른 이유보다 세다', by(report, 'web/lib/api.ts')?.because, 'denied-by-contract')
eq('허용 범위 안이라도 계약 파손은 ask', by(report, 'web/lib/money.ts')?.because, 'contract-broken')
eq('기존 테스트를 느슨하게 고친 건 ask', by(report, 'web/__tests__/money.test.ts')?.because, 'test-touched')
eq('심한 것부터 온다', report.results[0].verdict.action, 'block')
eq('개수', report.counts, { block: 1, ask: 4, note: 0 })

console.log(`${NL}[계약이 허락하면 통과]`)
const loose = cx.checkChanges(changes.filter(ch => ch.file === 'web/__tests__/money.test.ts'), { allow: ['web/**'], tests: 'free' })
eq("tests: 'free' 면 테스트 수정도 범위 안", loose.ok, true)
const allowedTest = cx.checkChanges(changes.filter(ch => ch.file === 'web/__tests__/money.test.ts'), { allow: ['web/__tests__/**'] })
eq('테스트를 allow 에 명시해도 통과', allowedTest.ok, true)

console.log(`${NL}[사람이 잠근 파일]`)
cx.lock('web/app/admin/page.tsx', '관리자')
eq('잠긴 파일 변경은 block', by(cx.checkChanges(changes), 'web/app/admin/page.tsx')?.because, 'protected')

console.log(`${NL}[옛 모양도 받는다]`)
eq('{ file, patch } 입력', cx.checkChanges([{ file: 'web/lib/money.ts', patch: { before: 'export function formatMoney(cents: number)', after: 'export function formatMoney(cents: number, x: number)' } }]).results[0]?.because, 'contract-broken')

await cx.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`${NL}${fail === 0 ? c.g('통과') : c.r('실패')}  ${pass}개 성공, ${fail}개 실패${NL}`)
process.exit(fail === 0 ? 0 : 1)
