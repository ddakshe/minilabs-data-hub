/*
 * 학구도안내서비스(한국교육시설안전원) → school-zones/{schools,zones,chain,meta}.json
 *
 * 사용법:
 *   node scripts/fetch-school-zones.mjs
 *
 * 소비자: 학교 계보 미니앱(초→중→고 배정 체인 드릴다운).
 *   schools.json  전국 초·중·고 12,011개 — 위경도 + 자기가 속한 초/중/고 학구ID
 *   zones.json    학구 7,140(초)·1,684(중)·73(고) — 학구별 배정 학교 목록
 *   chain.json    고교 학교군 → 중학교 학구 → 초등 통학구역 드릴다운 인덱스
 *
 * 🔑 **이게 초→중→고를 잇는 유일한 공식 경로다.** "이 고등학교에 어느 중학교 출신이 많나"는
 *    개인 진학 이력이라 공시 대상이 아니다 — 어디에도 없고 앞으로도 안 나온다. 대신 교육청이
 *    확정한 **배정 구역**을 타면 "이 학교군에는 어느 중학교들이 물리나"가 정확히 나온다.
 *    추정이 아니라 제도상 확정값이라 오히려 더 강하다.
 *
 * **왜 허브에서 받나.** 원본이 게시판 첨부(ZIP 안 Shapefile)고, 좌표계가 EPSG:5186 이라
 * 앱이 직접 읽을 수 없다. 체인은 점-폴리곤 판정 1,200만 회라 빌드 타임에 한 번 굽는다.
 * 갱신은 연 2회 수준(2025-09, 2026-03)이므로 이 스크립트도 그 주기로 돌리면 된다.
 *
 * ── 이 도메인의 함정 (전부 실측) ──────────────────────────────
 * 1) **학교알리미에는 진학 데이터가 없다.** 공시항목 62개를 전수 확인했다 — 대량다운로드에도
 *    OpenAPI 제공목록에도 「졸업생의 진로 현황」이 없다. 진학률을 찾아 거기로 가지 말 것.
 * 2) **제공기관 이름이 릴리스마다 바뀐다.** 2025-09 은 「한국지방교육행정연구재단」,
 *    2026-03 은 「한국교육시설안전원」이다. **기관명이 아니라 데이터 종류로 매칭한다.**
 * 3) **CSV 두 개의 인코딩이 서로 다르다.** 학교위치는 UTF-8(BOM), 연계정보는 CP949 다.
 *    한쪽 기준으로 하드코딩하면 다른 쪽 학교명이 조용히 깨진다 → 디코딩을 감지로 처리한다.
 * 4) **좌표계가 다르다.** 폴리곤은 EPSG:5186(미터), 학교 위치는 WGS84(위경도)다.
 *    투영 없이 겹치면 **예외 없이 전부 미매칭**이 된다(0건이 아니라 조용한 오답).
 * 5) **한 학교가 여러 학구를 가진다.** 공동통학구역·자유학구(HAKGUDO_GB=1) 때문에
 *    연계정보가 1:N 이다(맹방초는 3개). 배열로 다루고, 대표값은 GB=0 을 우선한다.
 * 6) **「고등학교 학교군」과 「고등학교 비평준화지역」은 다른 데이터다.** 제목 매칭이
 *    느슨하면 비평준화지역을 학교군으로 잘못 집어온다.
 *
 * 8) **연계정보에는 자사고·특목고·특성화고가 없다.** 학교군 배정(추첨) 대상인 평준화
 *    일반고만 실린다 — 강남서초학교군은 연계정보 22곳인데 그 구역 안의 고교는 33곳이고,
 *    빠진 11곳이 휘문·중동·현대·세화·세화여(자사고)와 국립국악고 등이다. 전국으로는
 *    배정 1,017 · 위치만 508 · 비평준화 871 이다. **배출 실적을 다루는 앱에서 정작
 *    중요한 학교들이 여기서 통째로 빠진다.** 그래서 학교군 소속은 중·초등과 같이
 *    **위치 기준**으로 잡고, 추첨 배정 대상인지는 `assigned` 로 따로 남긴다.
 *
 * 함정 3·4·5 는 전부 "예외 없이 조용히 틀린 값"으로 끝난다. 그래서 파일을 쓰기 전에
 * validate() 가 매칭률과 골든 케이스(서울대치초 → 강남서초2학교군 → 강남서초학교군)를
 * 확인하고, 어긋나면 죽는다.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readZip } from './nps/zip.mjs'
import { toKorea2000 } from './school-zones/proj.mjs'
import { readDbf, indexShp, pointInRings } from './school-zones/shapefile.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../school-zones')

const HOST = 'https://schoolzone.emac.kr'
const LIST = `${HOST}/publicData/publicDataList.do`
const DOWNLOAD = `${HOST}/publicData/publicDataFileDownload.do`
const UA = 'Mozilla/5.0 (compatible; minilabs-data-hub/1.0)'

// 함정 2·6: 기관명이 아니라 데이터 종류로, 그리고 서로 겹치지 않게 매칭한다.
const KINDS = [
  { key: 'schools', match: (t) => /학교\s*위치/.test(t) },
  { key: 'link', match: (t) => /학교[-–]\s*학구도\s*연계정보/.test(t) },
  { key: 'elem', match: (t) => /초등학교\s*통학구역/.test(t) },
  { key: 'mid', match: (t) => /중학교\s*학구\s*및\s*학군/.test(t) },
  { key: 'high', match: (t) => /고등학교\s*학교군/.test(t) && !/비평준화/.test(t) },
  { key: 'flat', match: (t) => /고등학교\s*비평준화/.test(t) },
]

// 함정 7: 고교 학교군은 **평준화 지역에만 있다.** 8개 특·광역시는 전 지역이 평준화라
// 매칭률이 100% 여야 하고, 도 지역은 비평준화가 섞여 낮게 나오는 게 정상이다(실측:
// 경북 15% · 충남 29% · 전남 31%). 전체 매칭률로 검증하면 정상 데이터를 오탐한다.
const FULLY_LEVELLED = ['서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시', '대전광역시', '울산광역시', '세종특별자치시']

const LEVELS = { 초등학교: '초', 중학교: '중', 고등학교: '고' }

async function get(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, Referer: LIST, ...init.headers } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`)
  return res
}

/** 함정 3: 인코딩이 파일마다 다르다. UTF-8 로 엄격 디코드해보고 실패하면 CP949 로 본다. */
function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('euc-kr').decode(buf)
  }
}

