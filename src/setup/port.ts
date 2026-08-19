import fs from 'node:fs'
import path from 'node:path'

/**
 * 포트는 프로젝트마다 다르다.
 *
 * 모든 프로젝트가 7777 을 쓰면, 먼저 뜬 데몬이 포트를 잡고 있는 동안
 * 다른 프로젝트의 훅이 그 데몬한테 물어보게 된다. 남의 그래프에는 내 파일이 없으니
 * 전부 통과된다 - 아무것도 안 막히는데 아무 에러도 안 난다.
 * 실제로 겪었고, 조용히 실패하는 게 제일 나쁘다.
 */
export function projectPort(repoRoot: string): number {
  const key = path.resolve(repoRoot).toLowerCase().split(path.sep).join('/')
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return 7800 + ((h >>> 0) % 180) // 7800-7979
}

export interface Health {
  ok: boolean
  files: number
  repoRoot?: string
}

/** 훅에서도 쓰므로 빠르게 포기한다. */
export async function health(port: number, timeoutMs = 600): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return (await res.json()) as Health
  } catch {
    return null
  }
}

export const samePath = (a?: string, b?: string) =>
  Boolean(a && b) && path.resolve(a!).toLowerCase() === path.resolve(b!).toLowerCase()

const portFile = (repoRoot: string) => path.join(repoRoot, '.codyssey', 'port')

export function savePort(repoRoot: string, port: number) {
  const p = portFile(repoRoot)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, String(port) + '\n')
}

export function loadPort(repoRoot: string): number | null {
  try {
    const n = Number(fs.readFileSync(portFile(repoRoot), 'utf8').trim())
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * 이 프로젝트가 쓸 포트를 정한다.
 * 이미 우리 데몬이 떠 있으면 그 포트를, 아니면 빈 포트를 찾는다.
 * 남의 프로젝트가 잡고 있는 포트는 절대 고르지 않는다.
 */
export async function resolvePort(repoRoot: string, explicit?: number): Promise<number> {
  const root = path.resolve(repoRoot)
  if (explicit) return explicit

  const candidates = [loadPort(root), projectPort(root)].filter((p): p is number => Boolean(p))
  for (const port of candidates) {
    const h = await health(port)
    if (!h || samePath(h.repoRoot, root)) return port
  }

  // 해시가 겹쳤다. 빈 자리를 찾을 때까지 뒤로 민다.
  const base = projectPort(root)
  for (let i = 1; i < 60; i++) {
    const port = 7800 + ((base - 7800 + i) % 180)
    const h = await health(port)
    if (!h || samePath(h.repoRoot, root)) return port
  }
  return base
}
