#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { scan } from './index/scan.ts'
import type { Graph } from './core/graph.ts'
import { computeFeatures, autolockCandidates, featuresOf, allEntriesOf } from './core/features.ts'
import { Daemon } from './daemon/server.ts'
import { init, openBrowser, spawnDaemon } from './setup/init.ts'
import { health, resolvePort, samePath, savePort } from './setup/port.ts'
import { doctor } from './setup/doctor.ts'

const [, , cmd = 'help', ...rest] = process.argv

const flag = (name: string, def: string) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : def
}
const has = (name: string) => rest.includes(`--${name}`)
const positional = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--'))

const root = flag('root', '.')
const explicitPort = rest.includes('--port') ? Number(flag('port', '')) : undefined

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[36m${s}\x1b[0m`,
}

switch (cmd) {
  case 'init': await cmdInit(); break
  case 'start': case 'ui': case 'watch': await cmdStart(); break
  case 'ensure': await cmdEnsure(); break
  case 'doctor': await cmdDoctor(); break
  case 'scan': await cmdScan(); break
  case 'status': await cmdStatus(); break
  case 'impact': await cmdImpact(positional[0]); break
  default: help()
}

function help() {
  console.log(`
${C.b('CODYSSEY')} ${C.dim('- AI 가 구조를 깨뜨리지 않게 지켜주는 도구')}

  ${C.b('codyssey init')}            처음 한 번. 설정하고 웹 화면을 엽니다
  ${C.b('codyssey start')}           웹 화면 + 파일 감시 시작
  ${C.dim('codyssey ensure')}          꺼져 있으면 조용히 띄우기 (훅이 자동 호출)
  ${C.b('codyssey doctor')}          설정이 제대로 됐는지 점검
  ${C.dim('codyssey scan')}            구조 파일만 만들기
  ${C.dim('codyssey status')}          터미널에 요약 출력
  ${C.dim('codyssey impact <파일>')}   이 파일을 고치면 뭐가 영향받나

  ${C.dim('--root <경로>')}   대상 폴더 (기본: 현재 폴더)
  ${C.dim('--port <번호>')}   포트 지정 (기본: 프로젝트별로 자동 배정)
  ${C.dim('--no-open')}      브라우저 자동 실행 안 함
`)
}

async function cmdInit() {
  console.log(`\n${C.b('CODYSSEY 설정 중...')}\n`)
  const r = await init(root, explicitPort)

  console.log(`  코드 ${C.b(String(r.files))}개 파일을 읽었습니다`)
  console.log(`  기능 ${C.b(String(r.features))}개를 찾았습니다`)
  if (r.suggestions) {
    console.log(`  여러 기능이 함께 쓰는 파일 ${C.yellow(String(r.suggestions))}개 - 잠글지 화면에서 골라주세요`)
  }
  console.log()
  for (const w of r.wrote) console.log(`  ${C.green('+')} ${w}`)
  for (const s of r.skipped) console.log(`  ${C.dim('·')} ${C.dim(s)}`)

  console.log(`\n${C.green('설정 완료.')} 이 프로젝트는 포트 ${C.b(String(r.port))} 를 씁니다.`)
  console.log(`\n${C.yellow('중요:')} 차단이 켜지려면 ${C.b('Claude Code 를 다시 시작')}해야 합니다.`)
  console.log(C.dim('       훅 설정은 세션이 시작될 때 읽힙니다. 지금 세션에는 적용되지 않습니다.'))
  console.log(C.dim('       다시 시작한 뒤부터는 데몬도 자동으로 켜집니다.\n'))
  await cmdStart(r.port)
}

async function cmdStart(known?: number) {
  const abs = path.resolve(root)
  const port = known ?? (await resolvePort(abs, explicitPort))

  // 포트를 남이 잡고 있으면 절대 그 위에 얹지 않는다.
  // 예전에는 이 상황에서 훅이 남의 데몬한테 물어보고 전부 통과됐다.
  const existing = await health(port)
  if (existing && !samePath(existing.repoRoot, abs)) {
    console.error(`\n${C.yellow(`포트 ${port} 는 다른 프로젝트가 쓰고 있습니다.`)}`)
    console.error(C.dim(`  그쪽 폴더: ${existing.repoRoot}`))
    console.error(C.dim('  codyssey init 을 다시 돌리면 이 프로젝트 전용 포트를 잡아줍니다.\n'))
    process.exit(1)
  }
  if (existing) {
    const url = `http://127.0.0.1:${port}`
    console.log(`${C.b('CODYSSEY')} 이미 실행 중  ${C.blue(url)}`)
    if (!has('no-open')) openBrowser(url)
    return
  }

  savePort(abs, port)
  const d = new Daemon(root, port)
  try {
    await d.start()
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'EADDRINUSE') {
      console.error(`\n포트 ${port} 를 잡을 수 없습니다. --port 로 다른 번호를 지정해 주세요.\n`)
      process.exit(1)
    }
    throw err
  }

  const url = `http://127.0.0.1:${port}`
  console.log(`${C.b('CODYSSEY')} 실행 중  ${C.blue(url)}`)
  console.log(`  파일 ${d.graph.nodes.size} · 기능 ${d.features.roots.length} · 잠김 ${d.rules.protect.length}`)
  console.log(C.dim('  파일이 바뀌면 자동으로 다시 읽습니다. 끄려면 Ctrl+C\n'))
  if (!has('no-open')) openBrowser(url)

  const bye = async () => {
    await d.stop()
    process.exit(0)
  }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}

