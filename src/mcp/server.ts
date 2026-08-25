import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { health, resolvePort } from '../setup/port.ts'
import { spawnDaemon } from '../setup/init.ts'
import { t } from '../i18n/index.ts'

/**
 * 에이전트가 먼저 물어볼 수 있는 창구.
 *
 * 훅은 '막는' 쪽이고 여기는 '알려주는' 쪽이다. 둘 다 있어야 한다.
 * 막히고 나서 아는 것보다 미리 물어보는 게 낫고, 물어보지 않아도 막히는 게 낫다.
 *
 * 조회 자체는 데몬이 이미 다 하고 있으므로 여기서는 얇게 전달만 한다.
 * 그래프를 두 벌 들고 있으면 서로 어긋난다.
 */
/** 이 파일을 (전이적으로) 쓰는 모든 파일. CLI 의 impact 와 같은 셈법이다. */
function transitiveUsers(edges: any[], id: string): string[] {
  const inn = new Map<string, string[]>()
  for (const e of edges) inn.set(e.to, [...(inn.get(e.to) ?? []), e.from])
  const seen = new Set([id])
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    for (const from of inn.get(cur) ?? []) {
      if (seen.has(from)) continue
      seen.add(from)
      stack.push(from)
    }
  }
  seen.delete(id)
  return [...seen].sort()
}

