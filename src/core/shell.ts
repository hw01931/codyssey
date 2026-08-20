/**
 * bash 명령에서 '파일을 쓰는 대상' 을 뽑아낸다.
 *
 * Edit/Write 만 훅으로 막으면 에이전트가 `sed -i` 나 heredoc 으로 그대로 우회한다.
 * 실제로 그렇게 뚫렸다 - 잠긴 파일이 조용히 덮어써지고 활동 기록에도 안 남았다.
 *
 * 셸을 완전히 파싱하는 건 불가능하다. 그래서 두 단계로 나눈다.
 *   targets  확실히 짚어낸 쓰기 대상. Edit 과 똑같이 판정한다 (막을 수 있다)
 *   opaque   쓸 수는 있는데 대상을 못 짚었다 (`python -c`, `git checkout`, `find -exec`)
 *            이때는 잠긴 파일이 명령문에 보이는지만 보고 판단한다
 *
 * P4: 확신 없는 경로를 targets 에 넣지 않는다. 모르면 opaque 로 넘겨서 위에서 판단하게 한다.
 */

export interface ShellWrites {
  /** 확실히 짚어낸 쓰기 대상 (리다이렉션, sed -i, tee, cp/mv 목적지, rm ...) */
  targets: string[]
  /** 파일을 쓸 수 있는데 대상을 못 짚은 명령이 있다 */
  opaque: boolean
  /** 명령에 등장한 경로처럼 생긴 토큰. opaque 일 때 글롭 대조에 쓴다 */
  words: string[]
}

/** 인자를 그대로 덮어쓰거나 지우는 것들 */
const OPERAND_WRITERS = new Set(['tee', 'truncate', 'rm', 'unlink', 'shred'])
/** 마지막 인자가 목적지인 것들 */
const DEST_WRITERS = new Set(['cp', 'mv', 'install', 'rsync', 'ln'])
/** 제자리 편집 플래그를 받는 것들 */
const IN_PLACE = new Set(['sed', 'perl', 'ruby', 'gawk', 'awk'])
/** 실행하면 뭐든 쓸 수 있는데, 뭘 쓸지는 알 수 없는 것들 */
const INTERPRETERS = new Set([
  'python', 'python3', 'py', 'node', 'deno', 'bun', 'ruby', 'perl', 'php',
  'osascript', 'rscript', 'julia', 'lua',
])
/** 앞에 붙어도 실제 명령은 뒤에 있는 것들 */
const PREFIXES = new Set([
  'sudo', 'env', 'nohup', 'time', 'nice', 'ionice', 'timeout', 'stdbuf', 'command', 'exec', 'builtin',
])
/** 셸 문자열을 인자로 받는 것들. 재귀해서 안쪽을 본다 */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
/** 대상을 짚을 수 없는 편집기·패치 도구 */
const OPAQUE_CMDS = new Set(['patch', 'ed', 'ex', 'vi', 'vim', 'nano', 'emacs', 'sponge', 'eval', 'source', '.'])
/** 작업 트리를 바꾸는 git 하위 명령 */
const GIT_WRITES = new Set([
  'apply', 'checkout', 'restore', 'switch', 'stash', 'reset', 'clean',
  'revert', 'merge', 'rebase', 'cherry-pick', 'am', 'mv', 'rm', 'pull',
])

const MAX_DEPTH = 3

export function shellWrites(command: string): ShellWrites {
  const acc: Acc = { targets: new Set(), words: new Set(), opaque: false }
  analyze(command, acc, 0)
  return { targets: [...acc.targets].sort(), opaque: acc.opaque, words: [...acc.words].sort() }
}

interface Acc {
  targets: Set<string>
  words: Set<string>
  opaque: boolean
}

function analyze(command: string, acc: Acc, depth: number) {
  if (depth > MAX_DEPTH || !command.trim()) return
  for (const simple of splitCommands(tokenize(stripHeredocs(command)))) {
    analyzeSimple(simple, acc, depth)
  }
}

