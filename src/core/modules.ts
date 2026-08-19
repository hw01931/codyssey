import type { Graph } from './graph.ts'

/**
 * 모듈 = 폴더로 정해지는 코드 묶음.
 *
 * '기능 = 진입점 도달' 만으로는 라이브러리와 CLI 를 못 덮는다. 실측하니
 * 실제 레포에서 파일의 65~87% 가 어느 기능에도 안 속했고, 그 파일들에 대해
 * 도구가 아무 말도 못 했다.
 *
 * 모듈은 진입점이 있든 없든 항상 존재하고 모든 파일을 덮는다.
 * 기능이 '사용자 관점' 이라면 모듈은 '코드 관점' 이고, 둘 다 있어야 한다.
 */
export interface Modules {
  /** 파일 -> 모듈 이름 */
  of: Map<string, string>
  /** 모듈 이름 -> 그 안의 파일들 */
  members: Map<string, string[]>
}

/**
 * 프로젝트 루트 기준 상위 두 단계를 모듈로 본다.
 *   backend/app/api/routes/users.py  (projectRoot=backend)  ->  backend/app/api
 *   src/core/file/fileSearch.ts      (projectRoot=.)        ->  src/core
 * 규칙 하나로 고정한다. 프로젝트마다 다르게 추론하면 결과가 흔들려서 diff 가 무의미해진다.
 */
export function moduleOf(file: string, projectRoot: string, depth = 2): string {
  const base = projectRoot === '.' || projectRoot === '' ? '' : projectRoot + '/'
  const rest = file.startsWith(base) ? file.slice(base.length) : file
  const segs = rest.split('/')
  segs.pop() // 파일명 제거
  const taken = segs.slice(0, depth)
  return base + (taken.length ? taken.join('/') : '(루트)')
}

export function computeModules(
  graph: Graph,
  projectRootOf: (file: string) => string,
  depth = 2,
): Modules {
  const of = new Map<string, string>()
  const members = new Map<string, string[]>()
  for (const id of [...graph.nodes.keys()].sort()) {
    const m = moduleOf(id, projectRootOf(id), depth)
    of.set(id, m)
    const arr = members.get(m)
    if (arr) arr.push(id)
    else members.set(m, [id])
  }
  return { of, members }
}

/** 이 파일을 쓰는 쪽이 걸쳐 있는 모듈들 (자기 모듈 제외). */
export function consumerModules(graph: Graph, modules: Modules, file: string): string[] {
  const own = modules.of.get(file)
  const out = new Set<string>()
  for (const dep of graph.dependents(file)) {
    if (dep === file) continue
    const m = modules.of.get(dep)
    if (m && m !== own) out.add(m)
  }
  return [...out].sort()
}

/**
 * 여러 모듈이 함께 쓰는 파일. 진입점이 없는 프로젝트에서도 항상 나온다.
 * 여기가 깨지면 서로 상관없어 보이던 곳들이 한꺼번에 망가진다.
 */
export function crossModuleShared(
  graph: Graph,
  modules: Modules,
  min = 3,
): { file: string; modules: string[] }[] {
  const out: { file: string; modules: string[] }[] = []
  for (const file of graph.nodes.keys()) {
    const ms = consumerModules(graph, modules, file)
    if (ms.length >= min) out.push({ file, modules: ms })
  }
  return out.sort((a, b) => b.modules.length - a.modules.length || (a.file < b.file ? -1 : 1))
}
