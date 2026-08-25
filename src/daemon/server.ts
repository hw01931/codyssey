import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import chokidar from 'chokidar'
import { buildGraph, createCtx, listFiles, parseFile, parseFailures, adapterFor, type FileInfo } from '../index/scan.ts'
import { computeFeatures, allFilesOf, autolockCandidates, exclusiveOf, featuresOf, type Features } from '../core/features.ts'
import { checkEdit, defaultRules, findViolations, inertRules, matches, type Rules, type Verdict } from '../core/rules.ts'
import { shellWrites } from '../core/shell.ts'
import { computeModules, consumerModules, crossModuleShared, type Modules } from '../core/modules.ts'
import { buildSymbolGraph, sharedSymbols, symbolImpact, type SymbolGraph } from '../core/symbols.ts'
import type { Graph } from '../core/graph.ts'
import type { ResolveCtx } from '../core/ir.ts'
import { deltaBrief, promptBrief, sessionBrief, snapshotEdges, type CtxInput } from './context.ts'
import { brokenContracts, contractsOf, duplicateNames, nameIndex, testsFor } from '../core/contract.ts'
import { describeFeature, describeFile, describeModule, emptyLabels, loadLabels, saveLabels, unlabeled, type Labels } from '../core/labels.ts'
import { t, setLang, resolveLang, getLang, uiStrings } from '../i18n/index.ts'

/**
 * 웹 화면이 있는 곳.
 *
 * 개발 중에는 `src/daemon/server.ts` 옆의 `src/ui`, 번들된 배포본에서는
 * `dist/cli.js` 옆의 `dist/ui` 다. 한쪽만 계산하면 다른 쪽에서 404 가 난다.
 * 실제로 그랬다 — 배포본의 웹 화면이 안 떴다. init 이 알려주는 주소인데도.
 *
 * 추측하지 말고 실제로 있는 곳을 고른다. 없으면 첫 후보를 쓴다(에러 메시지가
 * 개발자 기준으로 나오도록).
 */
const UI_DIR = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.join(here, '..', 'ui'), // src/daemon -> src/ui
    path.join(here, 'ui'), // dist -> dist/ui
  ]
  return candidates.find(d => fs.existsSync(path.join(d, 'index.html'))) ?? candidates[0]
})()

