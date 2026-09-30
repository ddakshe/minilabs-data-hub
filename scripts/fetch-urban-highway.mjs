#!/usr/bin/env node
/*
 * 도시계획 지도(city-plan-map) — 한국도로공사 고속도로 공사현황 → urban-plan/highway.json
 *
 *   node scripts/fetch-urban-highway.mjs
 *
 * **무엇.** 시공 중인 고속도로 구간(노선+구간)을 공구 단위로 모은다. 한 공구는 4~9km 이고
 * 공구마다 시점·종점 주소가 있어 한 구간에 점이 여러 개 생긴다. 앱은 **점만 찍고 선으로 잇지 않는다** —
 * 공구 주소 사이의 실제 선형은 모른다(GTX 미확정 노선 점을 잇지 않는 것과 같은 규칙).
 *
 * **좌표.** API 에 좌표가 없다. 주소를 urban-plan/cache/bjd-centroids.json(법정동·리 경계 대표점,
 * scripts/build-bjd-centroids.py)에 맞춘다. 지오코더를 쓰지 않으므로 결과를 저장해도 된다.
 * 정밀도는 점마다 `lv` 로 싣는다: 'ri' · 'dong' · 'emd'(읍면 — 도로명 주소라 리를 모를 때).
 *
 * ── 이 도메인의 함정 ─────────────────────────────────────────────────
 * 1) data.ex.co.kr 은 **curl/Node 기본 UA 를 막는다**(400 "Request Blocked") → 브라우저 UA 필수.
 * 2) 인증키는 10자리 숫자(`EX_API_KEY`). 틀리면 200 + code "ERROR" 가 온다 — HTTP 상태로 못 거른다.
 * 3) 주소 칸이 **비어 있는 공구가 많다**(2026-09-30 실측 시점·종점 470칸 중 160). 한쪽만 있으면 한 점만 찍는다.
 * 4) **사업단·현장사무소 주소가 섞여 있다** — 시점과 종점이 같은 도로명 주소, 아파트 이름이 붙은 주소.
 *    공사 위치가 아니므로 버린다(`OFFICE`).
 * 5) 공사연장에 "3240.000km" 같은 값이 있다 → 공구 하나가 60km 를 넘으면 버린다.
 * 6) 시도 이름이 옛 이름·약칭·오타로 온다(「충북」「전라님도」「강진구」). 약칭과 시·군 접미사 차이는
 *    흡수하고, 오타는 매칭 실패로 남긴다 — 실패 목록을 출력한다.
 * 7) 2026 개편으로 전남·광주(12)·강원(51)·전북(52)·화성 일반구 코드가 바뀌었다. 중심점 표에 옛·새 코드가
 *    같이 있어 같은 이름이 두 번 걸린다 → 1km 안이면 같은 곳으로 본다.
 *
 * 약관: 고속도로 공공데이터 포털 OpenAPI. 가공 산출물만 낸다. 앱에 출처·기준일을 표기한다.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'
const API = 'https://data.ex.co.kr/openapi/safeDriving/hiwayCnstnPrss'

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

async function download(key) {
  const q = new URLSearchParams({ key, type: 'json', pagingYN: 'N' })
  const res = await fetch(`${API}?${q}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} (함정 1: UA)`)
  const body = await res.json()
  if (body.code !== 'SUCCESS') throw new Error(`API ${body.code}: ${body.message} (함정 2)`)
  const rows = Object.values(body).find(Array.isArray) ?? []
  if (rows.length !== Number(body.count)) throw new Error(`받은 행 ${rows.length} ≠ count ${body.count}`)
  return rows
}

// ─── 주소 → 법정동·리 대표점 ──────────────────────────────────────────

const C = JSON.parse(await fs.readFile(path.join(ROOT, 'urban-plan', 'cache', 'bjd-centroids.json'), 'utf8'))
const byName = new Map()
for (const [code, [, , nm]] of Object.entries(C.points)) {
  if (!byName.has(nm)) byName.set(nm, [])
  byName.get(nm).push(code)
}

/** 주소 앞머리 → 법정동코드 앞 두 자리(옛·새 코드 둘 다) */
// 시도 약칭은 주소에서 뽑는다 — 새 코드 12 는 광주·전남이 섞여 코드로는 못 가른다(함정 7)
const SIDO = [
  [/^서울/, ['11'], '서울'], [/^부산/, ['26'], '부산'], [/^대구/, ['27'], '대구'], [/^인천/, ['28'], '인천'],
  [/^광주광역/, ['29', '12'], '광주'], [/^대전/, ['30'], '대전'], [/^울산/, ['31'], '울산'], [/^세종/, ['36'], '세종'],
  [/^경기/, ['41'], '경기'], [/^강원/, ['42', '51'], '강원'], [/^충청북|^충북/, ['43'], '충북'], [/^충청남|^충남/, ['44'], '충남'],
  [/^전라북|^전북/, ['45', '52'], '전북'], [/^전라남|^전남/, ['46', '12'], '전남'], [/^경상북|^경북/, ['47'], '경북'],
  [/^경상남|^경남/, ['48'], '경남'], [/^제주/, ['50'], '제주'],
]

