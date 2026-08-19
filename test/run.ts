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
eq('최상위 기능은 페이지 3개 (BE 라우트는 흡수됨)', feat.roots.map(r => r.id), ['PAGE /admin', 'PAGE /checkout', 'PAGE /orders'])
eq('web/lib/money.ts = 3개 기능', featuresOf(feat, 'web/lib/money.ts'), ['PAGE /admin', 'PAGE /checkout', 'PAGE /orders'])
eq('web/components/PriceRow.tsx = 1개 기능', featuresOf(feat, 'web/components/PriceRow.tsx'), ['PAGE /checkout'])
eq(
  'api/services/money.py 는 FE 기능까지 전파',
  featuresOf(feat, 'api/services/money.py'),
  ['PAGE /admin', 'PAGE /checkout', 'PAGE /orders'],
)

console.log('\n[자동 잠금 후보]')
const locks = autolockCandidates(feat, 3).map(c => c.file)
eq('money 모듈 둘 다 후보', locks.includes('web/lib/money.ts') && locks.includes('api/services/money.py'), true)
eq('단일 기능 파일은 후보 아님', locks.includes('web/components/PriceRow.tsx'), false)

console.log('\n[영향 반경]')
eq(
  'api/services/payment.py 변경 -> FE 페이지까지',
  sorted(graph.dependents('api/services/payment.py')).filter(f => f.startsWith('web/app')),
  ['web/app/admin/page.tsx', 'web/app/checkout/page.tsx', 'web/app/orders/page.tsx'],
)
eq(
  'confidence=high 만으로도 동일 (전부 high 엣지)',
  sorted(graph.dependents('api/services/payment.py', { minConfidence: 'high' })).length,
  sorted(graph.dependents('api/services/payment.py')).length,
)

console.log('\n[결정성]')
const a = JSON.stringify((await scan('fixtures/shop')).graph.toJSON())
const b = JSON.stringify((await scan('fixtures/shop')).graph.toJSON())
eq('두 번 스캔해도 바이트 동일', a === b, true)

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
