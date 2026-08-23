import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

/**
 * 사람이 읽는 이름.
 *
 * `PAGE /checkout` 은 개발자에겐 충분하지만 코드를 모르는 사람에겐 아무 의미가 없다.
 * "결제 화면" 이라고 해야 알아듣는다.
 *
 * 이름을 얻는 방법이 두 가지인데 순서가 중요하다.
 *   1. 사전   경로 조각에서 바로 뽑는다. 설치 즉시 동작하고 완전히 결정적이다.
 *   2. 에이전트  사용자가 이미 구독 중인 AI 가 한 번 붙여주고 파일에 캐시한다.
 *
 * 우리가 LLM 을 부르지는 않는다. API 키도 비용도 없고, 무엇보다 결과가
 * 파일에 고정되므로 그래프는 여전히 결정적이다(P2). 이름은 구조가 아니라
 * 구조에 붙는 메모이고, 틀리면 사람이 파일을 고치면 된다.
 */
export interface Labels {
  /** 진입점 id -> 사람이 읽는 이름.  'PAGE /checkout' -> '결제 화면' */
  features: Record<string, string>
  /** 모듈 이름 -> 사람이 읽는 이름.  'api/services' -> '서버 처리 로직' */
  modules: Record<string, string>
  /** 파일 경로 -> 사람이 읽는 이름 */
  files: Record<string, string>
}

export const emptyLabels = (): Labels => ({ features: {}, modules: {}, files: {} })

const labelsPath = (repoRoot: string) => path.join(repoRoot, '.codyssey', 'labels.yaml')

export function loadLabels(repoRoot: string): Labels {
  try {
    const parsed = YAML.parse(fs.readFileSync(labelsPath(repoRoot), 'utf8')) ?? {}
    return {
      features: parsed.features ?? {},
      modules: parsed.modules ?? {},
      files: parsed.files ?? {},
    }
  } catch {
    return emptyLabels()
  }
}

export function saveLabels(repoRoot: string, labels: Labels) {
  const p = labelsPath(repoRoot)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const header = [
    '# 사람이 읽는 이름',
    '#',
    '# AI 가 한 번 붙여주고 여기에 저장됩니다. 틀린 게 있으면 직접 고치세요.',
    '# 이 파일은 커밋하는 게 좋습니다. 팀원과 AI 가 같은 이름을 보게 됩니다.',
    '',
  ].join('\n')
  // 정렬해서 쓴다. 순서가 흔들리면 diff 가 소음이 된다. (P8)
  const sorted: Labels = {
    features: sortKeys(labels.features),
    modules: sortKeys(labels.modules),
    files: sortKeys(labels.files),
  }
  fs.writeFileSync(p, header + YAML.stringify(sorted))
}

const sortKeys = (o: Record<string, string>) =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))

// ---------------------------------------------------------------- 사전

/**
 * 흔한 경로 조각. 실제 웹앱에서 이 정도면 대부분 덮인다.
 * AI 가 이름을 붙이기 전에도, 붙일 수 없는 환경에서도 이게 동작한다.
 */
const WORDS: Record<string, string> = {
  login: '로그인', logout: '로그아웃', signup: '회원가입', register: '회원가입',
  auth: '인증', password: '비밀번호', session: '세션', token: '토큰',
  user: '사용자', users: '사용자', profile: '프로필', account: '계정', member: '회원',
  admin: '관리자', dashboard: '대시보드', settings: '설정', config: '설정',
  payment: '결제', payments: '결제', checkout: '결제', billing: '결제', invoice: '청구서',
  order: '주문', orders: '주문', cart: '장바구니', product: '상품', products: '상품',
  item: '항목', items: '항목', catalog: '상품 목록', inventory: '재고',
  search: '검색', filter: '필터', sort: '정렬',
  post: '글', posts: '글', article: '글', comment: '댓글', comments: '댓글',
  message: '메시지', chat: '채팅', notification: '알림', mail: '메일', email: '메일',
  file: '파일', files: '파일', upload: '업로드', download: '다운로드', image: '이미지',
  report: '리포트', stats: '통계', analytics: '분석', metrics: '지표', log: '기록',
  api: 'API', client: '클라이언트', server: '서버', db: '데이터베이스', database: '데이터베이스',
  model: '데이터 구조', models: '데이터 구조', schema: '데이터 구조',
  service: '처리 로직', services: '처리 로직', route: '주소 연결', routes: '주소 연결',
  component: '화면 조각', components: '화면 조각', page: '화면', pages: '화면', view: '화면',
  lib: '공용 코드', util: '공용 코드', utils: '공용 코드', shared: '공용 코드', common: '공용 코드',
  core: '핵심 로직', hook: '재사용 로직', hooks: '재사용 로직', store: '상태 저장',
  test: '테스트', tests: '테스트', spec: '테스트', mock: '테스트용 가짜',
  home: '홈', index: '첫 화면', main: '메인', app: '앱', web: '웹',
  me: '내', new: '새로 만들기', edit: '수정', detail: '상세', list: '목록',
}

