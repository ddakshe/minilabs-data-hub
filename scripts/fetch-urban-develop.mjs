#!/usr/bin/env node
/*
 * 도시계획 지도(city-plan-map) — 전국도시개발사업정보표준데이터 → urban-plan/develop.json
 *
 *   node scripts/fetch-urban-develop.mjs
 *
 * **왜 필요한가.** 이 앱의 개발지구(sites.json)는 택지정보시스템 등록분이라 도시개발구역이
 * 전국의 절반쯤만 들어 있다. 이 표준데이터는 지자체가 직접 올린 도시개발사업이라
 * 그 빈틈을 메운다 — 2026-09-11 실측 189건 중 **158건이 sites.json 에 없던 곳**이다.
 *
 * **좌표가 온다.** 도시재생(좌표 없음 → 시군구 근사)과 달리 위도·경도가 그대로 들어 있다
 * (실측 189/189 전부 한반도 범위). 그래서 precision 은 'addr' 이다.
 *
 * ── 이 도메인의 함정 ─────────────────────────────────────────────────
 * 1) 표준데이터 다운로드는 **오픈API 가 아니다.** 활용신청·인증키 없이 AJAX 두 개로 받는다
 *    (fetch-urban-renewal.mjs 와 같은 경로). 단 Referer·X-Requested-With 헤더가 필요하다.
 * 2) **page 는 1부터다.** page=0 이면 200 + 빈 배열이 온다 — 에러가 안 난다.
 * 3) 시군구명에 시도를 붙여 올리는 기관이 있다("경기도 안산시") → 앞 토큰이 시도면 뗀다.
 * 4) 사업기간은 **YYYY-MM** 이다(도시재생은 YYYY). 끝이 비어 있는 곳이 많다 — 그대로 둔다.
 * 5) 경계 폴리곤은 없다. 점만 있다 — 앱은 핀으로만 그리고 "경계 없음"을 표기해야 한다.
 * 6) 🚨 **기준일(DATA_CRTR_YMD)이 행마다 다르다.** 지자체가 각자 올리기 때문이다 —
 *    2026-09-11 실측 24가지 날짜, 2025-01 부터 2026-06 까지 흩어져 있다.
 *    그래서 파일 하나의 `baseDate` 로 "이 데이터는 언제 것"이라고 말할 수 없다.
 *    항목마다 `baseDate` 를 실어 앱이 사업별로 보여준다. 파일의 `latestDate` 는 그중 가장 최근일 뿐이다.
 *
 * 약관: 공공데이터포털 표준데이터. 가공 산출물만 낸다. 앱에 출처·기준일을 표기한다.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'https://www.data.go.kr'
const PK = '15139224'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

async function getJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: `${BASE}/data/${PK}/standard.do`,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
  })
  if (!res.ok) throw new Error(`${url.slice(0, 80)}… — HTTP ${res.status}`)
  return res.json()
}

async function download() {
  const head = await getJson(`${BASE}/download/columList.json?pk=${PK}&ext=CSV`)
  const { colNmList, svcTableNm } = head.tableVO
  const total = head.totalCount
  const rows = []
  const PER = 1000
  for (let page = 1; rows.length < total; page++) {
    const q = new URLSearchParams([['publicDataPk', PK], ...colNmList.map((c) => ['colNmList', c]),
      ['totalCount', String(total)], ['svcTableNm', svcTableNm], ['perPage', String(PER)], ['page', String(page)]])
    const batch = await getJson(`${BASE}/download/standard.json?${q}`)
    if (!Array.isArray(batch) || batch.length === 0) break
    rows.push(...batch)
    if (page > 50) throw new Error('페이지가 끝나지 않는다')
  }
  if (rows.length !== total) throw new Error(`받은 행 ${rows.length} ≠ totalCount ${total} (함정 2: page 는 1부터)`)
  return rows
}

const SIDO_SHORT = [
  [/^서울/, '서울'], [/^부산/, '부산'], [/^대구/, '대구'], [/^인천/, '인천'], [/^광주/, '광주'], [/^대전/, '대전'],
  [/^울산/, '울산'], [/^세종/, '세종'], [/^경기/, '경기'], [/^강원/, '강원'], [/^충청북도|^충북/, '충북'],
  [/^충청남도|^충남/, '충남'], [/^전라북도|^전북/, '전북'], [/^전라남도|^전남/, '전남'],
  [/^경상북도|^경북/, '경북'], [/^경상남도|^경남/, '경남'], [/^제주/, '제주'],
]
const shortSido = (s) => SIDO_SHORT.find(([re]) => re.test(s))?.[1] ?? null

const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, '').trim())
  return Number.isFinite(n) && n > 0 ? n : null
}
/** YYYY-MM 만 받는다. 빈 값·형식 밖은 null */
const ym = (v) => (/^\d{4}-\d{2}$/.test(String(v ?? '').trim()) ? String(v).trim() : null)
/** 한반도 범위 밖 좌표는 버린다 — 0,0 이나 뒤바뀐 값이 섞이면 지도가 엉뚱한 곳으로 튄다 */
const inKorea = ([lat, lng]) => lat > 32 && lat < 39.5 && lng > 124 && lng < 132

