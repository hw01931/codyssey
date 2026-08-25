import type { en } from './en.ts'

/**
 * 한국어.
 *
 * 조사는 `josa()` 로 붙인다. `은(는)` 같은 표기를 남기지 않는다.
 * 그래서 이 카탈로그에는 `{name}{은는}` 처럼 조사 자리를 따로 둔 키가 있고,
 * 부르는 쪽에서 josa() 결과를 넘긴다.
 */
export const ko: Record<keyof typeof en, string> = {
  // ---- 차단 / 확인 ----
  'rule.protected': '{name}{은는} 보호된 파일입니다. {reason}',
  'rule.featureLocked': '{name}{은는} 잠겨 있습니다. {reason}',
  'rule.featureExclusive': "이 파일은 '{id}' 전용입니다. 다른 기능 파일은 자유롭게 고칠 수 있습니다.",
  'rule.layerDenied': '{from} 에서 {to} 를 import 할 수 없습니다.',
  'rule.layerHint': "'{spec}' import 를 제거하거나, 상위 계층에서 값을 내려받으세요.",
  'rule.sharedFeatures': '이 파일을 고치면 {list} {count}곳이 같이 바뀝니다. 계속할까요?',
  'rule.sharedModules': '이 파일은 {list}{more}에서 함께 씁니다. 계속할까요?',
  'rule.sharedModulesMore': ' 외 {count}곳',
  'rule.layerViolation': '레이어 위반',
  'rule.sharedBy': '기능 {count}개가 공유: {list}',
  'rule.unlockHint': '그래도 바꾸려면 "codyssey 에서 {name} 잠금 풀어줘" 라고 말하세요.',
  'rule.freeNeighbours': '대신 고칠 수 있는 이웃 파일: {list}',

  // ---- 계약 ----
  'contract.broken': '{name}{은는} 다른 파일 {count}곳이 씁니다. 지우거나 이름을 바꾸면 그곳들이 깨집니다.',
  'contract.users': '쓰는 곳: {list}',
  'contract.keepHint': '이름을 export 로 남겨두거나, 쓰는 곳을 이번 작업에서 같이 고치세요.',

  // ---- 테스트 ----
  'test.covering': '이 파일을 검증하는 테스트: {list}',

  // ---- 설치 ----
  'init.readFiles': '코드 {count}개 파일을 읽었습니다',
  'init.foundFeatures': '기능 {count}개를 찾았습니다',
  'init.wrote': '만든 파일',
  'init.done': '설정 완료. 이 프로젝트는 포트 {port} 를 씁니다.',
  'init.restart': '중요: 차단이 켜지려면 Claude Code 를 다시 시작해야 합니다.',
  'init.restartWhy': '훅 설정은 세션이 시작될 때 읽힙니다. 지금 세션에는 적용되지 않습니다.',
  'init.restartThen': '다시 시작한 뒤부터는 데몬도 자동으로 켜집니다.',
  'init.running': '실행 중',
  'init.notReady': '아직 준비 중',
  'init.stopHint': '끄려면: codyssey stop',
  'init.noGit': 'git 저장소가 아니라 커밋 훅은 건너뛰었습니다.',

  // ---- 상태 / 진단 ----
  'status.files': '파일',
  'status.edges': '연결',
  'status.features': '기능',
  'status.locks': '잠김',
  'doctor.ok': '이상 없습니다.',
  'doctor.daemonDown': '데몬이 꺼져 있습니다. `codyssey start` 를 실행하세요.',
  'doctor.portTaken': '포트 {port} 를 다른 프로젝트({root})가 쓰고 있습니다. `codyssey init` 을 다시 실행해 새 포트를 받으세요.',
  'doctor.noHooks': '훅이 설치되어 있지 않습니다. `codyssey init` 을 실행하세요.',
  'doctor.notRestarted': '훅은 설치됐지만 이 세션은 그 전에 시작됐습니다. Claude Code 를 다시 시작하세요.',
  'doctor.parseFailures': '{count}개 파일을 읽지 못해 그래프에서 빠졌습니다.',

  // ---- 잠금 ----
  'lock.locked': '{name}{을를} 잠갔습니다.',
  'lock.unlocked': '{name} 잠금을 풀었습니다.',
  'lock.noSuchFile': '그런 파일이 없습니다: {file}',
  'lock.outsideRepo': '프로젝트 밖의 경로입니다: {file}',
  'lock.noSuchFeature': '그런 기능이 없습니다: {id}',
  'lock.needPath': '파일 경로가 필요합니다.',

  // ---- 브리핑 ----
  'brief.title': '프로젝트 구조 (codyssey)',
  'brief.lockedFiles': '잠긴 파일 — 고치면 차단됩니다:',
  'brief.noLocks': '아직 잠근 것이 없습니다.',
  'brief.hint': '어떤 파일이 무엇에 영향을 주는지 모르겠으면 고치기 전에 codyssey 에게 물어보세요.',

  // ---- 레이블 (경로에서 뽑은 이름에 붙는 말) ----
  'label.home': '첫 화면',
  'label.page': '{name} 화면',
  'label.entry': '{name} 시작점',
  'label.api': '{name} {verb} API',
  'label.apiOnly': '{verb} API',
  'label.verb.get': '조회',
  'label.verb.post': '생성',
  'label.verb.delete': '삭제',
  'label.verb.other': '변경',
  'label.root': '최상위',

  // ---- 일반 ----
  'common.and': '외',
  'common.none': '없음',
  'common.more': '외 {count}곳',
}