function parseCsv(text) {
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false }
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  const header = rows.shift().map((h) => h.trim())
  return rows.filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i].trim()])))
}

/** 목록 페이지에서 종류별 최신 릴리스를 고른다. */
async function findDatasets() {
  const html = await (await get(`${LIST}?pageIndex=1&pageUnit=100`)).text()
  const found = {}
  const re = /data-nttId="(\d+)"\s+data-atchFileId="([^"]+)"\s+data-fileSn="(\d+)"/g
  const rows = [...html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)]

  for (const [tr] of rows.map((m) => [m[0]])) {
    const file = new RegExp(re.source).exec(tr)
    if (!file) continue
    const title = tr.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const date = (title.match(/(\d{4})[.\-](\d{2})[.\-](\d{2})/) || []).slice(1).join('-')
    for (const kind of KINDS) {
      if (!kind.match(title)) continue
      const prev = found[kind.key]
      if (!prev || date > prev.date) {
        found[kind.key] = { title, date, nttId: file[1], atchFileId: file[2], fileSn: file[3] }
      }
    }
  }
  const missing = KINDS.filter((k) => !found[k.key]).map((k) => k.key)
  if (missing.length) throw new Error(`목록에서 못 찾은 데이터: ${missing.join(', ')} — 게시판 제목 형식이 바뀌었을 수 있다`)
  return found
}

async function download(ds) {
  const url = `${DOWNLOAD}?nttId=${ds.nttId}&atchFileId=${ds.atchFileId}&fileSn=${ds.fileSn}`
  const buf = Buffer.from(await (await get(url)).arrayBuffer())
  if (buf.readUInt16BE(0) !== 0x504b) throw new Error(`ZIP 이 아니다: ${ds.title} (${buf.length}바이트)`)
  return readZip(buf)
}

function pickEntry(entries, ext) {
  const hit = entries.find((e) => e.name.toLowerCase().endsWith(ext))
  if (!hit) throw new Error(`ZIP 안에 ${ext} 가 없다 (${entries.map((e) => e.name).join(', ')})`)
  return hit.data
}

