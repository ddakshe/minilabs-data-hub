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
 *
 * ── 주소 단위로 올리는 단계 (도로명주소 API, business.juso.go.kr) ─────────────
 * 5) **검색 API**(키 JUSO_SEARCH_KEY): 주소 → 행정구역코드·도로명코드·건물번호. 2026-09-10 실측 179건 중
 *    그대로 124건, "~번지 일원" 꼬리를 떼면 +26건 = 150건. 나머지는 건물 없는 지번이라 못 찾는다.
 *    결과는 urban-plan/cache/renewal-juso.json 에 남겨 **주소가 바뀐 항목만** 다시 부른다.
 *    검색 결과가 여러 건이면 시군구와 번지가 입력과 맞는 첫 건만 받는다 — 아니면 '모호함'으로 둔다.
 * 6) **좌표제공 API**(키 JUSO_COORD_KEY, 운영용만 있어 심사 중): 5) 의 코드 → UTM-K 좌표.
 *    ⚠️ 응답을 실제로 본 적이 없어 **아직 구현하지 않는다.** 키가 오면 첫 응답을 보고 채운다.
 *    그 전까지 precision 은 'sigungu' 그대로다. 앱은 precision 으로 그리는 법을 가른다.
 * 키가 없으면 5)·6) 을 조용히 건너뛴다 — 주소 API 장애로 도시재생 데이터 전체가 멈추면 안 된다.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
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


// ─── 도로명주소 검색 (함정 5) ──────────────────────────────────────────

const JUSO_CACHE = path.join(ROOT, 'urban-plan', 'cache', 'renewal-juso.json')

/** CI 는 env, 로컬·셀프호스티드 러너는 ~/.config/credentials/keys.env 에서 읽는다 */
async function readKey(name) {
  if (process.env[name]) return process.env[name]
  try {
    const env = await fs.readFile(path.join(os.homedir(), '.config', 'credentials', 'keys.env'), 'utf8')
    return env.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1].trim() ?? null
  } catch {
    return null
  }
}

/** "1594-73번지일원" · "280 일원" · "(OO동)" · "외 3필지" 를 뗀다 */
function cleanAddr(a) {
  return a
    .replace(/\s*(번지)?\s*일원.*$/, '')
    .replace(/번지$/, '')
    .replace(/\s*\(.*?\)/g, '')
    .replace(/\s*외\s*\d+\s*필지.*$/, '')
    .trim()
}

async function jusoSearch(key, keyword) {
  const q = new URLSearchParams({ confmKey: key, currentPage: '1', countPerPage: '5', keyword, resultType: 'json' })
  const res = await fetch(`https://business.juso.go.kr/addrlink/addrLinkApi.do?${q}`, { headers: { 'User-Agent': 'minilabs-data-hub' } })
  if (!res.ok) throw new Error(`juso HTTP ${res.status}`)
  const { results } = await res.json()
  if (results.common.errorCode !== '0') throw new Error(`juso ${results.common.errorCode} ${results.common.errorMessage}`)
  return results.juso ?? []
}

/** 여러 건이면 시군구 끝 토큰과 입력의 번지가 모두 들어 있는 첫 건만 받는다 */
function pickJuso(list, item, keyword) {
  if (list.length === 1) return list[0]
  const sgg = item.sigungu.split(/\s+/).at(-1)
  const num = keyword.match(/(\d+(?:-\d+)?)\s*$/)?.[1]
  return list.find((j) => (j.roadAddr + ' ' + j.jibunAddr).includes(sgg) && (!num || (j.roadAddr + ' ' + j.jibunAddr).includes(num))) ?? null
}

async function refineWithJuso(items) {
  const key = await readKey('JUSO_SEARCH_KEY')
  if (!key) {
    console.log('  · JUSO_SEARCH_KEY 없음 — 주소 검색 단계 건너뜀 (좌표는 시군구 중심 그대로)')
    return null
  }
  const cache = JSON.parse(await fs.readFile(JUSO_CACHE, 'utf8').catch(() => '{}'))
  const next = {}
  const stat = { reused: 0, found: 0, ambiguous: 0, notFound: 0, failed: 0 }
  for (const it of items) {
    const prev = cache[it.id]
    if (prev && prev.addr === it.addr) {
      next[it.id] = prev
      stat.reused++
      continue
    }
    const tries = [...new Set([it.addr, cleanAddr(it.addr)])].filter(Boolean)
    let entry = { addr: it.addr, status: 'notFound' }
    try {
      for (const kw of tries) {
        const list = await jusoSearch(key, kw)
        if (!list.length) continue
        const j = pickJuso(list, it, kw)
        entry = j
          ? { addr: it.addr, status: 'found', query: kw, roadAddr: j.roadAddr, admCd: j.admCd, rnMgtSn: j.rnMgtSn, udrtYn: j.udrtYn, buldMnnm: j.buldMnnm, buldSlno: j.buldSlno }
          : { addr: it.addr, status: 'ambiguous', query: kw, candidates: list.length }
        break
      }
    } catch (e) {
      // 한 건 실패로 전체를 멈추지 않는다. 캐시에 남기지 않아 다음 달에 다시 부른다.
      stat.failed++
      console.warn(`  ! juso 실패 ${it.id}: ${e.message}`)
      continue
    }
    next[it.id] = entry
    stat[entry.status]++
    await new Promise((r) => setTimeout(r, 100))
  }
  await fs.mkdir(path.dirname(JUSO_CACHE), { recursive: true })
  await fs.writeFile(JUSO_CACHE, JSON.stringify(next, null, 1))
  const found = Object.values(next).filter((e) => e.status === 'found').length
  console.log(`  · 주소 검색 ${found}/${items.length} 매칭 (재사용 ${stat.reused} · 새로 찾음 ${stat.found} · 모호 ${stat.ambiguous} · 못 찾음 ${stat.notFound} · 실패 ${stat.failed})`)
  return next
}

/** 함정 6 — 좌표제공 API. 응답을 확인하기 전에는 구현하지 않는다(추측한 응답 형태로 틀린 좌표를 내지 않기 위해). */
async function applyCoordinates(items, codes) {
  if (!codes) return
  if (await readKey('JUSO_COORD_KEY')) {
    console.warn('  ! JUSO_COORD_KEY 가 있지만 좌표 단계는 아직 구현 전이다 — 첫 응답을 확인하고 applyCoordinates() 를 채울 것')
  }
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
await applyCoordinates(built.items, await refineWithJuso(built.items))
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
