# CODYSSEY

> AI가 코드를 고치기 전에 **뭐가 깨지는지 알려주고**, 건드리면 안 되는 곳은 **실제로 막습니다.**

[English →](README.md)

바이브 코딩을 하다 보면 AI가 잘 돌아가던 부분을 조용히 망가뜨립니다.
CODYSSEY는 편집이 일어나기 직전에 끼어들어서, 여러 기능이 함께 쓰는 파일이나
잠가둔 파일을 고치려 하면 이유와 함께 막습니다.

기존 도구들은 전부 *알려주기*만 합니다. AI가 무시하면 그만입니다.
CODYSSEY는 `PreToolUse` 훅에서 차단합니다. 그게 유일하게 강제력이 있는 지점입니다.

`Edit` 만 막으면 `sed -i` 한 줄로 뚫립니다. 그래서 **`Bash` 명령도 읽어서**
어떤 파일을 쓰려는지 뽑아냅니다. 리다이렉션, heredoc, `sed -i`, `tee`, `cp`/`mv`, `rm`
전부 같은 규칙을 거칩니다. 읽기만 하는 명령(`cat`, `grep`, `npm test`)은 그대로 통과합니다.

## 시작하기

**AI 에게 시켜도 됩니다.** Claude Code 에 이렇게 말하세요:

> "codyssey 를 설치해줘. `npx codyssey init` 실행하고, 끝나면 나한테 Claude Code 를 다시 시작하라고 알려줘."

직접 치려면:

```bash
npx codyssey init
```

이 한 줄이 전부입니다. 코드를 읽고, 설정을 만들고, 웹 화면을 띄웁니다.
포트는 프로젝트 폴더에서 계산되므로 여러 프로젝트를 동시에 열어도 서로 안 겹칩니다.

```
CODYSSEY 설정 중...

  코드 19개 파일을 읽었습니다
  기능 4개를 찾았습니다
  여러 기능이 함께 쓰는 파일 5개 - 잠글지 화면에서 골라주세요

  + .codyssey/rules.yaml
  + .claude/settings.json
  + .mcp.json
  + .git/hooks/pre-commit

설정 완료. 이 프로젝트는 포트 7912 를 씁니다.

중요: 차단이 켜지려면 Claude Code 를 다시 시작해야 합니다.
```

**설정 직후 Claude Code 를 한 번 다시 시작해야 합니다.** 훅 설정은 세션이
시작될 때 읽히기 때문입니다. 다시 시작한 뒤로는 데몬도 알아서 켜집니다.

브라우저에서 파일 상자를 클릭하고 **지키기**를 누르면 끝입니다.
그다음부터 AI가 그 파일을 고치려 하면 이렇게 막힙니다.

```
[codyssey] 결제 코어. 사람 승인 필요
한 화면에만 필요한 변경이면 이 파일을 쓰는 쪽에서 고치세요: api/routes/admin.py, api/routes/payments.py
```

## 쓰는 말

기본은 영어이고, 시스템 설정이 한국어면 알아서 한국어로 갑니다.

```bash
codyssey init --lang ko      # 또는 en
```

고른 말은 `.codyssey/rules.yaml` 의 `lang:` 에 적힙니다. 그래서 어느 컴퓨터에서
열어도 같은 말로 나옵니다. `--lang` 은 언제나 파일보다 우선합니다.

## 큰 프로젝트에서도

400 파일짜리 저장소를 통째로 그리면 아무것도 읽을 수 없습니다.
그래서 기본 화면은 **지금 관심 있는 파일 주변**만 보여줍니다.

- **주변만** - 고른 파일(없으면 최근 활동/잠긴 파일/잠금 제안)에서 가까운 순으로 24개
- **이 모듈** - 같은 폴더 묶음만
- **전체** - 다 보기 (모듈로 접어서)

몇 개를 숨겼는지 항상 위에 적습니다. 조용히 줄이지 않습니다.

## 기능과 모듈, 두 가지 축