export async function runMcp(repoRoot: string, explicitPort?: number) {
  const port = await resolvePort(repoRoot, explicitPort)

  const api = async (path: string): Promise<any> => {
    if (!(await health(port))) {
      spawnDaemon(repoRoot, port)
      for (let i = 0; i < 20 && !(await health(port)); i++) await new Promise(r => setTimeout(r, 250))
    }
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(t('mcp.daemonError', { status: res.status }))
    return res.json()
  }

  const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })

  const server = new McpServer({ name: 'codyssey', version: '0.1.0' })

  server.registerTool(
    'get_overview',
    {
      title: 'Repository structure at a glance',
      description:
        'Features (screens and APIs people use), modules (folder groups) and locked files in this repository. Worth calling before you start work.',
      inputSchema: {},
    },
    async () => {
      const s = await api('/api/state')
      const L = [
        t('mcp.counts', { files: s.counts.files, edges: s.counts.edges, features: s.counts.features, locks: s.counts.locks }),
        '',
        t('mcp.featuresTitle'),
        ...s.features.map(
          (f: any) => `  ${f.label ?? f.id}  ${f.id}  ${t('mcp.featureRow', { files: f.size, exclusive: f.exclusive })}${f.locked ? ' ' + t('mcp.lockedTag') : ''}`,
        ),
        '',
        t('mcp.bigModules'),
        ...s.modules.slice(0, 12).map((m: any) => `  ${m.label ?? m.name}  (${m.name})  ${t('report.count', { count: m.files })}`),
      ]
      const locked = s.nodes.filter((n: any) => n.locked).map((n: any) => n.id)
      if (locked.length) L.push('', t('mcp.lockedTitle'), ...locked.map((f: string) => `  ${f}`))
      return text(L.join('\n'))
    },
  )

  server.registerTool(
    'impact_of',
    {
      title: 'What this file affects',
      description:
        'Which features and modules can break if you edit one file, and what uses it. Check before you edit.',
      inputSchema: { file: z.string().describe('Path relative to the repo root. A trailing fragment is enough.') },
    },
    async ({ file }) => {
      const s = await api('/api/state')
      const node =
        s.nodes.find((n: any) => n.id === file) ?? s.nodes.find((n: any) => n.id.endsWith(file))
      if (!node) return text(t('mcp.notInGraph', { file }))

      // CLI 의 impact 는 전이적으로 세는데 여기만 직접 연결만 세면
      // 같은 이름의 지표가 표면마다 달라진다. 둘 다 같은 값을 내야 한다.
      const direct = s.edges.filter((e: any) => e.to === node.id).map((e: any) => e.from)
      const users = transitiveUsers(s.edges, node.id)
      const uses = s.edges.filter((e: any) => e.from === node.id).map((e: any) => e.to)
      const L = [
        `${node.label ?? node.id}  (${node.id})${node.locked ? '  ' + t('mcp.lockedInline') : ''}`,
        t('mcp.belongsTo', { module: node.moduleLabel ?? node.module ?? '-' }),
        node.features.length
          ? t('mcp.affects', { count: node.features.length, list: (node.featureLabels ?? node.features).join(', ') })
          : t('mcp.noFeature'),
        t('mcp.usedBy', { count: users.length, direct: direct.length }) + (users.length ? ': ' + users.slice(0, 20).join(', ') : ''),
        t('mcp.uses', { count: uses.length }) + (uses.length ? ': ' + uses.slice(0, 20).join(', ') : ''),
      ]
      return text(L.join('\n'))
    },
  )

  server.registerTool(
    'find_file',
    {
      title: 'Find a file',
      description: 'Find files by a name fragment or a feature name. Use it when you do not know where to edit.',
      inputSchema: { query: z.string().describe('A filename fragment, a folder name, or a feature name') },
    },
    async ({ query }) => {
      const s = await api('/api/state')
      const q = query.toLowerCase()
      const byName = s.nodes.filter((n: any) => n.id.toLowerCase().includes(q))
      const byFeature = s.features
        .filter((f: any) => f.id.toLowerCase().includes(q))
        .flatMap((f: any) => s.nodes.filter((n: any) => n.features.includes(f.id)))
      const hits = [...new Set([...byName, ...byFeature].map((n: any) => n.id))].sort().slice(0, 30)
      if (!hits.length) return text(t('mcp.noHits', { query }))
      return text([t('mcp.hits', { query, count: hits.length }), ...hits.map(h => `  ${h}`)].join('\n'))
    },
  )

  server.registerTool(
    'check_edit',
    {
      title: 'May I edit this file',
      description: 'Check in advance whether an edit would be blocked. Better than being stopped after the fact.',
      inputSchema: {
        file: z.string().describe('Path relative to the repo root'),
        adding: z.string().optional().describe('Code you are about to add (used to check import rules)'),
      },
    },
    async ({ file, adding }) => {
      const res = await fetch(`http://127.0.0.1:${port}/pre`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file, new_string: adding ?? '' } }),
        signal: AbortSignal.timeout(5000),
      })
      const j: any = await res.json()
      const d = j.hookSpecificOutput?.permissionDecision
      if (!d) return text(t('mcp.free', { file }))
      return text(
        [
          d === 'deny' ? t('mcp.willBlock', { file }) : t('mcp.needsHuman', { file }),
          j.hookSpecificOutput.permissionDecisionReason ?? '',
          j.hookSpecificOutput.additionalContext ?? '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
    },
  )

  server.registerTool(
    'get_unlabeled',
    {
      title: 'Things that have no human-readable name yet',
      description:
        'Features and folder groups in this repository that still have no human-readable name. ' +
        'Name them with set_labels so someone who cannot read code can still recognise them. ' +
        'Once is enough - the result is saved to a file.',
      inputSchema: {},
    },
    async () => {
      const u = await api('/api/unlabeled')
      if (!u.features.length && !u.modules.length) return text(t('mcp.allLabeled'))
      return text(
        [
          t('mcp.labelAsk') + ' ' + t('mcp.labelLang'),
          t('mcp.labelHow'),
          t('mcp.labelExample'),
          '',
          t('mcp.labelFeatures'),
          ...u.features.map((f: string) => `  ${f}`),
          '',
          t('mcp.labelModules'),
          ...u.modules.map((m: string) => `  ${m}`),
        ].join('\n'),
      )
    },
  )

  server.registerTool(
    'set_labels',
    {
      title: 'Save human-readable names',
      description:
        'Attach human-readable names to features, folders and files, saved to .codyssey/labels.yaml. ' +
        'Saved once, used from then on, and a person can edit the file directly.',
      inputSchema: {
        features: z.record(z.string()).optional().describe('entrypoint id -> name'),
        modules: z.record(z.string()).optional().describe('folder group -> name'),
        files: z.record(z.string()).optional().describe('file path -> name'),
      },
    },
    async ({ features, modules, files }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/labels`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ features, modules, files }),
        signal: AbortSignal.timeout(5000),
      })
      const j: any = await res.json()
      return text(t('mcp.labelSaved', { features: j.counts.features, modules: j.counts.modules, files: j.counts.files }))
    },
  )

  await server.connect(new StdioServerTransport())
}
