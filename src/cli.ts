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
import { runMcp } from './mcp/server.ts'
import { archDiff, renderDiff, shouldFail } from './setup/archdiff.ts'
import { architectureMd, terminalMap, type ReportInput } from './render/report.ts'
import { Daemon as _D } from './daemon/server.ts'
import { setLang, resolveLang, t } from './i18n/index.ts'

const [, , cmd = 'help', ...rest] = process.argv

const flag = (name: string, def: string) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : def
}
const has = (name: string) => rest.includes(`--${name}`)
const positional = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--'))

const root = flag('root', '.')
const explicitPort = rest.includes('--port') ? Number(flag('port', '')) : undefined
const explicitLang = rest.includes('--lang') ? flag('lang', '') : undefined

// 명령을 실행하기 전에 쓸 말부터 정한다. 도움말과 에러도 이 말로 나와야 한다.
// init 은 스스로 다시 정한다 (아직 rules.yaml 이 없을 수 있으므로).
setLang(resolveLang(path.resolve(root), explicitLang), Boolean(explicitLang))

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
  case 'stop': await cmdStop(); break
  case 'doctor': await cmdDoctor(); break
  case 'mcp': await runMcp(path.resolve(root), explicitPort); break
  case 'diff': await cmdDiff(); break
  case 'map': await cmdMap(); break
  case 'scan': await cmdScan(); break
  case 'status': await cmdStatus(); break
  case 'impact': await cmdImpact(positional[0]); break
  default: help()
}

/**
 * 터미널에서 차지하는 칸 수. 한글·한자·가나는 두 칸이다.
 * 이걸 안 세면 말을 바꿨을 때 도움말 정렬이 어긋난다.
 */
function width(s: string): number {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    n += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
         (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
         (c >= 0xffe0 && c <= 0xffe6) ? 2 : 1
  }
  return n
}

function help() {
  // 말마다 명령 이름 길이가 달라지므로 폭을 고정하지 않고 그때그때 맞춘다.
  // 색을 입히기 전에 맞춰야 한다 - ANSI 코드는 칸을 차지하지 않는데 길이에는 잡힌다.
  const cmds: Array<[string, string, boolean]> = [
    ['codyssey init', t('cli.cmd.init'), true],
    ['codyssey start', t('cli.cmd.start'), true],
    ['codyssey stop', t('cli.cmd.stop'), false],
    ['codyssey ensure', t('cli.cmd.ensure'), false],
    ['codyssey doctor', t('cli.cmd.doctor'), true],
    ['codyssey mcp', t('cli.cmd.mcp'), false],
    ['codyssey map', t('cli.cmd.map'), true],
    [`codyssey diff ${t('cli.arg.base')}`, t('cli.cmd.diff'), true],
    ['codyssey scan', t('cli.cmd.scan'), false],
    ['codyssey status', t('cli.cmd.status'), false],
    [`codyssey impact ${t('cli.arg.file')}`, t('cli.cmd.impact'), false],
  ]
  const opts: Array<[string, string]> = [
    [`--root ${t('cli.arg.path')}`, t('cli.opt.root')],
    [`--port ${t('cli.arg.port')}`, t('cli.opt.port')],
    ['--no-open', t('cli.opt.noOpen')],
    ['--lang <en|ko>', t('cli.opt.lang')],
    ['--foreground', t('cli.opt.foreground')],
  ]
  const pad = (s: string, to: number) => s + ' '.repeat(Math.max(0, to - width(s)))
  const w = (rows: Array<[string, ...unknown[]]>) => Math.max(...rows.map(r => width(r[0]))) + 3

  const cw = w(cmds)
  const ow = w(opts)
  console.log(
    [
      '',
      `${C.b('CODYSSEY')} ${C.dim('- ' + t('cli.tagline'))}`,
      '',
      ...cmds.map(([name, desc, strong]) => `  ${strong ? C.b(pad(name, cw)) : C.dim(pad(name, cw))}${desc}`),
      '',
      ...opts.map(([name, desc]) => `  ${C.dim(pad(name, ow))}${desc}`),
      '',
    ].join('\n'),
  )
}

