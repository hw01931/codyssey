# CODYSSEY

> AI가 코드를 고치기 전에 **뭐가 깨지는지 알려주고**, 건드리면 안 되는 곳은 **실제로 막습니다.**

바이브 코딩을 하다 보면 AI가 잘 돌아가던 부분을 조용히 망가뜨립니다.
CODYSSEY는 편집이 일어나기 직전에 끼어들어서, 여러 기능이 함께 쓰는 파일이나
잠가둔 파일을 고치려 하면 이유와 함께 막습니다.

기존 도구들은 전부 *알려주기*만 합니다. AI가 무시하면 그만입니다.
CODYSSEY는 `PreToolUse` 훅에서 차단합니다. 그게 유일하게 강제력이 있는 지점입니다.

## 시작하기

```bash
npx codyssey init
```

이 한 줄이 전부입니다. 코드를 읽고, 설정을 만들고, 웹 화면을 띄웁니다.

```
CODYSSEY 설정 중...

  코드 19개 파일을 읽었습니다
  기능 4개를 찾았습니다
  여러 기능이 함께 쓰는 파일 5개 - 잠글지 화면에서 골라주세요

  + .codyssey/rules.yaml
  + .claude/settings.json
  + .gitignore

설정 완료. 이제 웹 화면을 엽니다.
```

브라우저에서 파일 상자를 클릭하고 **잠그기**를 누르면 끝입니다.
그다음부터 AI가 그 파일을 고치려 하면 이렇게 막힙니다.

```
[codyssey] 결제 코어. 사람 승인 필요
대신 고칠 수 있는 이웃 파일: api/services/order.py
```

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
codyssey status               터미널에 요약 출력
codyssey impact <파일>        이 파일을 고치면 뭐가 영향받나
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
protect:                                    # AI가 못 고치는 파일
  - path: api/services/payment.py
    reason: 결제 코어. 사람 승인 필요

layers:                                     # 이 방향 import 금지
  - deny: web/components/** -> web/lib/api.ts
    reason: 데이터 가져오기는 페이지에서만

autolock:                                   # 여러 기능이 공유하는 파일
  minFeatures: 3
  mode: ask                                 # off | ask | block
```

## 지원

TypeScript / JavaScript / Python.
Next.js 파일 기반 라우트, FastAPI `APIRouter` prefix 합성(중첩 포함), tsconfig 경로 별칭을 이해합니다.

## 개발

```bash
npm install
npm test          # 단위 19개 + 통합 35개
npm start         # 데몬 실행
```

`fixtures/shop`은 잡아야 할 케이스를 전부 심어둔 최소 프로젝트입니다.
TypeScript 프론트 + Python 백엔드로 되어 있어서 언어 경계 추적까지 실제로 검증합니다.

## 구조

```
src/core/      언어와 무관한 본체 - 그래프, 기능 추출, 규칙
src/adapters/  언어별 어댑터 (각 200줄 내외)
src/index/     파서, 스캐너
src/daemon/    상주 서버 + 훅 응답
src/ui/        웹 화면 (단일 HTML, 빌드 없음)
```

의존성 4개. LLM 호출 0회.
