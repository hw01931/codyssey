/** 어댑터가 뱉는 공통 중간표현(IR). 언어별 지식은 전부 여기서 끝난다. */

/** P4: 확신 없는 엣지로는 절대 차단하지 않는다. */
export type Confidence = 'high' | 'low'

export interface Sym { name: string; kind: string; line: number }

/**
 * 한 심볼이 다른 심볼을 부르는 것.
 *
 * 파일 단위 그래프는 바이브코딩 결과물에서 아무것도 못 본다. 화면 여섯 개가
 * 한 파일에 들어있으면 파일이 1개라 '여러 곳이 공유하는 파일' 이 성립하지 않는다.
 * 위험은 그대로인데(formatPrice 를 6곳이 부른다) 우리 눈에만 안 보였다.
 *
 * `to` 는 같은 파일의 심볼이거나, import 로 들여온 이름이다.
 * 후자는 스캐너가 대상 파일까지 이어준다.
 */
export interface CallRef {
  /** 부르는 쪽 최상위 심볼. 모듈 레벨에서 부르면 undefined */
  from?: string
  /** 불리는 이름 */
  to: string
  line: number
}

/** import 문 하나. spec 은 아직 해석되지 않은 원문. */
export interface ImportRef {
  spec: string
  line: number
  /**
   * 추측성 spec.  `from a import b` 의 b 는 서브모듈일 수도 심볼일 수도 있어서
   * 양쪽 다 시도한다. 해석 실패해도 정상이므로 unresolved 로 기록하지 않는다. (P4)
   */
  speculative?: boolean
  /**
   * 이 import 로 실제로 가져온 이름들.  `import { fetchOrders } from './api'` => ['fetchOrders']
   * undefined 면 전체 모듈을 가져온 것(default/namespace/side-effect)이라 게이팅하지 않는다.
   */
  names?: string[]
}

/** router 변수 선언.  py: APIRouter(prefix=..)  /  js: express.Router() */
export interface RouterDef { name: string; prefix: string; line: number }

/** router 를 다른 모듈에 마운트.  py: include_router(x.router, prefix=..)  /  js: app.use('/x', r) */
export interface RouterMount { on: string; spec: string; attr: string; prefix: string; line: number }

/** 라우트 선언. owner 는 이걸 매단 router 변수명(앱 직결이면 '@app'). */
export interface RouteDecl { method: string; path: string; owner: string; line: number }

/** 나가는 HTTP 호출. FE→BE 경계를 잇는 유일한 단서. */
export interface HttpCall {
  method: string
  url: string
  line: number
  confidence: Confidence
  /** 이 호출을 감싼 최상위 심볼. 심볼 게이팅의 출발점이다. */
  inSymbol?: string
}

export interface ParseResult {
  symbols: Sym[]
  /** 같은 파일 안 또는 import 한 이름을 부르는 관계 */
  calls: CallRef[]
  imports: ImportRef[]
  /** 로컬 이름 -> import spec.  py: `from routes import orders` => { orders: 'routes.orders' } */
  bindings: Record<string, string>
  routerDefs: RouterDef[]
  routerMounts: RouterMount[]
  routes: RouteDecl[]
  httpCalls: HttpCall[]
}

export const emptyParse = (): ParseResult => ({
  symbols: [], calls: [], imports: [], bindings: {}, routerDefs: [], routerMounts: [], routes: [], httpCalls: [],
})

export interface ResolveCtx {
  /** 레포 루트 기준 상대경로 → 존재 여부 */
  exists(relPath: string): boolean
  /** 이 파일이 속한 프로젝트 루트(레포 상대). 예: fixtures/shop/web */
  projectRootOf(relFile: string): string
  /** 프로젝트별 alias 맵. 예: { '@/*': ['./*'] } */
  aliasesOf(projectRoot: string): Record<string, string[]>
}

export interface LangAdapter {
  name: string
  exts: string[]
  /** tree-sitter-wasm/out/<grammar> */
  grammar: string
  parse(src: string, relPath: string): Promise<ParseResult>
  resolve(spec: string, fromRel: string, ctx: ResolveCtx): { path: string; confidence: Confidence } | null
  /** 파일 경로 자체가 라우트인 경우(Next.js app router 등) */
  routeFromPath?(relPath: string, projectRoot: string): RouteDecl | null
}
