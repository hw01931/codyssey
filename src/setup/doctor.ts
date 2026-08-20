import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { health, loadPort, projectPort, resolvePort, samePath } from './port.ts'

export interface Check {
  ok: boolean
  label: string
  detail?: string
  fix?: string
}

/**
 * 설정이 조용히 어긋난 상태를 찾아낸다.
 *
 * 실제로 겪은 사고: 훅은 7777 을 보는데 7777 은 다른 프로젝트의 데몬이었다.
 * 내 파일은 그쪽 그래프에 없으니 전부 통과됐고, 에러는 한 줄도 안 났다.
 * 그런 걸 사람이 눈치채길 기대하면 안 된다.
 */
export async function doctor(repoRoot: string): Promise<Check[]> {
  const root = path.resolve(repoRoot)
  const checks: Check[] = []
  const port = await resolvePort(root)

  checks.push({
    ok: true,
    label: '이 프로젝트의 포트',
    detail: `${port}${loadPort(root) ? '' : ` (경로에서 계산: ${projectPort(root)})`}`,
  })

  // 1) 데몬
  const h = await health(port, 1500)
  if (!h) {
    checks.push({ ok: false, label: '데몬이 꺼져 있습니다', fix: 'codyssey start' })
  } else if (!samePath(h.repoRoot, root)) {
    checks.push({
      ok: false,
      label: '포트를 다른 프로젝트가 쓰고 있습니다',
      detail: `그쪽 폴더: ${h.repoRoot}`,
      fix: 'codyssey init 을 다시 실행하면 이 프로젝트 전용 포트를 잡습니다',
    })
  } else {
    checks.push({ ok: true, label: '데몬 정상', detail: `${h.files}개 파일` })
  }

  // 2) 훅 설정
  const settingsPath = path.join(root, '.claude', 'settings.json')
  if (!fs.existsSync(settingsPath)) {
    checks.push({ ok: false, label: '.claude/settings.json 이 없습니다', fix: 'codyssey init' })
  } else {
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      const urls: string[] = []
      const toolMatchers: string[] = []
      for (const ev of ['PreToolUse', 'PostToolUse']) {
        for (const g of s?.hooks?.[ev] ?? []) {
          let mine = false
          for (const hk of g.hooks ?? []) {
            if (typeof hk.url !== 'string') continue
            urls.push(hk.url)
            mine = true
          }
          if (mine) toolMatchers.push(String(g.matcher ?? ''))
        }
      }

      // Bash 가 matcher 에 없으면 `sed -i` 한 줄로 잠금이 통째로 우회된다.
      // 예전 설치본이 이 상태라서, 막고 있다고 믿는 동안 실제로는 안 막힌다.
      const noBash = toolMatchers.filter(m => !/(^|\|)Bash(\||$)/.test(m))
      if (noBash.length) {
        checks.push({
          ok: false,
          label: 'Bash 편집이 훅을 안 거칩니다',
          detail: `matcher: ${noBash.join(', ') || '(없음)'}`,
          fix: 'codyssey init 을 다시 실행하면 matcher 에 Bash 가 들어갑니다',
        })
      }
      if (!urls.length) {
        checks.push({ ok: false, label: '훅이 설정돼 있지 않습니다', fix: 'codyssey init' })
      } else {
        const wrong = urls.filter(u => !u.includes(`:${port}/`))
        checks.push(
          wrong.length
            ? {
                ok: false,
                label: '훅이 엉뚱한 포트를 가리킵니다',
                detail: wrong.join(', '),
                fix: 'codyssey init 을 다시 실행하면 고쳐집니다',
              }
            : { ok: true, label: '훅 설정 정상', detail: `${urls.length}개` },
        )
      }
    } catch {
      checks.push({ ok: false, label: '.claude/settings.json 을 읽을 수 없습니다', fix: 'JSON 문법을 확인해 주세요' })
    }
  }

  // 3) 규칙 파일
  const rulesPath = path.join(root, '.codyssey', 'rules.yaml')
  if (!fs.existsSync(rulesPath)) {
    checks.push({ ok: false, label: 'rules.yaml 이 없습니다', fix: 'codyssey init' })
  } else {
    try {
      const r = YAML.parse(fs.readFileSync(rulesPath, 'utf8')) ?? {}
      const n = (r.protect?.length ?? 0) + (r.features?.length ?? 0) + (r.layers?.length ?? 0)
      checks.push({
        ok: true,
        label: '규칙 파일 정상',
        detail: n ? `잠금/규칙 ${n}건` : '아직 아무것도 안 잠갔습니다',
      })
    } catch {
      checks.push({
        ok: false,
        label: 'rules.yaml 을 읽을 수 없습니다',
        fix: '문법이 깨지면 아무것도 막지 않습니다. 웹 화면에서 다시 잠가주세요',
      })
    }
  }

  // 4) 남의 요청이 들어오는지
  if (h && samePath(h.repoRoot, root)) {
    try {
      const st = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as { foreign?: number }
      if (st.foreign) {
        checks.push({
          ok: false,
          label: '이 폴더 밖의 파일 요청이 들어오고 있습니다',
          detail: `${st.foreign}건`,
          fix: '다른 프로젝트의 .claude/settings.json 이 이 포트를 가리킵니다. 그쪽에서 codyssey init 을 다시 실행하세요',
        })
      }
    } catch {
      /* 상태를 못 읽어도 진단은 계속한다 */
    }
  }

  return checks
}
