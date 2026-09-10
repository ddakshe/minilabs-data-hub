/*
 * 학교알리미 OpenAPI → school-zones/stats.json
 *
 * 사용법:
 *   SCHOOLINFO_API_KEY=... node scripts/fetch-school-stats.mjs
 *   (키는 ~/.config/credentials/keys.env 에 있다)
 *
 * 소비자: 「내 학군 찾기」 미니앱 — 학교 상세의 규모·수요 지표.
 *
 * 🔑 **이 앱이 학구도 서비스와 갈리는 지점이다.** 배정 구역만 보여주면 "어디로 가나"까지고,
 *    학부모가 실제로 묻는 "거기 어떤 학교야"에 답하지 못한다. 특히 **전입 학생수**는
 *    학부모들이 실제로 그 학군을 고르고 있다는 신호라, 진학 실적 없이도 학군의 강도를 보여준다.
 *
 * 라이선스: 공공누리 제1유형 — API 상세에 "출처를 표시하면 **영리 목적의 이용**이나 변경 및
 * 2차적저작물의 작성을 포함한 자유 이용을 할 수 있습니다" 로 명시. 요청제한횟수도 '제한없음'.
 *
 * ── 함정 (전부 실측) ────────────────────────────────────────
 * 1) **시·군·구 파라미터가 필수다.** 2026-01-01 이후 발급된 키는 전국 일괄 조회가 안 된다.
 *    253개 시군구를 순회한다 (코드는 school-zones/sigungu.json — 학구도의 SD_CD+SGG_CD 와
 *    같은 체계다). `sggCode` 는 **5자리**다. 3자리로 주면 "데이터가 존재하지 않습니다".
 * 2) **`pbanYr`(공시연도)가 필수다.** 없으면 "pbanYr은 필수 정보입니다" 로 실패한다.
 * 3) **학교 코드 체계가 학구도와 다르다.** 학교알리미는 `S000003540`, 학구도는 `B000011804`,
 *    NEIS 는 또 다르다. → **(시도|시군구|학교급|학교명) 으로 조인한다.** 전국 12,011곳 중
 *    이 키가 겹치는 건 2건뿐이다(실측). 겹치면 버리고 경고한다 — 조용히 아무거나 붙이지 않는다.
 * 4) **응답 컬럼명이 COL_1 같은 불투명한 이름이다.** 뜻은 `/js/new/dev/openApi.js` 의
 *    `{label, column, school}` 정의에 있다. 아래 매핑은 거기서 확인한 것이다.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.resolve(__dirname, '../school-zones')

const API = 'https://www.schoolinfo.go.kr/openApi.do'
const KEY = process.env.SCHOOLINFO_API_KEY
const LEVELS = { '02': '초', '03': '중', '04': '고' }
const CONCURRENCY = 6

/** 함정 4: 컬럼 뜻은 openApi.js 의 정의에서 확인했다. */
const ITEMS = {
  '09': { name: '학년별·학급별 학생수', fields: { students: 'COL_S_SUM', classSize: 'COL_SUM', perTeacher: 'TEACH_CAL' } },
  '10': { name: '전·출입 및 학업중단 학생 수', fields: { movedIn: 'MVIN_SUM', movedOut: 'MVT_SUM', total: 'STDNT_SUM' } },
}

const num = (v) => {
  const n = Number(String(v ?? '').trim())
  return Number.isFinite(n) ? n : null
}

async function call(apiType, pbanYr, sido, sgg, knd) {
  const body = new URLSearchParams({ apiKey: KEY, apiType, pbanYr: String(pbanYr), sidoCode: sido, sggCode: sgg, schulKndCode: knd })
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://www.schoolinfo.go.kr/ng/go/pnnggo_a01_l0.do' },
    body,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  if (json.resultCode !== 'success') {
    // 해당 시군구에 그 학교급이 없는 건 정상이다 (예: 군 지역의 특수 학교급)
    if (String(json.resultMsg).includes('존재하지 않습니다')) return []
    throw new Error(json.resultMsg)
  }
  return json.list ?? []
}