function analyzeSimple(toks: Tok[], acc: Acc, depth: number) {
  // 1) 리다이렉션은 명령이 뭐든 상관없이 파일을 만든다
  const words: Tok[] = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (!t.op) {
      words.push(t)
      continue
    }
    if (t.text === '<') {
      // 입력 리다이렉션은 쓰기가 아니다. 인자 목록에서도 빼야 `tee out < in` 의
      // `in` 이 쓰기 대상으로 잘못 잡히지 않는다
      if (toks[i + 1] && !toks[i + 1].op) i++
      continue
    }
    if (t.text !== '>' && t.text !== '>>') continue
    const target = toks[i + 1]
    if (!target || target.op) continue
    addTarget(acc, target)
    i++ // 대상은 인자 목록에서 뺀다
  }
  if (!words.length) return

  // 2) 접두 명령(sudo, env, VAR=x ...)을 벗겨서 진짜 명령 이름을 찾는다
  let k = 0
  while (k < words.length && (PREFIXES.has(base(words[k].text)) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k].text))) k++
  if (k >= words.length) return

  const cmd = base(words[k].text).toLowerCase()
  const args = words.slice(k + 1)
  for (const a of args) if (looksLikePath(a.text)) acc.words.add(norm(a.text))

  // 3) 셸 문자열은 안쪽을 다시 본다. `bash -c "sed -i ... file"` 을 놓치지 않는다
  if (SHELLS.has(cmd)) {
    const c = flagValue(args, '-c')
    if (c !== null) analyze(c, acc, depth + 1)
    else acc.opaque = true
    return
  }
  if (cmd === 'xargs') {
    const sub = args.filter(a => !a.text.startsWith('-'))
    if (sub.length) analyzeSimple(sub, acc, depth + 1)
    else acc.opaque = true
    return
  }

  // 4) 인터프리터는 무엇이든 쓸 수 있고, 무엇을 쓸지는 알 수 없다
  if (INTERPRETERS.has(cmd) || OPAQUE_CMDS.has(cmd)) {
    acc.opaque = true
    return
  }

  if (cmd === 'git') {
    const sub = args.find(a => !a.text.startsWith('-'))?.text
    if (sub && GIT_WRITES.has(sub)) acc.opaque = true
    return
  }

  if (cmd === 'find') {
    if (args.some(a => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(a.text))) acc.opaque = true
    return
  }

  if (cmd === 'dd') {
    for (const a of args) if (a.text.startsWith('of=')) addTarget(acc, { ...a, text: a.text.slice(3) })
    return
  }

  if (IN_PLACE.has(cmd)) {
    // -i / -i.bak / --in-place 가 있을 때만 파일을 고친다
    const inPlace = args.some(
      a => a.text === '--in-place' || (a.text.startsWith('-') && !a.text.startsWith('--') && /i/.test(a.text)),
    )
    if (!inPlace) return
    // 스크립트 인자 하나를 걷어내야 파일만 남는다.
    //   sed -i 's/a/b/' f     첫 피연산자가 스크립트
    //   sed -i -e 's/a/b/' f  -e 가 다음 인자를 스크립트로 먹는다
    let scriptTaken = false
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a.text.startsWith('-')) {
        if (/^(-e|-f|--expression|--file)$/.test(a.text)) {
          i++ // 붙어 있는 값을 건너뛴다
          scriptTaken = true
        } else if (/^(-e|-f|--expression=|--file=)/.test(a.text)) {
          scriptTaken = true // -e's/a/b/' 처럼 한 토큰으로 붙은 경우
        }
        continue
      }
      if (!scriptTaken) {
        scriptTaken = true
        continue
      }
      addTarget(acc, a)
    }
    return
  }

  if (OPERAND_WRITERS.has(cmd)) {
    for (const a of operands(args)) addTarget(acc, a)
    return
  }

  if (DEST_WRITERS.has(cmd)) {
    const ops = operands(args)
    if (!ops.length) return
    addTarget(acc, ops[ops.length - 1]) // 목적지
    if (cmd === 'mv') for (const a of ops.slice(0, -1)) addTarget(acc, a) // 원본은 사라진다
    return
  }
}

/** `-` 로 시작하지 않는 인자들 */
function operands(args: Tok[]): Tok[] {
  return args.filter(a => !a.text.startsWith('-'))
}

function flagValue(args: Tok[], flag: string): string | null {
  const i = args.findIndex(a => a.text === flag)
  return i >= 0 && args[i + 1] ? args[i + 1].text : null
}

