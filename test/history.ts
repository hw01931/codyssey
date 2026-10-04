/**
 * git 이력 신호. 자주 바뀌는 파일과 함께 바뀌는 파일을 커밋 로그에서 읽는다.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readHistory, hotThreshold } from '../src/core/history.ts'
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-hist-'))
fs.cpSync('fixtures/shop', tmp, { recursive: true })
fs.rmSync(path.join(tmp, '.codyssey'), { recursive: true, force: true })
fs.rmSync(path.join(tmp, '.claude'), { recursive: true, force: true })
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: tmp, stdio: 'pipe' })
const touch = (rel: string) => fs.appendFileSync(path.join(tmp, rel), `${NL}// ${Math.random()}${NL}`)
const commit = (...files: string[]) => { for (const f of files) touch(f); git('add', '-A'); git('commit', '-qm', files.join(' ')) }

git('init', '-q')
git('add', '-A'); git('commit', '-qm', 'init')
// money.ts 는 5번 바뀌고, 그중 4번은 import 관계가 없는 api/services/money.py 와 함께 바뀐다
for (let i = 0; i < 4; i++) commit('web/lib/money.ts', 'api/services/money.py')
commit('web/lib/money.ts')
// PriceRow 는 한 번
commit('web/components/PriceRow.tsx')
// 큰 커밋 하나: 전부 건드림. 공변경에 들어가면 안 된다
const all = ['web/lib/api.ts', 'web/app/admin/page.tsx', 'web/app/checkout/page.tsx', 'web/app/orders/page.tsx', 'api/main.py', 'api/services/order.py', 'api/services/payment.py', 'api/db/models.py']
commit(...all)

console.log(`${NL}[커밋 로그를 읽는다]`)
const h = readHistory(tmp, { days: 30, maxFilesPerCommit: 5 })
ok('git 저장소로 인식한다', !h.unavailable)
eq('커밋 수', h.commits, 8)
eq('money.ts 는 6번 바뀌었다 (init 포함)', h.files.get('web/lib/money.ts')?.commits, 6)
eq('PriceRow 는 2번', h.files.get('web/components/PriceRow.tsx')?.commits, 2)
const co = h.files.get('web/lib/money.ts')?.coChanges ?? []
eq('함께 바뀐 파일 1위는 money.py, 4번', co[0], { file: 'api/services/money.py', together: 4 })
ok('큰 커밋은 공변경에 안 들어간다', !co.some(x => x.file === 'api/main.py'), co.map(x => `${x.file}:${x.together}`).join(', '))
ok('자주 바뀜 기준은 분포에서 나온다 (최소 3)', hotThreshold(h) >= 3, String(hotThreshold(h)))
ok('git 이 아니면 모른다고 한다', readHistory(os.tmpdir()).unavailable)

console.log(`${NL}[추천과 컨텍스트에 들어간다]`)
const cx = await Codyssey.open(tmp, { watch: false })
const money = cx.recommendations().recommend.find(r => r.file === 'web/lib/money.ts')
ok('자주 바뀐 파일에 churn 이유가 붙는다', !!money && money.reasons.some(x => x.kind === 'churn' && (x.evidence.count ?? 0) >= 5), money?.reasons.map(x => x.text).join(' | '))
ok('import 없이 함께 바뀐 파일을 숨은 결합으로 말한다', !!money && money.reasons.some(x => x.kind === 'co-change' && x.evidence.list?.includes('api/services/money.py')))
const first = cx.recommendations().recommend.filter(r => r.level === 'ask')[0]
eq('자주 바뀐 공유 파일이 맨 위로 온다', first?.file, 'web/lib/money.ts')

const facts = cx.facts('web/lib/money.ts')
eq('facts 에 이력이 있다', facts.history?.commits, 6)
const ctx = cx.contextFor(['web/lib/money.ts'])
ok('작업 컨텍스트가 "이것도 봐야 할 파일" 을 준다', ctx.coChanged.some(x => x.file === 'api/services/money.py' && x.with === 'web/lib/money.ts'), JSON.stringify(ctx.coChanged))
ok('이미 작업 목록에 있는 파일은 다시 안 준다', !cx.contextFor(['web/lib/money.ts', 'api/services/money.py']).coChanged.some(x => x.file === 'api/services/money.py'))

await cx.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`${NL}${fail === 0 ? c.g('통과') : c.r('실패')}  ${pass}개 성공, ${fail}개 실패${NL}`)
process.exit(fail === 0 ? 0 : 1)