| | 기능 | 모듈 |
|---|---|---|
| 관점 | 사용자가 쓰는 화면/API | 폴더로 나눈 코드 묶음 |
| 어떻게 찾나 | 진입점에서 도달 가능한 파일 | 프로젝트 루트 기준 상위 두 단계 |
| 언제 유용한가 | 웹앱 | 항상 (라이브러리·CLI 포함) |

여러 기능이나 여러 모듈이 함께 쓰는 파일이 잠금 후보입니다.

## 잠금 추천은 이유를 말합니다

"여러 기능이 쓰는 파일 9개, 골라주세요" 는 추천이 아닙니다. `codyssey status`, 웹 화면,
MCP 개요, 라이브러리 API 가 전부 같은 걸 줍니다. 무엇을 잠글지, 왜(실제 숫자와 함께),
잠그면 AI 에게 무슨 일이 생기는지, 얼마나 확실한지, 그리고 무엇을 왜 빼놓았는지.

```
3. backend/app/core/security.py  권장: 고칠 때 승인
   왜: 기능 23개가 함께 씁니다: Items read API, Login API 외 21곳.
   왜: 여기서 내보낸 'verify_password'를 5곳이 가져다 씁니다. 이름을 바꾸거나 없애면 거기가 깨집니다.
   잠그면: AI 는 읽을 수 있지만 고칠 땐 당신 확인을 거칩니다.
   import 관계만 봤습니다. 실제 동작이 깨지는지는 테스트가 알려줍니다.

추천하지 않는 것, 그리고 왜
   backend/app/__init__.py            비어 있어서 지킬 게 없습니다
   frontend/src/client/sdk.gen.ts     도구가 만드는 파일. 사람이 고치지 않습니다
```

`.env` 같은 비밀은 **차단**을 권장합니다. `secret` 으로 잠그면 AI 가 고치지도 읽지도 못합니다
(Claude Code 규칙에 `Edit(/.env)` 와 `Read(/.env)` 를 적고, 이 규칙은 Bash 의 `cat`/`sed` 에도 적용됩니다).

## 파일 잠금만으로는 안 잡히는 것들

파일을 통째로 잠그는 건 무딘 도구입니다. 그 파일을 고치는 건 대부분 정상이고,
문제는 **그 안의 특정 이름**이거나 **고친 뒤에 뭘 확인해야 하는가**입니다.

**약속(계약) 보호** — 밖에서 이름으로 가져다 쓰는 export 를 없애려 하면 알립니다.

```
AI: export function formatMoney 를 formatCents 로 바꾸려 함
→  'formatMoney'를 없애려 합니다. 3곳이 이 이름을 가져다 씁니다.
   쓰는 곳: web/app/admin/page.tsx, web/components/OrderTable.tsx, ...
```

실제 저장소에서 `src/shared/logger.ts` 의 `logger` 는 **83곳**이 가져다 씁니다.
AI 가 리팩터링하다 이런 걸 지우는 게 가장 흔한 사고인데, 파일 잠금으로는 안 잡힙니다.

**돌려야 할 테스트** — 고친 뒤에 무엇을 확인해야 하는지 알려줍니다. "테스트 돌려" 가 아니라 이름으로.

```
→  끝내기 전에 이 테스트를 돌리세요: tests/core/packager.test.ts
```

안 돌리고 끝내려 하면 `Stop` 훅이 같은 목록을 들고 **한 번** 되돌려 보냅니다.
두 번째는 보내줍니다. 벽이 아니라 한 번 찌르는 겁니다.
영향받는 테스트를 이름으로 주는 것이 회귀를 줄인다고 측정된 유일한 개입이고,
"TDD 하라" 같은 일반 지시는 오히려 악화시켰습니다 (TDAD, 2026 프리프린트).

**되돌릴 수 없는 명령** — 프로젝트 밖(또는 프로젝트 자체)을 지우는 `rm -rf`,
`git reset --hard`, `git clean -f`, `git checkout .` 은 사람에게 먼저 묻습니다.
체크포인트는 Bash 가 지운 걸 되살리지 못합니다.

