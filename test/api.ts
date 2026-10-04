/**
 * 라이브러리 API.
 *
 * 다른 프로그램이 데몬·훅 없이 codyssey 를 부른다. 돌려주는 건 구조화된 데이터여야 하고,
 * HTTP 를 열지 않아야 하고, 훅 경로와 같은 판정을 내려야 한다.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { Codyssey } from '../src/api.ts'
import { setLang } from '../src/i18n/index.ts'

setLang('ko', true)

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-api-'))
fs.cpSync('fixtures/shop', tmp, { recursive: true })
fs.rmSync(path.join(tmp, '.codyssey'), { recursive: true, force: true })
fs.rmSync(path.join(tmp, '.claude'), { recursive: true, force: true })
fs.mkdirSync(path.join(tmp, 'web/__tests__'), { recursive: true })
fs.writeFileSync(path.join(tmp, 'web/__tests__/money.test.ts'), "import { formatMoney } from '../lib/money'\nexport const ok = formatMoney(1)\n")

const portInUse = (port: number) =>
  new Promise<boolean>(r => {
    const s = net.createServer().once('error', () => r(true)).once('listening', () => s.close(() => r(false)))
    s.listen(port, '127.0.0.1')
  })

console.log(`${NL}[열기]`)
const cx = await Codyssey.open(tmp, { watch: false })
ok('HTTP 를 열지 않는다 (기본 포트 7777 비어 있음)', !(await portInUse(7777)))
eq('루트를 그대로 돌려준다', cx.root, tmp)

console.log(`${NL}[읽기: 구조화된 사실]`)
const feats = cx.features()
ok('기능 목록이 나온다', feats.length >= 3, feats.map(f => f.id).join(', '))
const checkout = feats.find(f => f.id === 'PAGE /checkout')
ok('기능마다 파일 묶음이 있다', !!checkout && checkout.files.includes('web/lib/money.ts'))
ok('기능마다 사람이 읽는 이름이 있다', !!checkout && checkout.label.length > 0, checkout?.label)

const money = cx.facts('web/lib/money.ts')
ok('공유 파일은 기능이 여럿이다', money.features.length >= 3, money.features.join(', '))
ok('이 파일을 import 하는 곳을 안다', money.importers.includes('web/components/PriceRow.tsx'), money.importers.join(', '))
ok('밖에 약속한 이름을 안다', money.contracts.some(k => k.name === 'formatMoney' && k.users.length >= 2))
eq('검증하는 테스트를 안다', money.tests, ['web/__tests__/money.test.ts'])
eq('절대 경로로 물어도 같은 답', cx.facts(path.join(tmp, 'web/lib/money.ts')).file, 'web/lib/money.ts')

const ctx = cx.contextFor(['web/lib/money.ts', 'api/services/payment.py'])
eq('작업 컨텍스트는 파일마다 사실을 담는다', ctx.files.map(f => f.file), ['web/lib/money.ts', 'api/services/payment.py'])
ok('영향 기능을 합쳐서 준다', ctx.features.includes('PAGE /checkout'))
eq('돌릴 테스트를 합쳐서 준다', ctx.tests, ['web/__tests__/money.test.ts'])
eq('아직 잠긴 건 없다', ctx.locked, [])

console.log(`${NL}[판정: 훅과 같은 답]`)
eq('공유 파일은 기본으로 note', cx.checkEdit('web/lib/money.ts').action, 'note')
eq('일반 파일은 allow', cx.checkEdit('web/components/PriceRow.tsx').action, 'allow')
eq('rm -rf ~/ 는 ask', cx.checkCommand('rm -rf ~/').action, 'ask')
eq('git status 는 allow', cx.checkCommand('git status').action, 'allow')
const broken = cx.checkEdit('web/lib/money.ts', { before: 'export function formatMoney', after: 'export function formatCents' })
eq('쓰이는 이름을 없애면 ask', broken.action, 'ask')

console.log(`${NL}[규칙]`)
eq('잠근다', cx.lock('api/services/payment.py', '결제 코어'), { ok: true })
eq('잠긴 파일은 block', cx.checkEdit('api/services/payment.py').action, 'block')
eq('잠금 목록', cx.lockedFiles(), ['api/services/payment.py'])
eq('컨텍스트에도 잠금이 반영된다', cx.contextFor(['api/services/payment.py']).locked, ['api/services/payment.py'])
const changes = cx.checkChanges([{ file: 'api/services/payment.py' }, { file: 'web/components/PriceRow.tsx' }])
eq('변경 묶음 검사는 문제 있는 파일만 돌려준다', changes.map(x => [x.file, x.verdict.action]), [['api/services/payment.py', 'block']])
ok('잠금이 Claude Code 규칙으로도 적힌다',
  JSON.parse(fs.readFileSync(path.join(tmp, '.claude/settings.json'), 'utf8')).permissions.deny.includes('Edit(/api/services/payment.py)'))
eq('푼다', cx.unlock('api/services/payment.py'), { ok: true })
ok('풀면 다시 막지 않는다 (공유 파일이라 note 는 남는다)', cx.checkEdit('api/services/payment.py').action !== 'block')

console.log(`${NL}[갱신]`)
fs.writeFileSync(path.join(tmp, 'web/components/Badge.tsx'), "import { formatMoney } from '@/lib/money'\nexport function Badge(){ return null }\n")
const after = await cx.afterEdit('web/components/Badge.tsx', { after: 'import { formatMoney }' })
ok('새 파일이 그래프에 들어온다', cx.facts('web/lib/money.ts').importers.includes('web/components/Badge.tsx'))
eq('편집 뒤에 돌릴 테스트를 준다 (없으면 빈 목록)', after.tests, [])
const after2 = await cx.afterEdit('web/lib/money.ts')
eq('공유 파일을 고치면 그 테스트를 준다', after2.tests, ['web/__tests__/money.test.ts'])

await cx.close()
fs.rmSync(tmp, { recursive: true, force: true })

console.log(`${NL}${fail === 0 ? c.g('통과') : c.r('실패')}  ${pass}개 성공, ${fail}개 실패${NL}`)
process.exit(fail === 0 ? 0 : 1)
