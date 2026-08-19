import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import chokidar from 'chokidar'
import { buildGraph, createCtx, listFiles, parseFile, adapterFor, type FileInfo } from '../index/scan.ts'
import { computeFeatures, allFilesOf, autolockCandidates, exclusiveOf, featuresOf, type Features } from '../core/features.ts'
import { checkEdit, defaultRules, findViolations, suggestRules, type Rules, type Verdict } from '../core/rules.ts'
import type { Graph } from '../core/graph.ts'
import type { ResolveCtx } from '../core/ir.ts'

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')

export interface Activity {
  at: number
  file: string
  action: Verdict['action'] | 'foreign'
  reason?: string
  rule?: string
  tool: string
}

export class Daemon {
  repoRoot: string
  port: number
  files = new Map<string, FileInfo>()
  graph!: Graph
  features!: Features
  rules: Rules = defaultRules()
  activity: Activity[] = []
  /** 우리 루트 밖에서 들어온 요청 수. 0 이 아니면 포트 설정이 잘못된 것이다. */
  foreign = 0
  private ctx!: ResolveCtx
  private server?: http.Server
  private watcher?: chokidar.FSWatcher
  private rebuildTimer?: NodeJS.Timeout

  constructor(repoRoot: string, port = 7777) {
    this.repoRoot = path.resolve(repoRoot)
    this.port = port
  }

  get rulesPath() {
    return path.join(this.repoRoot, '.codyssey', 'rules.yaml')
  }

  async start({ watch = true } = {}) {
    await this.fullScan()
    this.loadRules()
    if (watch) this.startWatching()
    await this.listen()
    return this
  }

  async stop() {
    await this.watcher?.close()
    await new Promise<void>(r => (this.server ? this.server.close(() => r()) : r()))
  }

  // -------------------------------------------------------------- 인덱싱

  async fullScan() {
    this.ctx = createCtx(this.repoRoot)
    this.files.clear()
    for (const rel of listFiles(this.repoRoot)) {
      const info = await parseFile(this.repoRoot, rel, this.ctx)
      if (info) this.files.set(rel, info)
    }
    this.rebuild()
  }

  /** 파일 하나만 다시 파싱하고 그래프를 재구성한다. 파싱이 비싼 부분이라 이걸로 충분히 빠르다. */
  async reindex(rel: string) {
    const abs = path.join(this.repoRoot, rel)
    if (!fs.existsSync(abs)) this.files.delete(rel)
    else {
      const info = await parseFile(this.repoRoot, rel, this.ctx)
      if (info) this.files.set(rel, info)
      else this.files.delete(rel)
    }
    this.rebuild()
  }

  private rebuild() {
    this.graph = buildGraph(this.files, this.ctx, this.repoRoot)
    this.features = computeFeatures(this.graph)
  }

  private startWatching() {
    this.watcher = chokidar.watch(this.repoRoot, {
      ignored: (p: string) =>
        /[\\/](node_modules|\.git|dist|build|out|\.next|__pycache__|\.venv|venv|\.codyssey)[\\/]?/.test(p),
      ignoreInitial: true,
    })
    const onChange = (abs: string) => {
      const rel = this.toRel(abs)
      if (!adapterFor(rel)) return
      clearTimeout(this.rebuildTimer)
      this.rebuildTimer = setTimeout(() => void this.reindex(rel), 120)
    }
    this.watcher.on('add', onChange).on('change', onChange).on('unlink', onChange)
  }

  // -------------------------------------------------------------- 룰

  loadRules() {
    try {
      if (fs.existsSync(this.rulesPath)) {
        const parsed = YAML.parse(fs.readFileSync(this.rulesPath, 'utf8'))
        this.rules = { ...defaultRules(), ...(parsed ?? {}) }
        this.rules.protect ??= []
        this.rules.features ??= []
        this.rules.layers ??= []
        this.rules.autolock = { ...defaultRules().autolock, ...(this.rules.autolock ?? {}) }
      }
    } catch {
      // P5: 룰 파일이 깨져도 데몬은 산다. 대신 아무것도 막지 않는다.
      this.rules = defaultRules()
    }
  }