**잠금은 Claude Code 규칙으로도 적힙니다.** `protect:` 항목마다 `.claude/settings.json` 의
`permissions.deny` 에 `Edit(/경로)` 가 들어갑니다. 데몬이 꺼져 있어도 막히고,
`sed`/`tee`/리다이렉션도 같은 규칙을 타고, 샌드박스가 켜져 있으면 스크립트 안에서 쓰는 것까지
막힙니다. 명령문을 읽는 방식으로는 절대 못 보는 영역입니다.

**이미 있는 이름** — 있는 함수를 또 만들려 하면 알립니다.

```
→  'formatMoney'는 web/lib/money.ts 에 이미 있습니다.
```

## AI 에게 세 가지 방식으로 붙습니다

| 방식 | 언제 | 무엇 |
|---|---|---|
| **차단** | 편집 직전 | 잠긴 파일이면 이유와 함께 막는다 (1.15ms). `Edit`/`Write` 뿐 아니라 `Bash` 도 본다 |
| **알림** | 세션 시작 · 프롬프트 · 편집 직후 | 기능 목록, 언급된 파일의 영향 범위, 바뀐 연결 |
| **조회** | 에이전트가 물어볼 때 | MCP 도구 6개: `get_overview` `impact_of` `find_file` `check_edit` `get_unlabeled` `set_labels` |

알림은 **할 말이 없으면 아무것도 넣지 않습니다.** 같은 말을 두 번 하지도 않습니다.
편집마다 수백 토큰씩 붙이면 도움이 아니라 방해입니다.

## 라이브러리로 쓰기

훅·MCP 서버·웹 화면은 전부 하나의 엔진 위에 얹힌 껍데기입니다. 다른 프로그램
(예: 여러 AI 작업자에게 일을 나눠 주는 오케스트레이터)이 엔진을 바로 부를 수 있습니다.
데몬도, 포트도, 훅 JSON 흉내도 필요 없습니다.

```ts
import { Codyssey } from 'codyssey'

const c = await Codyssey.open('/path/to/repo')

c.features()                       // [{ id: 'PAGE /checkout', label, file, files: [...] }]
c.contextFor(['src/pay/core.py'])  // 작업 계약에 넣을 사실: 영향 기능, import 하는 곳,
                                   // 밖에서 쓰는 export, 돌릴 테스트, 잠긴 파일
c.checkEdit('src/pay/core.py', { before, after })  // allow | note | ask | block + 이유
c.checkCommand('rm -rf ~/')        // ask: 되돌릴 수 없다
c.checkChanges(diffFiles)          // 작업자의 변경을 합치기 전 검사
await c.afterEdit('src/pay/core.py') // 그래프 갱신, { tests, notes } 반환
c.lock('src/pay/core.py', '결제 코어')  // Claude Code permissions.deny 에도 적힌다
await c.diff('origin/main')        // 아키텍처 diff
```

돌려주는 값은 전부 구조화된 데이터입니다. 사실을 문장으로 바꾸는 건 부르는 쪽이 합니다.
모델이 다르면 필요한 문장도 다르기 때문입니다. 타입은 `dist/types/api.d.ts` 에 있습니다.

## PR 에서

```bash
codyssey diff origin/main --markdown
```

```markdown
## 아키텍처 변화 (`origin/main` 대비)

### 잠긴 파일이 바뀌었습니다
- `api/services/payment.py`
사람 승인이 필요한 파일입니다. 의도한 변경인지 확인해 주세요.

### 새 모듈 간 연결
- `web/components -> api/routes (HTTP)`
```

`.github/workflows/codyssey.yml` 을 그대로 쓰면 PR 에 코멘트가 달리고,
잠긴 파일이 바뀌거나 새 규칙 위반이 생기면 CI 가 실패합니다.

파일 단위가 아니라 **모듈 간 연결**로 봅니다. 파일 하나 옮긴 걸로 수백 줄이 나오면
아무도 안 읽습니다.

## 왜 필요한가

- **언어 경계를 넘는 영향 추적** — 파이썬 서비스 파일 하나가 어느 프론트 화면을 깨뜨리는지 보여줍니다
- **여러 기능이 공유하는 파일 자동 탐지** — 여기가 깨지면 여러 곳이 한꺼번에 망가집니다
- **LLM 호출 0회** — 전부 정적 분석입니다. API 키도, 코드 유출도, 요금도 없습니다
- **코드는 한 줄도 안 바뀝니다** — `.codyssey/` 폴더만 지우면 완전히 원상복구됩니다
- **막히면 안 될 때는 안 막습니다** — 프로그램이 꺼져 있거나 판단이 안 서면 조용히 통과시킵니다

