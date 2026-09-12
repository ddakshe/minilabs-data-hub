#!/usr/bin/env node
// 예방접종 — vaccine/app/{prices,local-support,meta}.json 으로 저장.
// flu-shot-mini(우리동네 독감주사) 앱이 "우리 동네 지자체 추가 지원"과 "시도별 백신 가격"에 쓴다.
// 이번 시즌은 독감만 화면에 나오지만, 시즌 뒤 다른 접종으로 넓힐 수 있게 백신 종류별로 저장한다.
//
// 로컬 실행:
//   DATA_GO_KR_KEY=<decoded key> node scripts/fetch-vaccine.mjs
//   (보조금24·심평원 비급여 두 데이터셋 모두 그 키의 계정에 '활용신청'이 되어 있어야 한다)
//
// ── 원본 1: 보조금24 (api.odcloud.kr/api/gov24/v3/serviceList) ─────────────
// - fetch-benefit-gauge.mjs 의 함정이 그대로 적용된다: 건수는 totalCount 가 아니라 matchCount,
//   perPage 상한 1000(넘기면 data 키만 사라지는 조용한 실패).
// - benefit-gauge 는 "금액 표현이 있는 서비스"만 남겨서 무료 접종 지원이 0건이다 → 따로 받는다.
// - 서비스명 LIKE 인플루엔자·독감·예방접종 3회로 받는다(2026-09-12 실측 61건·55기관이 독감 관련).
//   지원내용에만 독감이 적힌 서비스는 놓칠 수 있다 — 전국을 다 담는 목록이 아니다.
//
// ── 원본 2: 심평원 비급여 (B551182/nonPaymentDamtInfoService) ──────────────
// - getNonPaymentItemHospList2 전체(약 18.6만 행)를 훑어 '예방접종료/' 행만 남긴다.
//   npayCd 파라미터는 필터로 먹지 않는다(전체가 온다, 2026-09-12 실측).
// - 시도·종별 통계 오퍼레이션은 제품 단위라 "일반 독감 백신" 하나로 합칠 수 없어서 병원 행에서 직접 센다.
// - **병원급 이상만** 들어 있다(상급종합·종합병원·병원·요양병원·한방병원·정신병원·치과병원 — 의원 없음,
//   2026-09-12 전수 실측). 앱은 이걸 반드시 밝힌다. 전체 187쪽을 동시 4개로 받는 데 약 6분.
// - 시도명은 짧은 이름으로 오고 통합 행정구역은 '전남광주', 세종은 '세종시' 다(HIRA_SIDO).
// - 제품명은 앱에 내보내지 않는다(전문의약품 제품명+가격 나열은 대중광고 소지) — meta 에만 남겨 검증용으로 쓴다.

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, 'vaccine/app')

const key = process.env.DATA_GO_KR_KEY
if (!key) {
  console.error('DATA_GO_KR_KEY 가 필요합니다 (data.go.kr 일반 인증키, 디코딩 형태).')
  process.exit(1)
}
// 디코딩 키면 인코딩하고, 이미 인코딩된 키(% 포함)는 그대로 쓴다 — 두 번 인코딩하면 403.
const encKey = key.includes('%') ? key : encodeURIComponent(key)

const REGION_INDEX = resolve(ROOT, 'report-reward/regions/index.json')

/** 데이터에 실제로 나타나는 시도명(통합 행정구역 때문에 16개). fetch-benefit-gauge.mjs 와 같다. */
const SIDO = ['서울특별시', '부산광역시', '대구광역시', '인천광역시', '대전광역시', '울산광역시',
  '세종특별자치시', '경기도', '강원특별자치도', '충청북도', '충청남도', '전북특별자치도',
  '전남광주통합특별시', '경상북도', '경상남도', '제주특별자치도']

/** 심평원 sidoCdNm(짧은 이름) → SIDO. 광주·전남은 통합 행정구역 하나로 묶는다. */
const HIRA_SIDO = {
  서울: '서울특별시', 부산: '부산광역시', 대구: '대구광역시', 인천: '인천광역시', 광주: '전남광주통합특별시',
  대전: '대전광역시', 울산: '울산광역시', 세종: '세종특별자치시', 세종시: '세종특별자치시', 경기: '경기도',
  강원: '강원특별자치도', 충북: '충청북도', 충남: '충청남도', 전북: '전북특별자치도', 전남: '전남광주통합특별시',
  전남광주: '전남광주통합특별시', 경북: '경상북도', 경남: '경상남도', 제주: '제주특별자치도',
}

