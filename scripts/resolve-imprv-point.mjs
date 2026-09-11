#!/usr/bin/env node
/*
 * 도시계획 지도 — 정비사업 「위치」(지번 주소) → 필지 좌표
 *
 *   node scripts/resolve-imprv-point.mjs           # 캐시에 없는 것만 조회
 *   node scripts/resolve-imprv-point.mjs --all     # 전부 다시 조회
 *
 * **왜 필요한가.** 정비사업 원본에는 좌표가 없고 「위치」 텍스트만 있다. 그래서 지금은 전부
 * 시군구 중심(근사)에 모아 배지로 표시한다. 그런데 682곳 중 233곳은 **지번 형태**라
 * 실제 위치를 찾을 수 있다 — 「주공12단지가 지도에서 제자리에 떠야 하지 않나」(2026-09-11 피드백).
 *
 * ── 경로 (2026-09-11 실측으로 검증) ─────────────────────────────────
 *   위치 텍스트에서 법정동명 + 본번-부번 파싱
 *     → juso 검색 API 로 **법정동코드(admCd)** 획득  (동 이름만으로 검색한다)
 *     → PNU = admCd(10) + 산여부(1) + 본번(4) + 부번(4)
 *     → 브이월드 Data API `LP_PA_CBND_BUBUN`(연속지적도) 조회 → 필지 폴리곤
 *     → 폴리곤 중심점을 point 로, precision:'addr'
 *
 * 🚨 **지오코더가 아니다.** 카카오·VWorld 지오코딩 API 는 결과 저장이 약관상 금지라 못 쓴다.
 *    이건 **지적도라는 공간 데이터를 PNU 로 조회**하는 것이라 성격이 다르다.
 *
 * 🚨 **`jiga`(개별공시지가)를 읽지 않는다.** 같은 레이어에 들어 있지만 이 앱의 정책 경계 밖이다.
 *    정비사업 컬럼을 좁게 고정한 것과 같은 원칙 — 데이터에 담으면 언젠가 샌다.
 *
 * ── 함정 ────────────────────────────────────────────────────────────
 * 1) **juso 는 "동 이름 + 지번" 으로 검색하면 0건이다.** 동 이름만 넣어야 법정동코드가 나온다
 *    (실측: "고양시 덕양구 성사동" → 1,260건 · admCd 4128110600 / "…성사동 715" → 0건).
 * 2) **준공된 구역은 지번이 사라진다.** 재건축이 끝나면 합필·분할되기 때문이다
 *    (실측: 성사동 715 → NOT_FOUND. 2009년 준공). 결함이 아니라 자연스러운 결과다 —
 *    못 찾으면 시군구 근사로 남긴다. 억지로 맞추면 엉뚱한 필지를 가리킨다.
 * 3) 브이월드 Data API 는 `geomFilter`(BOX ≤10km²) 또는 **단일검색 속성(pnu)** 중 하나가 필요하다.
 *    `addr`·`emd_nm` 으로는 못 거른다. `/req/wfs` 쪽 ATTRFILTER 는 **조용히 무시된다**(실측).
 * 4) 같은 동 이름이 여러 시군구에 있다 — 반드시 시도·시군구를 함께 검색어에 넣는다.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IMPRV = path.join(ROOT, 'urban-plan', 'imprv.json')
const CACHE = path.join(ROOT, 'urban-plan', 'cache', 'imprv-parcel.json')
const ALL = process.argv.includes('--all')
const DOMAIN = 'https://rrecommend.com'

/** CI 는 env, 로컬은 ~/.config/credentials/keys.env */
async function readKey(name) {
  if (process.env[name]) return process.env[name]
  const env = await fs.readFile(path.join(os.homedir(), '.config', 'credentials', 'keys.env'), 'utf8')
  return env.split('\n').find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, '')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─── 1) 지번 파싱 ────────────────────────────────────────────────────

/**
 * 「경기도 고양시 덕양구 관산동 178-57번지 일원(한양연립 주변)」 → { dong:'관산동', bon:178, bu:57 }
 * 「경동 40번지 및 율목동 10번지 일원」 → 앞의 것만 쓴다(구역 범위가 아니라 대표 지번이므로).
 * 서술형(「○○구역 일원」)은 null.
 */
export function parseJibun(text) {
  const s = String(text ?? '').replace(/\(.*?\)/g, ' ')
  // 법정동명(동·리·가) 뒤에 오는 첫 지번. **「번지」는 있어도 없어도 된다** —
  // 요구했더니 「광명시 철산동 510」 같은 표기를 통째로 놓쳤다(2026-09-11 실측: 231건 → 653건).
  // 숫자는 법정동명 **바로 뒤**라야 한다. 그래서 「부림동 주공12단지」의 12 는 걸리지 않는다.
  const m = s.match(/([가-힣]+(?:\d+)?(?:동|리|가))\s*(?:일원\s*)?(산\s*)?(\d+)(?:-(\d+))?\s*(?:번지)?(?![\d-])/)
  if (!m) return null
  return { dong: m[1], san: Boolean(m[2]), bon: Number(m[3]), bu: Number(m[4] ?? 0) }
}

// ─── 2) juso 검색 → 법정동코드 ───────────────────────────────────────

const admCache = new Map()