async function cmdInit() {
  console.log(`\n${C.b(t('cli.init.title'))}\n`)
  const r = await init(root, explicitPort, explicitLang)

  console.log('  ' + t('init.readFiles', { count: C.b(String(r.files)) }))
  console.log('  ' + t('init.foundFeatures', { count: C.b(String(r.features)) }))
  if (r.suggestions) {
    console.log('  ' + t('cli.init.suggestions', { count: C.yellow(String(r.suggestions)) }))
  }
  console.log()
  for (const w of r.wrote) console.log(`  ${C.green('+')} ${w}`)
  for (const s of r.skipped) console.log(`  ${C.dim('·')} ${C.dim(s)}`)

  console.log(`\n${C.green(t('cli.init.doneWord'))} ${t('init.done', { port: C.b(String(r.port)) })}`)
  console.log(`\n${C.yellow(t('cli.init.importantWord'))} ${t('cli.init.restartLine', { bold: C.b(t('cli.init.restartBold')) })}`)
  console.log(C.dim('       ' + t('init.restartWhy')))
  console.log(C.dim('       ' + t('init.restartThen')))

  // 데몬을 포그라운드로 물고 있으면 init 이 영영 끝나지 않는다.
  // README 는 "AI 에게 시켜도 됩니다" 라고 안내하는데, 에이전트가 실행하면
  // 무한 대기하다 타임아웃난다. 백그라운드로 띄우고 바로 빠진다.
  if (has('foreground')) {
    console.log()
    await cmdStart(r.port)
    return
  }

  const abs = path.resolve(root)
  if (!(await health(r.port))) {
    spawnDaemon(abs, r.port)
    for (let i = 0; i < 20 && !(await health(r.port)); i++) {
      await new Promise(res => setTimeout(res, 250))
    }
  }
  const url = `http://127.0.0.1:${r.port}`
  const up = Boolean(await health(r.port))
  console.log(`\n${up ? C.green(t('init.running')) : C.yellow(t('init.notReady'))}  ${C.blue(url)}`)
  console.log(C.dim('  ' + t('init.stopHint') + '\n'))
  if (!has('no-open')) openBrowser(url)
}

/** 백그라운드로 띄운 데몬을 끈다. */
async function cmdStop() {
  const abs = path.resolve(root)
  const port = await resolvePort(abs, explicitPort)
  const h = await health(port)
  if (!h) return console.log(t('cli.stop.notRunning'))
  if (!samePath(h.repoRoot, abs)) {
    return console.error(t('cli.stop.foreign', { port, root: h.repoRoot }))
  }
  try {
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) })
  } catch {
    /* 종료 중에는 응답이 끊기는 게 정상이다 */
  }
  console.log(t('cli.stop.done'))
}

async function cmdStart(known?: number) {
  const abs = path.resolve(root)
  const port = known ?? (await resolvePort(abs, explicitPort))

  // 포트를 남이 잡고 있으면 절대 그 위에 얹지 않는다.
  // 예전에는 이 상황에서 훅이 남의 데몬한테 물어보고 전부 통과됐다.
  const existing = await health(port)
  if (existing && !samePath(existing.repoRoot, abs)) {
    console.error(`\n${C.yellow(t('cli.start.portTaken', { port }))}`)
    console.error(C.dim('  ' + t('cli.start.theirFolder', { root: existing.repoRoot })))
    console.error(C.dim('  ' + t('cli.start.reinit') + '\n'))
    process.exit(1)
  }
  if (existing) {
    const url = `http://127.0.0.1:${port}`
    console.log(`${C.b('CODYSSEY')} ${t('cli.start.already')}  ${C.blue(url)}`)
    if (!has('no-open')) openBrowser(url)
    return
  }

  savePort(abs, port)
  const d = new Daemon(root, port)
  try {
    await d.start()
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'EADDRINUSE') {
      console.error(`\n${t('cli.start.cantBind', { port })}\n`)
      process.exit(1)
    }
    throw err
  }

  const url = `http://127.0.0.1:${port}`
  console.log(`${C.b('CODYSSEY')} ${t('cli.start.running')}  ${C.blue(url)}`)
  console.log(`  ${t('status.files')} ${d.graph.nodes.size} · ${t('status.features')} ${d.features.roots.length} · ${t('status.locks')} ${d.rules.protect.length}`)
  console.log(C.dim('  ' + t('cli.start.watching') + '\n'))
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
  ${C.yellow(t('cli.doctor.problems', { count: bad }))}
` : `
  ${C.green(t('doctor.ok'))}
