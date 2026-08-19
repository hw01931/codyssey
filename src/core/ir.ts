/** 어댑터가 뱉는 공통 중간표현(IR). 언어별 지식은 전부 여기서 끝난다. */

/** P4: 확신 없는 엣지로는 절대 차단하지 않는다. */
export type Confidence = 'high' | 'low'

export interface Sym { name: string; kind: string; line: number }

/** import 문 하나. spec 은 아직 해석되지 않은 원문. */
export interface ImportRef {
  spec: string
  line: number
  /**
   * 추측성 spec.  `from a import b` 의 b 는 서브모듈일 수도 심볼일 수도 있어서
   * 양쪽 다 시도한다. 해석 실패해도 정상이므로 unresolved 로 기록하지 않는다. (P4)
   */
  speculative?: boolean
}

/** router 변수 선언.  py: APIRouter(prefix=..)  /  js: express.Router() */
export interface RouterDef { name: string; prefix: string; line: number }

/** router 를 다른 모듈에 마운트.  py: include_router(x.router, prefix=..)  /  js: app.use('/x', r) */
export interface RouterMount { on: string; spec: string; attr: string; prefix: string; line: number }

/** 라우트 선언. owner 는 이걸 매단 router 변수명(앱 직결이면 '@app'). */
export interface RouteDecl { method: string; path: string; owner: string; line: number }

/** 나가는 HTTP 호출. FE→BE 경계를 잇는 유일한 단서. */
export interface HttpCall { method: string; url: string; line: number; confidence: Confidence }

export interface ParseResult {
  symbols: Sym[]
  imports: ImportRef[]
  /** 로컬 이름 -> import spec.  py: `from routes import orders` => { orders: 'routes.orders' } */
  bindings: Record<string, string>
  routerDefs: RouterDef[]
  routerMounts: RouterMount[]
  routes: RouteDecl[]
  httpCalls: HttpCall[]
}

export const emptyParse = (): ParseResult => ({
  symbols: [], imports: [], bindings: {}, routerDefs: [], routerMounts: [], routes: [], httpCalls: [],
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