const stem = (w) => w.slice(0, -1)
const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 0.02

function tokens(a) {
  const par = [...a.matchAll(/\(([^)]*)\)/g)].map((m) => m[1])
  const t = a.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, ' ').split(/\s+/).filter(Boolean)
  for (const p of par) t.push(...p.split(/[ ,]/).filter((w) => /^\S+[동가]$/.test(w)))
  return t
}

const LEVELS = [['ri', /^\S+리$/], ['dong', /^\S+(동|가)$/], ['emd', /^\S+[읍면]$/]]

/** @returns {{code, at:[lat,lng], lv, sido, sigungu} | null} */
function resolve(addr) {
  const [, sd, sidoShort] = SIDO.find(([re]) => re.test(addr)) ?? []
  const t = tokens(addr)
  if (!sd || !t.length) return null
  const sgg = t.slice(1).filter((w) => /^\S+[시군구]$/.test(w)).map(stem)
  const emd = t.filter((w) => /^\S+[읍면]$/.test(w))
  const sggOk = (code) => {
    const full = C.sgg[code.slice(0, 5)]
    if (!full) return true // 함정 7) 새 코드 — 시군구 이름을 모른다
    const parts = full.split(' ').slice(1)
    return sgg.every((g) => parts.some((x) => stem(x) === g || x.startsWith(g)))
  }
  for (const [lv, re] of LEVELS) {
    for (const w of t.filter((w) => re.test(w) && !/(로|길)\d/.test(w))) {
      const names = lv === 'dong' ? [w, `${w}동`] : [w] // 「죽동」→「죽동동」
      const cs = names.flatMap((n) => byName.get(n) ?? []).filter((c) => sd.includes(c.slice(0, 2)))
      let f = cs.filter(sggOk)
      if (!f.length) f = cs
      if (f.length > 1 && emd.length) {
        const g = f.filter((c) => (C.names[c.slice(0, 8) + '00'] ?? '').endsWith(emd[0]))
        if (g.length) f = g
      }
      if (f.length > 1 && f.every((c) => near(C.points[c], C.points[f[0]]))) f = f.slice(0, 1)
      if (f.length === 1) {
        const code = f[0]
        const full = C.names[code] ?? C.sgg[code.slice(0, 5)] ?? ''
        return {
          code,
          at: C.points[code].slice(0, 2),
          lv,
          sido: sidoShort,
          // 세종은 시군구가 없다(「세종특별자치시 전동면」). 새 코드는 이름을 몰라 주소의 시군구 토큰을 쓴다
          sigungu: code.startsWith('36') ? '세종시' : (C.names[code] || C.sgg[code.slice(0, 5)]) ? full.split(' ')[1] ?? null
            : t.slice(1).find((w) => /^\S+[시군구]$/.test(w)) ?? null,
        }
      }
      if (f.length > 1) return null // 모호하면 찍지 않는다
    }
  }
  return null
}

// ─── 가공 ─────────────────────────────────────────────────────────────

/** 함정 4) 사업단·현장사무소 주소 */
const OFFICE = (r) => {
  const s = r.cnstnStpntAddr.trim(), e = r.cnstnEnpntAddr.trim()
  return (s && s === e && /(로|길)\s*\d/.test(s)) || /(아파트|캐슬|자이|푸르지오|힐스테이트|래미안)/.test(s + e)
}
const km = (v) => {
  const n = parseFloat(String(v ?? '').replace(/km/i, ''))
  return Number.isFinite(n) && n > 0 && n <= 60 ? n : null // 함정 5)
}
const ymRange = (v) => {
  const m = String(v ?? '').match(/(\d{4})(\d{2})\s*~\s*(\d{4})(\d{2})/)
  return m ? { start: `${m[1]}-${m[2]}`, end: `${m[3]}-${m[4]}` } : { start: null, end: null }
}

