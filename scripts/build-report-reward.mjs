#!/usr/bin/env node
/*
 * 신고하고 포상금받자(report-reward-mini) — 동네별 쓰레기 무단투기 신고포상금 검증 → index·meta
 *
 *   node scripts/build-report-reward.mjs
 *
 * report-reward/regions/{code}.json 은 사람이(또는 수집 세션이) 조례를 읽고 채운다 → report-reward/COLLECT.md.
 * 이 스크립트는 **틀린 값이 앱에 가지 않게만** 막고, 앱의 동네 시트가 읽는 regions/index.json 과 meta.json 을 다시 만든다.
 * 네트워크 호출 없음. 실패하면 exit 1 — 커밋하지 않는다.
 *
 * 동네 단위(기초자치단체)는 scripts/report-reward/units.mjs 참고.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadUnits, shortName } from './report-reward/units.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, 'report-reward')
const REGIONS = path.join(DIR, 'regions')

const STATUS = new Set(['verified', 'stale', 'none'])
const METHOD = new Set(['rate', 'fixed', 'table'])
const KIND = new Set(['조례', '규칙'])
const DATE = /^\d{4}-\d{2}-\d{2}$/
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)

const posInt = (v) => v === null || (Number.isInteger(v) && v > 0)
const strOrNull = (v) => v === null || (typeof v === 'string' && v.trim() !== '')
const strArrOrNull = (v) => v === null || (Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.trim()))

function check(file, d, unit, fail) {
  const at = (msg) => fail.push(`${file}: ${msg}`)
  if (!unit) return at(`code '${d.code}' 가 기초자치단체 목록에 없다 (일반구면 모시 코드로)`)
  if (`${d.code}.json` !== file) at(`파일명과 code 가 다르다`)
  if (d.sido !== unit.sido || d.sigungu !== unit.sigungu) at(`sido/sigungu 는 '${unit.sido}' / '${unit.sigungu}' 여야 한다`)
  if (!STATUS.has(d.status)) at(`status '${d.status}' — verified | stale | none`)
  if (!DATE.test(d.checkedAt ?? '') || d.checkedAt > today) at(`checkedAt '${d.checkedAt}' — 오늘 이전 YYYY-MM-DD`)
  if (!strOrNull(d.note ?? null)) at('note 는 문자열 또는 null')

  if (!Array.isArray(d.sources) || !d.sources.length) at('sources 가 비었다 — 어느 조례를 읽었는지 남긴다')
  for (const s of d.sources ?? []) {
    const who = `source '${s.title}'`
    if (!s.title?.includes(shortName(unit))) at(`${who}: 제목에 지자체 이름이 없다 — 다른 지역 조례가 섞였는지 확인`)
    if (!KIND.has(s.kind)) at(`${who}: kind '${s.kind}' — 조례 | 규칙`)
    if (!/^\d+$/.test(s.ordinId ?? '') || !/^\d+$/.test(s.mst ?? '')) at(`${who}: ordinId·mst 는 숫자 문자열 (월간 개정 감지가 이걸로 비교한다)`)
    if (!DATE.test(s.promulgatedAt ?? '')) at(`${who}: promulgatedAt YYYY-MM-DD`)
    if (!Array.isArray(s.articles)) at(`${who}: articles 배열 (포상금 조문이 없으면 [])`)
    if (!/^https:\/\/www\.law\.go\.kr\//.test(s.url ?? '')) at(`${who}: url 은 https://www.law.go.kr/…`)
  }

  if (d.status === 'none') {
    if (d.dumping !== null) at('status none 이면 dumping 은 null')
    if (!d.note) at('status none 이면 note 에 「없다」고 본 근거를 적는다 (폐기물 조례·규칙·과태료 조례를 모두 봤는지)')
    return
  }

  const m = d.dumping
  if (!m || typeof m !== 'object') return at('dumping 이 없다')
  if (!METHOD.has(m.method)) at(`dumping.method '${m.method}' — rate | fixed | table`)
  if (typeof m.tableOnly !== 'boolean') at('dumping.tableOnly 는 boolean')
  if (m.method === 'rate') {
    if (!Array.isArray(m.rates) || !m.rates.length) at('method rate 인데 rates 가 비었다')
    for (const r of m.rates ?? []) {
      if (!r.item || typeof r.rate !== 'number' || r.rate <= 0 || r.rate > 1) at(`rates '${r.item}': rate 는 0~1 (20% → 0.2)`)
    }
  } else if (m.rates !== null) at('method 가 rate 가 아니면 rates 는 null')
  if (m.method === 'fixed' && !(m.fixedWon > 0)) at('method fixed 인데 fixedWon 이 없다')
  if (m.method !== 'fixed' && m.fixedWon !== null) at('method 가 fixed 가 아니면 fixedWon 은 null')
  if (m.method === 'table' && !m.tableOnly && !m.examples?.length) at('method table 인데 examples 도 없고 tableOnly 도 false')
  if (m.examples !== null) {
    if (!Array.isArray(m.examples) || !m.examples.length) at('examples 는 null 또는 비지 않은 배열')
    for (const e of m.examples ?? []) {
      if (!e.item || !posInt(e.fineWon ?? null) || !(Number.isInteger(e.rewardWon) && e.rewardWon > 0)) at(`examples '${e.item}': fineWon(정수|null)·rewardWon(양의 정수)`)
    }
  }
  const c = m.caps
  if (c !== null) {
    if (typeof c !== 'object') at('caps 는 객체 또는 null')
    else for (const k of ['monthWon', 'yearWon', 'monthCount', 'yearCount']) if (!posInt(c[k] ?? null)) at(`caps.${k} 는 양의 정수 또는 null (0 금지)`)
    if (c && !strOrNull(c.note ?? null)) at('caps.note 는 문자열 또는 null')
  }
  if (!(m.deadlineDays === null || (Number.isInteger(m.deadlineDays) && m.deadlineDays > 0 && m.deadlineDays <= 90))) at(`deadlineDays '${m.deadlineDays}' — 1~90 또는 null`)
  if (!strOrNull(m.residency ?? null)) at('residency 는 문자열 또는 null')
  for (const k of ['payment', 'channels', 'exclusions']) if (!strArrOrNull(m[k] ?? null)) at(`${k} 는 비지 않은 문자열 배열 또는 null`)
  if (d.status === 'stale' && !DATE.test(d.staleSince ?? '')) at('status stale 이면 staleSince YYYY-MM-DD')
}

const units = await loadUnits(ROOT)
const byCode = new Map(units.map((u) => [u.code, u]))
const fail = []
const done = new Map()

await fs.mkdir(REGIONS, { recursive: true })
for (const file of (await fs.readdir(REGIONS)).filter((f) => /^\d{5}\.json$/.test(f)).sort()) {
  let d
  try {
    d = JSON.parse(await fs.readFile(path.join(REGIONS, file), 'utf8'))
  } catch (e) {
    fail.push(`${file}: JSON 파싱 실패 — ${e.message}`)
    continue
  }
  check(file, d, byCode.get(d.code), fail)
  done.set(d.code, d)
}

if (fail.length) {
  console.error('✗ report-reward 검증 실패\n  - ' + fail.join('\n  - '))
  process.exit(1)
}

// 말투·길이 경고 — 앱은 이 문자열들을 가공 없이 보여준다(COLLECT.md 「앱에 보이는 문장」).
// 규칙으로 완벽히 잡을 수 없어 커밋을 막지는 않고 알린다. 0건이 되게 고친다.
const CLAUSE = /(한다|된다|있다|없다|않는다|이다|하여야|할 것|포함해야)\s*[.)]?$/
const warn = []
for (const d of done.values()) {
  const m = d.dumping ?? {}
  const texts = [['note', d.note], ['caps.note', m.caps?.note], ['residency', m.residency]]
  for (const k of ['payment', 'channels', 'exclusions']) for (const v of m[k] ?? []) texts.push([k, v])
  for (const [k, v] of texts) if (v && CLAUSE.test(v.trim())) warn.push(`${d.code} ${d.sigungu} ${k}: 조문 말투 — 「${v.slice(0, 40)}」`)
  const seenItems = new Set()
  for (const e of [...(m.examples ?? []), ...(m.rates ?? [])]) {
    if (e.item.length > 25) warn.push(`${d.code} ${d.sigungu} item ${e.item.length}자 — 「${e.item.slice(0, 30)}…」 (20자 안팎으로)`)
    // 길이만 보면 「…버리는 행위」가 25자 안이라 안 걸린다(수집 세션 실측 30건) — 끝말도 본다
    if (/행위$/.test(e.item)) warn.push(`${d.code} ${d.sigungu} item 「${e.item}」 — 「…행위」 대신 「…한 경우」`)
    // 줄이다가 서로 다른 두 행이 같은 라벨이 되면 앱에서 구분이 사라진다(양주 소각 2행)
    if (seenItems.has(e.item)) warn.push(`${d.code} ${d.sigungu} item 중복 「${e.item}」 — 두 행을 가르는 말을 남긴다`)
    seenItems.add(e.item)
  }
}
if (warn.length) {
  console.warn(`⚠ 말투·길이 확인 ${warn.length}건 (커밋은 막지 않는다)\n  - ` + warn.slice(0, 40).join('\n  - ') + (warn.length > 40 ? `\n  … 외 ${warn.length - 40}건` : ''))
}

const index = units.map((u) => {
  const d = done.get(u.code)
  return { code: u.code, sido: u.sido, sigungu: u.sigungu, status: d?.status ?? null, checkedAt: d?.checkedAt ?? null }
})
const counts = { total: units.length, verified: 0, stale: 0, none: 0, pending: 0 }
for (const r of index) counts[r.status ?? 'pending'] += 1

await fs.writeFile(path.join(REGIONS, 'index.json'), JSON.stringify({ regions: index }))
await fs.writeFile(
  path.join(DIR, 'meta.json'),
  JSON.stringify(
    {
      source: '국가법령정보센터 자치법규 (조례·시행규칙)',
      sourceUrl: 'https://www.law.go.kr',
      unitSource: 'realestate/region-master.json (일반구 → 모시, 세종·제주는 광역)',
      generatedAt: new Date().toISOString(),
      counts,
      caveats: ['포상금은 모두 예산 범위에서 지급 — 소진되면 지급되지 않을 수 있다', 'status null 은 아직 수집하지 않은 곳 (없다는 뜻이 아니다)'],
    },
    null,
    2,
  ) + '\n',
)
console.log(`✓ report-reward — 기초자치단체 ${counts.total} · verified ${counts.verified} · stale ${counts.stale} · none ${counts.none} · 미수집 ${counts.pending}`)
