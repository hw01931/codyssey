/**
 * fixtures/shop/EXPECTED.md 를 실제로 검증한다.
 * 픽스처는 우리가 잡아야 할 케이스를 전부 심어놓은 최소 프로젝트다.
 */
import { scan } from '../src/index/scan.ts'
import { computeFeatures, autolockCandidates, featuresOf } from '../src/core/features.ts'

let pass = 0
let fail = 0

function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}\n         got  ${g}\n         want ${w}`)
  }
}

const { graph } = await scan('fixtures/shop')
const feat = computeFeatures(graph)
const sorted = (s: Iterable<string>) => [...s].sort()

console.log('\n[진입점]')
eq(
  '라우트 6개 (prefix 합성 포함)',
  [...graph.entries.keys()].sort(),
  [
    'GET /api/v1/admin/stats',
    'GET /api/v1/orders',
    'PAGE /admin',
    'PAGE /checkout',
    'PAGE /orders',
    'POST /api/v1/payments',
  ],
)
eq('중첩 prefix 합성', graph.entries.get('GET /api/v1/admin/stats')?.file, 'api/routes/admin.py')

console.log('\n[import 해석]')
eq(
  'tsconfig alias @/lib/money',
  graph.out('web/components/PriceRow.tsx').map(e => e.to),
  ['web/lib/money.ts'],
)
eq('해석 실패 없음', graph.unresolved, [])

console.log('\n[FE -> BE 경계]')
const http = graph.edges
  .filter(e => e.kind === 'http')
  .map(e => `${e.from} -> ${e.to} [${e.via}] ${e.confidence}`)
  .sort()
eq('http 엣지 3개, 전부 high', http, [
  'web/lib/api.ts -> api/routes/admin.py [GET /api/v1/admin/stats] high',
  'web/lib/api.ts -> api/routes/orders.py [GET /api/v1/orders] high',
  'web/lib/api.ts -> api/routes/payments.py [POST /api/v1/payments] high',
])

console.log('\n[기능 소속]')
eq('최상위 기능 (FE 가 안 부르는 라우트는 독립 기능)', feat.roots.map(r => r.id), [
  'GET /api/v1/admin/stats', // fetchStats 를 아무도 import 안 함 = 사실상 죽은 라우트
  'PAGE /admin',
  'PAGE /checkout',
  'PAGE /orders',
])
eq('web/lib/money.ts = 3개 기능', featuresOf(feat, 'web/lib/money.ts'), ['PAGE /admin', 'PAGE /checkout', 'PAGE /orders'])
eq('web/components/PriceRow.tsx = 1개 기능', featuresOf(feat, 'web/components/PriceRow.tsx'), ['PAGE /checkout'])
eq('api/services/money.py 는 FE 기능까지 전파', featuresOf(feat, 'api/services/money.py'), [
  'GET /api/v1/admin/stats',
  'PAGE /admin',
  'PAGE /checkout',
  'PAGE /orders',
])
eq('api/services/payment.py 는 결제 경로만', featuresOf(feat, 'api/services/payment.py'), [
  'GET /api/v1/admin/stats',
  'PAGE /checkout',
])

console.log('\n[자동 잠금 후보]')
const locks = autolockCandidates(feat, 3).map(c => c.file)
eq('money 모듈 둘 다 후보', locks.includes('web/lib/money.ts') && locks.includes('api/services/money.py'), true)
eq('단일 기능 파일은 후보 아님', locks.includes('web/components/PriceRow.tsx'), false)

console.log('\n[영향 반경]')
eq(
  'api/services/payment.py 변경 -> 결제 페이지만',
  sorted(graph.dependents('api/services/payment.py')).filter(f => f.startsWith('web/app')),
  ['web/app/checkout/page.tsx'],
)
eq(
  'confidence=high 만으로도 동일 (전부 high 엣지)',
  sorted(graph.dependents('api/services/payment.py', { minConfidence: 'high' })).length,
  sorted(graph.dependents('api/services/payment.py')).length,
)

console.log('\n[심볼 게이팅]')
// lib/api.ts 한 파일에 fetch 3개가 있어도, 가져간 이름으로 걸러 실제 경로만 따라간다.
const routesFrom = (f: string, gated: boolean) =>
  [...graph.reachable(f, { gated })].filter(x => x.startsWith('api/routes')).sort()

eq('OrderTable(fetchOrders) -> orders.py 하나', routesFrom('web/components/OrderTable.tsx', true), [
  'api/routes/orders.py',
])
eq('checkout(createPayment) -> payments.py 하나', routesFrom('web/app/checkout/page.tsx', true), [
  'api/routes/payments.py',
])
eq('게이팅 끄면 과대추정으로 복귀', routesFrom('web/components/OrderTable.tsx', false), [
  'api/routes/admin.py',
  'api/routes/orders.py',
  'api/routes/payments.py',
])
eq(
  '역방향도 게이팅됨',
  sorted(graph.dependents('api/routes/payments.py')).filter(f => f.startsWith('web/app')),
  ['web/app/checkout/page.tsx'],
)

console.log('\n[결정성]')
const a = JSON.stringify((await scan('fixtures/shop')).graph.toJSON())
const b = JSON.stringify((await scan('fixtures/shop')).graph.toJSON())
eq('두 번 스캔해도 바이트 동일', a === b, true)

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
