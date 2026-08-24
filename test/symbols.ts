/**
 * 심볼 단위 그래프.
 *
 * 바이브코딩 결과물은 파일이 몇 개 없다. 화면 여섯 개가 한 파일에 들어있으면
 * 파일 단위로는 '여러 곳이 공유하는 파일' 이 성립하지 않는다.
 * 위험이 사라진 게 아니라 파일 안으로 숨은 것이다.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scan, createCtx } from '../src/index/scan.ts'
import { buildSymbolGraph, sharedSymbols, symbolImpact, symId } from '../src/core/symbols.ts'
import { Daemon } from '../src/daemon/server.ts'

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

// ---------------------------------------------------------------- 한 파일 몰빵

console.log(`${NL}[한 파일에 다 몰아넣은 프로젝트]`)
const { graph, files } = await scan('fixtures/vibe')
const sg = buildSymbolGraph(files, createCtx('fixtures/vibe'))

eq('파일은 2개뿐이다', graph.nodes.size, 2)
ok('그런데 심볼은 많다', sg.nodes.size > 50, `${sg.nodes.size}개`)

const shared = sharedSymbols(sg, 3)
eq('여러 곳이 쓰는 심볼을 찾는다', shared.map(s => s.id), ['App.jsx#formatPrice'])
eq('부르는 곳을 전부 짚는다', shared[0].callers.map(x => x.split('#')[1]), [
  'AdminPage',
  'Cart',
  'Checkout',
  'Orders',
  'ProductList',
])

console.log(`${NL}[영향 추적]`)
eq(
  'formatPrice 를 고치면 이 화면들이 바뀐다',
  symbolImpact(sg, symId('App.jsx', 'formatPrice')).map(x => x.split('#')[1]).filter(x => x !== 'App'),
  ['AdminPage', 'Cart', 'Checkout', 'Orders', 'ProductList'],
)
eq('아무도 안 쓰는 심볼은 영향이 없다', symbolImpact(sg, symId('App.jsx', 'helper1')), [])
eq('서버 쪽도 잡힌다', sharedSymbols(sg, 2).some(s => s.id === 'server.py#to_cents'), true)

console.log(`${NL}[재귀·내장은 관계가 아니다]`)
const callees = sg.callees.get(symId('App.jsx', 'ProductList')) ?? new Set()
ok('React 훅은 관계로 안 센다', ![...callees].some(x => x.includes('useState')), [...callees].join(', '))
ok('자기 자신은 안 센다', ![...(sg.callers.get(symId('App.jsx', 'formatPrice')) ?? [])].includes(symId('App.jsx', 'formatPrice')))

// ---------------------------------------------------------------- 제품에 실제로 반영되나

console.log(`${NL}[사용자가 보는 것]`)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-sym-'))
fs.cpSync('fixtures/vibe', tmp, { recursive: true })
const d = new Daemon(tmp, 7972)
await d.start({ watch: false })
const state = d.state()

ok('제안이 나온다', state.suggestions.length > 0, `${state.suggestions.length}개`)
const top = state.suggestions[0] as any
ok('심볼 이름이 보인다', String(top.label).includes('formatPrice'), String(top.label))
ok('부르는 곳을 사람이 읽을 수 있다', top.why.includes('Checkout'), top.why.join(', '))
eq('화면->서버 경계는 파일이 적어도 잘 잡힌다', state.edges.filter((e: any) => e.kind === 'http').length, 5)

await d.stop()
fs.rmSync(tmp, { recursive: true, force: true })

// ---------------------------------------------------------------- 잘 나뉜 저장소는 그대로

console.log(`${NL}[잘 나뉜 저장소는 파일 단위가 그대로 우선]`)
const shopScan = await scan('fixtures/shop')
const shopSym = buildSymbolGraph(shopScan.files, createCtx('fixtures/shop'))
ok('심볼 그래프도 같이 만들어진다', shopSym.nodes.size > 0, `${shopSym.nodes.size}개`)
// 잘 나뉜 저장소에서도 심볼 관계는 잡힌다. 다만 사용자에게 보여줄 때는
// 파일 단위 제안이 이미 충분하므로 심볼 제안을 겹쳐 내보내지 않는다.
eq(
  '심볼 관계 자체는 잡힌다',
  sharedSymbols(shopSym, 3).map(x => x.id),
  ['web/lib/money.ts#formatMoney'],
)

const shopTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-sym2-'))
fs.cpSync('fixtures/shop', shopTmp, { recursive: true })
fs.rmSync(path.join(shopTmp, '.codyssey'), { recursive: true, force: true })
const d2 = new Daemon(shopTmp, 7973)
await d2.start({ watch: false })
const kinds = new Set((d2.state().suggestions as any[]).map(x => x.kind))
ok('제안은 파일 단위로만 나온다 (심볼 제안이 겹쳐 나오지 않는다)', !kinds.has('symbol'), [...kinds].join(', '))
await d2.stop()
fs.rmSync(shopTmp, { recursive: true, force: true })

console.log(`${NL}${fail === 0 ? c.g('통과') : c.r('실패')}  ${pass}개 성공, ${fail}개 실패${NL}`)
process.exit(fail === 0 ? 0 : 1)
