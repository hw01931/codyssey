/**
 * 배포용 빌드.
 *
 * 개발은 `node --experimental-strip-types` 로 .ts 를 바로 돌리지만,
 * 남에게 주려면 그 플래그 없이 실행돼야 한다. esbuild 로 한 파일로 묶는다.
 * (tsc 는 .ts 확장자 import 를 그대로 두거나 emit 을 막아서 이 구조에 안 맞는다)
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'

fs.rmSync('dist', { recursive: true, force: true })

// 라이브러리 진입점도 같이 묶는다. 다른 프로그램이 `import { Codyssey } from 'codyssey'` 로 쓴다.
await build({
  entryPoints: ['src/api.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/api.js',
  external: ['web-tree-sitter', 'tree-sitter-wasm', 'chokidar', 'yaml', '@modelcontextprotocol/sdk', 'zod'],
  logLevel: 'warning',
})

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/cli.js',
  // cli.ts 첫 줄에 이미 셰뱅이 있다. banner 로 또 넣으면 두 줄이 되어 문법 오류가 난다.
  // 네이티브/wasm 은 묶지 않고 런타임 의존으로 둔다
  // 런타임 의존은 묶지 않는다. 묶으면 node_modules 와 중복되고 번들이 15배가 된다.
  external: ['web-tree-sitter', 'tree-sitter-wasm', 'chokidar', 'yaml', '@modelcontextprotocol/sdk', 'zod'],
  logLevel: 'warning',
})

// 웹 화면은 그대로 복사한다 (데몬이 dist/../ui 를 찾는다)
fs.mkdirSync('dist/ui', { recursive: true })
for (const f of fs.readdirSync('src/ui')) {
  fs.copyFileSync(path.join('src/ui', f), path.join('dist/ui', f))
}

// 타입 선언. esbuild 는 .d.ts 를 안 만든다. 기존 타입 오류가 있어도 선언은 나온다 (noEmitOnError 기본값 false).
// npx 가 아니라 node 로 직접 부른다. 윈도우에서 execFileSync('npx') 는 ENOENT 다.
import { execFileSync } from 'node:child_process'
try {
  execFileSync(process.execPath, [path.join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.types.json'], { stdio: 'pipe' })
} catch {
  /* 타입 오류는 선언 생성을 막지 않는다 (noEmitOnError 기본값 false). 파일이 나왔는지만 본다 */
}
if (!fs.existsSync('dist/types/api.d.ts')) {
  // package.json 의 types 가 없는 파일을 가리킨 채 배포되면 안 된다. 여기서 멈춘다.
  console.error('dist/types/api.d.ts 가 생성되지 않았다')
  process.exit(1)
}

const size = fs.statSync('dist/cli.js').size
console.log(`dist/cli.js  ${(size / 1024).toFixed(0)}KB`)
console.log(`dist/api.js  ${(fs.statSync('dist/api.js').size / 1024).toFixed(0)}KB`)
console.log(`dist/ui/     ${fs.readdirSync('dist/ui').length}개 파일`)