function build(rows) {
  const underway = rows.filter((r) => r.cmcnCstrClssCd === 'C02')
  const groups = new Map()
  const fails = []
  let office = 0
  for (const r of underway) {
    const key = `${r.routeName.trim()}|${r.sectionName.trim()}`
    if (!groups.has(key)) groups.set(key, { route: r.routeName.trim(), section: r.sectionName.trim(), agency: r.cnsof?.trim() || null, lots: [] })
    const isOffice = OFFICE(r)
    if (isOffice) office++
    const end = (k) => {
      const addr = r[k].replace(/\s+/g, ' ').trim()
      if (!addr || isOffice) return null
      const hit = resolve(addr)
      if (!hit) fails.push(addr)
      return { addr, at: hit?.at ?? null, lv: hit?.lv ?? null, sido: hit?.sido ?? null, sigungu: hit?.sigungu ?? null }
    }
    groups.get(key).lots.push({
      name: r.bizMgmtName?.trim() || null,
      lengthKm: km(r.cnstnExtns),
      period: ymRange(r.cnstnTerm),
      from: end('cnstnStpntAddr'),
      to: end('cnstnEnpntAddr'),
    })
  }

  const items = [...groups.values()].map((g) => {
    const ends = g.lots.flatMap((l) => [l.from, l.to]).filter((e) => e?.at)
    // 같은 리·동에 여러 공구가 걸치면 점 하나로
    const points = []
    for (const e of ends) if (!points.some((p) => p.at[0] === e.at[0] && p.at[1] === e.at[1])) points.push({ at: e.at, lv: e.lv })
    const count = (k) => Object.entries(ends.reduce((a, e) => ((a[e[k]] = (a[e[k]] ?? 0) + 1), a), {})).sort((x, y) => y[1] - x[1]).map(([v]) => v)
    const starts = g.lots.map((l) => l.period.start).filter(Boolean).sort()
    const endsYm = g.lots.map((l) => l.period.end).filter(Boolean).sort()
    const lens = g.lots.map((l) => l.lengthKm).filter(Boolean)
    return {
      id: crypto.createHash('sha1').update(`${g.route}|${g.section}`).digest('hex').slice(0, 12),
      name: `${g.route} ${g.section}`,
      route: g.route,
      section: g.section,
      agency: g.agency,
      sidos: count('sido'),
      sigungus: count('sigungu'),
      period: { start: starts[0] ?? null, end: endsYm.at(-1) ?? null },
      lotCount: g.lots.length,
      /** 연장이 적힌 공구만 더한 값 — 전체 구간 길이가 아니다 */
      lengthKm: lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) * 10) / 10 : null,
      lengthLots: lens.length,
      points,
      lots: g.lots,
    }
  })
  return { items, fails, office, underway: underway.length }
}

// ─── 실행 ───────────────────────────────────────────────────────────────

const key = await readKey('EX_API_KEY')
if (!key) {
  console.error('✗ EX_API_KEY 가 없다 (env 또는 ~/.config/credentials/keys.env)')
  process.exit(1)
}
const rows = await download(key)
const built = build(rows)
const mapped = built.items.filter((i) => i.points.length)

const fail = []
if (rows.length < 300) fail.push(`전체 ${rows.length}건 — 2026-09-30 실측 597건보다 크게 적다`)
if (built.underway < 100) fail.push(`시공 중 ${built.underway}공구 — 실측 235보다 크게 적다`)
if (mapped.length < 15) fail.push(`점이 있는 구간 ${mapped.length} — 실측 28보다 크게 적다(중심점 표·매칭 확인)`)
for (const it of built.items) for (const p of it.points) {
  if (!(p.at[0] > 32 && p.at[0] < 39.5 && p.at[1] > 124 && p.at[1] < 132)) fail.push(`${it.name}: 좌표 ${p.at}`)
}
if (new Set(built.items.map((i) => i.id)).size !== built.items.length) fail.push('id 중복')
if (fail.length) {
  console.error('✗ highway 검증 실패\n  - ' + fail.join('\n  - '))
  process.exit(1)
}

const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
await fs.writeFile(path.join(ROOT, 'urban-plan', 'highway.json'), JSON.stringify({
  source: '한국도로공사 고속도로 공사현황 (고속도로 공공데이터 포털)',
  sourceUrl: 'https://data.ex.co.kr/openapi/basicinfo/openApiInfoM?apiId=0614',
  /** API 가 기준일을 주지 않는다 — 받은 날 */
  fetchedDate: today,
  pointBasis: '공구 시점·종점 주소의 법정동·리 경계 대표점(브이월드 법정경계)',
  items: built.items,
}))

const pts = built.items.reduce((a, i) => a + i.points.length, 0)
console.log(`✓ highway.json — 시공 중 ${built.underway}공구 · ${built.items.length}구간(점 있음 ${mapped.length}) · 점 ${pts} · 사무소 주소 제외 ${built.office} · 매칭 실패 ${built.fails.length}`)
if (built.fails.length) console.log('  실패: ' + [...new Set(built.fails)].slice(0, 30).join(' / '))