function build(rows) {
  const noPoint = []
  const items = rows.map((r) => {
    const sido = shortSido(r.CTPV_NM ?? '') ?? r.CTPV_NM
    // 함정 3) 시군구명에 시도를 붙여 올리는 기관이 있다
    const sigungu = (r.SGG_NM ?? '').trim().replace(/^\S+(특별시|광역시|특별자치시|특별자치도|도)\s+/, '')
    const addr = (r.LCTN_ROAD_NM_ADDR || r.LCTN_LOTNO_ADDR || '').trim()
    const lat = Number(r.LAT), lng = Number(r.LOT)
    const point = Number.isFinite(lat) && Number.isFinite(lng) && inKorea([lat, lng])
      ? [Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6]
      : null
    if (!point) noPoint.push(`${sido} ${sigungu} — ${r.BIZ_NM}`)
    return {
      id: crypto.createHash('sha1').update(`${r.INSTT_CODE}|${r.BIZ_NM}|${addr}`).digest('hex').slice(0, 12),
      name: (r.BIZ_NM ?? '').trim(),
      sido,
      sigungu,
      addr,
      point,
      area: num(r.BZAR),
      households: num(r.ACTC_HH_CNT),
      period: { start: ym(r.BIZ_BGNG_YM), end: ym(r.BIZ_END_YM) },
      // 행마다 다르다(함정 6) — 사업별로 보여줘야 정확하다
      baseDate: (r.DATA_CRTR_YMD ?? '').trim() || null,
      method: (r.BIZ_MTH_SE_NM ?? '').trim() || null,
      developer: (r.BIZ_DVLR_NM ?? '').trim() || null,
      agency: (r.INSTT_NM ?? '').trim() || null,
    }
  })
  // 파일 전체의 기준일이 아니다 — 가장 최근에 올라온 한 건의 날짜다(함정 6)
  const latestDate = rows.map((r) => r.DATA_CRTR_YMD).filter(Boolean).sort().at(-1) ?? null
  return { items, noPoint, latestDate }
}

// ─── 실행 ───────────────────────────────────────────────────────────────

const rows = await download()
const built = build(rows)

const fail = []
if (!built.latestDate) fail.push('latestDate 를 못 뽑았다')
if (built.items.length < 100) fail.push(`건수 ${built.items.length} — 2026-09-11 실측 189건보다 크게 적다`)
for (const it of built.items) {
  if (!it.id || !it.name) fail.push(`id·name 이 비었다: ${JSON.stringify(it).slice(0, 80)}`)
  if (it.point && !inKorea(it.point)) fail.push(`${it.name}: 좌표 ${JSON.stringify(it.point)} — [lat,lng] 순서 확인`)
}
const ids = new Set(built.items.map((i) => i.id))
if (ids.size !== built.items.length) fail.push(`id 중복 ${built.items.length - ids.size}건`)
if (fail.length) {
  console.error('✗ develop 검증 실패\n  - ' + fail.join('\n  - '))
  process.exit(1)
}

const out = path.join(ROOT, 'urban-plan', 'develop.json')
await fs.writeFile(out, JSON.stringify({
  source: '전국도시개발사업정보표준데이터 (공공데이터포털)',
  /** 가장 최근에 올라온 한 건의 날짜. 파일 전체의 기준일이 아니다 — 항목마다 baseDate 가 따로 있다 */
  latestDate: built.latestDate,
  items: built.items,
}))

const bySido = built.items.reduce((a, i) => ((a[i.sido] = (a[i.sido] ?? 0) + 1), a), {})
const dates = new Set(built.items.map((i) => i.baseDate).filter(Boolean))
console.log(`✓ develop.json — ${built.items.length}건 · 최근 등록 ${built.latestDate} · 등록일 ${dates.size}가지 · 좌표 없음 ${built.noPoint.length}`)
console.log(`  시도 ${JSON.stringify(bySido)}`)