/** 훅에서 부른다. 이미 떠 있으면 아무것도 안 하고 즉시 끝난다. */
async function cmdEnsure() {
  const abs = path.resolve(root)
  const port = await resolvePort(abs, explicitPort)
  const existing = await health(port)
  if (existing && samePath(existing.repoRoot, abs)) return
  if (existing) return // 남의 포트다. 건드리지 않는다.
  savePort(abs, port)
  spawnDaemon(abs, port)
  // 데몬이 포트를 잡을 때까지만 잠깐 기다린다. 못 떠도 조용히 넘어간다 (P5).
  for (let i = 0; i < 20; i++) {
    const h = await health(port)
    if (h) return
    await new Promise(r => setTimeout(r, 250))
  }
}

async function cmdDoctor() {
  const checks = await doctor(root)
  console.log()
  for (const c of checks) {
    console.log(`  ${c.ok ? C.green('OK ') : C.yellow('!! ')} ${c.label}${c.detail ? C.dim('  ' + c.detail) : ''}`)
    if (c.fix) console.log(`      ${C.dim('-> ' + c.fix)}`)
  }
  const bad = checks.filter(c => !c.ok).length
  console.log(bad ? `
  ${C.yellow(`문제 ${bad}건`)}
` : `
  ${C.green('이상 없습니다.')}
`)
  process.exitCode = bad ? 1 : 0
}

async function cmdScan() {
  const { graph, files, ms } = await scan(root)
  const dir = path.join(root, '.codyssey')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graph.toJSON(), null, 2) + '\n')
  fs.writeFileSync(path.join(dir, 'ARCHITECTURE.md'), renderArchitecture(graph))
  console.log(
    `${files.size}개 파일 -> 노드 ${graph.nodes.size}, 연결 ${graph.edges.length}, 진입점 ${graph.entries.size}  (${ms.toFixed(0)}ms)`,
  )
  console.log(`  ${path.join(dir, 'graph.json')}`)
  console.log(`  ${path.join(dir, 'ARCHITECTURE.md')}`)
  if (graph.unresolved.length) console.log(`  ! 해석 못 한 import ${graph.unresolved.length}건`)
}

async function cmdStatus() {
  const { graph } = await scan(root)
  const feat = computeFeatures(graph)

  console.log(`\n${C.b('기능')} ${C.dim('(사용자가 실제로 쓰는 화면/API)')}`)
  for (const e of feat.roots) {
    console.log(`  ${e.id.padEnd(26)} ${String(feat.members.get(e.id)!.size).padStart(3)} files   ${C.dim(e.file)}`)
  }

  const locks = autolockCandidates(feat, 3)
  if (locks.length) {
    console.log(`\n${C.b('잠금 제안')} ${C.dim('(기능 3개 이상이 공유)')}`)
    for (const c of locks) console.log(`  ${c.file}\n      ${C.dim(c.features.join(', '))}`)
  }

  const cross = graph.edges.filter(e => e.kind === 'http')
  if (cross.length) {
    console.log(`\n${C.b('프론트 -> 백엔드')}`)
    for (const e of cross) {
      console.log(`  ${e.from}  ${C.blue('--[' + e.via + ']->')}  ${e.to}  ${C.dim('(' + e.confidence + ')')}`)
    }
  }

  if (graph.unresolved.length) {
    console.log(`\n${C.b('해석 못 한 import')} ${C.dim('(차단 근거로 쓰지 않음)')}`)
    for (const u of graph.unresolved) console.log(`  ${u.from}:${u.line}  ${u.spec}`)
  }
  console.log()
}

async function cmdImpact(file?: string) {
  if (!file) return console.error('사용법: codyssey impact <파일>')
  const { graph } = await scan(root)
  const feat = computeFeatures(graph)
  const target = graph.nodes.has(file) ? file : [...graph.nodes.keys()].find(k => k.endsWith(file))
  if (!target) return console.error(`그래프에서 못 찾음: ${file}`)

  const deps = [...graph.dependents(target)].filter(f => f !== target).sort()
  const feats = featuresOf(feat, target)

  console.log(`\n${C.b(target)}\n`)
  console.log(`영향 기능 ${feats.length}개`)
  for (const f of feats) console.log(`  ${f}`)
  const routes = allEntriesOf(feat, target).filter(e => !feats.includes(e))
  if (routes.length) {
    console.log(`\n경유 라우트 ${routes.length}개`)
    for (const r of routes) console.log(`  ${C.dim(r)}`)
  }
  console.log(`\n이 파일을 쓰는 곳 ${deps.length}개`)
  for (const d of deps) console.log(`  ${d}`)
  console.log()
}

/** P8: 정렬 고정. 코드가 안 바뀌면 이 파일도 안 바뀐다 -> diff 노이즈 0. */
function renderArchitecture(graph: Graph): string {
  const feat = computeFeatures(graph)
  const L: string[] = ['# Architecture', '', '> codyssey 자동 생성. 직접 수정하지 말 것.', '']

  L.push('## 기능 (최상위 진입점)', '')
  for (const e of feat.roots) L.push(`- \`${e.id}\` - ${e.file} (${feat.members.get(e.id)!.size} files)`)

  const locks = autolockCandidates(feat, 3)
  if (locks.length) {
    L.push('', '## 공유 모듈 (잠금 후보)', '')
    for (const c of locks) L.push(`- \`${c.file}\` - ${c.features.length} features: ${c.features.join(', ')}`)
  }

  const http = graph.edges.filter(e => e.kind === 'http')
  if (http.length) {
    L.push('', '## FE -> BE', '')
    for (const e of http) L.push(`- \`${e.via}\`: ${e.from} -> ${e.to} (${e.confidence})`)
  }
  return L.join('\n') + '\n'
}