/** 폴리곤 레이어: 속성 + bbox 인덱스 + 점 조회 */
function buildLayer(entries) {
  const { rows } = readDbf(pickEntry(entries, '.dbf'))
  const shp = indexShp(pickEntry(entries, '.shp'))
  if (rows.length !== shp.count) {
    throw new Error(`dbf(${rows.length}) 와 shp(${shp.count}) 레코드 수가 다르다`)
  }
  return {
    rows,
    count: rows.length,
    /** 함정 5: 공동통학구역 때문에 여러 건이 나올 수 있다. GB=0 을 앞에 둔다. */
    locate(x, y) {
      const { bbox } = shp
      const hits = []
      for (let i = 0; i < shp.count; i++) {
        const b = i * 4
        if (x < bbox[b] || x > bbox[b + 2] || y < bbox[b + 1] || y > bbox[b + 3]) continue
        if (pointInRings(x, y, shp.rings(i))) hits.push(rows[i])
      }
      hits.sort((a, b) => (a.HAKGUDO_GB === '0' ? -1 : 1) - (b.HAKGUDO_GB === '0' ? -1 : 1))
      return hits
    },
  }
}

function build(sources) {
  const schoolRows = parseCsv(decodeText(pickEntry(sources.schools, '.csv')))
  const linkRows = parseCsv(decodeText(pickEntry(sources.link, '.csv')))

  const layers = {
    초: buildLayer(sources.elem),
    중: buildLayer(sources.mid),
    고: buildLayer(sources.high),
  }
  const flat = buildLayer(sources.flat) // 비평준화지역 — 학교군이 없는 대신 여기 들어간다

  // 학구 → 배정 학교 (연계정보가 정본이다. 점-폴리곤 판정으로 대체하지 않는다.)
  const zoneSchools = new Map()
  for (const r of linkRows) {
    if (!zoneSchools.has(r['학구ID'])) zoneSchools.set(r['학구ID'], [])
    zoneSchools.get(r['학구ID']).push(r['학교ID'])
  }

  const zones = []
  for (const [lv, layer] of Object.entries(layers)) {
    for (const r of layer.rows) {
      zones.push({
        id: r.HAKGUDO_ID,
        name: r.HAKGUDO_NM,
        level: lv,
        shared: r.HAKGUDO_GB !== '0', // 공동통학구역·자유학구
        sido: r.EDU_UP_NM.replace(/교육청$/, ''),
        office: r.EDU_NM,
        schools: zoneSchools.get(r.HAKGUDO_ID) ?? [],
      })
    }
  }

  // 함정 8: 연계정보에 실린 고교 = 추첨 배정 대상(평준화 일반고).
  const assignedHigh = new Set(
    zones.filter((z) => z.level === '고').flatMap((z) => z.schools ?? []),
  )

  const schools = []
  for (const r of schoolRows) {
    if (r['운영상태'] !== '운영') continue
    const level = LEVELS[r['학교급구분']]
    if (!level) continue
    const lat = Number(r['위도']), lon = Number(r['경도'])
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue

    const [x, y] = toKorea2000(lon, lat) // 함정 4
    const zones = {}
    // 초등은 자기 통학구역까지, 중등 이상은 상위 구역만 본다.
    for (const lv of level === '초' ? ['초', '중', '고'] : level === '중' ? ['중', '고'] : ['고']) {
      const hits = layers[lv].locate(x, y)
      if (hits.length) zones[lv] = hits.map((h) => h.HAKGUDO_ID)
    }

    // 함정 7: 학교군이 안 잡히는 고교는 대개 비평준화 지역이다. 누락과 구분해서 표기한다.
    const nonLevelled = level === '고' && !zones['고'] ? flat.locate(x, y).length > 0 : false

    schools.push({
      id: r['학교ID'],
      name: r['학교명'],
      level,
      estab: r['설립형태'],
      sido: r['시도교육청명'].replace(/교육청$/, ''),
      office: r['교육지원청명'],
      addr: r['소재지도로명주소'] || r['소재지지번주소'],
      lat, lon,
      elemZone: zones['초']?.[0] ?? null,
      midZone: zones['중']?.[0] ?? null,
      highZone: zones['고']?.[0] ?? null,
      ...(nonLevelled ? { nonLevelled: true } : {}),
      ...(level === '고' ? { assigned: assignedHigh.has(r['학교ID']) } : {}),
    })
  }

  return { schools, zones, baseDate: schoolRows[0]?.['데이터기준일자'] ?? null }
}