async function admCd(key, sido, sigungu, dong) {
  const q = `${sido} ${sigungu} ${dong}`.replace(/\s+/g, ' ').trim()
  if (admCache.has(q)) return admCache.get(q)
  const u = new URL('https://business.juso.go.kr/addrlink/addrLinkApi.do')
  u.searchParams.set('confmKey', key)
  u.searchParams.set('currentPage', '1')
  u.searchParams.set('countPerPage', '1')
  // 함정 1) 지번을 붙이면 0건이다 — 동 이름까지만 넣는다
  u.searchParams.set('keyword', q)
  u.searchParams.set('resultType', 'json')
  const j = await (await fetch(u)).json()
  const first = j?.results?.juso?.[0]
  // 법정동코드는 admCd 앞 10자리다
  const code = first?.admCd ? String(first.admCd).slice(0, 10) : null
  admCache.set(q, code)
  return code
}

// ─── 3) PNU → 필지 ──────────────────────────────────────────────────

const pnuOf = (adm, bon, bu, san = false) =>
  `${adm}${san ? '2' : '1'}${String(bon).padStart(4, '0')}${String(bu).padStart(4, '0')}`

/** 폴리곤 꼭짓점 평균. 필지 하나라 무게중심과 큰 차이가 없다 */
function centerOf(geometry) {
  const ring = geometry?.coordinates?.[0]?.[0]
  if (!Array.isArray(ring) || !ring.length) return null
  const lat = ring.reduce((a, c) => a + c[1], 0) / ring.length
  const lng = ring.reduce((a, c) => a + c[0], 0) / ring.length
  return [Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6]
}

async function parcel(key, pnu) {
  const u = new URL('https://api.vworld.kr/req/data')
  u.searchParams.set('service', 'data')
  u.searchParams.set('request', 'GetFeature')
  u.searchParams.set('data', 'LP_PA_CBND_BUBUN')
  u.searchParams.set('key', key)
  u.searchParams.set('domain', DOMAIN)
  u.searchParams.set('attrFilter', `pnu:=:${pnu}`) // 함정 3) 단일검색 속성은 pnu 뿐이다
  u.searchParams.set('size', '1')
  u.searchParams.set('format', 'json')
  const r = (await (await fetch(u)).json())?.response
  if (r?.status !== 'OK') return { status: r?.status ?? 'ERROR' }
  const f = r.result?.featureCollection?.features?.[0]
  if (!f) return { status: 'NOT_FOUND' }
  // 🚨 properties 에서 addr 만 가져온다 — jiga(개별공시지가)는 읽지 않는다
  return { status: 'OK', at: centerOf(f.geometry), addr: f.properties?.addr ?? null }
}

// ─── 실행 ───────────────────────────────────────────────────────────

const file = JSON.parse(await fs.readFile(IMPRV, 'utf8'))
let cache = {}
try {
  cache = JSON.parse(await fs.readFile(CACHE, 'utf8'))
} catch {
  await fs.mkdir(path.dirname(CACHE), { recursive: true })
}

const jusoKey = await readKey('JUSO_SEARCH_KEY')
const vworldKey = await readKey('VWORLD_KEY')
if (!jusoKey || !vworldKey) {
  console.error('✗ JUSO_SEARCH_KEY · VWORLD_KEY 가 필요하다 (~/.config/credentials/keys.env)')
  process.exit(1)
}

const targets = file.items.filter((it) => parseJibun(it.addr))
console.log(`지번이 있는 정비사업 ${targets.length} / ${file.items.length}곳`)

let done = 0, hit = 0, miss = 0, skipped = 0
for (const it of targets) {
  // 'API_ERR' 는 일시 오류다 — 캐시에 있어도 다시 시도한다(NOT_FOUND 와 달리 결론이 아니다)
  if (!ALL && cache[it.id] && cache[it.id].status !== 'API_ERR') { skipped += 1; continue }
  const p = parseJibun(it.addr)
  const adm = await admCd(jusoKey, it.sido, it.sigungu, p.dong)
  if (adm === undefined) {
    // juso 일시 오류 — 캐시에 남기지 않는다. 다음 실행이 다시 시도한다
    miss += 1
    done += 1
    await sleep(150)
    continue
  }
  if (!adm) {
    cache[it.id] = { status: 'NO_ADM', dong: p.dong }
    miss += 1
  } else {
    const pnu = pnuOf(adm, p.bon, p.bu, p.san)
    const r = await parcel(vworldKey, pnu)
    if (r.status === 'OK' && r.at) {
      cache[it.id] = { status: 'OK', at: r.at, pnu, addr: r.addr }
      hit += 1
    } else {
      // 함정 2) 준공된 구역은 지번이 사라진다 — 왜 못 찾았는지 남긴다
      cache[it.id] = { status: r.status, pnu }
      miss += 1
    }
  }
  done += 1
  if (done % 20 === 0) {
    console.log(`  … ${done}/${targets.length - skipped} (찾음 ${hit} · 못 찾음 ${miss})`)
    await fs.writeFile(CACHE, JSON.stringify(cache, null, 1))
  }
  await sleep(150) // 기관 서버를 몰아치지 않는다
}

await fs.writeFile(CACHE, JSON.stringify(cache, null, 1))
const ok = Object.values(cache).filter((c) => c.status === 'OK').length
console.log(`✓ imprv-parcel.json — 캐시 ${Object.keys(cache).length}건 · 좌표 확보 ${ok}건`)
console.log(`  이번 실행: 찾음 ${hit} · 못 찾음 ${miss} · 건너뜀(캐시) ${skipped}`)
const why = Object.values(cache).filter((c) => c.status !== 'OK').reduce((a, c) => ((a[c.status] = (a[c.status] ?? 0) + 1), a), {})
console.log(`  못 찾은 이유 ${JSON.stringify(why)}`)
