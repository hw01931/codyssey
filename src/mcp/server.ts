import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { health, resolvePort } from '../setup/port.ts'
import { spawnDaemon } from '../setup/init.ts'

/**
 * 에이전트가 먼저 물어볼 수 있는 창구.
 *
 * 훅은 '막는' 쪽이고 여기는 '알려주는' 쪽이다. 둘 다 있어야 한다.
 * 막히고 나서 아는 것보다 미리 물어보는 게 낫고, 물어보지 않아도 막히는 게 낫다.
 *
 * 조회 자체는 데몬이 이미 다 하고 있으므로 여기서는 얇게 전달만 한다.
 * 그래프를 두 벌 들고 있으면 서로 어긋난다.
 */
export async function runMcp(repoRoot: string, explicitPort?: number) {
  const port = await resolvePort(repoRoot, explicitPort)

  const api = async (path: string): Promise<any> => {
    if (!(await health(port))) {
      spawnDaemon(repoRoot, port)
      for (let i = 0; i < 20 && !(await health(port)); i++) await new Promise(r => setTimeout(r, 250))
    }
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`codyssey 데몬 응답 오류 (${res.status})`)
    return res.json()
  }

  const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })

  const server = new McpServer({ name: 'codyssey', version: '0.1.0' })

  server.registerTool(
    'get_overview',
    {
      title: '저장소 구조 요약',
      description:
        '이 저장소의 기능(사용자가 쓰는 화면/API), 모듈(폴더 묶음), 잠긴 파일을 한 번에 본다. 작업을 시작하기 전에 부르면 좋다.',
      inputSchema: {},
    },
    async () => {
      const s = await api('/api/state')
      const L = [
        `파일 ${s.counts.files} · 연결 ${s.counts.edges} · 기능 ${s.counts.features} · 잠김 ${s.counts.locks}`,
        '',
        '기능 (사용자가 쓰는 화면/API)',
        ...s.features.map((f: any) => `  ${f.id}  (${f.size}개 파일, 이 기능만 쓰는 파일 ${f.exclusive}개)${f.locked ? ' [잠김]' : ''}`),
        '',
        '큰 모듈',
        ...s.modules.slice(0, 12).map((m: any) => `  ${m.name}  ${m.files}개`),
      ]
      const locked = s.nodes.filter((n: any) => n.locked).map((n: any) => n.id)
      if (locked.length) L.push('', `잠긴 파일 (수정하면 차단됨)`, ...locked.map((f: string) => `  ${f}`))
      return text(L.join('\n'))
    },
  )

  server.registerTool(
    'impact_of',
    {
      title: '이 파일을 고치면 무엇이 영향받나',
      description:
        '파일 하나를 수정했을 때 깨질 수 있는 기능·모듈과 그 파일을 쓰는 곳을 알려준다. 고치기 전에 확인하라.',
      inputSchema: { file: z.string().describe('레포 루트 기준 경로. 끝부분만 줘도 찾는다') },
    },
    async ({ file }) => {
      const s = await api('/api/state')
      const node =
        s.nodes.find((n: any) => n.id === file) ?? s.nodes.find((n: any) => n.id.endsWith(file))
      if (!node) return text(`그래프에서 못 찾음: ${file}`)

      const users = s.edges.filter((e: any) => e.to === node.id).map((e: any) => e.from)
      const uses = s.edges.filter((e: any) => e.from === node.id).map((e: any) => e.to)
      const L = [
        `${node.id}${node.locked ? '  [잠김 - 수정하면 차단됨]' : ''}`,
        `모듈: ${node.module || '-'}`,
        node.features.length ? `영향 기능 ${node.features.length}개: ${node.features.join(', ')}` : '어느 기능에도 안 속함',
        `이 파일을 쓰는 곳 ${users.length}개${users.length ? ': ' + users.slice(0, 20).join(', ') : ''}`,
        `이 파일이 쓰는 것 ${uses.length}개${uses.length ? ': ' + uses.slice(0, 20).join(', ') : ''}`,
      ]
      return text(L.join('\n'))
    },
  )

  server.registerTool(
    'find_file',
    {
      title: '파일 찾기',
      description: '이름 조각이나 기능 이름으로 파일을 찾는다. 어디를 고쳐야 할지 모를 때 쓴다.',
      inputSchema: { query: z.string().describe('파일명 조각, 폴더명, 또는 기능 이름') },
    },
    async ({ query }) => {
      const s = await api('/api/state')
      const q = query.toLowerCase()
      const byName = s.nodes.filter((n: any) => n.id.toLowerCase().includes(q))
      const byFeature = s.features
        .filter((f: any) => f.id.toLowerCase().includes(q))
        .flatMap((f: any) => s.nodes.filter((n: any) => n.features.includes(f.id)))
      const hits = [...new Set([...byName, ...byFeature].map((n: any) => n.id))].sort().slice(0, 30)
      if (!hits.length) return text(`'${query}' 로 찾은 파일이 없습니다.`)
      return text([`'${query}' 결과 ${hits.length}개`, ...hits.map(h => `  ${h}`)].join('\n'))
    },
  )

  server.registerTool(
    'check_edit',
    {
      title: '이 파일을 고쳐도 되나',
      description: '수정하면 차단되는지 미리 확인한다. 막히고 나서 되돌리는 것보다 낫다.',
      inputSchema: {
        file: z.string().describe('레포 루트 기준 경로'),
        adding: z.string().optional().describe('추가할 코드 (import 규칙 검사용)'),
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
      if (!d) return text(`${file} - 자유롭게 고칠 수 있습니다.`)
      return text(
        [
          `${file} - ${d === 'deny' ? '차단됩니다' : '사람 확인이 필요합니다'}`,
          j.hookSpecificOutput.permissionDecisionReason ?? '',
          j.hookSpecificOutput.additionalContext ?? '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
    },
  )

  await server.connect(new StdioServerTransport())
}