/** 고교 학교군 → 중학교 학구 → 초등 통학구역 드릴다운 인덱스 */
function buildChain(schools, zones) {
  const byId = new Map(zones.map((z) => [z.id, z]))
  const group = (key, level) => {
    const m = new Map()
    for (const s of schools) {
      if (s.level !== level || !s[key]) continue
      if (!m.has(s[key])) m.set(s[key], [])
      m.get(s[key]).push(s.id)
    }
    return m
  }

  const highHigh = group('highZone', '고')
  const highMid = group('highZone', '중')
  const highElem = group('highZone', '초')
  const midElem = group('midZone', '초')
  const midMid = group('midZone', '중')

  const highZones = zones.filter((z) => z.level === '고').map((z) => ({
    id: z.id, name: z.name, sido: z.sido, office: z.office,
    // 함정 8: 중·초등과 같은 위치 기준. 자사고·특목고가 빠지지 않는다.
    highSchools: highHigh.get(z.id) ?? [],
    assignedHighSchools: z.schools,               // 그중 추첨 배정 대상(연계정보)
    middleSchools: highMid.get(z.id) ?? [],       // 좌표가 이 학교군 안에 있는 중학교
    elemSchools: highElem.get(z.id) ?? [],
    midZones: [...new Set((highMid.get(z.id) ?? [])
      .map((id) => schools.find((s) => s.id === id)?.midZone).filter(Boolean))],
  }))

  const midZones = zones.filter((z) => z.level === '중').map((z) => ({
    id: z.id, name: z.name, shared: z.shared, sido: z.sido, office: z.office,
    middleSchools: z.schools,
    elemSchools: midElem.get(z.id) ?? [],
    _located: midMid.get(z.id) ?? [],
  })).filter((z) => z.middleSchools.length || z.elemSchools.length)

  for (const z of midZones) delete z._located
  return { highZones, midZones }
}

/** 함정 3·4·5 는 조용히 틀린다. 여기서 막는다. */
function validate({ schools, zones }, chain) {
  const count = (lv) => schools.filter((s) => s.level === lv).length
  const n = { 초: count('초'), 중: count('중'), 고: count('고') }
  if (schools.length < 10000 || schools.length > 15000) {
    throw new Error(`학교 수가 이상하다: ${schools.length} (기대 10,000~15,000)`)
  }
  for (const [lv, min] of [['초', 5000], ['중', 2500], ['고', 2000]]) {
    if (n[lv] < min) throw new Error(`${lv}등학교가 ${n[lv]}개뿐이다 (최소 ${min})`)
  }

  // 함정 4 가 터지면 매칭률이 0 에 수렴한다.
  const rate = (lv, key) => {
    const pool = schools.filter((s) => s.level === lv)
    return pool.filter((s) => s[key]).length / pool.length
  }
  for (const [lv, key, min] of [['초', 'elemZone', 0.85], ['초', 'midZone', 0.85]]) {
    const r = rate(lv, key)
    if (r < min) throw new Error(`${lv} → ${key} 매칭률 ${(r * 100).toFixed(1)}% (최소 ${min * 100}%) — 좌표계를 의심하라`)
  }

  // 함정 7: 전체 매칭률이 아니라 **평준화가 확실한 시도**로 검증한다. 여기서 깨지면 좌표계다.
  const levelled = schools.filter((s) => s.level === '고' && FULLY_LEVELLED.some((x) => x.startsWith(s.sido)))
  const levelledHit = levelled.filter((s) => s.highZone).length / levelled.length
  if (levelledHit < 0.99) {
    throw new Error(`평준화 시도 고교 학교군 매칭률 ${(levelledHit * 100).toFixed(1)}% (기대 100%) — 좌표계를 의심하라`)
  }
  // 나머지 고교는 학교군이 없어도 비평준화지역에는 들어가야 한다.
  const highs = schools.filter((s) => s.level === '고')
  const covered = highs.filter((s) => s.highZone || s.nonLevelled).length / highs.length
  if (covered < 0.9) {
    throw new Error(`고교 ${((1 - covered) * 100).toFixed(1)}% 가 학교군에도 비평준화지역에도 없다 — 구역 데이터가 어긋났다`)
  }

  // 골든 케이스: 실측으로 확인한 체인이다. 깨지면 파이프라인이 어긋난 것이다.
  const daechi = schools.find((s) => s.name === '서울대치초등학교')
  if (!daechi) throw new Error('골든 케이스 학교(서울대치초등학교)를 못 찾았다')
  const nameOf = (id) => zones.find((z) => z.id === id)?.name
  if (nameOf(daechi.midZone) !== '강남서초2학교군') {
    throw new Error(`골든 케이스 실패: 서울대치초 중학교 학구가 "${nameOf(daechi.midZone)}" (기대 강남서초2학교군)`)
  }
  if (nameOf(daechi.highZone) !== '강남서초학교군') {
    throw new Error(`골든 케이스 실패: 서울대치초 고교 학교군이 "${nameOf(daechi.highZone)}" (기대 강남서초학교군)`)
  }

  const empty = chain.highZones.filter((z) => !z.assignedHighSchools.length).length
  if (empty > chain.highZones.length / 2) {
    throw new Error(`고교 학교군 ${chain.highZones.length}개 중 ${empty}개가 배정 학교 0건 — 연계정보 조인이 어긋났다`)
  }
  return n
}