  saveRules() {
    fs.mkdirSync(path.dirname(this.rulesPath), { recursive: true })
    fs.writeFileSync(this.rulesPath, YAML.stringify(this.rules))
  }

  /** 기능 단위 잠금. 기본은 그 기능만 쓰는 파일에만 걸린다. */
  setFeatureLock(id: string, locked: boolean, scope: 'exclusive' | 'all' = 'exclusive', reason?: string) {
    this.rules.features = (this.rules.features ?? []).filter(f => f.id !== id)
    if (locked) this.rules.features.push({ id, scope, reason: reason ?? `'${id}' 기능 잠금` })
    this.rules.features.sort((a, b) => (a.id < b.id ? -1 : 1))
    this.saveRules()
  }

  setLock(file: string, locked: boolean, reason?: string) {
    this.rules.protect = this.rules.protect.filter(p => p.path !== file)
    if (locked) this.rules.protect.push({ path: file, reason: reason ?? '수동 잠금' })
    this.rules.protect.sort((a, b) => (a.path < b.path ? -1 : 1))
    this.saveRules()
  }

  // -------------------------------------------------------------- 판정

  decide(tool: string, input: Record<string, unknown>): Verdict {
    const raw = String(input.file_path ?? input.path ?? '')
    if (!raw) return { action: 'allow' }
    const file = this.toRel(raw)

    // 우리 프로젝트 밖의 파일이다. 포트가 겹쳐서 남의 훅이 들어온 것이다.
    // 통과시키되(P5) 반드시 눈에 보이게 남긴다. 조용히 넘기면 아무도 모른다.
    if (file.startsWith('../')) {
      this.foreign++
      this.log({ at: Date.now(), file: raw, action: 'foreign', tool, reason: '다른 프로젝트의 파일입니다' })
      return { action: 'allow' }
    }

    if (!this.graph.nodes.has(file) && !this.rules.protect.some(p => p.path === file)) {
      // 그래프에 없는 파일(새 파일, 설정파일 등)에 대해서는 아무 주장도 하지 않는다
      return { action: 'allow' }
    }
    const added = String(input.new_string ?? input.content ?? '')
    const verdict = checkEdit(this.rules, this.graph, this.features, {
      file,
      added,
      resolve: (spec, from) => {
        const adapter = this.files.get(from)?.adapter ?? adapterFor(from)
        return adapter?.resolve(spec, from, this.ctx)?.path ?? null
      },
    })
    this.log({ at: Date.now(), file, action: verdict.action, tool, ...(verdict.action !== 'allow' ? { reason: verdict.reason, rule: verdict.rule } : {}) })
    return verdict
  }

  private log(a: Activity) {
    this.activity.unshift(a)
    if (this.activity.length > 200) this.activity.length = 200
  }

  toRel(p: string) {
    const abs = path.isAbsolute(p) ? p : path.join(this.repoRoot, p)
    return path.relative(this.repoRoot, abs).split(path.sep).join('/')
  }

  // -------------------------------------------------------------- 상태

  state() {
    const locked = new Set(this.rules.protect.map(p => p.path))
    for (const fr of this.rules.features ?? []) {
      const files = (fr.scope ?? 'exclusive') === 'all' ? allFilesOf(this.features, fr.id) : exclusiveOf(this.features, fr.id)
      for (const f of files) locked.add(f)
    }
    return {
      repoRoot: this.repoRoot,
      counts: {
        files: this.graph.nodes.size,
        edges: this.graph.edges.length,
        features: this.features.roots.length,
        locks: locked.size,
      },
      features: this.features.roots.map(r => {
        const fr = (this.rules.features ?? []).find(f => f.id === r.id)
        return {
          id: r.id,
          kind: r.kind,
          file: r.file,
          size: this.features.members.get(r.id)?.size ?? 0,
          exclusive: exclusiveOf(this.features, r.id).length,
          locked: Boolean(fr),
          scope: fr?.scope ?? 'exclusive',
        }
      }),
      nodes: [...this.graph.nodes.values()].map(n => ({
        id: n.id,
        lang: n.lang,
        features: featuresOf(this.features, n.id),
        symbols: n.symbols.length,
        locked: locked.has(n.id),
        isEntry: this.features.entries.some(e => e.file === n.id),
      })),
      edges: this.graph.edges.map(e => ({ from: e.from, to: e.to, kind: e.kind, confidence: e.confidence, via: e.via })),
      suggestions: autolockCandidates(this.features, this.rules.autolock.minFeatures)
        .filter(c => !locked.has(c.file))
        .map(c => ({ file: c.file, features: c.features })),
      violations: findViolations(this.rules, this.graph),
      unresolved: this.graph.unresolved,
      rules: this.rules,
      foreign: this.foreign,
      activity: this.activity.slice(0, 50),
    }
  }

