/**
 * 잠금 추천. 숫자 하나가 아니라 무엇을·왜·잠그면 어떻게 되는지, 그리고 추천하지 않는 건 왜인지.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Codyssey } from '../src/api.ts'
import { findSecrets, renderRecommendations } from '../src/core/recommend.ts'
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-rec-'))
fs.cpSync('fixtures/shop', tmp, { recursive: true })
fs.rmSync(path.join(tmp, '.codyssey'), { recursive: true, force: true })
fs.rmSync(path.join(tmp, '.claude'), { recursive: true, force: true })
// 생성 파일 하나, 빈 barrel 하나, 비밀 둘 (하나는 예시 파일이라 비밀이 아니다)
write(tmp, 'web/lib/api.gen.ts', 'export const API = "/api"\n')
write(tmp, 'web/lib/index.ts', '')
for (const page of ['web/app/admin/page.tsx', 'web/app/checkout/page.tsx', 'web/app/orders/page.tsx']) {
  fs.appendFileSync(path.join(tmp, page), `${NL}import { API } from '../../lib/api.gen'${NL}import '../../lib/index'${NL}export const __api = API${NL}`)
}
write(tmp, '.env', 'SECRET=1\n')
write(tmp, '.env.example', 'SECRET=\n')
write(tmp, 'api/service-account.json', '{}')

const cx = await Codyssey.open(tmp, { watch: false })
const r = cx.recommendations()

console.log(`${NL}[무엇을, 왜]`)
const money = r.recommend.find(x => x.file === 'web/lib/money.ts')
ok('공유 파일이 추천에 오른다', !!money)
ok('이유에 기능 이름이 들어 있다', !!money && money.reasons.some(x => x.kind === 'shared-features' && /관리자|결제|주문/.test(x.text)), money?.reasons.map(x => x.text).join(' | '))
ok('이유에 근거값이 붙어 있다', !!money && money.reasons.some(x => (x.evidence.count ?? 0) >= 3))
ok("밖에 약속한 이름('formatMoney')도 이유가 된다", !!money && money.reasons.some(x => x.kind === 'contract' && x.evidence.name === 'formatMoney'))
eq('권장 수준은 승인', money?.level, 'ask')
ok('잠그면 어떻게 되는지 말한다', !!money && money.effect.includes('확인'))
// 이 픽스처의 money.ts 에는 테스트가 없다. 그러면 '잠가도 깨졌는지 알 길이 없다' 고 말해야 한다.
ok('근거의 한계를 말한다 (테스트가 없으면 그 사실을)', !!money && money.basis.includes('테스트가 없습니다'))
ok('대안 파일은 실제로 이 파일을 쓰는 곳이다', !!money && money.alternatives.every(a => cx.facts('web/lib/money.ts').importers.includes(a)), money?.alternatives.join(', '))

console.log(`${NL}[비밀]`)
eq('비밀 파일을 찾는다 (.env.example 은 아니다)', findSecrets(tmp), ['.env', 'api/service-account.json'])
const env = r.recommend.find(x => x.file === '.env')
eq('비밀은 차단 권장', env?.level, 'block')
ok('비밀이 맨 위에 온다', r.recommend[0].level === 'block')
ok('잠그면 읽지도 못한다고 말한다', !!env && env.effect.includes('읽지도'))

console.log(`${NL}[추천하지 않는 것, 그리고 왜]`)
const why = (f: string) => r.skipped.find(s => s.file === f)?.why
eq('생성 파일은 추천하지 않는다', why('web/lib/api.gen.ts'), 'generated')
eq('빈 barrel 은 추천하지 않는다', why('web/lib/index.ts'), 'empty')
ok('추천 목록에는 없다', !r.recommend.some(x => x.file === 'web/lib/api.gen.ts' || x.file === 'web/lib/index.ts'))
ok('빠진 이유가 사람 말로 있다', r.skipped.every(s => s.text.length > 0))

console.log(`${NL}[잠그면 추천에서 빠지고 이유가 남는다]`)
cx.lock('web/lib/money.ts', '돈 계산')
const r2 = cx.recommendations()
ok('잠긴 파일은 추천에서 빠진다', !r2.recommend.some(x => x.file === 'web/lib/money.ts'))
eq('빠진 이유: 이미 잠김', r2.skipped.find(s => s.file === 'web/lib/money.ts')?.why, 'locked')
eq('비밀을 secret 으로 잠근다', cx.lock('.env', '비밀', { secret: true }), { ok: true })
const deny = JSON.parse(fs.readFileSync(path.join(tmp, '.claude/settings.json'), 'utf8')).permissions.deny
ok('비밀은 Edit 과 Read 둘 다 Claude Code 규칙으로 막는다', deny.includes('Edit(/.env)') && deny.includes('Read(/.env)'), deny.join(', '))
ok('보통 잠금은 Edit 만', deny.includes('Edit(/web/lib/money.ts)') && !deny.includes('Read(/web/lib/money.ts)'))

console.log(`${NL}[터미널 출력]`)
const lines = renderRecommendations(r)
ok('무엇을·왜·잠그면 이 한 묶음으로 나온다', lines.some(l => l.includes('왜:')) && lines.some(l => l.includes('잠그면:')))
ok('추천하지 않는 것도 나온다', lines.some(l => l.includes('추천하지 않는 것')))

await cx.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`${NL}${fail === 0 ? c.g('통과') : c.r('실패')}  ${pass}개 성공, ${fail}개 실패${NL}`)
process.exit(fail === 0 ? 0 : 1)