/**
 * 백신 태그. 순서가 판정 우선순위다. 앱 src/data/vaccines.ts 의 id 와 같아야 한다.
 * 'b형헤모필루스인플루엔자'(Hib)가 독감으로 잡히지 않도록 판정 전에 지운다.
 */
const VACCINES = [
  ['flu', /인플루엔자|독감/],
  ['zoster', /대상포진/],
  ['pneumo', /폐렴구균/],
  ['hpv', /HPV|사람유두종|자궁경부암/i],
  ['hepa', /A형\s*간염/],
  ['hepb', /B형\s*간염/],
  ['tdap', /파상풍|Tdap|Td\b|백일해/],
  ['covid', /코로나/],
  ['rsv', /RSV|호흡기세포융합/i],
  ['mening', /수막구균/],
  ['rota', /로타/],
  ['varicella', /수두/],
  ['mmr', /홍역|MMR/i],
  ['je', /일본뇌염/],
  ['typhoid', /장티푸스/],
  ['hfrs', /신증후군출혈열|유행성출혈열/],
  ['hib', /헤모필루스|Hib\b/i],
]
const ANIMAL = /조류\s*인플루엔자|가축|산란계|광견병|반려동물|농가/

const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replaceAll('-', '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchJson(url, label, tries = 4) {
  for (let i = 1; ; i += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) })
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`)
      return JSON.parse(text)
    } catch (e) {
      if (i >= tries) throw new Error(`${label}: ${e.message}`)
      await sleep(1500 * i)
    }
  }
}

function tagVaccines(text) {
  const t = String(text ?? '')
  const tags = []
  for (const [id, re] of VACCINES) {
    const probe = id === 'flu' ? t.replace(/b?형?\s*헤모필루스\s*인플루엔자/gi, '') : t
    if (re.test(probe)) tags.push(id)
  }
  return tags
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

// ───────────────────────── 보조금24 ─────────────────────────
async function fetchGov24(regionIndex) {
  const byName = new Map(regionIndex.map((r) => [`${r.sido} ${r.sigungu}`, r]))
  const seen = new Map()
  for (const word of ['인플루엔자', '독감', '예방접종']) {
    for (let page = 1; ; page += 1) {
      const qs = new URLSearchParams({ page: String(page), perPage: '1000', 'cond[서비스명::LIKE]': word })
      const json = await fetchJson(`https://api.odcloud.kr/api/gov24/v3/serviceList?${qs}&serviceKey=${encKey}`, `gov24 ${word} p${page}`)
      if (!Array.isArray(json.data)) throw new Error(`gov24 ${word} p${page}: data 배열이 없습니다 — ${JSON.stringify(json).slice(0, 200)}`)
      for (const row of json.data) seen.set(row['서비스ID'], row)
      const total = json.matchCount ?? 0
      if (page * 1000 >= total || json.data.length === 0) break
    }
  }

  const items = []
  const unmatched = []
  for (const s of seen.values()) {
    const all = [s['서비스명'], s['서비스목적요약'], s['지원대상'], s['지원내용'], s['선정기준']].join('\n')
    if (ANIMAL.test(all)) continue
    const users = String(s['사용자구분'] ?? '')
    if (users && !/개인|가구/.test(users)) continue
    const vaccines = tagVaccines(all)
    if (!vaccines.length) continue

    const type = s['소관기관유형'] ?? ''
    const org = String(s['소관기관명'] ?? '').trim()
    let scope
    if (type === '중앙행정기관' || type === '공공기관') scope = { scope: 'national' }
    else if (type === '광역시도' && SIDO.includes(org)) scope = { scope: 'sido', sido: org }
    else if (type === '시군구' && byName.has(org)) {
      const r = byName.get(org)
      scope = { scope: 'sigungu', sido: r.sido, sigungu: r.sigungu, code: r.code }
    } else {
      unmatched.push(`${type}:${org}`)
      continue
    }

    items.push({
      id: s['서비스ID'],
      ...scope,
      org,
      name: clip(s['서비스명'], 80),
      vaccines,
      target: clip(s['지원대상'], 700),
      content: clip(s['지원내용'], 700),
      criteria: clip(s['선정기준'], 400),
      how: clip(s['신청방법'], 300),
      contact: clip(s['전화문의'], 120),
      dept: clip(s['부서명'], 60),
      url: s['상세조회URL'] || null,
      updatedAt: String(s['수정일시'] ?? '').slice(0, 8) || null,
    })
  }
  items.sort((a, b) => (a.code ?? a.sido ?? '').localeCompare(b.code ?? b.sido ?? '') || a.id.localeCompare(b.id))
  return { items, fetched: seen.size, unmatched }
}