async function main() {
  const datasets = await findDatasets()
  console.log('· 최신 릴리스')
  for (const [key, ds] of Object.entries(datasets)) console.log(`   ${key.padEnd(7)} ${ds.date}  ${ds.title.slice(0, 60)}`)

  const sources = {}
  for (const [key, ds] of Object.entries(datasets)) {
    sources[key] = await download(ds)
    console.log(`· 내려받음 ${key} (${sources[key].map((e) => e.name).join(', ').slice(0, 70)})`)
  }

  const data = build(sources)
  const chain = buildChain(data.schools, data.zones)
  const n = validate(data, chain)

  await fs.mkdir(OUT_DIR, { recursive: true })
  const baseDate = data.baseDate
  const write = (name, obj) => fs.writeFile(path.join(OUT_DIR, name), JSON.stringify(obj, null, 1) + '\n')

  await write('schools.json', { baseDate, count: data.schools.length, schools: data.schools })
  await write('zones.json', { baseDate, count: data.zones.length, zones: data.zones })
  await write('chain.json', { baseDate, ...chain })
  await write('meta.json', {
    baseDate,
    source: '학구도안내서비스(한국교육시설안전원) 공공데이터',
    sourceUrl: LIST,
    license: '공공누리 제1유형 — 출처 표시',
    releases: Object.fromEntries(Object.entries(datasets).map(([k, d]) => [k, { date: d.date, title: d.title }])),
    counts: { schools: n, zones: { 초: data.zones.filter((z) => z.level === '초').length, 중: data.zones.filter((z) => z.level === '중').length, 고: data.zones.filter((z) => z.level === '고').length } },
    caveat: '학구는 제도상 배정 구역이다. 개인의 실제 진학 경로가 아니다 — 앱에서 그렇게 표기하지 말 것.',
  })

  const nonLev = data.schools.filter((s) => s.nonLevelled).length
  console.log(`✓ school-zones/schools.json — 초 ${n.초} · 중 ${n.중} · 고 ${n.고} (기준 ${baseDate})`)
  console.log(`  고교 중 학교군 배정 ${data.schools.filter((s) => s.level === '고' && s.highZone).length} · 비평준화 ${nonLev}`)
  console.log(`✓ school-zones/zones.json — 학구 ${data.zones.length}개`)
  console.log(`✓ school-zones/chain.json — 고교 학교군 ${chain.highZones.length} · 중학교 학구 ${chain.midZones.length}`)
  const sample = chain.highZones.find((z) => z.name === '강남서초학교군')
  if (sample) console.log(`  예) ${sample.name} — 고교 ${sample.highSchools.length} · 중학교 ${sample.middleSchools.length} · 초등 ${sample.elemSchools.length}`)
}

main().catch((e) => { console.error('✗', e.message); process.exit(1) })
