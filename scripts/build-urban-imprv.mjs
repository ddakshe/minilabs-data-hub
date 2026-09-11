#!/usr/bin/env node
/*
 * 도시계획 지도(city-plan-map) — 정비사업(재개발·재건축) → urban-plan/imprv.json
 *
 *   node scripts/build-urban-imprv.mjs
 *
 * **전국 소스가 없다.** 지자체가 각자 공개한다 — 2026-09-11 조사:
 *   - 전국 표준데이터: 없음 (PK 전수 스캔)
 *   - 서울: 열린데이터광장 OA-2253·OA-20281 **둘 다 종료**. 정보몽땅은 고시문 건수 통계라 구역 목록이 아니다
 *   - 국토부 통계누리 hRsId=17: 시도별 **집계표** · 2022년
 * 그래서 **지역별 파일을 손으로 모아** 한 형태로 굽는다. 소스가 늘면 SOURCES 에 추가한다.
 *
 * ── 왜 자동 수집이 아닌가 ────────────────────────────────────────────
 * 경기는 오픈API(`https://openapi.gg.go.kr/GenrlimprvBizpropls`)가 있지만
 * **분기 갱신**이라 자동화 가치가 낮고, 포털 다운로드는 모달 안에 숨은 버튼이라 스크립트가 깨지기 쉽다.
 * 1년에 네 번 사람이 파일을 받아 두는 편이 실질적으로 더 안정적이다 (GTX seed 와 같은 취급).
 * 인천은 data.go.kr 파일데이터(PK 15055212)라 브라우저 버튼으로 받는다 — docs 의 (b) 방법.
 *
 * ── 🚨 가져오는 컬럼을 좁게 고정한다 (2026-09-11 합의) ──────────────
 * 경기 원본은 53개 컬럼인데 그중 **조합원분양세대수·일반분양세대수·임대세대수·면적별분양주택수·
 * 용적률·토지등소유자수·조합원수** 가 있다. 가격은 없지만 분양 물량 구성은 이 앱이 다루지 않는
 * 관점의 지표로 읽힐 소지가 있다. **"다 받아 놓고 화면에서 안 보여주기"는 하지 않는다** —
 * 데이터에 있으면 언젠가 샌다. 아래 KEEP 밖의 값은 읽지도 않는다.
 *
 * ── 좌표 ─────────────────────────────────────────────────────────
 * 원본에 좌표가 없다(주소만). 도시재생과 같은 방식으로 **시군구 중심**에 떨어뜨리고
 * precision:'sigungu' 를 단다 — 앱이 "대략 위치"로 표기한다.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SEED = path.join(ROOT, 'urban-plan', 'seed', 'imprv')

/** 이 컬럼만 읽는다. 원본에 다른 게 있어도 건드리지 않는다. */
const KEEP_GG = {
  sigungu: '시군명',
  stage: '사업단계',
  type: '사업유형',
  name: '정비구역명',
  addr: '위치',
  area: '구역면적(㎡)',
  operator: '사업시행자',
  note: '현추진상황',
  d_zone: '정비구역지정일자(최초지정)',
  d_assoc: '조합설립인가일자',
  d_impl: '사업시행인가일자',
  d_mgmt: '관리처분인가일자',
  d_start: '착공일자',
  d_done: '준공일자',
}

const KEEP_IC = {
  sigungu: '구명',
  name: '구 역 명',
  addr: '위치',
  area: '면적(제곱미터)',
  type: '사업유형',
  stage: '진행단계',
}

/** 지자체별 소스. 파일은 사람이 받아 seed/imprv/ 에 둔다 (docs/data-updates.md 참고) */
const SOURCES = [
  {
    sido: '경기',
    file: 'gyeonggi.csv',
    keep: KEEP_GG,
    source: '경기도 일반정비사업 추진현황 (경기데이터드림)',
    url: 'https://data.gg.go.kr/portal/data/service/selectServicePage.do?infId=S62GFEEN7JMLMA0PH6CF19108891',
  },
  {
    sido: '인천',
    file: 'incheon.csv',
    keep: KEEP_IC,
    source: '인천광역시 도시 및 주거환경 정비사업 추진현황 (공공데이터포털 15055212)',
    url: 'https://www.data.go.kr/data/15055212/fileData.do',
  },
]

// ─── CSV ────────────────────────────────────────────────────────────────

/** 따옴표 안 쉼표·줄바꿈을 지킨다. split(',') 로는 안 된다 — 주소에 쉼표가 있다 */
function parseCsv(text) {
  const rows = []
  let row = [], cell = '', q = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++ } else q = false }
      else cell += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (c !== '\r') cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  const head = rows.shift().map((h) => h.trim())
  // 🚨 원본 CSV 에 문자열 'nan' 이 빈 칸 대신 들어 있다(2026-09-11 실측 7건) —
  //    그대로 두면 화면에 「경기도 광명시 nan」 이 뜨고 지번 파싱도 어긋난다. 빈 값으로 본다.
  const clean = (v) => {
    const t = (v ?? '').trim()
    return t === 'nan' || t === 'NaN' || t === 'null' ? '' : t
  }
  return rows.filter((r) => r.some((v) => v.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, clean(r[i])])))
}

