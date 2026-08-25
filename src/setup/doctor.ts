import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { health, loadPort, projectPort, resolvePort, samePath } from './port.ts'
import { t } from '../i18n/index.ts'

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
    label: t('doctor.port'),
    detail: `${port}${loadPort(root) ? '' : ' ' + t('doctor.portComputed', { port: projectPort(root) })}`,
  })

  // 1) 데몬
  const h = await health(port, 1500)
  if (!h) {
    checks.push({ ok: false, label: t('doctor.daemonOff'), fix: 'codyssey start' })
  } else if (!samePath(h.repoRoot, root)) {
    checks.push({
      ok: false,
      label: t('doctor.portForeign'),
      detail: t('doctor.theirFolder', { root: h.repoRoot }),
      fix: t('doctor.fixReinit'),
    })
  } else {
    checks.push({ ok: true, label: t('doctor.daemonOk'), detail: t('doctor.filesCount', { count: h.files }) })
  }

  // 2) 훅 설정
  const settingsPath = path.join(root, '.claude', 'settings.json')
  if (!fs.existsSync(settingsPath)) {
    checks.push({ ok: false, label: t('doctor.noSettings'), fix: 'codyssey init' })
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
          label: t('doctor.bashNotHooked'),
          detail: `matcher: ${noBash.join(', ') || t('doctor.none')}`,
          fix: t('doctor.fixBash'),
        })
      }
      if (!urls.length) {
        checks.push({ ok: false, label: t('doctor.noHooksSet'), fix: 'codyssey init' })
      } else {
        const wrong = urls.filter(u => !u.includes(`:${port}/`))
        checks.push(
          wrong.length
            ? {
                ok: false,
                label: t('doctor.wrongPort'),
                detail: wrong.join(', '),
                fix: t('doctor.fixReinitSimple'),
              }
            : { ok: true, label: t('doctor.hooksOk'), detail: t('doctor.count', { count: urls.length }) },
        )
      }
    } catch {
      checks.push({ ok: false, label: t('doctor.cantReadSettings'), fix: t('doctor.fixJson') })
    }
  }

  // 3) 규칙 파일
  const rulesPath = path.join(root, '.codyssey', 'rules.yaml')
  if (!fs.existsSync(rulesPath)) {
    checks.push({ ok: false, label: t('doctor.noRules'), fix: 'codyssey init' })
  } else {
    try {
      const r = YAML.parse(fs.readFileSync(rulesPath, 'utf8')) ?? {}
      const n = (r.protect?.length ?? 0) + (r.features?.length ?? 0) + (r.layers?.length ?? 0)
      checks.push({
        ok: true,
        label: t('doctor.rulesOk'),
        detail: n ? t('doctor.rulesCount', { count: n }) : t('doctor.nothingLocked'),
      })
    } catch {
      checks.push({
        ok: false,
        label: t('doctor.cantReadRules'),
        fix: t('doctor.fixRules'),
      })
    }
  }

  // 4) 못 읽은 파일
  if (h && samePath(h.repoRoot, root)) {
    try {
      const st = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as {
        parseFailures?: { file: string; error: string }[]
      }
      const pf = st.parseFailures ?? []
      if (pf.length) {
        checks.push({
          ok: false,
          label: t('doctor.unparsed', { count: pf.length }),
          detail: pf.slice(0, 3).map(x => x.file).join(', '),
          fix: t('doctor.fixUnparsed'),
        })
      }
    } catch {
      /* 못 읽어도 진단은 계속 */
    }
  }

  // 5) 남의 요청이 들어오는지
  if (h && samePath(h.repoRoot, root)) {
    try {
      const st = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as { foreign?: number }
      if (st.foreign) {
        checks.push({
          ok: false,
          label: t('doctor.foreignRequests'),
          detail: t('doctor.foreignCount', { count: st.foreign }),
          fix: t('doctor.fixForeign'),
        })
      }
    } catch {
      /* 상태를 못 읽어도 진단은 계속한다 */
    }
  }

  return checks
}
