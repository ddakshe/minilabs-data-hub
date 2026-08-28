/*
 * KOSIS Open API → cancer-cover/{cancers,incidence,costs,meta}.json
 *
 * 사용법:
 *   KOSIS_API_KEY=xxx node scripts/fetch-cancer-cover.mjs
 *
 * 소비자: cancer-cover-mini(암보험 충분할까). 앱은 번들 내장이라 런타임에 이 파일을
 * 읽지 않는다 — `npm run data` 로 내려받아 src/data/ 에 굽고 재배포한다.
 *
 * **왜 허브에서 받나.** 두 통계 모두 연 1회 갱신이라 사람이 기억해서 다시 받아야 했다.
 * 앱 저장소에는 원본만 있고 "어떻게 받았는지"가 없어서, 1년 뒤 파라미터를 다시
 * 알아내야 하는 상태였다. cron 이 매달 돌면 새 연도 자료가 올라온 순간 diff 로 잡힌다.
 *
 * ── 이 도메인의 함정 ─────────────────────────────────────────────
 * 1) **두 통계의 축이 다르다.** 발생률은 24개 암종(위·대장·폐), 진료비는 112개 ICD-10
 *    C코드(C16·C18·C34). 자동 추론이 불가능해 CANCERS 에 매핑을 손으로 적는다.
 * 2) **KOSIS 암종명에 ICD 범위가 붙어 온다** — '위(C16)'. 안 떼면 매칭이 조용히 전부
 *    실패하고 빈 데이터가 담긴 파일이 정상 생성된다. 예외도 안 난다.
 * 3) **ITM_ID 대소문자가 섞여 온다** — 조발생률 …AC000107 / 발생자수 …ac000101.
 * 4) **10년 연령대를 5세 통계에서 만들 때 단순 평균을 쓰면 안 된다.** 발생자수와
 *    조발생률로 인구를 역산해 가중한다(오차 중위 1.0% → 0).
 * 5) **여러 C코드에 걸친 암종은 가중평균이 불가능하다.** 원본에 1인당 진료비만 있고
 *    환자수가 없다. 대표 코드를 고르고 basis 로 앱 화면에 밝힌다.
 *
 * 위 함정들은 전부 "조용히 틀린 값"으로 끝난다. 그래서 파일을 쓰기 전에 validate() 로
 * 구조를 검사하고, 어긋나면 커밋 전에 죽는다.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../cancer-cover')

const API_KEY = process.env.KOSIS_API_KEY
if (!API_KEY) {
  console.error('✗ KOSIS_API_KEY env var required')
  process.exit(1)
}

const BASE = 'https://kosis.kr/openapi/Param/statisticsParameterData.do'

async function kosis(params) {
  const qs = new URLSearchParams({
    method: 'getList',
    apiKey: API_KEY,
    format: 'json',
    jsonVD: 'Y',
    prdSe: 'Y',
    newEstPrdCnt: '1',
    ...params,
  })
  const res = await fetch(`${BASE}?${qs}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (data && !Array.isArray(data) && data.err) {
    throw new Error(`KOSIS ${data.err}: ${data.errMsg}`)
  }
  if (!Array.isArray(data) || data.length === 0) throw new Error('empty response')
  return data
}

/* ── 암종 레지스트리 ───────────────────────────────────────────────
 * hira: 진료비를 대표할 단일 C코드. null 이면 대표를 고를 수 없는 암종이다
 * (입술·구강·인두는 C00-C14 14개 코드에 분산돼 어느 하나도 대표가 아니다).
 * 진료비를 비우고 앱이 "계산하지 않았다"고 밝힌다 — 지어내지 않는다. */