function addTarget(acc: Acc, t: Tok) {
  const v = t.text
  if (!v || v.startsWith('-')) return
  if (/^\/dev\//.test(v)) return
  // 변수·명령치환이 섞이면 실제 경로를 알 수 없다. 짚었다고 주장하면 안 된다
  if (!t.quoted && /[$`]/.test(v)) {
    acc.opaque = true
    return
  }
  if (/[*?[\]]/.test(v)) {
    // 글롭은 여기서 못 펼친다. 대조는 잠금 목록 쪽에서 한다
    acc.opaque = true
    acc.words.add(norm(v))
    return
  }
  if (!looksLikePath(v)) return
  acc.targets.add(norm(v))
  acc.words.add(norm(v))
}

/** 셸 스크립트 조각이 아니라 파일 경로처럼 보이는가 */
function looksLikePath(v: string): boolean {
  if (!v || v.length > 512) return false
  if (/^[a-z]+:\/\//i.test(v)) return false // URL
  // `:` 를 허용해야 윈도우 절대경로(C:/...)가 걸러지지 않는다
  return /^[\w./\\~@+*?:[\]-]+$/.test(v)
}

const base = (p: string) => norm(p).split('/').pop() ?? p
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '')

// ---------------------------------------------------------------- 토크나이저

interface Tok {
  text: string
  /** 따옴표 안이었나. `$` 가 들어 있어도 확장되지 않았다는 뜻 */
  quoted: boolean
  op: boolean
}

const SEPARATORS = new Set([';', '|', '&', '&&', '||', '\n', '(', ')', ';;'])

function splitCommands(toks: Tok[]): Tok[][] {
  const out: Tok[][] = []
  let cur: Tok[] = []
  for (const t of toks) {
    if (t.op && SEPARATORS.has(t.text)) {
      if (cur.length) out.push(cur)
      cur = []
      continue
    }
    cur.push(t)
  }
  if (cur.length) out.push(cur)
  return out
}

/**
 * heredoc 본문은 명령이 아니라 내용이다. 안 걷어내면 본문 속 `>` 나 파일 이름이
 * 쓰기 대상으로 잘못 잡힌다. (`cat > a.py <<'EOF' ... EOF`)
 */
function stripHeredocs(src: string): string {
  const lines = src.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    out.push(line)
    i++
    const delims = [...line.matchAll(/<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/g)].map(m => m[2])
    for (const d of delims) {
      while (i < lines.length && lines[i].trim() !== d) i++
      if (i < lines.length) i++ // 종료 구분자
    }
  }
  return out.join('\n')
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let cur = ''
  let quoted = false
  let started = false
  let i = 0

  const flush = () => {
    if (started) out.push({ text: cur, quoted, op: false })
    cur = ''
    quoted = false
    started = false
  }
  const op = (text: string) => {
    flush()
    out.push({ text, quoted: false, op: true })
  }
  /** `2>` 의 `2`, `&>` 의 `&` 는 파일 이름이 아니라 fd 다 */
  const dropFd = () => {
    if (!quoted && (cur === '1' || cur === '2' || cur === '&')) {
      cur = ''
      started = false
    }
  }

  while (i < src.length) {
    const ch = src[i]

    if (ch === '\\' && i + 1 < src.length) {
      cur += src[i + 1]
      started = true
      i += 2
      continue
    }

    if (ch === "'" || ch === '"') {
      const q = ch
      quoted = true
      started = true
      i++
      while (i < src.length && src[i] !== q) {
        if (q === '"' && src[i] === '\\' && i + 1 < src.length) {
          cur += src[i + 1]
          i += 2
          continue
        }
        cur += src[i++]
      }
      i++
      continue
    }

    if (ch === '\n') {
      op('\n')
      i++
      continue
    }
    if (/\s/.test(ch)) {
      flush()
      i++
      continue
    }

    const two = src.slice(i, i + 2)
    if (two === '&&' || two === '||' || two === ';;') {
      op(two)
      i += 2
      continue
    }
    if (two === '>>') {
      dropFd()
      op('>>')
      i += 2
      continue
    }
    if (ch === '>') {
      dropFd()
      op('>')
      i++
      continue
    }
    if (ch === '<') {
      // `<<` 는 heredoc 이라 본문이 이미 걷혔다. `<` 는 입력이라 쓰기가 아니지만,
      // 뒤따르는 파일을 인자로 오해하지 않도록 연산자로 남긴다
      dropFd()
      if (two === '<<') {
        flush()
        i += 2
      } else {
        op('<')
        i++
      }
      continue
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      op(ch)
      i++
      continue
    }

    cur += ch
    started = true
    i++
  }
  flush()
  return out
}
