import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import chokidar from 'chokidar'
import { buildGraph, createCtx, listFiles, parseFile, adapterFor, type FileInfo } from '../index/scan.ts'
import { computeFeatures, allFilesOf, autolockCandidates, exclusiveOf, featuresOf, type Features } from '../core/features.ts'
import { checkEdit, defaultRules, findViolations, inertRules, matches, type Rules, type Verdict } from '../core/rules.ts'
import { shellWrites } from '../core/shell.ts'
import { computeModules, consumerModules, crossModuleShared, type Modules } from '../core/modules.ts'
import type { Graph } from '../core/graph.ts'
import type { ResolveCtx } from '../core/ir.ts'
import { deltaBrief, promptBrief, sessionBrief, snapshotEdges, type CtxInput } from './context.ts'
import { brokenContracts, contractsOf, duplicateNames, nameIndex, testsFor } from '../core/contract.ts'

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')

/** 한 명령이 여러 파일을 건드리면 제일 센 판정이 이긴다. */
const RANK = { allow: 0, ask: 1, block: 2 } as const

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
  modules!: Modules
  private names = new Map<string, string[]>()
  rules: Rules = defaultRules()
  activity: Activity[] = []
  /** 우리 루트 밖에서 들어온 요청 수. 0 이 아니면 포트 설정이 잘못된 것이다. */
  foreign = 0
  /** 세션마다 이미 알려준 것. 같은 말을 두 번 하면 토큰만 쓴다. */
  private told = new Map<string, Set<string>>()
  private ctx!: ResolveCtx
  private server?: http.Server
  private watcher?: chokidar.FSWatcher
  private rebuildTimer?: NodeJS.Timeout
  /** 디바운스 동안 밀린 변경 파일들. 타이머 하나에 파일 하나만 실으면 나머지가 사라진다. */
  private pending = new Set<string>()

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
    this.modules = computeModules(this.graph, id => this.files.get(id)?.projectRoot ?? '.')
    this.names = nameIndex(this.graph)
  }

  /** 밀려 있던 파일을 전부 다시 읽는다. 그래프 재구성은 마지막에 한 번만. */
  private async flushPending() {
    const rels = [...this.pending]
    this.pending.clear()
    for (const rel of rels) {
      const abs = path.join(this.repoRoot, rel)
      if (!fs.existsSync(abs)) {
        this.files.delete(rel)
        continue
      }
      const info = await parseFile(this.repoRoot, rel, this.ctx)
      if (info) this.files.set(rel, info)
      else this.files.delete(rel)
    }
    this.rebuild()
  }

  private startWatching() {
    this.watcher = chokidar.watch(this.repoRoot, {
      ignored: (p: string) =>
        /[\\/](node_modules|\.git|dist|build|out|\.next|__pycache__|\.venv|venv|\.codyssey)[\\/]?/.test(p),
      ignoreInitial: true,
    })
    // 타이머 하나에 파일 하나만 실으면, 여러 파일이 한꺼번에 바뀔 때(git checkout,
    // 포매터 일괄 실행) 마지막 하나만 남고 나머지가 조용히 사라진다. 실측으로 4개 중
    // 3개가 누락됐다. 밀린 파일을 모아뒀다가 한 번에 처리한다.
    const onChange = (abs: string) => {
      const rel = this.toRel(abs)
      if (!adapterFor(rel)) return
      this.pending.add(rel)
      clearTimeout(this.rebuildTimer)
      this.rebuildTimer = setTimeout(() => void this.flushPending(), 120)
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
        this.rules.contracts = { ...defaultRules().contracts, ...(this.rules.contracts ?? {}) }
        this.rules.autolock = { ...defaultRules().autolock, ...(this.rules.autolock ?? {}) }
      }
    } catch {
      // P5: 룰 파일이 깨져도 데몬은 산다. 대신 아무것도 막지 않는다.
      // 기본값으로 되돌리면 읽지도 못한 설정을 근거로 질문하기 시작한다.
      this.rules = inertRules()
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
    // Bash 는 파일 인자가 없다. 명령문에서 쓰기 대상을 직접 뽑아내야 한다.
    if (tool === 'Bash') return this.decideBash(tool, String(input.command ?? ''))

    const raw = String(input.file_path ?? input.path ?? '')
    if (!raw) return { action: 'allow' }
    const file = this.toRel(raw)

    // 우리 프로젝트 밖의 파일이다. 포트가 겹쳐서 남의 훅이 들어온 것이다.
    // 통과시키되(P5) 반드시 눈에 보이게 남긴다. 조용히 넘기면 아무도 모른다.
    if (file.startsWith('../')) return this.foreignAllow(tool, raw)

    const after = String(input.new_string ?? input.content ?? '')
    const before = String(input.old_string ?? '')
    const whole = input.content !== undefined && input.old_string === undefined

    let verdict = this.checkFile(file, after)
    if (verdict.action === 'allow') verdict = this.checkContract(file, { before, after, whole })

    this.log({ at: Date.now(), file, action: verdict.action, tool, ...(verdict.action !== 'allow' ? { reason: verdict.reason, rule: verdict.rule } : {}) })
    return verdict
  }

  /**
   * 밖에 약속한 이름을 없애는 중인가.
   *
   * 파일 단위 잠금으로는 안 잡힌다. 그 파일을 고치는 건 대부분 정상이고,
   * 문제는 '그 안의 특정 이름' 이기 때문이다.
   */
  private checkContract(file: string, edit: { before: string; after: string; whole: boolean }): Verdict {
    if (this.rules.contracts?.mode === 'off') return { action: 'allow' }
    const broken = brokenContracts(contractsOf(this.graph, file), edit)
    if (!broken.length) return { action: 'allow' }

    const c = broken[0]
    const others = broken.length > 1 ? ` 외 ${broken.length - 1}개` : ''
    return {
      action: this.rules.contracts?.mode === 'block' ? 'block' : 'ask',
      rule: `contract: ${file}#${c.name}`,
      reason: `'${c.name}' 을(를) 없애려 합니다${others}. ${c.users.length}곳이 이 이름을 가져다 씁니다.`,
      hint: `쓰는 곳: ${c.users.slice(0, 5).join(', ')}${c.users.length > 5 ? ' 외' : ''}`,
    }
  }

  /** 편집 뒤 알려줄 것: 돌려야 할 테스트, 이미 있는 이름. */
  afterEditNotes(file: string, edit: { before: string; after: string }): string[] {
    const notes: string[] = []

    const dupes = duplicateNames(this.names, file, edit)
    for (const d of dupes) {
      notes.push(`'${d.name}' 은(는) ${d.existing.slice(0, 2).join(', ')} 에 이미 있습니다. 새로 만들 필요가 있는지 확인하세요.`)
    }

    const tests = testsFor(this.graph, file)
    if (tests.length) notes.push(`이 파일을 검증하는 테스트: ${tests.slice(0, 3).join(', ')}${tests.length > 3 ? ` 외 ${tests.length - 3}개` : ''}`)

    return notes
  }

  /**
   * Bash 판정.
   *
   * Edit/Write 만 막으면 `sed -i` 나 heredoc 으로 그대로 우회된다. 실제로 뚫렸다.
   * 셸을 완전히 해석할 수는 없으므로 확신의 정도를 나눠서 다루게 한다.
   *   짚어낸 대상  Edit 과 똑같이 판정한다 (막을 수 있다)
   *   못 짚은 명령  사람이 '일부러 잠근' 파일이 명령문에 보일 때만 막는다
   * 둘 다 아니면 통과다. 명령 하나 때문에 셸 전체를 막으면 즉시 제거당한다. (D9)
   */
  private decideBash(tool: string, command: string): Verdict {
    if (!command.trim()) return { action: 'allow' }
    const { targets, opaque, words } = shellWrites(command)

    // 1) 확실히 짚어낸 쓰기 대상
    let worst: Verdict = { action: 'allow' }
    let worstFile = ''
    for (const t of targets) {
      const file = this.toRel(t)
      if (file.startsWith('../')) {
        this.foreignAllow(tool, t)
        continue
      }
      const v = this.checkFile(file, command)
      if (RANK[v.action] > RANK[worst.action]) {
        worst = v
        worstFile = file
      }
    }
    if (worst.action !== 'allow') {
      this.log({ at: Date.now(), file: worstFile, action: worst.action, tool, reason: worst.reason, rule: worst.rule })
      return { ...worst, reason: `${worst.reason}\n이 명령이 '${worstFile}' 을 고칩니다.` }
    }

    // 2) 대상을 못 짚은 명령(python -c, git checkout, find -exec ...).
    //    잠긴 파일 이름이 명령에 들어 있으면 막는다. 판단 근거가 '사람이 건 잠금' 이라
    //    P4 를 어기지 않는다. 잠금과 무관한 명령은 여기까지 와도 통과한다.
    if (opaque) {
      const cmd = command.replace(/\\/g, '/')
      const hit = [...this.lockedFiles()].filter(f => cmd.includes(f) || words.some(w => matches(w, f))).sort()
      if (hit.length) {
        const verdict: Verdict = {
          action: 'block',
          rule: 'bash: 해석할 수 없는 명령',
          reason: `잠긴 파일이 명령에 들어 있습니다: ${hit.slice(0, 3).join(', ')}`,
          hint: '이 명령이 그 파일을 어떻게 건드릴지 알 수 없어서 막았습니다. 읽기만 한다면 Read 도구를 쓰세요.',
        }
        this.log({ at: Date.now(), file: hit[0], action: 'block', tool, reason: verdict.reason, rule: verdict.rule })
        return verdict
      }
    }

    return { action: 'allow' }
  }

  /**
   * 파일 한 개에 대한 판정. Edit 과 Bash 가 같은 경로를 쓴다.
   *
   * 그래프에 없는 파일이라고 미리 통과시키면 안 된다. 잠금과 레이어 규칙은
   * 경로 패턴이라 그래프가 없어도 판단할 수 있고, 아직 없는 파일을 새로 만드는 게
   * 오히려 규칙을 우회하는 흔한 방법이다. 그래프가 필요한 규칙(autolock)은
   * 모르는 파일에 대해 알아서 빈 결과를 내므로 아무것도 주장하지 않는다.
   */
  private checkFile(file: string, added: string): Verdict {
    return checkEdit(this.rules, this.graph, this.features, {
      file,
      added,
      resolve: (spec, from) => {
        const adapter = this.files.get(from)?.adapter ?? adapterFor(from)
        return adapter?.resolve(spec, from, this.ctx)?.path ?? null
      },
    }, this.modules)
  }

  private foreignAllow(tool: string, raw: string): Verdict {
    this.foreign++
    this.log({ at: Date.now(), file: raw, action: 'foreign', tool, reason: '다른 프로젝트의 파일입니다' })
    return { action: 'allow' }
  }

  private log(a: Activity) {
    this.activity.unshift(a)
    if (this.activity.length > 200) this.activity.length = 200
  }

  /** 잠긴 파일 전체 (명시 잠금 + 기능 잠금) */
  lockedFiles(): Set<string> {
    const locked = new Set(this.rules.protect.map(p => p.path))
    for (const fr of this.rules.features ?? []) {
      const files = (fr.scope ?? 'exclusive') === 'all' ? allFilesOf(this.features, fr.id) : exclusiveOf(this.features, fr.id)
      for (const f of files) locked.add(f)
    }
    return locked
  }

  private ctxInput(): CtxInput {
    return {
      graph: this.graph,
      features: this.features,
      modules: this.modules,
      rules: this.rules,
      lockedFiles: this.lockedFiles(),
      port: this.port,
    }
  }

  /** 이 세션에 같은 내용을 이미 넣었나. 중복 주입이 토큰을 제일 많이 먹는다. */
  private isNew(session: string, key: string): boolean {
    const set = this.told.get(session) ?? new Set<string>()
    if (set.has(key)) return false
    set.add(key)
    if (set.size > 400) set.clear()
    this.told.set(session, set)
    return true
  }

  toRel(p: string) {
    const abs = path.isAbsolute(p) ? p : path.join(this.repoRoot, p)
    return path.relative(this.repoRoot, abs).split(path.sep).join('/')
  }

  // -------------------------------------------------------------- 상태

  state() {
    const locked = this.lockedFiles()
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
        module: this.modules.of.get(n.id) ?? '',
        symbols: n.symbols.length,
        locked: locked.has(n.id),
        isEntry: this.features.entries.some(e => e.file === n.id),
      })),
      edges: this.graph.edges.map(e => ({ from: e.from, to: e.to, kind: e.kind, confidence: e.confidence, via: e.via })),
      modules: [...this.modules.members.entries()]
        .map(([name, fs]) => ({ name, files: fs.length }))
        .sort((a, b) => b.files - a.files || (a.name < b.name ? -1 : 1)),
      suggestions: [
        ...autolockCandidates(this.features, this.rules.autolock.minFeatures).map(c => ({
          file: c.file,
          why: c.features,
          kind: 'feature' as const,
        })),
        ...crossModuleShared(this.graph, this.modules, this.rules.autolock.minModules ?? 3).map(c => ({
          file: c.file,
          why: c.modules,
          kind: 'module' as const,
        })),
      ]
        .filter((c, i, arr) => !locked.has(c.file) && arr.findIndex(x => x.file === c.file) === i)
        .slice(0, 40),
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

      if (url.pathname === '/session' && req.method === 'POST') {
        const body = await readJson(req)
        const session = String(body.session_id ?? 'default')
        this.told.delete(session)
        const text = sessionBrief(this.ctxInput())
        if (!text || !this.isNew(session, 'brief')) return send(200, {})
        return send(200, {
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
        })
      }

      if (url.pathname === '/prompt' && req.method === 'POST') {
        const body = await readJson(req)
        const session = String(body.session_id ?? 'default')
        const text = promptBrief(this.ctxInput(), String(body.prompt ?? ''))
        // 같은 파일 이야기를 매 턴 반복하지 않는다
        if (!text || !this.isNew(session, text)) return send(200, {})
        return send(200, {
          hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
        })
      }

      if (url.pathname === '/post' && req.method === 'POST') {
        const body = await readJson(req)
        const input = (body.tool_input ?? {}) as Record<string, unknown>
        // Bash 로 고친 파일도 다시 읽어야 한다. 안 그러면 그래프가 조용히 낡는다.
        const touched =
          String(body.tool_name ?? '') === 'Bash'
            ? shellWrites(String(input.command ?? '')).targets
            : [String(input.file_path ?? '')]
        const rels = touched.map(t => this.toRel(t)).filter(r => r && !r.startsWith('../') && adapterFor(r))
        if (!rels.length) return send(200, {})

        const rel = rels[0]
        const before = snapshotEdges(this.graph, rel)
        // 재인덱싱 전에 봐야 한다. 편집 내용은 훅이 준 조각에만 있다.
        const notes = this.afterEditNotes(rel, {
          before: String(input.old_string ?? ''),
          after: String(input.new_string ?? input.content ?? ''),
        })
        for (const r of rels) await this.reindex(r)

        const parts = [deltaBrief(before, snapshotEdges(this.graph, rel), rel).replace(/^\[codyssey\] /, ''), ...notes]
          .filter(Boolean)
        if (!parts.length) return send(200, {})
        return send(200, {
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: `[codyssey] ${parts.join('\n')}`,
          },
        })
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