// ─── 값 다듬기 ──────────────────────────────────────────────────────────

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}
/** YYYYMMDD | YYYY-MM-DD → YYYY-MM-DD. 그 밖은 null */
function ymd(v) {
  const t = String(v ?? '').replace(/[.\-/\s]/g, '')
  if (!/^\d{8}$/.test(t)) return null
  const [y, m, d] = [t.slice(0, 4), t.slice(4, 6), t.slice(6, 8)]
  if (+m < 1 || +m > 12 || +d < 1 || +d > 31) return null
  return `${y}-${m}-${d}`
}

/** 지자체마다 단계 이름이 다르다 — 공통 단계로 모은다. 원문(stageRaw)도 함께 남긴다. */
const STAGE_MAP = [
  [/예정구역|후보지|사업지선정/, 'planned'],
  [/추진위/, 'committee'],
  [/조합설립/, 'assoc'],
  [/사업시행/, 'impl'],
  [/관리처분/, 'mgmt'],
  [/착공/, 'building'],
  [/준공|청산|이전고시/, 'done'],
  [/정비구역|구역지정/, 'zoned'],
]
const stageKey = (s) => STAGE_MAP.find(([re]) => re.test(s))?.[1] ?? null

const TYPE_MAP = [[/재건축/, '재건축'], [/재개발/, '재개발'], [/주거환경/, '주거환경개선'], [/재정비촉진/, '재정비촉진']]
const typeName = (s) => TYPE_MAP.find(([re]) => re.test(s))?.[1] ?? (s || null)

// ─── 필지 좌표 캐시 (resolve-imprv-point.mjs 가 채운다) ───────────────

/**
 * 지번이 있는 곳은 연속지적도에서 찾은 **필지 중심점**을 쓴다(precision:'addr').
 * 못 찾으면 시군구 근사로 남는다 — 준공된 구역은 지번이 사라져 못 찾는 게 정상이다.
 * 캐시가 없으면(첫 실행·CI) 전부 시군구 근사로 간다 — 조용히 동작한다.
 */
async function parcelPoints() {
  try {
    const j = JSON.parse(await fs.readFile(path.join(ROOT, 'urban-plan', 'cache', 'imprv-parcel.json'), 'utf8'))
    const out = new Map()
    for (const [id, v] of Object.entries(j)) if (v?.status === 'OK' && Array.isArray(v.at)) out.set(id, v.at)
    return out
  } catch {
    return new Map()
  }
}

// ─── 시군구 중심 (도시재생과 같은 방식) ────────────────────────────────

async function sigunguCenters() {
  const { schools } = JSON.parse(await fs.readFile(path.join(ROOT, 'school-zones', 'schools.json'), 'utf8'))
  const acc = new Map()
  const add = (key, lat, lon) => {
    const a = acc.get(key) ?? { lat: 0, lon: 0, n: 0 }
    a.lat += lat; a.lon += lon; a.n += 1
    acc.set(key, a)
  }
  for (const s of schools) {
    const t = String(s.addr ?? '').split(/\s+/)
    if (t.length < 2) continue
    const sido = (t[0].match(/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/) ?? [])[1]
    if (!sido) continue
    add(`${sido} ${t[1]}`, s.lat, s.lon)
    if (/[시군]$/.test(t[1]) && /구$/.test(t[2] ?? '')) add(`${sido} ${t[1]} ${t[2]}`, s.lat, s.lon)
  }
  const out = new Map()
  for (const [k, a] of acc) out.set(k, [Math.round((a.lat / a.n) * 1e5) / 1e5, Math.round((a.lon / a.n) * 1e5) / 1e5])
  return out
}

// ─── 굽기 ───────────────────────────────────────────────────────────────

