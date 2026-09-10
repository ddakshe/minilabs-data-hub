#!/usr/bin/env node
/*
 * 도시계획 지도(city-plan-map) — 택지정보시스템 개발사업지구 → urban-plan/
 *
 *   node scripts/fetch-urban-plan.mjs                 # 택지정보시스템에서 받는다
 *   node scripts/fetch-urban-plan.mjs --save DIR      # 받은 ZIP 을 DIR 에 남긴다
 *   node scripts/fetch-urban-plan.mjs --from DIR      # DIR 의 ZIP 으로만 굽는다 (네트워크 0)
 *
 * **왜 택지정보시스템인가.** 신도시·공공주택지구·도시개발구역이 한 소스에 다 들어 있다.
 * 전국 1,372 지구(폴리곤 1,332) · 법령 18종 · 3기 신도시 전부 · 인증키 없음 · 월 1회 갱신.
 * 거래가격·시세는 없다 — 고시·계획·현황만. 이 앱의 정책 경계와 정확히 맞는다.
 *
 * ── 이 도메인의 함정 (전부 2026-09-10 실측) ──────────────────────────────
 * 1) **세션이 없으면 WAF 가 406 을 준다.** `/down/detail.do` 를 폼 POST 로 먼저 열어
 *    JSESSIONID 를 받아야 `/api/list.json` · `/openApi/down.do` 가 열린다.
 *    GET 으로 detail.do 를 열어도 406 이다. `testAt=Y` 를 붙여도 406 이다.
 * 2) **fileNo 는 매달 바뀐다.** list.json 으로 그달 번호를 먼저 받는다.
 *    ntfcDe(고시월)를 비우면 list 가 빈 배열로 온다 — detail 페이지의 첫 옵션을 쓴다.
 * 3) **CSV 는 cp949, 따옴표 감싼 필드 + 빈 필드**가 섞여 있다. split(',') 금지.
 *    ZIP 내부 파일명도 cp949 라 macOS unzip 이 죽는다 → scripts/nps/zip.mjs.
 * 4) **위치코드(LC_CODE)에 레거시 코드가 섞여 있다** (12=전남·광주, 30=대전).
 *    시도는 위치명(LC_NM) 첫 토큰으로 뽑는다.
 * 5) 지구경계는 3857·5186 두 벌이다. **3857(coordGubun=1)** 을 받는다 — 역변환이 수식 한 줄.
 * 6) 경계 SHP 는 멀티파트 + 구멍이 있다. 링 방향(시계=외곽)으로 묶어 MultiPolygon 으로 낸다.
 *
 * 약관: jigu.go.kr 이용약관 13조에 재배포 제한 문구가 있다. 원본 CSV/SHP 를 커밋하지 않고
 * **가공 산출물(요약 JSON·단순화 경계)** 만 낸다. 앱에 출처를 표기한다.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readZip } from './nps/zip.mjs'
import { readDbf, indexShp } from './school-zones/shapefile.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'urban-plan')
const BASE = 'https://openapi.jigu.go.kr'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'

const TABLES = {
  info: { table: 'BLS5_DSTRC_INFO', pick: (r) => r.fileTy === 'csv', file: 'info.zip' },
  master: { table: 'BLS5_DSTRC_MASTER', pick: (r) => r.fileTy === 'csv', file: 'master.zip' },
  bndry: { table: 'BLS5_GIS_DSTRC_BNDRY', pick: (r) => r.fileTy === 'shp' && String(r.coordGubun) === '1', file: 'bndry3857.zip' },
}

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const FROM = arg('--from')
const SAVE = arg('--save')

// ─── 받기 ───────────────────────────────────────────────────────────────

/** 쿠키 한 통을 들고 다니는 최소 세션. Node 내장 fetch 는 쿠키를 기억하지 않는다. */
function session() {
  const jar = new Map()
  const remember = (res) => {
    const list = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean)
    for (const c of list) {
      const [pair] = c.split(';')
      const eq = pair.indexOf('=')
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }
  return async (url, { method = 'GET', form, referer, xhr } = {}) => {
    const headers = { 'User-Agent': UA, Origin: BASE, Referer: referer ?? `${BASE}/main.do` }
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    if (xhr) {
      headers['X-Requested-With'] = 'XMLHttpRequest'
      headers.Accept = 'application/json, text/javascript, */*; q=0.01'
    }
    let body
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
      body = new URLSearchParams(form).toString()
    }
    const res = await fetch(url, { method, headers, body, redirect: 'follow' })
    remember(res)
    if (!res.ok) throw new Error(`${method} ${url} — HTTP ${res.status} (406 이면 세션/WAF: 함정 1)`)
    return res
  }
}