  // -------------------------------------------------------------- HTTP

  private listen() {
    return new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => void this.handle(req, res))
      this.server.on('error', reject)
      this.server.listen(this.port, '127.0.0.1', resolve)
    })
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    const send = (code: number, body: unknown, type = 'application/json') => {
      const payload = type === 'application/json' ? JSON.stringify(body) : String(body)
      res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' })
      res.end(payload)
    }

    try {
      if (url.pathname === '/health') {
        // repoRoot 를 같이 준다. 어느 프로젝트의 데몬인지 확인할 수 있어야
        // 포트가 겹쳤을 때 조용히 엉뚱한 데몬한테 물어보는 일이 없다.
        return send(200, { ok: true, files: this.graph.nodes.size, repoRoot: this.repoRoot })
      }

      if (url.pathname === '/pre' && req.method === 'POST') {
        const body = await readJson(req)
        const verdict = this.decide(String(body.tool_name ?? ''), (body.tool_input ?? {}) as Record<string, unknown>)
        if (verdict.action === 'allow') return send(200, {}) // 조용히 통과 = 컨텍스트 0토큰
        return send(200, {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: verdict.action === 'block' ? 'deny' : 'escalate',
            permissionDecisionReason: `[codyssey] ${verdict.reason}`,
            ...(verdict.hint ? { additionalContext: verdict.hint } : {}),
          },
        })
      }

      if (url.pathname === '/post' && req.method === 'POST') {
        const body = await readJson(req)
        const input = (body.tool_input ?? {}) as Record<string, unknown>
        const rel = this.toRel(String(input.file_path ?? ''))
        if (rel && adapterFor(rel)) await this.reindex(rel)
        return send(200, {})
      }

      if (url.pathname === '/api/state') return send(200, this.state())

      if (url.pathname === '/api/lock' && req.method === 'POST') {
        const body = await readJson(req)
        this.setLock(String(body.file), Boolean(body.locked), body.reason ? String(body.reason) : undefined)
        return send(200, { ok: true, rules: this.rules })
      }

      if (url.pathname === '/api/lock-feature' && req.method === 'POST') {
        const body = await readJson(req)
        this.setFeatureLock(
          String(body.id),
          Boolean(body.locked),
          body.scope === 'all' ? 'all' : 'exclusive',
          body.reason ? String(body.reason) : undefined,
        )
        return send(200, { ok: true, rules: this.rules })
      }

      if (url.pathname === '/api/rescan' && req.method === 'POST') {
        await this.fullScan()
        this.loadRules()
        return send(200, { ok: true, files: this.graph.nodes.size })
      }

      // UI
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      const abs = path.join(UI_DIR, file)
      if (abs.startsWith(UI_DIR) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const type = abs.endsWith('.html') ? 'text/html' : abs.endsWith('.js') ? 'text/javascript' : 'text/css'
        return send(200, fs.readFileSync(abs, 'utf8'), type)
      }
      send(404, { error: 'not found' })
    } catch (err) {
      // P5: 데몬이 터져도 편집은 막히면 안 된다. 빈 200 = 통과.
      send(200, {})
      void err
    }
  }
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    // 문자열로 이어붙이면 멀티바이트 문자가 청크 경계에서 깨진다. 버퍼로 모은 뒤 한 번에 디코딩.
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}