`)
  process.exitCode = bad ? 1 : 0
}

async function cmdDiff() {
  const base = positional[0] ?? 'origin/main'
  // 규칙과 잠금 목록은 데몬을 띄우지 않고 파일에서 직접 읽는다 (CI 에서 돌아야 한다)
  const d0 = new _D(root, 0)
  await d0.fullScan()
  d0.loadRules()
  let d
  try {
    d = await archDiff(root, base, d0.rules, d0.lockedFiles())
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not a git repository|unknown revision|bad revision|ambiguous argument/i.test(msg)) {
      console.error(`\n${t('cli.diff.cantCompare', { base })}`)
      console.error(C.dim('  ' + t('cli.diff.notRepo')))
      console.error(C.dim('  ' + t('cli.diff.example') + '\n'))
      process.exitCode = 1
      return
    }
    throw err
  }
  const md = renderDiff(d)

  if (has('markdown')) console.log(md)
  else {
    console.log()
    console.log(md.replace(/^#+ /gm, '').replace(/`/g, '').replace(/<sub>.*<\/sub>/g, ''))
  }
  if (has('fail-on-violation') && shouldFail(d)) process.exitCode = 1
}

/** 브라우저 없이 쓰는 산출물들의 공통 입력 */
async function reportInput(): Promise<ReportInput> {
  const d = new _D(root, 0)
  await d.fullScan()
  d.loadRules()
  return {
    graph: d.graph,
    features: d.features,
    modules: d.modules,
    lockedFiles: d.lockedFiles(),
    minModules: d.rules.autolock.minModules ?? 3,
  }
}

async function cmdMap() {
  console.log()
  console.log(terminalMap(await reportInput(), !has('no-color')))
  console.log()
}

async function cmdScan() {
  const { graph, files, ms } = await scan(root)
  const dir = path.join(root, '.codyssey')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graph.toJSON(), null, 2) + '\n')
  fs.writeFileSync(path.join(dir, 'ARCHITECTURE.md'), architectureMd(await reportInput()))
  console.log(
    t('cli.scan.result', { files: files.size, nodes: graph.nodes.size, edges: graph.edges.length, entries: graph.entries.size, ms: ms.toFixed(0) }),
  )
  console.log(`  ${path.join(dir, 'graph.json')}`)
  console.log(`  ${path.join(dir, 'ARCHITECTURE.md')}`)
  if (graph.unresolved.length) console.log('  ' + t('cli.scan.unresolved', { count: graph.unresolved.length }))
}

async function cmdStatus() {
  const { graph } = await scan(root)
  const feat = computeFeatures(graph)

  console.log(`\n${C.b(t('cli.status.features'))} ${C.dim(t('cli.status.featuresHint'))}`)
  for (const e of feat.roots) {
    console.log(`  ${e.id.padEnd(26)} ${String(feat.members.get(e.id)!.size).padStart(3)} files   ${C.dim(e.file)}`)
  }

  const locks = autolockCandidates(feat, 3)
  if (locks.length) {
    console.log(`\n${C.b(t('cli.status.locks'))} ${C.dim(t('cli.status.locksHint'))}`)
    for (const c of locks) console.log(`  ${c.file}\n      ${C.dim(c.features.join(', '))}`)
  }

  const cross = graph.edges.filter(e => e.kind === 'http')
  if (cross.length) {
    console.log(`\n${C.b(t('cli.status.frontBack'))}`)
    for (const e of cross) {
      console.log(`  ${e.from}  ${C.blue('--[' + e.via + ']->')}  ${e.to}  ${C.dim('(' + e.confidence + ')')}`)
    }
  }

  if (graph.unresolved.length) {
    console.log(`\n${C.b(t('cli.status.unresolved'))} ${C.dim(t('cli.status.unresolvedHint'))}`)
    for (const u of graph.unresolved) console.log(`  ${u.from}:${u.line}  ${u.spec}`)
  }
  console.log()
}

async function cmdImpact(file?: string) {
  if (!file) return console.error(t('cli.impact.usage'))
  const { graph } = await scan(root)
  const feat = computeFeatures(graph)
  const target = graph.nodes.has(file) ? file : [...graph.nodes.keys()].find(k => k.endsWith(file))
  if (!target) return console.error(t('cli.impact.notFound', { file }))

  const deps = [...graph.dependents(target)].filter(f => f !== target).sort()
  const feats = featuresOf(feat, target)

  console.log(`\n${C.b(target)}\n`)
  console.log(t('cli.impact.features', { count: feats.length }))
  for (const f of feats) console.log(`  ${f}`)
  const routes = allEntriesOf(feat, target).filter(e => !feats.includes(e))
  if (routes.length) {
    console.log(`\n${t('cli.impact.routes', { count: routes.length })}`)
    for (const r of routes) console.log(`  ${C.dim(r)}`)
  }
  console.log(`\n${t('cli.impact.users', { count: deps.length })}`)
  for (const d of deps) console.log(`  ${d}`)
  console.log()
}