const CANCERS = [
  { id: 'oral',       kosis: '입술 구강 및 인두',  label: '입·구강·인두',   hira: null   },
  { id: 'esophagus',  kosis: '식도',              label: '식도',           hira: 'C016' },
  { id: 'stomach',    kosis: '위',                label: '위',             hira: 'C017' },
  { id: 'colorectal', kosis: '대장',              label: '대장',           hira: 'C019' },
  { id: 'liver',      kosis: '간',                label: '간',             hira: 'C023' },
  { id: 'biliary',    kosis: '담낭 및 기타 담도',  label: '담낭·담도',      hira: 'C024' },
  { id: 'pancreas',   kosis: '췌장',              label: '췌장',           hira: 'C026' },
  { id: 'larynx',     kosis: '후두',              label: '후두',           hira: 'C030' },
  { id: 'lung',       kosis: '폐',                label: '폐',             hira: 'C032' },
  { id: 'breast',     kosis: '유방',              label: '유방',           hira: 'C045' },
  { id: 'cervix',     kosis: '자궁경부',           label: '자궁경부',        hira: 'C048' },
  { id: 'uterus',     kosis: '자궁체부',           label: '자궁체부',        hira: 'C049' },
  { id: 'ovary',      kosis: '난소',              label: '난소',           hira: 'C051' },
  { id: 'prostate',   kosis: '전립선',             label: '전립선',          hira: 'C055' },
  { id: 'testis',     kosis: '고환',              label: '고환',           hira: 'C056' },
  { id: 'kidney',     kosis: '신장',              label: '신장',           hira: 'C058' },
  { id: 'bladder',    kosis: '방광',              label: '방광',           hira: 'C061' },
  { id: 'cns',        kosis: '뇌 및 중추신경계',   label: '뇌·중추신경',     hira: 'C065' },
  { id: 'thyroid',    kosis: '갑상선',             label: '갑상선',          hira: 'C067' },
  { id: 'hodgkin',    kosis: '호지킨 림프종',      label: '호지킨림프종',    hira: 'C075' },
  { id: 'nhl',        kosis: '비호지킨 림프종',    label: '비호지킨림프종',  hira: 'C079' },
  { id: 'myeloma',    kosis: '다발성 골수종',      label: '다발골수종',      hira: 'C082' },
  { id: 'leukemia',   kosis: '백혈병',             label: '백혈병',          hira: 'C084' },
]

/** 10년 단위 연령대 → KOSIS 5세 그룹. 앱의 선택지가 만 20~79세다. */
const BANDS = {
  '20대': ['20-24세', '25-29세'],
  '30대': ['30-34세', '35-39세'],
  '40대': ['40-44세', '45-49세'],
  '50대': ['50-54세', '55-59세'],
  '60대': ['60-64세', '65-69세'],
  '70대': ['70-74세', '75-79세'],
}

const SEXES = ['남자', '여자']
const ALL_CANCERS = '모든 암'

/** '위(C16)' → '위'. 안 떼면 매칭이 조용히 전부 실패한다. */
const stripIcd = (name) => name.replace(/\s*\([^)]*\)\s*$/, '').trim()
const icdOf = (name) => name.match(/\(([^)]*)\)\s*$/)?.[1] ?? null

/** ITM_ID 대소문자가 섞여 온다. 소문자로 맞춰 비교한다. */
const ITM_RATE = '16117ac000107'
const ITM_COUNT = '16117ac000101'

