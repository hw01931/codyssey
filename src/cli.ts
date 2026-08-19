#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { scan } from './index/scan.ts'
import type { Graph } from './core/graph.ts'
import { computeFeatures, autolockCandidates, featuresOf, allEntriesOf } from './core/features.ts'

const [, , cmd = 'help', ...rest] = process.argv

const flag = (name: string, def: string) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : def
}
const positional = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--'))
const root = flag('root', '.')

switch (cmd) {
  case 'scan': await cmdScan(); break
  case 'status': await cmdStatus(); break
  case 'impact': await cmdImpact(positional[0]); break
  default: help()
}

function help() {
  console.log(`codyssey - AI 에이전트용 아키텍처 가드레일

  codyssey scan   [--root .]     그래프 + ARCHITECTURE.md 생성
  codyssey status [--root .]     기능/잠금후보/미해결 요약
  codyssey impact <file> [--root .]  이 파일을 고치면 뭐가 영향받나`)
}

async function cmdScan() {
  const { graph, files, ms } = await scan(root)
  const dir = path.join(root, '.codyssey')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graph.toJSON(), null, 2) + '\n')
  fs.writeFileSync(path.join(dir, 'ARCHITECTURE.md'), renderArchitecture(graph))
  console.log(
    `scanned ${files.size} files -> ${graph.nodes.size} nodes, ${graph.edges.length} edges, ` +
      `${graph.entries.size} entrypoints  (${ms.toFixed(0)}ms)`,
  )
  console.log(`  ${path.join(dir, 'graph.json')}`)
  console.log(`  ${path.join(dir, 'ARCHITECTURE.md')}`)
  if (graph.unresolved.length) console.log(`  ! ${graph.unresolved.length} unresolved imports (codyssey status 로 확인)`)
}

async function cmdStatus() {
  const { graph } = await scan(root)
  const feat = computeFeatures(graph)

  console.log('기능 (최상위 진입점 도달 기준)')
  for (const e of feat.roots) {
    console.log(`  ${e.id.padEnd(26)} ${String(feat.members.get(e.id)!.size).padStart(3)} files   ${e.file}`)
  }

  const locks = autolockCandidates(feat, 3)
  if (locks.length) {
    console.log('\n자동 잠금 후보 (3개 이상 기능이 공유)')
    for (const c of locks) console.log(`  ${c.file}\n      ${c.features.join(', ')}`)
  }

  const cross = graph.edges.filter(e => e.kind === 'http')
  if (cross.length) {
    console.log('\nFE -> BE 경계')
    for (const e of cross) console.log(`  ${e.from}  --[${e.via}]-->  ${e.to}  (${e.confidence})`)
  }

  if (graph.unresolved.length) {
    console.log('\n미해결 import (차단 근거로 쓰지 않음)')
    for (const u of graph.unresolved) console.log(`  ${u.from}:${u.line}  ${u.spec}`)
  }
}

async function cmdImpact(file?: string) {
  if (!file) return console.error('usage: codyssey impact <file>')
  const { graph } = await scan(root)
  const feat = computeFeatures(graph)
  const target = graph.nodes.has(file) ? file : [...graph.nodes.keys()].find(k => k.endsWith(file))
  if (!target) return console.error(`파일을 그래프에서 못 찾음: ${file}`)

  const deps = [...graph.dependents(target)].filter(f => f !== target).sort()
  const feats = featuresOf(feat, target)

  console.log(`${target}\n`)
  console.log(`영향 기능 ${feats.length}개`)
  for (const f of feats) console.log(`  ${f}`)
  const routes = allEntriesOf(feat, target).filter(e => !feats.includes(e))
  if (routes.length) {
    console.log(`
경유 라우트 ${routes.length}개`)
    for (const r of routes) console.log(`  ${r}`)
  }
  console.log(`\n이 파일을 쓰는 곳 ${deps.length}개`)
  for (const d of deps) console.log(`  ${d}`)
}

/** P8: 정렬 고정. 코드가 안 바뀌면 이 파일도 안 바뀐다 -> diff 노이즈 0. */
function renderArchitecture(graph: Graph): string {
  const feat = computeFeatures(graph)
  const L: string[] = ['# Architecture', '', '> codyssey 자동 생성. 직접 수정하지 말 것.', '']

  L.push('## 기능 (최상위 진입점)', '')
  for (const e of feat.roots) {
    L.push(`- \`${e.id}\` - ${e.file} (${feat.members.get(e.id)!.size} files)`)
  }

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