/** 동시 실행 제한. 제한없음이라지만 상대 서버를 배려한다. */
async function pool(tasks, limit) {
  const out = []
  let i = 0
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < tasks.length) out.push(await tasks[i++]())
  }))
  return out
}

async function main() {
  if (!KEY) throw new Error('SCHOOLINFO_API_KEY 가 없다 (~/.config/credentials/keys.env)')

  const { schools } = JSON.parse(await fs.readFile(path.join(DIR, 'schools.json'), 'utf8'))
  const { list: sigungu } = JSON.parse(await fs.readFile(path.join(DIR, 'sigungu.json'), 'utf8'))

  // 함정 3: (시도|시군구|급|이름) 으로 조인한다. 겹치는 키는 아예 버린다.
  const byKey = new Map()
  const dup = new Set()
  for (const s of schools) {
    const [sido, sgg] = s.addr.split(' ')
    const k = `${sido}|${sgg}|${s.level}|${s.name}`
    if (byKey.has(k)) dup.add(k)
    byKey.set(k, s.id)
  }
  for (const k of dup) byKey.delete(k)
  if (dup.size) console.warn(`· 이름이 겹쳐 건너뛰는 학교 ${dup.size}건: ${[...dup].join(', ')}`)

  const pbanYr = Number(process.env.PBAN_YR ?? new Date().getFullYear() - 1)
  const stats = new Map()
  let matched = 0, unmatched = 0, calls = 0, failed = 0

  const jobs = []
  for (const { sido, sgg } of sigungu) {
    for (const knd of Object.keys(LEVELS)) {
      for (const apiType of Object.keys(ITEMS)) {
        jobs.push(async () => {
          let rows
          try { rows = await call(apiType, pbanYr, sido, sgg, knd) } catch (e) { failed++; console.warn(`  ! ${sgg}/${knd}/${apiType} — ${e.message}`); return }
          calls++
          for (const r of rows) {
            const adr = String(r.ADRCD_NM ?? '').split(' ')
            const k = `${adr[0]}|${adr[1]}|${LEVELS[knd]}|${r.SCHUL_NM}`
            const id = byKey.get(k)
            if (!id) { unmatched++; continue }
            if (!stats.has(id)) { stats.set(id, {}); matched++ }
            const cur = stats.get(id)
            for (const [out, col] of Object.entries(ITEMS[apiType].fields)) {
              const v = num(r[col])
              if (v !== null) cur[out] = v
            }
          }
        })
      }
    }
  }

  console.log(`· ${pbanYr}년 공시 · 시군구 ${sigungu.length} × 학교급 3 × 항목 ${Object.keys(ITEMS).length} = ${jobs.length} 호출`)
  const t0 = Date.now()
  await pool(jobs, CONCURRENCY)
  const secs = ((Date.now() - t0) / 1000).toFixed(0)

  if (matched < schools.length * 0.5) {
    throw new Error(`매칭된 학교가 ${matched}곳뿐이다 (전체 ${schools.length}) — 조인 키를 의심하라`)
  }

  await fs.writeFile(path.join(DIR, 'stats.json'), JSON.stringify({
    pbanYr,
    source: '학교알리미 OpenAPI (한국교육학술정보원)',
    license: '공공누리 제1유형 — 출처 표시 (영리 목적 이용 가능)',
    fields: {
      students: '학생수(계)', classSize: '학급당 학생수(계)', perTeacher: '수업교원 1인당 학생수',
      movedIn: '전입학생수(계)', movedOut: '전출학생수(계)', total: '전체학생수(계)',
    },
    count: stats.size,
    stats: Object.fromEntries(stats),
  }, null, 1) + '\n')

  console.log(`✓ school-zones/stats.json — ${matched}곳 (${secs}초 · 성공 ${calls} · 실패 ${failed} · 미매칭 행 ${unmatched})`)
  const sample = [...stats.entries()].slice(0, 2)
  for (const [id, v] of sample) {
    const s = schools.find((x) => x.id === id)
    console.log(`  예) ${s?.name} — 학생 ${v.students} · 학급당 ${v.classSize} · 교원1인당 ${v.perTeacher} · 전입 ${v.movedIn} / 전출 ${v.movedOut}`)
  }
}

main().catch((e) => { console.error('✗', e.message); process.exit(1) })