async function download() {
  const http = session()
  await http(`${BASE}/main.do`)
  const detailHtml = await (await http(`${BASE}/down/detail.do`, { method: 'POST', form: { table: TABLES.info.table } })).text()
  const ntfcDe = detailHtml.match(/<option value="(\d{4}-\d{2})"/)?.[1]
  if (!ntfcDe) throw new Error('detail.do 에서 고시월 옵션을 찾지 못했다 (함정 2) — 페이지 구조가 바뀌었다')

  const files = {}
  let stdrDe
  for (const [key, t] of Object.entries(TABLES)) {
    await http(`${BASE}/down/detail.do`, { method: 'POST', form: { table: t.table } })
    const list = await (await http(`${BASE}/api/list.json`, {
      method: 'POST', xhr: true, referer: `${BASE}/down/detail.do`,
      form: { tNm: t.table, table: t.table, ctprvn: '00', ntfcDe },
    })).json()
    const row = (list.list ?? []).find(t.pick)
    if (!row) throw new Error(`${t.table}: list.json 에서 파일을 못 찾았다 — ${JSON.stringify(list.list)}`)
    stdrDe ??= row.stdrDe
    if (row.stdrDe !== stdrDe) throw new Error(`기준일이 테이블마다 다르다: ${stdrDe} vs ${row.stdrDe} (${t.table})`)

    const q = new URLSearchParams({ fileTy: row.fileTy, stdrDe: row.stdrDe, ctprvn: '00', table: t.table, fileNo: String(row.fileNo) })
    const exist = await (await http(`${BASE}/openApi/fileExist.json?${q}`, { method: 'POST', xhr: true, referer: `${BASE}/down/detail.do` })).json()
    if (!exist.exist) throw new Error(`${t.table}: fileExist=false (fileNo ${row.fileNo})`)
    const buf = Buffer.from(await (await http(`${BASE}/openApi/down.do?${q}`, { referer: `${BASE}/down/detail.do` })).arrayBuffer())
    console.log(`  ↓ ${t.table} fileNo=${row.fileNo} ${(buf.length / 1024).toFixed(0)}KB`)
    files[key] = buf
    if (SAVE) {
      await fs.mkdir(SAVE, { recursive: true })
      await fs.writeFile(path.join(SAVE, t.file), buf)
    }
  }
  if (SAVE) await fs.writeFile(path.join(SAVE, 'stdr.json'), JSON.stringify({ stdrDe, ntfcDe }))
  return { files, stdrDe, ntfcDe }
}

async function loadLocal(dir) {
  const files = {}
  for (const [key, t] of Object.entries(TABLES)) files[key] = await fs.readFile(path.join(dir, t.file))
  const stdr = JSON.parse(await fs.readFile(path.join(dir, 'stdr.json'), 'utf8').catch(() => '{}'))
  return { files, stdrDe: stdr.stdrDe ?? 'unknown', ntfcDe: stdr.ntfcDe ?? 'unknown' }
}

// ─── 파싱 ───────────────────────────────────────────────────────────────

/** 따옴표·빈 필드·따옴표 안 콤마를 견디는 CSV 파서 (함정 3) */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  const [head, ...body] = rows
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])))
}

function csvFromZip(buf) {
  const entry = readZip(buf).find((e) => e.name.toLowerCase().endsWith('.csv'))
  if (!entry) throw new Error('ZIP 안에 CSV 가 없다')
  return parseCsv(new TextDecoder('euc-kr').decode(entry.data))
}

// ─── 좌표 ───────────────────────────────────────────────────────────────

const R = 6378137
const toLngLat = ([x, y]) => [(x / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)]
const r5 = (v) => Math.round(v * 1e5) / 1e5

