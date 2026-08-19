import type { Graph, Entry } from './graph.ts'

/**
 * 기능 = 진입점에서 도달 가능한 서브그래프. LLM 불필요, 완전 결정적.
 * 여기서 두 가지가 공짜로 나온다:
 *   1) 기능 단위 영향 반경 (파일 단위보다 사람이 읽기 쉽다)
 *   2) 자동 잠금 후보 (여러 기능이 공유하는 파일 = 위험)
 */
export interface Features {
  /** 진입점 id -> 그 기능에 속한 파일들 */
  members: Map<string, Set<string>>
  /** 파일 -> 그 파일에 닿는 모든 진입점 id (정렬됨) */
  owners: Map<string, string[]>
  /** 파일 -> 그 파일에 닿는 최상위 진입점만 (정렬됨) */
  rootOwners: Map<string, string[]>
  entries: Entry[]
  /**
   * 최상위 진입점. FE 페이지가 http 로 BE 라우트에 닿으면 그 라우트는
   * 독립 기능이 아니라 페이지 기능의 일부다. 안 그러면 기능이 이중계산돼서
   * 잠금 후보가 소음이 된다. (FE 가 안 부르는 공개 API 는 그대로 최상위)
   */
  roots: Entry[]
}

export function computeFeatures(graph: Graph): Features {
  const entries = [...graph.entries.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
  const members = new Map<string, Set<string>>()
  for (const e of entries) members.set(e.id, graph.reachable(e.file))

  const roots = entries.filter(e => !entries.some(o => o.id !== e.id && members.get(o.id)!.has(e.file)))

  const owners = new Map<string, string[]>()
  const rootOwners = new Map<string, string[]>()
  const rootIds = new Set(roots.map(r => r.id))
  for (const e of entries) {
    for (const f of members.get(e.id)!) {
      push(owners, f, e.id)
      if (rootIds.has(e.id)) push(rootOwners, f, e.id)
    }
  }
  for (const m of [owners, rootOwners]) for (const arr of m.values()) arr.sort()

  return { members, owners, rootOwners, entries, roots }
}

/** 이 파일을 고치면 영향받는 기능들(최상위 기준). 사람에게 보여줄 단위. */
export function featuresOf(features: Features, file: string): string[] {
  return features.rootOwners.get(file) ?? []
}

/** 영향받는 라우트 전부(최상위로 흡수된 것 포함). 디버깅/정밀 조회용. */
export function allEntriesOf(features: Features, file: string): string[] {
  return features.owners.get(file) ?? []
}

function push(m: Map<string, string[]>, k: string, v: string) {
  const arr = m.get(k)
  if (arr) arr.push(v)
  else m.set(k, [v])
}

/**
 * 이 기능'만' 쓰는 파일들. 기능 단위 잠금의 기본 단위다.
 * 공유 파일까지 잠그면 다른 기능 작업이 같이 막혀서 쓸모가 없어진다.
 */
export function exclusiveOf(features: Features, featureId: string): string[] {
  return [...(features.members.get(featureId) ?? [])]
    .filter(f => {
      const owners = features.rootOwners.get(f) ?? []
      return owners.length === 1 && owners[0] === featureId
    })
    .sort()
}

/** 이 기능이 닿는 파일 전부 (공유 파일 포함). */
export function allFilesOf(features: Features, featureId: string): string[] {
  return [...(features.members.get(featureId) ?? [])].sort()
}

/**
 * 자동 잠금 후보: minFeatures 개 이상의 기능이 공유하는 파일.
 * 사람은 rules.yaml 을 처음부터 쓸 필요 없이 이 제안을 승인만 하면 된다.
 */
export function autolockCandidates(features: Features, minFeatures = 3): { file: string; features: string[] }[] {
  return [...features.rootOwners.entries()]
    .filter(([file, fs]) => fs.length >= minFeatures && !features.entries.some(e => e.file === file))
    .map(([file, fs]) => ({ file, features: fs }))
    .sort((a, b) => b.features.length - a.features.length || (a.file < b.file ? -1 : 1))
}
