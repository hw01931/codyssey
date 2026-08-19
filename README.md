# CODYSSEY

> AI 에이전트용 아키텍처 가드레일.
> 코드를 바꾸기 전에 **뭐가 깨지는지 알려주고**, 건드리면 안 되는 곳은 **실제로 막는다.**

기존 코드베이스 도구들은 전부 *알려주기(조회)* 만 한다. 에이전트가 무시하면 그만이다.
CODYSSEY 는 편집 직전 `PreToolUse` 훅에서 차단한다. 그게 유일한 강제 지점이다.

## 특징

- **LLM 호출 0회** — 전부 정적 분석. 결정적이라 아키텍처 diff 가 성립한다
- **코드 침투 0** — import·데코레이터·빌드 개입 없음. `.codyssey/` 지우면 원상복구
- **언어 경계를 넘는 영향 반경** — 파이썬 서비스 파일이 어느 프론트 페이지를 깨뜨리는지 추적
- **fail-open** — 데몬이 죽거나 파싱이 실패하면 조용히 통과. 개발을 절대 막지 않는다

## 지금 되는 것

```bash
node --experimental-strip-types src/cli.ts scan   --root fixtures/shop
node --experimental-strip-types src/cli.ts status --root fixtures/shop
node --experimental-strip-types src/cli.ts impact services/payment.py --root fixtures/shop
```

```
$ codyssey impact services/payment.py

영향 기능 3개
  PAGE /admin
  PAGE /checkout
  PAGE /orders
```

## 상태

W1 완료. TypeScript/Python 어댑터, 그래프, 기능 추출, FE↔BE URL 매칭, CLI.
다음은 심볼 게이팅과 훅 차단.

## 테스트

```bash
node --experimental-strip-types test/run.ts
```
`fixtures/shop` 은 잡아야 할 케이스를 전부 심어둔 최소 프로젝트다.
기대 결과는 `test/run.ts` 에 어서션으로 박혀 있다.
