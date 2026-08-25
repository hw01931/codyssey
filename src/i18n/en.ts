/**
 * 기준이 되는 카탈로그.
 *
 * 다른 말은 전부 여기 있는 키를 그대로 가져야 한다. 테스트가 강제한다.
 * 문장은 짧고 평범하게 쓴다. 코드를 모르는 사람이 읽고 다음에 뭘 할지
 * 알 수 있어야 한다 — 어느 말로 읽든 그건 같다.
 */
export const en = {
  // ---- 차단 / 확인 (훅이 돌려주는 말. 사람도 읽고 AI 도 읽는다) ----
  'rule.protected': '{name} is protected. {reason}',
  'rule.featureLocked': '{name} is locked. {reason}',
  'rule.featureExclusive': "This file belongs only to '{id}'. Files in other features are free to edit.",
  'rule.layerDenied': '{from} may not import {to}.',
  'rule.layerHint': "Remove the '{spec}' import, or pass the value down from the layer above.",
  'rule.sharedFeatures': 'Editing this file changes {list} — {count} places at once. Continue?',
  'rule.sharedModules': 'This file is used by {list}{more}. Continue?',
  'rule.sharedModulesMore': ' and {count} more',
  'rule.layerViolation': 'layer violation',
  'rule.sharedBy': 'shared by {count} features: {list}',
  'rule.unlockHint': 'To change it anyway, say: "codyssey, unlock {name}".',
  'rule.freeNeighbours': 'Files nearby you can edit instead: {list}',

  // ---- 계약 ----
  'contract.broken': '{name} is used by {count} other files. Removing or renaming it will break them.',
  'contract.users': 'Used by: {list}',
  'contract.keepHint': 'Keep the name exported, or update every caller in the same change.',

  // ---- 테스트 ----
  'test.covering': 'Tests covering this file: {list}',

  // ---- 설치 ----
  'init.readFiles': 'Read {count} source files',
  'init.foundFeatures': 'Found {count} features',
  'init.wrote': 'Wrote',
  'init.done': 'Setup complete. This project uses port {port}.',
  'init.restart': 'Important: restart Claude Code for blocking to take effect.',
  'init.restartWhy': 'Hook settings are read when a session starts, so this session is not covered.',
  'init.restartThen': 'After restarting, the daemon also starts on its own.',
  'init.running': 'running',
  'init.notReady': 'not ready yet',
  'init.stopHint': 'To stop: codyssey stop',
  'init.noGit': 'Not a git repository, so the commit hook was skipped.',

  // ---- 상태 / 진단 ----
  'status.files': 'files',
  'status.edges': 'links',
  'status.features': 'features',
  'status.locks': 'locked',
  'doctor.ok': 'All good.',
  'doctor.daemonDown': 'The daemon is not running. Run `codyssey start`.',
  'doctor.portTaken': 'Port {port} is held by another project ({root}). Run `codyssey init` again to get a fresh port.',
  'doctor.noHooks': 'No hooks are installed. Run `codyssey init`.',
  'doctor.notRestarted': 'Hooks are installed but this session predates them. Restart Claude Code.',
  'doctor.parseFailures': '{count} files could not be parsed and are missing from the graph.',

  // ---- 잠금 ----
  'lock.locked': 'Locked {name}.',
  'lock.unlocked': 'Unlocked {name}.',
  'lock.noSuchFile': 'No such file: {file}',
  'lock.outsideRepo': 'That path is outside the project: {file}',
  'lock.noSuchFeature': 'No such feature: {id}',
  'lock.needPath': 'A file path is required.',

  // ---- 브리핑 (세션 시작 때 AI 에게 주는 말) ----
  'brief.title': 'Project structure (from codyssey)',
  'brief.lockedFiles': 'Locked files — editing these is blocked:',
  'brief.noLocks': 'Nothing is locked yet.',
  'brief.hint': 'Ask codyssey before you edit if you are unsure what a file affects.',

  // ---- 레이블 (경로에서 뽑은 이름에 붙는 말) ----
  'label.home': 'Home',
  'label.page': '{name} page',
  'label.entry': '{name} entrypoint',
  'label.api': '{name} {verb} API',
  'label.apiOnly': '{verb} API',
  'label.verb.get': 'read',
  'label.verb.post': 'create',
  'label.verb.delete': 'delete',
  'label.verb.other': 'change',
  'label.root': 'Top level',

  // ---- 일반 ----
  'common.and': 'and',
  'common.none': 'none',
  'common.more': '{count} more',
} as const
