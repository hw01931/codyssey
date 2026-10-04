/**
 * 라이브러리 진입점.
 *
 * Claude Code 훅·MCP·웹 화면은 전부 이 위에 얹힌 껍데기다. 다른 프로그램
 * (예: 여러 AI 작업자를 부리는 오케스트레이터)이 codyssey 를 쓰려면 HTTP 데몬을
 * 띄우고 훅 JSON 을 흉내 낼 게 아니라, 여기서 바로 함수를 부르면 된다.
 *
 *   const c = await Codyssey.open(root)
 *   c.contextFor(['src/auth/service.py'])   // 작업자에게 줄 구조화된 사실
 *   c.checkEdit('src/pay/core.py', patch)   // 반영해도 되는가
 *   c.checkCommand('rm -rf ~/')             // 이 명령은 되돌릴 수 있는가
 *   await c.afterEdit('src/auth/service.py') // 그래프 갱신 + 돌릴 테스트
 *
 * 돌려주는 값은 전부 구조화된 데이터다. 문장으로 바꾸는 건 부르는 쪽이 한다.
 * 모델이 다르면 필요한 문장도 다르기 때문이다.
 *
 * LLM 호출은 없다. 전부 결정적이고, 같은 저장소에 같은 답을 준다.
 */
import { Daemon } from './daemon/server.ts'
import type { Verdict, Rules } from './core/rules.ts'
import { featuresOf, allEntriesOf } from './core/features.ts'
import { contractsOf, testsFor, type Contract } from './core/contract.ts'
import { describeFeature, describeFile } from './core/labels.ts'
import { archDiff, type ArchDiff } from './setup/archdiff.ts'
import type { Recommendations, Recommendation, Reason, Skipped } from './core/recommend.ts'
import type { VerifyRun, FeatureVerification, TestResult, TestStatus, VerifyOptions } from './core/verify.ts'
import type { FileHistory } from './core/history.ts'
import { setLang, type Lang } from './i18n/index.ts'

export type { Verdict, Rules, Contract, ArchDiff, Recommendations, Recommendation, Reason, Skipped, VerifyRun, FeatureVerification, TestResult, TestStatus, VerifyOptions }

export interface Feature {
  id: string
  kind: 'route' | 'page' | 'entry'
  /** 사람이 읽는 이름. 라벨이 없으면 id 에서 만든다 */
  label: string
  /** 진입점 파일 */
  file: string
  /** 이 기능이 닿는 파일 전부 */
  files: string[]
  /** 우리가 돌려서 본 검증 상태. PASS 는 '그 커밋에서 그 테스트들이 통과' 라는 뜻이다 */
  verification: FeatureVerification
}

export interface FileFacts {
  file: string
  /** 사람이 읽는 이름 */
  label: string
  /** 이 파일에 닿는 최상위 기능 */
  features: string[]
  /** 흡수된 라우트까지 전부 */
  entries: string[]
  /** 사람이 잠갔거나 기능 잠금에 걸린 파일인가 */
  locked: boolean
  /** 이 파일을 import 하는 파일 */
  importers: string[]
  /** 밖에 약속한 이름들과 그걸 쓰는 곳. 없애거나 시그니처를 바꾸면 깨진다 */
  contracts: Contract[]
  /** 이 파일을 검증하는 테스트 */
  tests: string[]
  /**
   * git 이력. 기간 안의 커밋 수와, 같은 커밋에 자주 함께 든 파일.
   * 함께 바뀌는 파일은 import 없이도 이어진 숨은 결합이다. 작업자에게 "이것도 봐야 할지" 를 알려준다.
   * git 이 없으면 null.
   */
  history: FileHistory | null
}

/** 작업자에게 줄 컨텍스트. 작업이 건드릴 파일들에 대한 사실만. */
export interface TaskContext {
  files: FileFacts[]
  /** 건드릴 파일들이 공통으로 영향을 주는 기능 */
  features: string[]
  /**
   * 건드릴 파일들과 자주 함께 바뀌었지만 이번 작업 목록에는 없는 파일.
   * 작업 계약에 "이것도 확인" 으로 넣을 후보다. import 관계가 없어도 나온다.
   */
  coChanged: { file: string; together: number; with: string }[]
  /** 작업 전체에서 돌려야 할 테스트 (중복 제거) */
  tests: string[]
  /** 그 중 잠긴 파일. 작업 계약에서 '변경 금지' 로 적어야 한다 */
  locked: string[]
}