## 명령어

```bash
codyssey init                 처음 한 번. 설정하고 웹 화면 열기
codyssey start                웹 화면 + 파일 감시 시작
codyssey doctor               설정이 제대로 됐는지 점검
codyssey status               터미널에 요약 출력
codyssey map                  터미널에 구조 그리기
codyssey impact <파일>        이 파일을 고치면 뭐가 영향받나
codyssey diff <기준>          기준 커밋 대비 아키텍처 변화
codyssey mcp                  MCP 서버 (에이전트가 물어볼 창구)
codyssey stop                 백그라운드로 켜진 것 끄기
codyssey scan                 구조 파일만 만들기
```

```
$ codyssey impact services/payment.py

영향 기능 2개
  GET /api/v1/admin/stats
  PAGE /checkout

이 파일을 쓰는 곳 5개
  api/main.py
  api/routes/admin.py
  ...
```

## 규칙

`.codyssey/rules.yaml` 한 파일입니다. 웹 화면에서 클릭으로 편집되지만 직접 써도 됩니다.

```yaml
lang: ko                                    # en | ko

protect:                                    # AI가 못 고치는 파일
  - path: api/services/payment.py
    reason: 결제 코어. 사람 승인 필요

layers:                                     # 이 방향 import 금지
  - deny: web/components/** -> web/lib/api.ts
    reason: 데이터 가져오기는 페이지에서만

autolock:                                   # 여러 기능이 공유하는 파일
  minFeatures: 3
  mode: note                                # off | note | ask | block
```

`note`(기본)는 **AI 에게** "이 파일은 기능 8개가 쓴다, 전부 호환되게 고치고 그 테스트를 돌려라" 라고
알려주고 편집은 통과시킵니다. 사람에게 묻지 않습니다. 사람은 권한 요청의 93% 를 그냥 승인하고,
너무 자주 묻는 도구는 꺼버리기 때문입니다. 묻는 건 `ask` 모드와 직접 잠근 파일에만 씁니다.

## 지원

TypeScript / JavaScript / Python.
Next.js 파일 기반 라우트(app + pages), TanStack Router, FastAPI `APIRouter` prefix
합성(중첩 포함), tsconfig 경로 별칭, TypeScript ESM(`./x.js` → `x.ts`)을 이해합니다.

## 상태

v0.2.3. 실제 오픈소스 6개로 검증합니다 (`npm run bench`).
테스트 304개. 빌드된 배포본을 설치해서 설정→데몬→웹 화면→잠금→차단까지
한 바퀴 도는 검증이 포함돼 있습니다.

## 개발

```bash
npm install
npm test          # 7개 스위트 304개
npm start         # 데몬 실행
```

`fixtures/shop`은 잡아야 할 케이스를 전부 심어둔 최소 프로젝트입니다.
TypeScript 프론트 + Python 백엔드로 되어 있어서 언어 경계 추적까지 실제로 검증합니다.
`fixtures/vibe`는 그 반대입니다. 한 파일에 전부 몰아넣은, 실제 바이브 코딩 결과물에 가까운 모양입니다.

```bash
npm run bench -- --pull   # 실제 오픈소스 6개에 대고 점수 내기
```

픽스처 하나만 보고 개발하면 실제 저장소에서 그래프가 통째로 비어도 모릅니다.
실제로 그랬습니다. 그래서 판단은 벤치 표를 보고 합니다.

## 구조

```
src/core/      언어와 무관한 본체 - 그래프, 기능 추출, 규칙
src/adapters/  언어별 어댑터 (각 200줄 내외)
src/index/     파서, 스캐너
src/daemon/    상주 서버 + 훅 응답
src/i18n/      메시지 카탈로그 (en, ko)
src/ui/        웹 화면 (단일 HTML, 빌드 없음)
```

의존성 5개. LLM 호출 0회.