/** '-'(해당없음 — 여성의 고환암 등)·빈값을 숫자로 바꾸지 않는다. */
function num(dt) {
  if (dt === null || dt === undefined) return null
  const s = String(dt).trim()
  if (s === '' || s === '-' || s === 'X') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

const k = (...parts) => parts.join('|')

// ── 발생률 ────────────────────────────────────────────────────────

function buildIncidence(rows) {
  const cell = new Map() // (성별, 5세그룹, 암종) → { rate, count }
  const icd = {}
  let year = null

  for (const r of rows) {
    year ??= r.PRD_DE
    const itm = String(r.ITM_ID).toLowerCase()
    if (itm !== ITM_RATE && itm !== ITM_COUNT) continue
    const site = stripIcd(r.C1_NM)
    icd[site] ??= icdOf(r.C1_NM)
    const ck = k(r.C2_NM, r.C3_NM, site)
    const e = cell.get(ck) ?? {}
    e[itm === ITM_RATE ? 'rate' : 'count'] = num(r.DT)
    cell.set(ck, e)
  }

  /* 원본 암종명이 바뀌면 sites 가 조용히 빈다. 여기서 터뜨린다. */
  const known = new Set(Object.keys(icd))
  const missing = CANCERS.filter((c) => !known.has(c.kosis)).map((c) => c.kosis)
  if (missing.length) {
    throw new Error(
      '원본 암종명과 안 맞는 CANCERS.kosis: ' + missing.join(', ') +
        '\n원본에 있는 이름: ' + [...known].join(' | ')
    )
  }

  /* 5세 그룹 인구를 역산한다: 인구 = 발생자수 / 조발생률 × 100,000.
   * 화면 칩은 10년 단위인데 통계는 5세 단위다. 두 조발생률을 단순 평균하면 두 그룹
   * 인구가 같다고 가정하는 셈이라 틀린다(60대는 인구가 1.30배 차이 → 4.8% 과대).
   * '모든 암' 행으로 역산한다 — 발생자수가 커서 반올림 오차가 가장 작다. */
  const population = new Map()
  for (const sex of SEXES) {
    for (const age of Object.values(BANDS).flat()) {
      const e = cell.get(k(sex, age, ALL_CANCERS))
      if (!e?.rate || !e?.count) throw new Error('인구 역산 실패: ' + sex + ' ' + age)
      population.set(k(sex, age), (e.count / e.rate) * 1e5)
    }
  }

  const rates = {}
  for (const sex of SEXES) {
    rates[sex] = {}
    for (const [band, ages] of Object.entries(BANDS)) {
      const pop = ages.reduce((s, a) => s + population.get(k(sex, a)), 0)

      const rateOf = (site) => {
        let count = 0
        let seen = false
        for (const age of ages) {
          const c = cell.get(k(sex, age, site))?.count
          if (c === null || c === undefined) continue // 해당 성별에 없는 암종
          count += c
          seen = true
        }
        if (!seen) return null
        return Math.round((count / pop) * 1e5 * 10) / 10
      }

      const sites = {}
      for (const c of CANCERS) {
        const v = rateOf(c.kosis)
        if (v !== null && v > 0) sites[c.id] = v
      }
      rates[sex][band] = { all: rateOf(ALL_CANCERS), sites }
    }
  }

  return {
    source: 'KOSIS 117 / DT_117N_A00023 — 24개 암종·성·연령(5세)별 암발생률',
    sourceShort: '국가암등록통계 ' + year,
    year: Number(year),
    unit: '명/10만명·년',
    note: '조발생률. 10년 단위 연령대는 5세 그룹의 발생자수 합을 인구 합으로 나눠 재계산했다.',
    rates,
  }
}

// ── 진료비 ────────────────────────────────────────────────────────

/** 상급종합병원. 암 환자 진료가 몰리는 종별이라 이 기준을 쓰고 앱 화면에 밝힌다. */
const TERTIARY = '1'

function buildCosts(inpatient, outpatient) {
  const index = (rows) => {
    const m = new Map()
    for (const r of rows) {
      if (r.C2 !== TERTIARY) continue
      m.set(k(r.C1, r.ITM_ID), { value: num(r.DT), label: r.C1_NM, year: r.PRD_DE })
    }
    return m
  }
  const ip = index(inpatient)
  const op = index(outpatient)
  let year = null

  const costs = {}
  for (const c of CANCERS) {
    if (!c.hira) {
      costs[c.id] = null // 대표 코드를 고를 수 없다. 앱이 그렇다고 밝힌다.
      continue
    }
    const ipCost = ip.get(k(c.hira, 'T001'))
    const ipDays = ip.get(k(c.hira, 'T002'))
    const opCost = op.get(k(c.hira, 'T001'))
    if (!ipCost?.value || !opCost?.value) {
      throw new Error('진료비 없음: ' + c.id + ' ' + c.hira)
    }
    year ??= ipCost.year

    costs[c.id] = {
      // 심사실적 총진료비(요양급여 청구분). 비급여는 들어있지 않다.
      inpatient: ipCost.value,
      outpatient: opCost.value,
      total: ipCost.value + opCost.value,
      inpatientDays: ipDays?.value ?? null,
      basis: ipCost.label.replace(/^\((\w+)\)\s*/, '$1 ').replace(/의 악성 신생물$/, ''),
    }
  }

  return {
    source: 'KOSIS 354 / DT_LEE_61(입원)·DT_LEE_62(외래) — 암 상병별 진료비 심사실적',
    sourceShort: '건강보험 심사실적 ' + year,
    year: Number(year),
    unit: '원',
    providerType: '상급종합병원',
    note: '요양급여 청구분(심사실적)이라 비급여가 빠져 있다. 이 앱은 비급여를 추정하지 않는다.',
    costs,
  }
}

// ── 검증 ──────────────────────────────────────────────────────────

/*
 * 쓰기 전에 구조를 본다. 이 도메인의 실패는 전부 "예외 없이 조용히 빈 값"이라
 * 파일이 정상 생성되고 앱 화면에서야 드러난다. 여기서 죽어야 잘못된 값이 커밋되지 않는다.
 */
function validate(incidence, costs) {
  const fail = []

  for (const sex of SEXES) {
    for (const band of Object.keys(BANDS)) {
      const cell = incidence.rates[sex]?.[band]
      if (!cell) { fail.push(`발생률 누락: ${sex} ${band}`); continue }
      if (!(cell.all > 0)) fail.push(`발생률 '모든 암' 이상: ${sex} ${band} = ${cell.all}`)
      /* 성별로 없는 암종을 빼도 10종은 남는다. 5종 밑이면 매칭이 깨진 것이다. */
      const n = Object.keys(cell.sites).length
      if (n < 5) fail.push(`발생률 암종 수 부족: ${sex} ${band} = ${n}종`)
    }
  }

  const known = Object.values(costs.costs).filter(Boolean)
  if (known.length < CANCERS.length - 3) {
    fail.push(`진료비 누락 과다: ${known.length}/${CANCERS.length}`)
  }
  for (const [id, c] of Object.entries(costs.costs)) {
    if (!c) continue
    /* 암 1인당 연간 총진료비가 100만 원 미만이거나 2억 원을 넘으면 축을 잘못 읽은 것이다.
     * (실측 범위: 위 1,128만 ~ 췌장 1,845만) */
    if (c.total < 1_000_000 || c.total > 200_000_000) {
      fail.push(`진료비 범위 이상: ${id} = ${c.total}원`)
    }
    if (!c.basis) fail.push(`basis 없음: ${id}`)
  }

  /* 연도가 뒤로 갈 수 없다. 표가 개편돼 옛 연도가 오면 앱이 조용히 과거로 돌아간다. */
  const nowYear = new Date().getFullYear()
  if (incidence.year < 2020 || incidence.year > nowYear) fail.push(`발생률 연도 이상: ${incidence.year}`)
  if (costs.year < 2020 || costs.year > nowYear) fail.push(`진료비 연도 이상: ${costs.year}`)

  if (fail.length) {
    console.error('✗ 검증 실패 — 파일을 쓰지 않는다')
    for (const f of fail) console.error('   ' + f)
    process.exit(1)
  }
}

// ── 실행 ──────────────────────────────────────────────────────────

async function write(name, data) {
  const json = JSON.stringify(data)
  await fs.writeFile(path.join(OUT_DIR, name), json + '\n')
  console.log(`  ${name.padEnd(16)} ${(Buffer.byteLength(json) / 1024).toFixed(1).padStart(6)} KB`)
}

const [incidenceRows, inpatientRows, outpatientRows] = await Promise.all([
  kosis({ orgId: '117', tblId: 'DT_117N_A00023', itmId: '16117AC000107+16117ac000101', objL1: 'ALL', objL2: 'ALL', objL3: 'ALL' }),
  kosis({ orgId: '354', tblId: 'DT_LEE_61', itmId: 'T001+T002', objL1: 'ALL', objL2: 'ALL' }),
  kosis({ orgId: '354', tblId: 'DT_LEE_62', itmId: 'T001+T002', objL1: 'ALL', objL2: 'ALL' }),
])
console.log(`KOSIS 응답: 발생률 ${incidenceRows.length}행 · 입원 ${inpatientRows.length}행 · 외래 ${outpatientRows.length}행`)

const incidence = buildIncidence(incidenceRows)
const costs = buildCosts(inpatientRows, outpatientRows)
validate(incidence, costs)

await fs.mkdir(OUT_DIR, { recursive: true })
await write('cancers.json', { cancers: CANCERS.map(({ id, label }) => ({ id, label })) })
await write('incidence.json', incidence)
await write('costs.json', costs)
await write('meta.json', {
  updatedAt: new Date().toISOString().slice(0, 10),
  incidenceYear: incidence.year,
  costsYear: costs.year,
  cancers: CANCERS.length,
  /* 진료비를 비운 암종과 그 이유. 지우지 말 것 — 없으면 다음 사람이 같은 조사를 다시 한다. */
  costsSkipped: CANCERS.filter((c) => !c.hira).map((c) => ({
    id: c.id,
    reason: 'C00-C14 14개 코드에 분산돼 대표 코드를 고를 수 없다',
  })),
})
console.log('완료')