export interface EditPatch {
  /** 바뀌기 전 조각 (Edit 도구의 old_string) */
  before?: string
  /** 바뀐 후 조각, 또는 파일 전체 */
  after?: string
  /** after 가 파일 전체인가 (Write 도구) */
  whole?: boolean
}

export interface OpenOptions {
  /** 파일 변경을 감시해서 그래프를 스스로 갱신한다. 오케스트레이터가 afterEdit 을 부를 거면 꺼도 된다 */
  watch?: boolean
  /** 메시지 언어. 생략하면 rules.yaml → 환경 → 영어 */
  lang?: Lang
}

export class Codyssey {
  private d: Daemon
  // 매개변수 프로퍼티는 strip-only 모드에서 안 돌아간다. 풀어서 쓴다.
  private constructor(d: Daemon) {
    this.d = d
  }

  static async open(root: string, opts: OpenOptions = {}): Promise<Codyssey> {
    if (opts.lang) setLang(opts.lang, true)
    const d = new Daemon(root)
    await d.start({ watch: opts.watch ?? false, listen: false })
    return new Codyssey(d)
  }

  get root() {
    return this.d.repoRoot
  }

  get rules(): Rules {
    return this.d.rules
  }

  // -------------------------------------------------------------- 읽기

  features(): Feature[] {
    const verifs = this.d.verifications()
    return this.d.features.roots.map(e => ({
      id: e.id,
      kind: e.kind,
      label: describeFeature(e.id, this.d.labels),
      file: e.file,
      files: [...(this.d.features.members.get(e.id) ?? [])].sort(),
      verification: verifs.find(v => v.feature === e.id)!,
    }))
  }

  /**
   * 고친 파일들을 검증하는 테스트를 직접 돌리고 결과를 적는다. 모델의 자기보고를 대신한다.
   * files 가 없으면 전부. 결과의 PASS 는 '그 코드 상태에서 그 테스트들이 통과' 이지 '기능이 정상' 이 아니다.
   */
  verify(files: string[] = [], opts: VerifyOptions = {}) {
    return this.d.verify(files, opts)
  }

  /** 기능별 검증 상태 (저장된 결과에서) */
  verification(): FeatureVerification[] {
    return this.d.verifications()
  }

  facts(file: string): FileFacts {
    const rel = this.d.toRel(file)
    const locked = this.d.lockedFiles()
    return {
      file: rel,
      label: describeFile(rel, this.d.labels),
      features: featuresOf(this.d.features, rel),
      entries: allEntriesOf(this.d.features, rel),
      locked: locked.has(rel),
      importers: [...new Set(this.d.graph.in(rel).filter(e => e.kind === 'import').map(e => e.from))].sort(),
      contracts: contractsOf(this.d.graph, rel),
      tests: testsFor(this.d.graph, rel),
      history: this.d.history.unavailable ? null : (this.d.history.files.get(rel) ?? { file: rel, commits: 0, lastChanged: null, coChanges: [] }),
    }
  }

  /** 이 파일을 고치면 영향받는 파일 전부 (import 를 거슬러 올라간 것) */
  dependents(file: string): string[] {
    return [...this.d.graph.dependents(this.d.toRel(file))].sort()
  }

  /**
   * 작업이 건드릴 파일들에 대한 사실 묶음.
   * 오케스트레이터는 이걸로 작업 계약(변경 허용·금지·완료 조건)을 채운다.
   */
  contextFor(files: string[]): TaskContext {
    const facts = files.map(f => this.facts(f))
    const uniq = (xs: string[]) => [...new Set(xs)].sort()
    return {
      files: facts,
      features: uniq(facts.flatMap(f => f.features)),
      tests: uniq(facts.flatMap(f => f.tests)),
      locked: facts.filter(f => f.locked).map(f => f.file),
      coChanged: facts
        .flatMap(f => (f.history?.coChanges ?? []).map(c => ({ file: c.file, together: c.together, with: f.file })))
        .filter(c => c.together >= 2 && !facts.some(f => f.file === c.file))
        .sort((a, b) => b.together - a.together || (a.file < b.file ? -1 : 1)),
    }
  }

