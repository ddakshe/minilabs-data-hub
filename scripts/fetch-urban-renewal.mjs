#!/usr/bin/env node
/*
 * 도시계획 지도(city-plan-map) — 도시재생 사업지 → urban-plan/renewal.json
 *
 *   node scripts/fetch-urban-renewal.mjs
 *
 * 원본: 공공데이터포털 「전국도시재생사업정보표준데이터」(15139235). 지자체가 등록한 것을
 * 매월 초 병합한다. 2026-09-10 실측 179건 · 제공기관 54곳 · 서울은 1건뿐이다.
 *
 * ── 함정 (전부 실측) ──────────────────────────────────────────────
 * 1) **오픈API 는 활용신청이 필요하다** (허브 키로 부르면 403 SERVICE_KEY_IS_NOT_REGISTERED).
 *    대신 데이터셋 페이지의 다운로드 버튼이 쓰는 AJAX 두 개는 키 없이 열린다:
 *      GET /download/columList.json?pk=15139235&ext=CSV  → tableVO.colNmList · totalCount · svcTableNm
 *      GET /download/standard.json?publicDataPk=…&colNmList=…(반복)&totalCount&svcTableNm&perPage&page
 *    `/tcs/dss/stdFileDown.do` 는 404 다. CSV 는 서버가 아니라 브라우저 JS 가 조립한다.
 * 2) **page 는 1부터다.** page=0 이면 200 + 빈 배열 `[]` 이 온다 — 에러가 안 난다.
 * 3) **좌표가 없다.** 주소(도로명·지번)만 있다. 카카오·VWorld·구글 지오코더는 결과 저장이
 *    약관상 금지라 쓸 수 없다. 행안부 좌표제공 API(활용신청 필요)를 붙이기 전까지는
 *    **시군구 중심점**으로 떨어뜨리고 precision:'sigungu' 를 단다 — 앱이 "대략 위치"로 표기한다.
 *    시군구 중심은 허브의 학교 위치(school-zones/schools.json, 12,011곳 · 모든 시군구에 있다)
 *    평균으로 만든다. 행정구역 경계 데이터가 허브에 없어서 택한 근사다.
 */
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'urban-plan', 'renewal.json')
const PK = '15139235'
const BASE = 'https://www.data.go.kr'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'

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

// ─── 시군구 중심점 (학교 위치 평균) ────────────────────────────────────

const SIDO_SHORT = [
  [/^서울/, '서울'], [/^부산/, '부산'], [/^대구/, '대구'], [/^인천/, '인천'], [/^광주/, '광주'], [/^대전/, '대전'],
  [/^울산/, '울산'], [/^세종/, '세종'], [/^경기/, '경기'], [/^강원/, '강원'], [/^충청북도|^충북/, '충북'],
  [/^충청남도|^충남/, '충남'], [/^전라북도|^전북/, '전북'], [/^전라남도|^전남/, '전남'],
  [/^경상북도|^경북/, '경북'], [/^경상남도|^경남/, '경남'], [/^제주/, '제주'],
]
const shortSido = (s) => SIDO_SHORT.find(([re]) => re.test(s))?.[1] ?? null

async function sigunguCenters() {
  const { schools } = JSON.parse(await fs.readFile(path.join(ROOT, 'school-zones', 'schools.json'), 'utf8'))
  const acc = new Map()
  const add = (key, lat, lon) => {
    const a = acc.get(key) ?? { lat: 0, lon: 0, n: 0 }
    a.lat += lat; a.lon += lon; a.n++
    acc.set(key, a)
  }
  for (const s of schools) {
    if (!s.lat || !s.lon || !s.addr) continue
    const t = s.addr.split(/\s+/)
    const sido = shortSido(t[0])
    if (!sido) continue
    if (sido === '세종') { add('세종', s.lat, s.lon); continue }
    add(`${sido} ${t[1]}`, s.lat, s.lon)                               // 안산시 · 강남구
    if (/[시군]$/.test(t[1]) && /구$/.test(t[2] ?? '')) add(`${sido} ${t[1]} ${t[2]}`, s.lat, s.lon) // 안산시 상록구
  }
  const out = new Map()
  for (const [k, a] of acc) out.set(k, [Math.round((a.lat / a.n) * 1e5) / 1e5, Math.round((a.lon / a.n) * 1e5) / 1e5])
  return out
}

// ─── 굽기 ───────────────────────────────────────────────────────────────

const year = (v) => (/^\d{4}$/.test(String(v).trim()) ? Number(v) : null)

function build(rows, centers) {
  const miss = []
  const items = rows.map((r) => {
    const sido = shortSido(r.CTPV_NM ?? '') ?? r.CTPV_NM
    // 함정 4) 일부 기관은 시군구명에 시도를 붙여 올린다 ("부산광역시 기장군"). 앞 토큰이 시도면 뗀다.
    const sgg = (r.SGG_NM ?? '').trim().replace(/^\S+(특별시|광역시|특별자치시|특별자치도|도)\s+/, '')
    const addr = (r.LCTN_ROAD_NM_ADDR || r.LCTN_LOTNO_ADDR || '').trim()
    const point = centers.get(sido === '세종' ? '세종' : `${sido} ${sgg}`) ?? centers.get(`${sido} ${sgg.split(/\s+/)[0]}`) ?? null
    if (!point) miss.push(`${sido} ${sgg} — ${r.BIZ_NM}`)
    return {
      id: crypto.createHash('sha1').update(`${r.INSTT_CODE}|${r.BIZ_NM}|${addr}`).digest('hex').slice(0, 12),
      name: (r.BIZ_NM ?? '').trim(),
      sido,
      sigungu: sgg,
      addr,
      point,
      precision: point ? 'sigungu' : null,
      startYear: year(r.BIZ_BGNG_YR),
      endYear: year(r.BIZ_END_YR),
      content: (r.BIZ_CN ?? '').trim() || null,
      agency: (r.MNG_INST_NM ?? '').trim() || null,
    }
  })
  const baseDate = rows.map((r) => r.DATA_CRTR_YMD).filter(Boolean).sort().at(-1) ?? null
  return { items, miss, baseDate }
}

function validate({ items, miss }) {
  const fail = []
  if (items.length < 100 || items.length > 600) fail.push(`${items.length}건 — 100~600 범위 밖 (2026-09 실측 179)`)
  if (new Set(items.map((i) => i.id)).size !== items.length) fail.push('id 중복')
  if (miss.length / items.length > 0.05) fail.push(`좌표 없는 항목 ${miss.length}건 — ${miss.slice(0, 3).join(' / ')}`)
  if (items.some((i) => !i.name)) fail.push('사업명 빈 항목')
  if (fail.length) {
    console.error('✗ validate 실패\n  - ' + fail.join('\n  - '))
    process.exit(1)
  }
}

const rows = await download()
const built = build(rows, await sigunguCenters())
validate(built)
await fs.mkdir(path.dirname(OUT), { recursive: true })
await fs.writeFile(OUT, JSON.stringify({
  source: '전국도시재생사업정보표준데이터 (공공데이터포털)',
  baseDate: built.baseDate,
  items: built.items,
}))
const bySido = built.items.reduce((a, i) => ((a[i.sido] = (a[i.sido] ?? 0) + 1), a), {})
console.log(`✓ renewal.json — ${built.items.length}건 · 기준일 ${built.baseDate} · 좌표 없음 ${built.miss.length}`)
console.log(`  시도 ${JSON.stringify(bySido)}`)
if (built.miss.length) console.log(`  좌표 못 찾음: ${built.miss.join(' / ')}`)
