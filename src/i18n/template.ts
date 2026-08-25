import type { Lang } from './index.ts'

/**
 * rules.yaml 머리말.
 *
 * 여러 줄이고 YAML 주석이라 `t()` 로 다루기엔 결이 다르다. 통째로 둔다.
 * 이 파일은 사람이 열어서 손으로 고치는 파일이므로, 안내가 읽는 사람의
 * 말로 나오는 게 특히 중요하다.
 */
const HEADERS: Record<Lang, string[]> = {
  en: [
    '# CODYSSEY rules',
    '#',
    '# lang     Language for codyssey messages. en | ko',
    '# protect  The AI cannot edit files listed here. (Easiest to add by clicking in the web view.)',
    '# layers   Forbid one folder from importing another.',
    '# autolock Ask before editing a file that several features share.',
    '#            mode: off | ask | block',
    '#',
    '# Example:',
    '# protect:',
    '#   - path: api/services/payment.py',
    '#     reason: Payment core. Needs a human to approve changes.',
    '# layers:',
    '#   - deny: web/components/** -> web/lib/api.ts',
    '#     reason: Only pages may fetch data.',
    '',
  ],
  ko: [
    '# CODYSSEY 규칙',
    '#',
    '# lang     codyssey 가 쓰는 말. en | ko',
    '# protect  여기 적힌 파일은 AI 가 못 고칩니다. (웹 화면에서 클릭으로 추가하는 걸 권장)',
    '# layers   특정 폴더에서 특정 파일을 import 하지 못하게 막습니다.',
    '# autolock 여러 기능이 함께 쓰는 파일을 고치려 할 때 확인을 요청합니다.',
    '#            mode: off(끔) | ask(물어봄) | block(막음)',
    '#',
    '# 예시:',
    '# protect:',
    '#   - path: api/services/payment.py',
    '#     reason: 결제 코어. 바꾸려면 사람 승인 필요',
    '# layers:',
    '#   - deny: web/components/** -> web/lib/api.ts',
    '#     reason: 데이터 가져오기는 페이지에서만',
    '',
  ],
}

export const rulesHeader = (lang: Lang): string => HEADERS[lang].join('\n') + '\n'

/** git 훅 안내 주석. */
const GIT_HOOK: Record<Lang, string[]> = {
  en: [
    '# codyssey - keeps the architecture map current on every commit.',
    '# Delete this file if you do not want it. A failure here never blocks a commit.',
  ],
  ko: [
    '# codyssey - 커밋할 때 구조도를 최신으로 유지합니다.',
    '# 이 훅이 싫으면 이 파일을 지우세요. 실패해도 커밋은 막지 않습니다.',
  ],
}

export const gitHookHeader = (lang: Lang): string[] => GIT_HOOK[lang]
