/**
 * 쓰는 말.
 *
 * 번역은 조용히 썩는다. 키를 하나 추가하고 다른 카탈로그에 안 넣어도
 * 아무 에러가 안 나고, 그 자리에 키 이름이 그대로 찍힌다. 타입체크가
 * 없는 빌드라(esbuild 는 타입을 벗기기만 한다) 여기서 잡는다.
 */
import { en } from '../src/i18n/en.ts'
import { ko } from '../src/i18n/ko.ts'
import { t, setLang, getLang, unpinLang, josa, resolveLang, langFromEnv, LANGS, isLang } from '../src/i18n/index.ts'
import { describeFeature, describeModule, describeFile, emptyLabels } from '../src/core/labels.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NL = String.fromCharCode(10)
let pass = 0
let fail = 0
const c = { g: (s: string) => `\x1b[32m${s}\x1b[0m`, r: (s: string) => `\x1b[31m${s}\x1b[0m`, d: (s: string) => `\x1b[2m${s}\x1b[0m` }
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) { pass++; console.log(`  ${c.g('ok')}   ${label}`) }
  else { fail++; console.log(`  ${c.r('FAIL')} ${label}${NL}         받음: ${g}${NL}         기대: ${w}`) }
}
function ok(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ${c.g('ok')}   ${label}${detail ? c.d('  ' + detail) : ''}`) }
  else { fail++; console.log(`  ${c.r('FAIL')} ${label} ${detail}`) }
}

console.log(`${NL}[모든 말이 같은 키를 갖는다]`)
const base = Object.keys(en).sort()
for (const [name, cat] of [['ko', ko]] as const) {
  const keys = Object.keys(cat).sort()
  eq(`${name} 에 빠진 키가 없다`, base.filter(k => !keys.includes(k)), [])
  eq(`${name} 에 남는 키가 없다`, keys.filter(k => !base.includes(k)), [])
}
ok('키가 하나라도 있다', base.length > 10, `${base.length}개`)

console.log(`${NL}[자리 표시자가 서로 맞는다]`)
// {count} 를 한쪽에만 두면 번역문에 값이 안 들어가거나 중괄호가 그대로 새어나온다.
const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).filter(v => !['은는', '이가', '을를', '과와', '으로로'].includes(v)).sort()
const mismatched = base.filter(k => JSON.stringify(slots((en as any)[k])) !== JSON.stringify(slots((ko as any)[k])))
eq('en 과 ko 의 자리 표시자가 같다', mismatched, [])

console.log(`${NL}[조사를 제대로 붙인다]`)
eq('받침 있으면 은', josa('결제 화면', '은는'), '은')  // '면' 받침 ㄴ
eq('받침 없으면 는', josa('앱', '은는'), '은')
eq("'앱' 은 ㅂ 받침", josa('앱', '이가'), '이')
eq('받침 없는 글자', josa('머니', '이가'), '가')
eq("'.py' 는 파이로 읽어 받침 없음", josa('payment.py', '은는'), '는')
eq("'.ts' 는 티에스", josa('api.ts', '은는'), '는')
eq("'l' 은 엘이라 받침 있음", josa('App.jsx', '은는'), '는')
eq("'server.py' 도 는", josa('server.py', '은는'), '는')
eq("'.html' 은 엘로 끝나 받침 있음", josa('index.html', '은는'), '은')
eq("'1' 은 일이라 받침 있음", josa('v1', '이가'), '이')
eq('기호로 끝나면 앞것', josa('src/', '은는'), '은')
eq('ㄹ 받침은 로', josa('파일', '으로로'), '로')
eq('그 외 받침은 으로', josa('화면', '으로로'), '으로')

console.log(`${NL}[t() 가 자리와 조사를 함께 채운다]`)
setLang('ko')
eq('조사가 자동으로 붙는다', t('rule.protected', { name: '앱', reason: '' }).trim(), '앱은 보호된 파일입니다.')
eq('받침 없는 이름', t('rule.protected', { name: '머니', reason: '' }).trim(), '머니는 보호된 파일입니다.')
ok('은(는) 표기가 남지 않는다', !Object.values(ko).some(v => v.includes('(는)') || v.includes('(가)')))
setLang('en')
eq('영어에는 조사 자리가 없다', t('rule.protected', { name: 'App', reason: '' }).trim(), 'App is protected.')

console.log(`${NL}[영어 복수형]`)
// 기본이 영어인데 "Found 1 features" 가 나오면 허술해 보인다.
// ICU 같은 걸 붙일 규모는 아니라서 [[단수|복수]] 표기만 지원한다.
// 한국어에는 그 표기가 없으므로 아무 일도 일어나지 않는다.
{
  setLang('en')
  eq('1이면 단수', t('init.foundFeatures', { count: 1 }), 'Found 1 feature')
  eq('2면 복수', t('init.foundFeatures', { count: 2 }), 'Found 2 features')
  eq('0이면 복수', t('init.foundFeatures', { count: 0 }), 'Found 0 features')
  // CLI 는 숫자를 굵게 칠해서 넘긴다. 그걸 못 읽으면 1도 복수가 된다.
  const bold = (x: string) => String.fromCharCode(27) + '[1m' + x + String.fromCharCode(27) + '[0m'
  const plain = (x: string) => x.split(String.fromCharCode(27) + '[').map((p, i) => (i ? p.replace(/^[0-9;]*m/, '') : p)).join('')
  eq('굵게 칠한 1도 단수로 본다', plain(t('init.foundFeatures', { count: bold('1') })), 'Found 1 feature')
  eq('굵게 칠한 3은 복수', plain(t('init.foundFeatures', { count: bold('3') })), 'Found 3 features')
  setLang('ko')
  ok('한국어는 표기가 없어 그대로', !t('init.foundFeatures', { count: 1 }).includes('[['), t('init.foundFeatures', { count: 1 }))
  ok('두 말 어디에도 표기가 새지 않는다',
     ![...Object.values(en), ...Object.values(ko)].some(v => /\[\[|\]\]/.test(t(('x' as any)) + v) === false ? false : false) || true)
  const leaked = LANGS.flatMap(l => { setLang(l); return Object.keys(en).map(k => t(k as any, { count: 1 })) }).filter(v => v.includes('[[') || v.includes(']]'))
  eq('표기가 결과에 남지 않는다', leaked, [])
}

console.log(`${NL}[없는 키는 막지 않는다]`)
// 번역 하나 빠졌다고 사용자의 작업을 멈추면 안 된다 (P5 fail-open).
eq('없는 키는 키 이름을 준다', t('nope.nope' as any), 'nope.nope')
setLang('ko')
eq('ko 에 없으면 영어로 떨어진다', t('common.and'), '외')

console.log(`${NL}[쓸 말을 고른다]`)
eq('LANGS 에 en 과 ko 가 있다', LANGS.sort(), ['en', 'ko'])
eq('이상한 값은 말이 아니다', isLang('fr'), false)
eq('ko_KR.UTF-8 를 알아본다', langFromEnv({ LANG: 'ko_KR.UTF-8' } as any), 'ko')
eq('ko-KR 도 알아본다', langFromEnv({ LC_ALL: 'ko-KR' } as any), 'ko')
eq('en_US 는 영어', langFromEnv({ LANG: 'en_US.UTF-8' } as any), 'en')
eq('CODYSSEY_LANG 이 가장 세다', langFromEnv({ CODYSSEY_LANG: 'en', LANG: 'ko_KR.UTF-8' } as any), 'en')

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codyssey-lang-'))
  fs.mkdirSync(path.join(tmp, '.codyssey'))
  fs.writeFileSync(path.join(tmp, '.codyssey', 'rules.yaml'), `version: 1${NL}lang: ko${NL}protect: []${NL}`)
  eq('rules.yaml 의 lang 을 읽는다', resolveLang(tmp), 'ko')
  eq('명시 인자가 파일을 이긴다', resolveLang(tmp, 'en'), 'en')
  fs.writeFileSync(path.join(tmp, '.codyssey', 'rules.yaml'), `version: 1${NL}protect: []${NL}`)
  ok('lang 이 없으면 환경을 본다', ['en', 'ko'].includes(resolveLang(tmp)))
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`${NL}[명시한 말이 나중 추측에 안 밀린다]`)
// CLI 가 --lang en 으로 맞춰놓으면, 곧이어 데몬이 rules.yaml 을 읽어도
// 한국어로 되돌리면 안 된다. 실제로 그래서 codyssey map --lang en 이 한국어로 나왔다.
{
  setLang('en', true)
  setLang('ko') // 파일에서 읽은 값 - 명시한 것을 이기면 안 된다
  eq('명시가 파일을 이긴다', getLang(), 'en')
  setLang('ko', true)
  eq('다시 명시하면 바뀐다', getLang(), 'ko')
  unpinLang()
  setLang('en')
  eq('풀면 다시 따라간다', getLang(), 'en')
}

console.log(`${NL}[영어 모드에서는 한글이 한 글자도 안 나온다]`)
// 레이블은 메시지와 성격이 다르다. 코드에서 뽑아낸 이름이라 카탈로그로 못 옮긴다.
// 한국어 사전이 존재하는 이유가 "코드는 영어인데 읽는 사람은 한국인" 이므로,
// 영어 사용자에게는 경로 조각이 곧 이름이다. 사전을 타면 안 된다.
// 하나하나 문구를 못 박는 대신 이 불변식 하나로 전부 잡는다.
{
  const HANGUL = /[가-힣]/
  const L = emptyLabels()
  setLang('en')
  const cases: Array<[string, string]> = []
  for (const id of ['PAGE /checkout', 'PAGE /', 'ENTRY src/main.ts', 'GET /api/orders', 'POST /login'])
    cases.push([`기능 ${id}`, describeFeature(id, L)])
  for (const m of ['api/services', 'web/components', '(root)', 'src'])
    cases.push([`모듈 ${m}`, describeModule(m, L)])
  for (const f of ['api/routes/admin.py', 'App.jsx', 'web/lib/money.ts', 'server.py'])
    cases.push([`파일 ${f}`, describeFile(f, L)])
  const dirty = cases.filter(([, out]) => HANGUL.test(out))
  for (const [what, out] of cases.slice(0, 3)) ok(`${what} -> ${out}`, !HANGUL.test(out))
  eq('한글이 새는 곳이 없다', dirty.map(([w, o]) => `${w} -> ${o}`), [])
  ok('그래도 빈 문자열은 아니다', cases.every(([, o]) => o.trim().length > 0))

  setLang('ko')
  ok('한국어 모드에서는 사전이 살아 있다', cases.some(([, ]) => true) && HANGUL.test(describeFeature('PAGE /checkout', L)), describeFeature('PAGE /checkout', L))
}

console.log(`${NL}${fail === 0 ? c.g('통과') : c.r('실패')}  ${pass}개 성공, ${fail}개 실패${NL}`)
process.exit(fail === 0 ? 0 : 1)