/** Douglas–Peucker (반복형). 3857 좌표(≈m×1.25, 한반도 위도)에서 돈다. */
function simplify(pts, tol) {
  if (pts.length <= 4) return pts
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  const t2 = tol * tol
  while (stack.length) {
    const [a, b] = stack.pop()
    const [ax, ay] = pts[a]
    const [bx, by] = pts[b]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    let maxD = -1
    let idx = -1
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
      t = Math.max(0, Math.min(1, t))
      const ex = px - (ax + t * dx)
      const ey = py - (ay + t * dy)
      const d = ex * ex + ey * ey
      if (d > maxD) { maxD = d; idx = i }
    }
    if (maxD > t2) {
      keep[idx] = 1
      stack.push([a, idx], [idx, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}

const signedArea = (ring) => {
  let s = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  return s / 2
}

function inRing([x, y], ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * SHP 링 → MultiPolygon. SHP 는 외곽이 시계방향(부호 음수), 구멍이 반시계(양수)다 (함정 6).
 * 단순화 후 3점 미만으로 무너진 링은 버린다 (아주 작은 구멍).
 * @returns {{ geometry, center:[lat,lng], bbox:[s,w,n,e] } | null}
 */
function toGeometry(rings, tol = 25) {
  const outers = []
  const holes = []
  for (const raw of rings) {
    const ring = simplify(raw, tol)
    if (ring.length < 4) continue
    ;(signedArea(raw) < 0 ? outers : holes).push({ ring, area: Math.abs(signedArea(raw)) })
  }
  if (!outers.length) return null
  const polys = outers.map((o) => ({ ...o, holes: [] }))
  for (const h of holes) {
    const owner = polys.find((p) => inRing(h.ring[0], p.ring)) ?? polys[0]
    owner.holes.push(h.ring)
  }

  // 핀 자리: 가장 큰 외곽 링의 면적중심. 오목해서 밖으로 나가면 bbox 중심으로 물러난다.
  const big = polys.reduce((a, b) => (b.area > a.area ? b : a))
  let cx = 0
  let cy = 0
  let a6 = 0
  const g = big.ring
  for (let i = 0, j = g.length - 1; i < g.length; j = i++) {
    const f = g[j][0] * g[i][1] - g[i][0] * g[j][1]
    cx += (g[j][0] + g[i][0]) * f
    cy += (g[j][1] + g[i][1]) * f
    a6 += f * 3
  }
  let c = a6 ? [cx / a6, cy / a6] : g[0]

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of polys) for (const [x, y] of p.ring) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (!inRing(c, g)) c = [(minX + maxX) / 2, (minY + maxY) / 2]

  const ll = (ring) => ring.map((p) => toLngLat(p).map(r5))
  const [cLng, cLat] = toLngLat(c)
  const [w, s] = toLngLat([minX, minY])
  const [e, n] = toLngLat([maxX, maxY])
  return {
    geometry: { type: 'MultiPolygon', coordinates: polys.map((p) => [ll(p.ring), ...p.holes.map(ll)]) },
    center: [r5(cLat), r5(cLng)],
    bbox: [r5(s), r5(w), r5(n), r5(e)],
  }
}

// ─── 정규화 ─────────────────────────────────────────────────────────────

const SIDO = [
  ['서울', 'seoul', /^서울/], ['부산', 'busan', /^부산/], ['대구', 'daegu', /^대구/], ['인천', 'incheon', /^인천/],
  ['광주', 'gwangju', /^광주광역시|^광주$/], ['대전', 'daejeon', /^대전/], ['울산', 'ulsan', /^울산/], ['세종', 'sejong', /^세종/],
  ['경기', 'gyeonggi', /^경기/], ['강원', 'gangwon', /^강원/], ['충북', 'chungbuk', /^충청북도|^충북/], ['충남', 'chungnam', /^충청남도|^충남/],
  ['전북', 'jeonbuk', /^전라북도|^전북/], ['전남', 'jeonnam', /^전라남도|^전남/], ['경북', 'gyeongbuk', /^경상북도|^경북/],
  ['경남', 'gyeongnam', /^경상남도|^경남/], ['제주', 'jeju', /^제주/],
]

/** 위치명 첫 토큰 → 시도 (함정 4). 못 맞추면 null — validate 가 막는다. */
function sidoOf(loc) {
  const first = loc.split(/\s+/)[0] ?? ''
  const hit = SIDO.find(([, , re]) => re.test(first))
  return hit ? { name: hit[0], slug: hit[1] } : null
}

const date = (v) => (/^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null)
const num = (v) => {
  const n = Number(String(v).replace(/,/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 법정 단계명 → 앱의 4단계 램프. 법정 용어는 stage 에 그대로 남긴다. */
function groupOf(stage) {
  if (stage === '준공') return 'done'
  if (stage.includes('준공')) return 'partial'   // 부분준공 — 아직 진행 중
  if (stage.startsWith('실시')) return 'underway'
  if (stage.startsWith('개발')) return 'planned'
  if (stage.startsWith('지구')) return 'designated'
  return 'other'
}

// ─── 굽기 ───────────────────────────────────────────────────────────────

function build({ files, stdrDe, ntfcDe }) {
  const info = new Map(csvFromZip(files.info).map((r) => [r['지구지정번호'], r]))
  const master = new Map(csvFromZip(files.master).map((r) => [r['지구지정번호'], r]))

  const entries = readZip(files.bndry)
  const pick = (ext) => entries.find((e) => e.name.toLowerCase().endsWith(ext))?.data
  const prj = pick('.prj')?.toString() ?? ''
  if (!/Web_Mercator|3857/i.test(prj)) throw new Error(`지구경계 좌표계가 3857 이 아니다 (함정 5): ${prj.slice(0, 80)}`)
  const dbf = readDbf(pick('.dbf'), 'euc-kr')
  const shp = indexShp(pick('.shp'))
  if (dbf.rows.length !== shp.count) throw new Error(`dbf ${dbf.rows.length}행 ≠ shp ${shp.count}개`)
  const shapeIndex = new Map(dbf.rows.map((r, i) => [r.zoneCode, i]))

  const sites = []
  const features = new Map()
  const unknownSido = []
  const otherStage = new Set()

  for (const [id, m] of master) {
    const stage = m['단계코드명']
    const group = groupOf(stage)
    if (group === 'other') otherStage.add(stage)
    if (group === 'done') continue

    const inf = info.get(id) ?? {}
    const loc = inf['위치명'] ?? ''
    const sido = sidoOf(loc)
    if (!sido) { unknownSido.push(`${id} ${loc}`); continue }

    const si = shapeIndex.get(id)
    const geo = si === undefined ? null : toGeometry(shp.rings(si))
    if (geo) {
      if (!features.has(sido.slug)) features.set(sido.slug, [])
      features.get(sido.slug).push({ type: 'Feature', id, properties: { g: group }, geometry: geo.geometry })
    }

    const steps = [
      ['designated', inf['지구지정일자']],
      ['planned', inf['개발계획승인일자']],
      ['underway', inf['실시계획승인일자']],
      ['done', inf['준공일자'] || inf['준공예정일자'], !inf['준공일자']],
    ]
      .map(([k, d, expected]) => ({ k, d: date(d ?? ''), ...(expected ? { expected: true } : {}) }))
      .filter((s) => s.d)

    const start = date(inf['사업시행시작일자'] ?? '')
    const end = date(inf['사업시행종료일자'] ?? '')
    sites.push({
      id,
      name: m['고시사업지구명'] || m['지구명'],
      kind: inf['택지구분코드명'] || null,        // 공공 / 민간 / 민관
      law: m['법령코드명1'] || null,
      stage,
      group,
      sido: sido.name,
      sidoSlug: sido.slug,
      sigungu: loc.split(/\s+/)[1] ?? null,
      loc,
      area: num(inf['면적']),
      households: num(inf['건설호수']),
      population: num(inf['계획인구수']),
      period: start || end ? { start, end } : null,
      notice: m['고시번호'] ? { no: m['고시번호'], date: date(m['고시일자']) } : null,
      approver: m['승인기관코드명'] || null,
      agency: m['담당기관부서'] || m['담당기관코드명'] || null,
      center: geo?.center ?? null,
      bbox: geo?.bbox ?? null,
      steps,
    })
  }
  sites.sort((a, b) => (b.notice?.date ?? '').localeCompare(a.notice?.date ?? ''))

  const bySido = {}
  const byGroup = {}
  for (const s of sites) {
    bySido[s.sidoSlug] = (bySido[s.sidoSlug] ?? 0) + 1
    byGroup[s.group] = (byGroup[s.group] ?? 0) + 1
  }
  const stdr = date(stdrDe) ?? stdrDe
  const meta = {
    source: '택지정보시스템 (국토교통부·한국국토정보공사)',
    sourceUrl: 'https://www.jigu.go.kr',
    stdrDe: stdr,
    ntfcDe,
    generatedAt: new Date().toISOString(),
    counts: { all: master.size, inProgress: sites.length, withBounds: sites.filter((s) => s.center).length, byGroup },
    sidos: SIDO.map(([name, slug]) => ({ name, slug, count: bySido[slug] ?? 0 })),
  }
  return { meta, sites, features, unknownSido, otherStage }
}

// ─── 검증 ───────────────────────────────────────────────────────────────

/** 전부 "예외 없이 조용히 틀린 값"을 막는 자리다. 어긋나면 파일을 쓰기 전에 죽는다. */
function validate({ meta, sites, features, unknownSido, otherStage }, sizes) {
  const fail = []
  if (otherStage.size) fail.push(`모르는 단계명: ${[...otherStage].join(', ')} — groupOf() 에 추가`)
  if (unknownSido.length) fail.push(`시도를 못 뽑은 지구 ${unknownSido.length}건: ${unknownSido.slice(0, 3).join(' / ')}`)
  const n = sites.length
  if (n < 400 || n > 600) fail.push(`진행중 지구 ${n}건 — 400~600 범위 밖 (2026-08 실측 483)`)

  for (const key of ['왕숙', '교산', '계양', '창릉', '대장', '광명시흥', '의왕군포안산', '진안']) {
    if (!sites.some((s) => s.name.includes(key))) fail.push(`3기 신도시 '${key}' 가 없다`)
  }
  const cr = sites.find((s) => s.name.includes('고양창릉'))
  if (cr?.bbox) {
    const [s, w, nn, e] = cr.bbox
    if (Math.abs(s - 37.59) > 0.02 || Math.abs(w - 126.84) > 0.02 || Math.abs(nn - 37.64) > 0.02 || Math.abs(e - 126.89) > 0.02) {
      fail.push(`고양창릉 bbox 가 어긋났다 ${cr.bbox} — 좌표 역변환 확인`)
    }
  } else fail.push('고양창릉 경계가 없다')

  const withBounds = meta.counts.withBounds
  if (withBounds / n < 0.9) fail.push(`경계 있는 진행중 지구 ${withBounds}/${n} — 90% 미만`)
  const featureCount = [...features.values()].reduce((a, f) => a + f.length, 0)
  if (featureCount !== withBounds) fail.push(`feature ${featureCount} ≠ center ${withBounds}`)

  const total = Object.values(sizes).reduce((a, b) => a + b, 0)
  if (total > 1.5 * 1024 * 1024) fail.push(`산출물 ${(total / 1024).toFixed(0)}KB — 1.5MB 초과`)

  if (fail.length) {
    console.error('✗ validate 실패\n  - ' + fail.join('\n  - '))
    process.exit(1)
  }
}

// ─── main ───────────────────────────────────────────────────────────────

const src = FROM ? await loadLocal(FROM) : await download()
const built = build(src)

const outputs = new Map()
outputs.set('meta.json', JSON.stringify(built.meta, null, 1))
outputs.set('sites.json', JSON.stringify({ stdrDe: built.meta.stdrDe, sites: built.sites }))
for (const [slug, feats] of built.features) {
  outputs.set(`bounds/${slug}.json`, JSON.stringify({ type: 'FeatureCollection', features: feats }))
}
const sizes = Object.fromEntries([...outputs].map(([k, v]) => [k, Buffer.byteLength(v)]))
validate(built, sizes)

await fs.rm(path.join(OUT, 'bounds'), { recursive: true, force: true })
await fs.mkdir(path.join(OUT, 'bounds'), { recursive: true })
for (const [name, body] of outputs) await fs.writeFile(path.join(OUT, name), body)

const kb = (b) => `${(b / 1024).toFixed(0)}KB`
console.log(`✓ urban-plan — 기준일 ${built.meta.stdrDe} · 진행중 ${built.sites.length} / 전체 ${built.meta.counts.all} · 경계 ${built.meta.counts.withBounds}`)
console.log(`  단계 ${JSON.stringify(built.meta.counts.byGroup)}`)
console.log(`  sites.json ${kb(sizes['sites.json'])} · bounds ${kb(Object.entries(sizes).filter(([k]) => k.startsWith('bounds/')).reduce((a, [, v]) => a + v, 0))} (${built.features.size}개 시도)`)