/** 바뀌면 다시 읽어야 하는 설정 파일들 */
const CONFIG_FILES = ['.codyssey/rules.yaml', '.codyssey/labels.yaml']

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
  symbols!: SymbolGraph
  private names = new Map<string, string[]>()
  labels: Labels = emptyLabels()
  rules: Rules = defaultRules()
  activity: Activity[] = []
  /** 우리 루트 밖에서 들어온 요청 수. 0 이 아니면 포트 설정이 잘못된 것이다. */
  foreign = 0
  /** 세션마다 이미 알려준 것. 같은 말을 두 번 하면 토큰만 쓴다. */
  private told = new Map<string, Set<string>>()
  private ctx!: ResolveCtx
  private server?: http.Server
  private watcher?: chokidar.FSWatcher
  private configWatcher?: chokidar.FSWatcher
  private rebuildTimer?: NodeJS.Timeout
  private configTimer?: NodeJS.Timeout
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
    this.loadLabels()
    if (watch) this.startWatching()
    await this.listen()
    return this
  }

  async stop() {
    await this.watcher?.close()
    await this.configWatcher?.close()
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
    // 파일이 몇 개 없는 프로젝트에서는 이쪽만 신호를 낸다
    this.symbols = buildSymbolGraph(this.files, this.ctx)
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
    // 설정 파일은 따로 본다.
    //
    // 위 감시자는 .codyssey 를 통째로 무시한다(생성물이 대부분이라). 그런데 그러면
    // 사람이 rules.yaml 에 직접 protect 를 적어도 반영되지 않는다. README 가
    // "직접 써도 됩니다" 라고 안내하므로, 잠갔다고 믿는데 안 잠긴 상태가 만들어진다.
    // 무시 규칙에 예외를 뚫는 것보다 감시자를 하나 더 두는 쪽이 확실하다.
    // 폴더가 없으면 감시가 안 붙는다. 아직 없으면 만들어두고 폴더째 본다.
    const configDir = path.join(this.repoRoot, '.codyssey')
    fs.mkdirSync(configDir, { recursive: true })
    // ignoreInitial 을 켜면 안 된다. 감시자가 초기 스캔을 하는 동안 파일이 만들어지면
    // 그걸 '원래 있던 파일' 로 보고 삼켜버린다. 그러면 설정을 써도 영영 반영되지 않는다.
    // 시작 직후 한 번 더 읽는 비용은 무시할 만하다.
    this.configWatcher = chokidar.watch(configDir, { ignoreInitial: false, depth: 0 })
    const onConfig = (abs: string) => {
      const norm = abs.replace(/\\/g, '/')
      if (!CONFIG_FILES.some(f => norm.endsWith(f))) return
      clearTimeout(this.configTimer)
      this.configTimer = setTimeout(() => {
        this.loadRules()
        this.loadLabels()
      }, 80)
    }
    this.configWatcher.on('add', onConfig).on('change', onConfig).on('unlink', onConfig)

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

  /** 사람이 읽는 이름. 사전 폴백이 있어서 파일이 없어도 동작한다. */
  loadLabels() {
    this.labels = loadLabels(this.repoRoot)
  }

  /** 이 기능/모듈/파일을 사람 말로 */
  say = {
    feature: (id: string) => describeFeature(id, this.labels),
    module: (m: string) => describeModule(m, this.labels),
    file: (f: string) => describeFile(f, this.labels),
  }

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
    // 룰을 읽을 때마다 말도 다시 정한다. 사람이 rules.yaml 의 lang 을 고치면
    // 데몬을 다시 안 켜도 다음 메시지부터 바뀐다.
    setLang(this.rules.lang ?? resolveLang(this.repoRoot))
  }

  saveRules() {
    fs.mkdirSync(path.dirname(this.rulesPath), { recursive: true })
    fs.writeFileSync(this.rulesPath, YAML.stringify(this.rules))
  }

  /** 기능 단위 잠금. 기본은 그 기능만 쓰는 파일에만 걸린다. */
  setFeatureLock(id: unknown, locked: boolean, scope: 'exclusive' | 'all' = 'exclusive', reason?: string):
    { ok: true } | { ok: false; error: string } {
    if (typeof id !== 'string' || !id.trim() || !this.features.entries.some(e => e.id === id)) {
      return { ok: false, error: t('daemon.noSuchFeature', { id: JSON.stringify(id) }) }
    }
    this.rules.features = (this.rules.features ?? []).filter(f => f.id !== id)
    if (locked) this.rules.features.push({ id, scope, reason: reason ?? t('daemon.featureLockReason', { id }) })
    this.rules.features.sort((a, b) => (a.id < b.id ? -1 : 1))
    this.saveRules()
    return { ok: true }
  }

  /**
   * 잠금 규칙을 쓴다.
   *
   * 경로를 검증하지 않으면 `path: "undefined"` 같은 쓰레기가 rules.yaml 에 그대로
   * 저장되고, 그게 SessionStart 브리핑에 "잠긴 파일: undefined" 로 새어나간다.
   * 가드레일 도구가 자기 설정을 못 지키면 신뢰가 통째로 무너진다.
   */
  setLock(file: unknown, locked: boolean, reason?: string): { ok: true } | { ok: false; error: string } {
    const path = typeof file === 'string' ? file.trim() : ''
    if (!path || path === 'undefined' || path === 'null') {
      return { ok: false, error: t('daemon.needFilePath', { got: JSON.stringify(file) }) }
    }
    const rel = this.toRel(path)
    if (rel.startsWith('../')) {
      return { ok: false, error: t('daemon.outsideProject', { path }) }
    }
    // 글롭이 아니면서 그래프에도 없으면 오타일 가능성이 높다
    if (!rel.includes('*') && !this.graph.nodes.has(rel)) {
      return { ok: false, error: t('daemon.noSuchFile', { file: rel }) }
    }

    this.rules.protect = this.rules.protect.filter(p => p.path !== rel)
    if (locked) this.rules.protect.push({ path: rel, reason: reason?.trim() || t('daemon.manualLock') })
    this.rules.protect.sort((a, b) => (a.path < b.path ? -1 : 1))
    this.saveRules()
    return { ok: true }
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
    const others = broken.length > 1 ? t('daemon.contractOthers', { count: broken.length - 1 }) : ''
    return {
      action: this.rules.contracts?.mode === 'block' ? 'block' : 'ask',
      rule: `contract: ${file}#${c.name}`,
      reason: t('daemon.contractBreak', { name: c.name, others, count: c.users.length }),
      hint: t('daemon.contractUsers', { list: c.users.slice(0, 5).join(', '), more: c.users.length > 5 ? ' ' + t('ctx.andMore') : '' }),
    }
  }

  /** 편집 뒤 알려줄 것: 돌려야 할 테스트, 이미 있는 이름. */
  afterEditNotes(file: string, edit: { before: string; after: string }): string[] {
    const notes: string[] = []

    const dupes = duplicateNames(this.names, file, edit)
    for (const d of dupes) {
      notes.push(t('daemon.duplicateName', { name: d.name, where: d.existing.slice(0, 2).join(', ') }))
    }

    const tests = testsFor(this.graph, file)
    if (tests.length) notes.push(t('daemon.testsFor', { list: tests.slice(0, 3).join(', '), more: tests.length > 3 ? t('daemon.contractOthers', { count: tests.length - 3 }) : '' }))

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
    for (const target of targets) {
      const file = this.toRel(target)
      if (file.startsWith('../')) {
        this.foreignAllow(tool, target)
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
      return { ...worst, reason: `${worst.reason}\n${t('daemon.bashTouches', { file: worstFile })}` }
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
          rule: t('daemon.bashOpaqueRule'),
          reason: t('daemon.bashOpaque', { list: hit.slice(0, 3).join(', ') }),
          hint: t('daemon.bashOpaqueHint'),
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
    }, this.modules, this.say)
  }

  private foreignAllow(tool: string, raw: string): Verdict {
    this.foreign++
    this.log({ at: Date.now(), file: raw, action: 'foreign', tool, reason: t('daemon.foreignFile') })
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
      // 화면은 정적 HTML 이라 빌드 단계가 없다. 카탈로그를 거기 또 두면 두 벌이
      // 되어 조용히 어긋난다. 지금 말에 맞는 것만 내려주고 화면은 받아 쓴다.
      lang: getLang(),
      strings: uiStrings(),
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
          label: this.say.feature(r.id),
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
        featureLabels: featuresOf(this.features, n.id).map(f => this.say.feature(f)),
        label: this.say.file(n.id),
        module: this.modules.of.get(n.id) ?? '',
        moduleLabel: this.say.module(this.modules.of.get(n.id) ?? ''),
        symbols: n.symbols.length,
        locked: locked.has(n.id),
        isEntry: this.features.entries.some(e => e.file === n.id),
      })),
      edges: this.graph.edges.map(e => ({ from: e.from, to: e.to, kind: e.kind, confidence: e.confidence, via: e.via })),
      modules: [...this.modules.members.entries()]
        .map(([name, fs]) => ({ name, label: this.say.module(name), files: fs.length }))
        .sort((a, b) => b.files - a.files || (a.name < b.name ? -1 : 1)),
      suggestions: [
        ...autolockCandidates(this.features, this.rules.autolock.minFeatures).map(c => ({
          file: c.file,
          label: this.say.file(c.file),
          why: c.features.map(f => this.say.feature(f)),
          kind: 'feature' as const,
        })),
        ...crossModuleShared(this.graph, this.modules, this.rules.autolock.minModules ?? 3).map(c => ({
          file: c.file,
          label: this.say.file(c.file),
          why: c.modules.map(m => this.say.module(m)),
          kind: 'module' as const,
        })),
        // 파일 단위로 아무것도 안 나오면(한 파일에 몰아넣은 프로젝트) 심볼 단위로 본다.
        ...(crossModuleShared(this.graph, this.modules, this.rules.autolock.minModules ?? 3).length
          ? []
          : sharedSymbols(this.symbols, this.rules.autolock.minModules ?? 3).map(sy => {
              const node = this.symbols.nodes.get(sy.id)!
              return {
                file: node.file,
                label: t('daemon.symbolIn', { name: node.name, file: this.say.file(node.file) }),
                why: sy.callers.map(c => c.split('#')[1] ?? c),
                kind: 'symbol' as const,
                symbol: node.name,
              }
            })),
      ]
        .filter((c, i, arr) => !locked.has(c.file) && arr.findIndex(x => x.file === c.file && (x as any).symbol === (c as any).symbol) === i)
        .slice(0, 40),
      violations: findViolations(this.rules, this.graph),
      unresolved: this.graph.unresolved,
      parseFailures: [...parseFailures.entries()].map(([file, error]) => ({ file, error })),
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
        const rels = touched.map(f => this.toRel(f)).filter(r => r && !r.startsWith('../') && adapterFor(r))
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
        const r = this.setLock(body.file, Boolean(body.locked), body.reason ? String(body.reason) : undefined)
        if (!r.ok) return send(400, r)
        return send(200, { ok: true, locked: this.lockedFiles().size })
      }

      if (url.pathname === '/api/lock-feature' && req.method === 'POST') {
        const body = await readJson(req)
        const r = this.setFeatureLock(
          body.id,
          Boolean(body.locked),
          body.scope === 'all' ? 'all' : 'exclusive',
          body.reason ? String(body.reason) : undefined,
        )
        if (!r.ok) return send(400, r)
        return send(200, { ok: true, locked: this.lockedFiles().size })
      }

      if (url.pathname === '/api/labels' && req.method === 'POST') {
        const body = await readJson(req)
        const next: Labels = {
          features: { ...this.labels.features, ...((body.features ?? {}) as Record<string, string>) },
          modules: { ...this.labels.modules, ...((body.modules ?? {}) as Record<string, string>) },
          files: { ...this.labels.files, ...((body.files ?? {}) as Record<string, string>) },
        }
        saveLabels(this.repoRoot, next)
        this.labels = next
        return send(200, { ok: true, counts: {
          features: Object.keys(next.features).length,
          modules: Object.keys(next.modules).length,
          files: Object.keys(next.files).length,
        } })
      }

      if (url.pathname === '/api/unlabeled') {
        return send(200, unlabeled(
          this.features.roots.map(r => r.id),
          [...this.modules.members.keys()],
          this.labels,
        ))
      }

      if (url.pathname === '/api/shutdown' && req.method === 'POST') {
        send(200, { ok: true })
        setTimeout(() => void this.stop().then(() => process.exit(0)), 50)
        return
      }

      if (url.pathname === '/api/rescan' && req.method === 'POST') {
        await this.fullScan()
        this.loadRules()
        this.loadLabels()
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
