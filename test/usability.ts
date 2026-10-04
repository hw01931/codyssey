/**
 * 실제 프로젝트에 깔아보고 나온 사용성 문제들.
 *
 * FastAPI 풀스택 템플릿(FastAPI + React + TanStack Router)에 처음 쓰는 사람처럼
 * init 부터 따라가 보고 걸린 것들이다. 전부 '틀린 말을 하거나, 말을 너무 많이 하거나,
 * 다른 컴퓨터에서 조용히 죽는' 쪽이다. 하나씩 테스트로 고정한다.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Daemon } from '../src/daemon/server.ts'
import { stripJsonc, loadAliases } from '../src/index/tsconfig.ts'
import { scan } from '../src/index/scan.ts'
import { computeFeatures, autolockCandidates, featuresOf, isGenerated } from '../src/core/features.ts'
import { shortList } from '../src/core/rules.ts'
import { commandFor, isMachineLocal } from '../src/setup/init.ts'
import { setLang } from '../src/i18n/index.ts'

setLang('ko', true)

const NL = String.fromCharCode(10)
const PORT = 7796
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

const write = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

// ---------------------------------------------------------------- 1. tsconfig 별칭

console.log(`${NL}[tsconfig 를 실제 모양 그대로 읽는다]`)
{
  const src = `{
    "$schema": "https://json.schemastore.org/tsconfig", // 문자열 안의 // 는 주석이 아니다
    "compilerOptions": {
      /* Bundler mode */
      "paths": { "@/*": ["./src/*"] }, /* 끝 쉼표도 */
    },
  }`
  const json = JSON.parse(stripJsonc(src))
  eq('블록 주석과 끝 쉼표를 지운다', json.compilerOptions.paths, { '@/*': ['./src/*'] })
  eq('문자열 안의 // 는 그대로 둔다', json.$schema, 'https://json.schemastore.org/tsconfig')

  // Vite 템플릿 모양: 루트 tsconfig 는 references 만, 별칭은 tsconfig.app.json 에
  const vite = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-ts-'))
  write(vite, 'tsconfig.json', `{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }`)
  write(vite, 'tsconfig.app.json', `{ /* app */ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }`)
  eq('references 를 따라가서 별칭을 찾는다', loadAliases(vite), { '@/*': ['src/*'] })

  // extends 로 물려받은 별칭
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-ts-'))
  write(ext, 'tsconfig.base.json', `{ "compilerOptions": { "paths": { "~/*": ["./app/*"] } } }`)
  write(ext, 'tsconfig.json', `{ "extends": "./tsconfig.base.json" }`)
  eq('extends 로 물려받은 별칭도 쓴다', loadAliases(ext), { '~/*': ['app/*'] })

  // 실제 스캔에서 @/ import 가 파일까지 이어지는가
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-ts-'))
  write(proj, 'package.json', '{}')
  write(proj, 'tsconfig.json', `{
    // Vite
    "compilerOptions": { /* Bundler mode */ "paths": { "@/*": ["./src/*"] } },
  }`)
  write(proj, 'src/components/Button.tsx', 'export function Button() { return null }\n')
  write(proj, 'src/routes/items.tsx', `import { Button } from "@/components/Button"\nexport function Items() { return <Button /> }\n`)
  const { graph } = await scan(proj)
  ok('주석 있는 tsconfig 에서도 @/ import 가 이어진다',
    graph.out('src/routes/items.tsx').some(e => e.to === 'src/components/Button.tsx'))

  for (const d of [vite, ext, proj]) fs.rmSync(d, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 2. 말의 양

console.log(`${NL}[물어볼 때 한눈에 읽히게]`)
{
  eq('세 개까지만 늘어놓는다', shortList(['A', 'B', 'C', 'D', 'E']), 'A, B, C 외 2곳')
  eq('같은 이름은 한 번만', shortList(['Items read API', 'Items read API', 'Users']), 'Items read API, Users')
  eq('짧으면 그대로', shortList(['A']), 'A')

  ok('OpenAPI 생성 파일은 잠금 후보가 아니다', isGenerated('frontend/src/client/sdk.gen.ts'))
  ok('protobuf 생성 파일도', isGenerated('api/proto/user_pb2.py'))
  ok('라우트 트리 생성 파일도', isGenerated('frontend/src/routeTree.gen.ts'))
  ok('보통 파일은 아니다', !isGenerated('frontend/src/components/ui/button.tsx'))
}

// ---------------------------------------------------------------- 3. 공유 파일 확인 요청

console.log(`${NL}[공유 파일 확인 요청이 Claude Code 에서 실제로 동작하는가]`)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-usability-'))
fs.cpSync('fixtures/shop', tmp, { recursive: true })
fs.rmSync(path.join(tmp, '.codyssey'), { recursive: true, force: true })
fs.rmSync(path.join(tmp, '.claude'), { recursive: true, force: true })
// 생성 파일을 하나 끼워 넣는다. 세 화면이 다 가져다 쓴다.
write(tmp, 'web/lib/api.gen.ts', 'export const API = "/api"\n')
for (const page of ['web/app/admin/page.tsx', 'web/app/checkout/page.tsx', 'web/app/orders/page.tsx']) {
  fs.appendFileSync(path.join(tmp, page), `${NL}import { API } from '../../lib/api.gen'${NL}export const __api = API${NL}`)
}

const daemon = new Daemon(tmp, PORT)
await daemon.start()

const post = (p: string, body: unknown) =>
  fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => (await r.json()) as any)
const pre = (session: string, file: string) =>
  post('/pre', { session_id: session, tool_name: 'Edit', tool_input: { file_path: path.join(tmp, file), old_string: 'x', new_string: 'y' } })
const after = (session: string, file: string) =>
  post('/post', { session_id: session, tool_name: 'Edit', tool_input: { file_path: path.join(tmp, file), old_string: 'x', new_string: 'y' } })

{
  const shared = 'web/lib/money.ts'
  const first = await pre('s1', shared)
  // Claude Code 가 받는 값은 allow | deny | ask | defer 뿐이다. 모르는 값이면 확인이 안 뜬다.
  eq('확인 요청은 Claude Code 가 아는 값(ask)으로 보낸다', first.hookSpecificOutput?.permissionDecision, 'ask')
  ok('이유는 한 줄로 읽힌다', String(first.hookSpecificOutput?.permissionDecisionReason ?? '').split(NL).length === 1)

  await after('s1', shared)
  eq('한 번 허락해서 고친 파일은 같은 세션에서 다시 묻지 않는다', await pre('s1', shared), {})
  eq('다른 세션에서는 다시 묻는다', (await pre('s2', shared)).hookSpecificOutput?.permissionDecision, 'ask')

  // 묻지 않았던 파일을 고쳤다고 허락으로 치면 안 된다
  await after('s3', shared)
  eq('물어본 적 없는 세션은 허락한 게 아니다', (await pre('s3', shared)).hookSpecificOutput?.permissionDecision, 'ask')

  eq('생성 파일은 공유돼도 묻지 않는다', await pre('s1', 'web/lib/api.gen.ts'), {})
  const { features } = daemon as any
  ok('생성 파일은 잠금 후보 목록에도 없다',
    !autolockCandidates(features, 3).some(c => c.file === 'web/lib/api.gen.ts'),
    `기능 ${featuresOf(features, 'web/lib/api.gen.ts').length}개가 씀`)
}

{
  // 사람이 건 잠금은 세션 허락과 무관하게 매번 막는다
  write(tmp, '.codyssey/rules.yaml', `protect:${NL}  - path: web/lib/money.ts${NL}    reason: 돈 계산${NL}`)
  await new Promise(r => setTimeout(r, 600))
  eq('사람이 건 잠금은 세션 허락으로 풀리지 않는다', (await pre('s1', 'web/lib/money.ts')).hookSpecificOutput?.permissionDecision, 'deny')
  const hint = String((await pre('s9', 'web/lib/money.ts')).hookSpecificOutput?.additionalContext ?? '')
  // 대안은 '이 파일을 쓰는 쪽' 이어야 한다. 같은 폴더의 상관없는 파일이 아니라.
  const suggested = (/: (.+)$/m.exec(hint.split(NL).find(l => l.includes('쓰는 쪽')) ?? '')?.[1] ?? '').split(', ').filter(Boolean)
  const users = new Set(((daemon as any).graph.in('web/lib/money.ts') as { from: string }[]).map(e => e.from))
  ok('대안으로 제안하는 파일은 실제로 이 파일을 쓰는 곳이다', suggested.every(f => users.has(f)), suggested.join(', ') || '(제안 없음)')
}

await daemon.stop()
fs.rmSync(tmp, { recursive: true, force: true })

// ---------------------------------------------------------------- 4. 설정을 커밋해도 다른 곳에서 돈다

console.log(`${NL}[커밋된 설정이 다른 컴퓨터에서도 돈다]`)
{
  const root = path.resolve('/work/app')
  const inProject = commandFor({ path: path.join(root, 'node_modules/codyssey/dist/cli.js'), isSource: false }, ['mcp'], root, '${CLAUDE_PROJECT_DIR:-.}')
  eq('프로젝트에 설치했으면 프로젝트 기준 경로로 적는다', inProject, {
    command: 'node',
    args: ['${CLAUDE_PROJECT_DIR:-.}/node_modules/codyssey/dist/cli.js', 'mcp'],
  })
  ok('그 명령에는 이 컴퓨터 전용 경로가 없다', !isMachineLocal(inProject))

  const npx = commandFor({ path: '/home/me/.npm/_npx/abc/node_modules/codyssey/dist/cli.js', isSource: false }, ['mcp'], root, '.')
  eq('npx 로 실행했으면 npx 로 적는다 (캐시는 지워진다)', npx, { command: 'npx', args: ['-y', 'codyssey', 'mcp'] })

  const own = commandFor({ path: path.join(root, 'src/cli.ts'), isSource: true }, ['scan'], root, '.')
  eq('codyssey 저장소 자체에서 쓸 때도 상대 경로', own, { command: 'node', args: ['--experimental-strip-types', './src/cli.ts', 'scan'] })

  const elsewhere = commandFor({ path: path.resolve('/opt/tools/codyssey/dist/cli.js'), isSource: false }, ['mcp'], root, '.')
  ok('프로젝트 밖 설치본이면 이 컴퓨터 전용이라고 알려준다', isMachineLocal(elsewhere))
}

console.log(`${NL}${fail === 0 ? c.g('통과') : c.r('실패')}  ${pass}개 성공, ${fail}개 실패${NL}`)
process.exit(fail === 0 ? 0 : 1)