// ───────────────────────── 심평원 비급여 ─────────────────────────
async function fetchHiraRows() {
  const BASE = 'https://apis.data.go.kr/B551182/nonPaymentDamtInfoService/getNonPaymentItemHospList2'
  const ROWS = 1000
  const page = async (n) => {
    const json = await fetchJson(`${BASE}?serviceKey=${encKey}&pageNo=${n}&numOfRows=${ROWS}&_type=json`, `hira p${n}`)
    const header = json?.response?.header
    if (header?.resultCode !== '00') throw new Error(`hira p${n}: ${JSON.stringify(header).slice(0, 200)}`)
    const b = json.response.body
    const it = b.items?.item ?? []
    return { total: b.totalCount, rows: Array.isArray(it) ? it : [it] }
  }
  const first = await page(1)
  const pages = Math.ceil(first.total / ROWS)
  const keep = []
  const take = (rows) => {
    for (const r of rows) if (String(r.npayKorNm ?? '').startsWith('예방접종료/')) keep.push(r)
  }
  take(first.rows)
  let next = 2
  let scanned = first.rows.length
  const worker = async () => {
    while (next <= pages) {
      const n = next++
      const { rows } = await page(n)
      scanned += rows.length
      take(rows)
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  // 페이지가 조용히 비면(쿼터 초과 등) 통계가 틀린 채 커밋된다 — 받은 행 수로 막는다.
  if (scanned < first.total * 0.98) throw new Error(`hira: ${first.total} 행 중 ${scanned} 행만 받음`)
  return { rows: keep, total: first.total, pages }
}

const round100 = (v) => Math.round(v / 100) * 100
/**
 * 최저·최고는 입력 실수가 그대로 드러난다(2026-09-12 실측: 대상포진 최저 8,300원, B형간염 최저 100원 —
 * 백신값 없이 접종료만 적은 행으로 보인다). 앱은 p10~p90 을 "대부분 이 범위"로 보여주고
 * min/max 는 검증용으로만 둔다. n 이 작으면(시도 5 미만) 앱이 전국 값으로 떨어진다.
 */
function stats(values) {
  const v = [...values].sort((a, b) => a - b)
  const at = (q) => v[Math.min(v.length - 1, Math.floor(q * (v.length - 1)))]
  return { n: v.length, min: round100(v[0]), p10: round100(at(0.1)), med: round100(at(0.5)), p90: round100(at(0.9)), max: round100(v[v.length - 1]) }
}

/** 병원 행 → 가격 그룹 id. 독감은 고령자용(면역증강) 백신을 따로 뗀다. */
function priceGroup(r) {
  const name = String(r.npayKorNm)
  const product = name.split('/').pop()
  const tags = tagVaccines(name.split('/').slice(1, -1).join('/') || name)
  const tag = tags[0]
  if (!tag) return null
  if (tag === 'flu') return /플루아드/.test(product) ? 'flu-senior' : 'flu'
  return tag
}

function buildPrices({ rows }) {
  const unknownSido = new Set()
  const groups = {}
  const products = {}
  for (const r of rows) {
    if (r.adtEndDd && String(r.adtEndDd) < today) continue
    const g = priceGroup(r)
    if (!g) continue
    const lo = Number(r.minPrc)
    const hi = Number(r.maxPrc) || lo
    if (!(lo > 0)) continue
    const sido = HIRA_SIDO[r.sidoCdNm]
    if (!sido) {
      unknownSido.add(r.sidoCdNm)
      continue
    }
    const price = (lo + hi) / 2
    const bucket = (groups[g] ??= { all: [], sido: {}, from: [] })
    bucket.all.push(price)
    bucket.from.push(Number(r.adtFrDd) || 0)
    ;(bucket.sido[sido] ??= []).push(price)
    const p = ((products[g] ??= {})[r.npayKorNm.split('/').pop()] ??= { rows: 0, latestFrom: 0 })
    p.rows += 1
    p.latestFrom = Math.max(p.latestFrom, Number(r.adtFrDd) || 0)
  }
  if (unknownSido.size) throw new Error(`hira: 모르는 시도명 ${[...unknownSido].join(', ')} — HIRA_SIDO 에 추가`)

  const out = {}
  for (const [g, b] of Object.entries(groups)) {
    // 병원이 가격을 신고한 시점. 2026-09-12 실측으로 독감은 91% 가 2025-09 신고분(지난 절기)이었다 —
    // 앱은 "YYYY년 M월 신고 가격"을 반드시 붙인다. 새 절기 신고가 쌓이면 mainMonth 가 넘어간다.
    const months = {}
    let latest = 0
    for (const f of b.from) {
      if (!f) continue
      const m = String(f).slice(0, 6)
      months[m] = (months[m] ?? 0) + 1
      if (f > latest) latest = f
    }
    const mainMonth = Object.entries(months).sort((a, c) => c[1] - a[1])[0]?.[0] ?? null
    out[g] = { national: stats(b.all), reported: { mainMonth, latest: latest || null }, sido: {} }
    for (const s of SIDO) if (b.sido[s]?.length) out[g].sido[s] = stats(b.sido[s])
  }
  return { groups: out, products }
}

async function main() {
  const regionIndex = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(REGION_INDEX, 'utf8'))).regions
  if (!Array.isArray(regionIndex) || regionIndex.length < 200) throw new Error(`지역 인덱스가 이상합니다: ${regionIndex?.length}`)

  console.error('보조금24 수집 중…')
  const gov = await fetchGov24(regionIndex)
  const flu = gov.items.filter((i) => i.vaccines.includes('flu'))
  console.error(`  받은 서비스 ${gov.fetched} · 사람 대상 접종 지원 ${gov.items.length} · 독감 ${flu.length} · 지역 못 맞춤 ${gov.unmatched.length}`)
  if (gov.items.length < 20 || flu.length < 20) throw new Error('보조금24 결과가 너무 적습니다 — 키·필터를 확인하세요')

  // 로컬 시험용: 이미 받아 둔 '예방접종료/' 행 파일을 주면 18만 행을 다시 긁지 않는다.
  const rowsFile = process.env.HIRA_ROWS_FILE
  let hira
  if (rowsFile) {
    const fs = await import('node:fs')
    const rows = JSON.parse(fs.readFileSync(rowsFile, 'utf8'))
    hira = { rows, total: Number(process.env.HIRA_TOTAL) || rows.length, pages: 0 }
    console.error(`심평원 행 파일 사용: ${rowsFile} (${rows.length} 행)`)
  } else {
    console.error('심평원 비급여 병원별 가격 수집 중… (18만 행, 몇 분 걸림)')
    hira = await fetchHiraRows()
  }
  const prices = buildPrices(hira)
  console.error(`  전체 ${hira.total} 행 · 예방접종 ${hira.rows.length} 행 · 독감 일반 ${prices.groups.flu?.national.n ?? 0} · 고령자용 ${prices.groups['flu-senior']?.national.n ?? 0}`)
  if (!prices.groups.flu || prices.groups.flu.national.n < 50) throw new Error('독감 가격 표본이 너무 적습니다')

  mkdirSync(OUT_DIR, { recursive: true })
  const note = '병원급 이상(상급종합·종합병원·병원·요양병원·한방병원 등)만 — 의원 가격은 없다. 값은 병원·제품별 (최저+최고)/2 의 분포, 100원 반올림.'
  writeFileSync(resolve(OUT_DIR, 'prices.json'), `${JSON.stringify({ v: 1, scope: note, groups: prices.groups })}\n`)
  writeFileSync(resolve(OUT_DIR, 'local-support.json'), `${JSON.stringify({ v: 1, items: gov.items })}\n`)
  writeFileSync(
    resolve(OUT_DIR, 'meta.json'),
    `${JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        baseDate: today,
        localSupport: { fetched: gov.fetched, items: gov.items.length, flu: flu.length, orgs: new Set(gov.items.map((i) => i.org)).size, unmatched: gov.unmatched },
        prices: { hospitalRows: hira.total, vaccineRows: hira.rows.length, products: prices.products },
        sources: ['행정안전부 대한민국 공공서비스(혜택) 정보', '건강보험심사평가원 비급여진료비정보조회서비스'],
      },
      null,
      2,
    )}\n`,
  )
  console.error(`저장: ${OUT_DIR}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