async function build() {
  const centers = await sigunguCenters()
  const parcels = await parcelPoints()
  const items = []
  const stats = []
  const miss = []

  for (const src of SOURCES) {
    let text
    try {
      text = await fs.readFile(path.join(SEED, src.file), 'utf8')
    } catch {
      stats.push(`${src.sido}: 파일 없음 (${src.file}) — 건너뜀`)
      continue
    }
    const rows = parseCsv(text)
    const k = src.keep
    for (const r of rows) {
      const sigungu = (r[k.sigungu] ?? '').trim()
      const name = (r[k.name] ?? '').trim()
      if (!sigungu || !name) continue
      // 🚨 원본 주소에 문자열 'nan' 이 토막으로 섞여 온다 — 「경기도 광명시 nan」(2026-09-11 실측 7건).
      //    빈 칸을 pandas 로 찍어 내보낸 흔적이다. 그대로 두면 화면·공유 문구에 그대로 나온다.
      const addr = (r[k.addr] ?? '').replace(/\bnan\b/gi, ' ').replace(/\s+/g, ' ').trim()
      const near = centers.get(`${src.sido} ${sigungu}`) ?? centers.get(`${src.sido} ${sigungu.split(/\s+/)[0]}`) ?? null
      const id = crypto.createHash('sha1').update(`${src.sido}|${sigungu}|${name}|${addr}`).digest('hex').slice(0, 12)
      // 필지를 찾았으면 그 좌표(정확), 아니면 시군구 중심(근사)
      const exact = parcels.get(id) ?? null
      const point = exact ?? near
      if (!point) miss.push(`${src.sido} ${sigungu} — ${name}`)
      const stageRaw = (r[k.stage] ?? '').trim()
      // 🚨 KEEP 밖의 컬럼은 읽지 않는다
      items.push({
        id,
        sido: src.sido,
        sigungu,
        name,
        addr,
        point,
        // 'addr' = 지적도에서 찾은 필지 위치 · 'sigungu' = 시군구 중심 근사
        precision: exact ? 'addr' : point ? 'sigungu' : null,
        type: typeName((r[k.type] ?? '').trim()),
        stage: stageKey(stageRaw),
        stageRaw: stageRaw || null,
        area: num(r[k.area]),
        operator: k.operator ? (r[k.operator] ?? '').trim() || null : null,
        note: k.note ? (r[k.note] ?? '').trim() || null : null,
        steps: k.d_zone
          ? [
              ['zoned', ymd(r[k.d_zone])],
              ['assoc', ymd(r[k.d_assoc])],
              ['impl', ymd(r[k.d_impl])],
              ['mgmt', ymd(r[k.d_mgmt])],
              ['building', ymd(r[k.d_start])],
              ['done', ymd(r[k.d_done])],
            ].filter(([, d]) => d).map(([kk, d]) => ({ k: kk, d }))
          : [],
      })
    }
    stats.push(`${src.sido}: ${rows.length}행`)
  }
  return { items, stats, miss }
}

// ─── 실행 ───────────────────────────────────────────────────────────────

const built = await build()
const { stats, miss } = built

// 원본에 똑같은 행이 두 번 들어 있는 경우가 있다 (2026-09-11 실측: 경기 안양시 등 18건, 값까지 동일).
// 같은 id 는 앞선 것만 남긴다 — 값이 다른데 id 가 같다면 키가 부족한 것이므로 그때는 검증이 잡는다.
const seen = new Map()
const dupDiff = []
for (const it of built.items) {
  const prev = seen.get(it.id)
  if (!prev) { seen.set(it.id, it); continue }
  if (JSON.stringify(prev) !== JSON.stringify(it)) dupDiff.push(`${it.sido} ${it.sigungu} ${it.name}`)
}
const items = [...seen.values()]
const dupCount = built.items.length - items.length

const fail = []
if (!items.length) fail.push('한 건도 못 읽었다 — seed/imprv/ 에 파일이 있는지 본다')
// 같은 id 인데 내용이 다르면 키(시도·시군구·구역명·주소)가 부족하다는 뜻이다 — 조용히 버리지 않는다
if (dupDiff.length) fail.push(`id 는 같은데 내용이 다른 행 ${dupDiff.length}건: ${dupDiff.slice(0, 3).join(' / ')}`)
for (const it of items) {
  if (it.point && !(it.point[0] > 32 && it.point[0] < 39.5 && it.point[1] > 124 && it.point[1] < 132)) {
    fail.push(`${it.name}: 좌표 ${JSON.stringify(it.point)} — [lat,lng] 순서 확인`)
  }
}
if (fail.length) {
  console.error('✗ imprv 검증 실패\n  - ' + fail.join('\n  - '))
  process.exit(1)
}

await fs.writeFile(path.join(ROOT, 'urban-plan', 'imprv.json'), JSON.stringify({
  sources: SOURCES.map((s) => ({ sido: s.sido, title: s.source, url: s.url })),
  /** 지역별 파일을 사람이 받아 합친다 — 전국 소스가 없다. 파일마다 기준일이 다르다 */
  note: '지자체가 각자 공개한 자료를 모았어요. 지역마다 기준일과 단계 이름이 달라요.',
  items,
}))

const byType = items.reduce((a, i) => ((a[i.type ?? '기타'] = (a[i.type ?? '기타'] ?? 0) + 1), a), {})
const exactN = items.filter((i) => i.precision === 'addr').length
console.log(`✓ imprv.json — ${items.length}건 · 필지 좌표 ${exactN} · 시군구 근사 ${items.length - exactN - miss.length} · 좌표 없음 ${miss.length} · 원본 중복 제거 ${dupCount}`)
console.log(`  ${stats.join(' · ')}`)
console.log(`  유형 ${JSON.stringify(byType)}`)