  // -------------------------------------------------------------- 판정

  /** 이 편집을 반영해도 되는가. 잠금·기능 잠금·레이어·공유·계약 전부 본다. */
  checkEdit(file: string, patch: EditPatch = {}): Verdict {
    return this.d.decide('Edit', {
      file_path: file,
      ...(patch.before !== undefined ? { old_string: patch.before } : {}),
      ...(patch.whole ? { content: patch.after ?? '' } : patch.after !== undefined ? { new_string: patch.after } : {}),
    })
  }

  /** 이 셸 명령을 실행해도 되는가. 쓰기 대상과 되돌릴 수 없는 명령을 본다. */
  checkCommand(command: string): Verdict {
    return this.d.decide('Bash', { command })
  }

  /**
   * 변경 묶음(diff)을 반영 전에 검사한다. 파일마다 가장 나쁜 판정을 돌려준다.
   * 격리된 작업 공간에서 만든 변경을 정식 코드에 합치기 직전에 부른다.
   */
  checkChanges(changes: { file: string; patch?: EditPatch }[]): { file: string; verdict: Verdict }[] {
    return changes
      .map(c => ({ file: this.d.toRel(c.file), verdict: this.checkEdit(c.file, c.patch) }))
      .filter(r => r.verdict.action !== 'allow')
  }

  // -------------------------------------------------------------- 갱신

  /**
   * 파일이 바뀐 뒤. 그래프를 갱신하고 '돌려야 할 테스트' 와 주의사항을 돌려준다.
   * notes 는 중복 이름 같은 사람 말 경고, tests 는 구조화된 목록이다.
   */
  async afterEdit(file: string, patch: EditPatch = {}): Promise<{ tests: string[]; notes: string[] }> {
    const rel = this.d.toRel(file)
    const notes = this.d.afterEditNotes(rel, { before: patch.before ?? '', after: patch.after ?? '' })
    await this.d.reindex(rel)
    return { tests: testsFor(this.d.graph, rel), notes }
  }

  /** 여러 파일이 바뀌었을 때 (git checkout, 다른 작업자의 반영 등) */
  async reindex(files: string[]) {
    for (const f of files) await this.d.reindex(this.d.toRel(f))
  }

  async rescan() {
    await this.d.fullScan()
  }

  // -------------------------------------------------------------- 규칙

  /**
   * 잠금 추천. 무엇을, 왜(근거값 포함), 잠그면 어떻게 되는지, 그리고 추천하지 않는 것은 왜인지.
   * 협업 프로그램의 '보호할 기능 선택' 화면이 바로 이 목록이다.
   */
  recommendations(): Recommendations {
    return this.d.recommendations()
  }

  /** secret: true 면 읽기도 막는다 (.env 같은 것). */
  lock(file: string, reason?: string, opts: { secret?: boolean } = {}) {
    return this.d.setLock(this.d.toRel(file), true, reason, opts)
  }

  unlock(file: string) {
    return this.d.setLock(this.d.toRel(file), false)
  }

  lockFeature(id: string, locked = true, scope: 'exclusive' | 'all' = 'exclusive', reason?: string) {
    return this.d.setFeatureLock(id, locked, scope, reason)
  }

  lockedFiles(): string[] {
    return [...this.d.lockedFiles()].sort()
  }

  /** 기준 커밋 대비 아키텍처 변화. 잠긴 파일 변경, 새 모듈 연결, 규칙 위반 */
  diff(baseRef: string): Promise<ArchDiff> {
    return archDiff(this.d.repoRoot, baseRef, this.d.rules, this.d.lockedFiles())
  }

  async close() {
    await this.d.stop()
  }
}