/** 경로 조각 하나를 사람 말로. 못 바꾸면 원문 그대로. */
function word(seg: string): string {
  const key = seg.toLowerCase().replace(/[-_]/g, '')
  return WORDS[key] ?? WORDS[key.replace(/s$/, '')] ?? seg
}

/**
 * 진입점 id 를 사람이 읽는 이름으로.
 *   'PAGE /checkout'          -> '결제 화면'
 *   'GET /api/v1/admin/stats' -> '관리자 통계 API'
 *   'ENTRY src/cli.ts'        -> 'cli 시작점'
 */
export function describeFeature(id: string, labels: Labels): string {
  const custom = labels.features[id]
  if (custom) return custom

  const [kind, ...rest] = id.split(' ')
  const raw = rest.join(' ')

  if (kind === 'PAGE') {
    const segs = raw.split('/').filter(Boolean).filter(s => !/^[:{[]/.test(s))
    if (!segs.length) return '첫 화면'
    return segs.map(word).join(' ') + ' 화면'
  }
  if (kind === 'ENTRY') {
    const base = raw.split('/').pop()?.replace(/\.\w+$/, '') ?? raw
    return `${word(base)} 시작점`
  }
  // GET / POST 같은 HTTP 라우트
  const segs = raw
    .split('/')
    .filter(Boolean)
    .filter(s => !/^[:{[]/.test(s) && !/^v\d+$/.test(s) && s.toLowerCase() !== 'api')
  const verb = kind === 'GET' ? '조회' : kind === 'POST' ? '생성' : kind === 'DELETE' ? '삭제' : '변경'
  if (!segs.length) return `${verb} API`
  return `${segs.map(word).join(' ')} ${verb} API`
}

/** 모듈 이름을 사람 말로.  'api/services' -> '서버 처리 로직' */
export function describeModule(name: string, labels: Labels): string {
  const custom = labels.modules[name]
  if (custom) return custom
  const segs = name.split('/').filter(s => s && s !== '(루트)')
  if (!segs.length) return '최상위'
  return segs.map(word).join(' ')
}

/**
 * 파일을 사람 말로.  'api/routes/admin.py' -> '관리자 (주소 연결)'
 *
 * 파일 이름은 기능·모듈보다 훨씬 안 풀린다. 마이그레이션 파일명 같은 건 방법이 없다.
 * 그래서 **확실할 때만 바꾸고 아니면 파일명 그대로 둔다.**
 * `routes/admin.py` 를 '주소 연결 관리자' 라고 하면 오히려 더 헷갈린다.
 * 구체적인 쪽(파일명)을 앞에 두고 맥락(폴더)은 괄호로 뒤에 붙인다.
 */
export function describeFile(file: string, labels: Labels): string {
  const custom = labels.files[file]
  if (custom) return custom

  const parts = file.split('/')
  const raw = parts.pop() ?? file
  const base = raw.replace(/\.\w+$/, '')
  const dir = parts[parts.length - 1] ?? ''

  const name = word(splitCamel(base))
  const where = dir ? word(dir) : ''
  const hasName = name !== splitCamel(base)
  const hasWhere = Boolean(where) && where !== dir

  if (hasName && hasWhere) return `${name} (${where})`
  if (hasName) return name
  if (hasWhere) return `${raw} (${where})`
  return raw
}

/** camelCase 를 첫 단어로. formatMoney -> format */
const splitCamel = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ')[0]

// ---------------------------------------------------------------- 에이전트에게 부탁하기

export interface LabelRequest {
  features: string[]
  modules: string[]
}

/**
 * 아직 사람이 붙인 이름이 없는 것들.
 * 사전으로 뽑은 이름은 '있는 것' 으로 치지 않는다. 사전은 어디까지나 폴백이다.
 */
export function unlabeled(
  featureIds: string[],
  moduleNames: string[],
  labels: Labels,
  limit = 40,
): LabelRequest {
  return {
    features: featureIds.filter(id => !labels.features[id]).slice(0, limit),
    modules: moduleNames.filter(m => !labels.modules[m]).slice(0, limit),
  }
}
