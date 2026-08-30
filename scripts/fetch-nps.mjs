/*
 * 국민연금공단 공공데이터 게시판 → nps/{regions,meta}.json
 *
 * 사용법:
 *   node scripts/fetch-nps.mjs
 *
 * 소비자: nps-region-mini(우리동네 연금). 시도 17개의 1인당 월평균 수령액과 순위.
 *
 * **왜 허브에서 받나.** 원본이 게시판 첨부(ZIP 안 CSV 26개)라 앱이 직접 못 읽는다.
 * 인증은 필요 없지만 CP949 · 첨부 형태 2종 · 단위 미표기 때문에 파싱이 까다롭고,
 * 매월 한 번 사람이 손으로 받을 수는 없다.
 *
 * ── 이 도메인의 함정 (전부 실측) ──────────────────────────────
 * 1) **CP949 다.** 게시판 HTML 은 UTF-8 인데 CSV 본문과 ZIP 내부 파일명은 CP949 다.
 *    macOS `unzip` 은 APFS 가 UTF-8 파일명만 받아 "Illegal byte sequence" 로 전부
 *    실패한다 → ZIP 을 메모리에서 직접 파싱한다(scripts/nps/zip.mjs).
 * 2) **첨부 형태가 시기마다 다르다.** 2026년은 ZIP 1개(atchFileSn=1), 2021~2024년은
 *    개별 CSV 20여개(atchFileSn 이 145596 같은 큰 정수 PK), 2015년은 통짜 CSV 1개다.
 *    **순번을 믿지 말고 파일명으로 매칭한다.**
 * 3) **개별 첨부일 때 게시판이 파일명을 `;` 로 쪼갠다.** 파일명에 `∼`(`&sim;`)가 들어가면
 *    `2-1 …수(1988.1.1&sim` / `현재) - 급여 종류별(1988.1.1&sim` / `현재).csv` 처럼 한 파일이
 *    세 항목으로 렌더링되고, **그 지점부터 파일명↔첨부 매핑이 통째로 밀린다.** 「2-3 지역별」
 *    이라 적힌 링크가 2-5 연령별을 내려준다(실측). → 개별 첨부는 **내용으로 식별**한다.
 * 4) **2021년 이전은 명명체계가 다르다.** 2018년은 `3-5 지역별 급여종별 수급자 현황`
 *    이고 **지역별 수급금액(2-11) 항목이 아예 없다.** 현재 스키마는 2021년부터다.
 * 5) **수급금액 단위가 CSV 어디에도 없다.** 백만원이다 — 2-10 누적 지급액
 *    26,563,360 이 265조원(2024년 실제 누적 급여지급액)과 맞는 것으로 교차검증했다.
 *    틀리면 평균이 100만배 어긋나므로 validate() 가 범위로 막는다.
 * 6) **CSV 에 따옴표 안 콤마가 있다** (`"1,50만원∼160만원 미만"`). split(',') 로
 *    자르면 조용히 열이 밀린다. 그리고 뒤에 빈 열이 붙는다 (`...,1538,,,,`).
 *
 * 함정 1·3·5·6 은 전부 "예외 없이 조용히 틀린 값"으로 끝난다. 그래서 파일을 쓰기 전에
 * validate() 로 막고, 어긋나면 커밋 전에 죽는다.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readZip } from './nps/zip.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../nps')

const HOST = 'https://www.nps.or.kr'
const LIST = `${HOST}/inforls/publdata/getOHAB0019M0List.do?menuId=MN24000873`
const DETAIL = `${HOST}/inforls/publdata/getOHAB0019M1.do`
const BOARD = { hmpgCd: '01', hmpgBbsCd: 'BS20240191', sortSe: 'FR' }
const UA = 'Mozilla/5.0 (compatible; minilabs-data-hub/1.0)'

/** 현재 명명체계가 시작된 시점. 이보다 오래된 게시물은 파싱 규칙이 다르다. (함정 4) */
const SCHEMA_FROM = '2021-01'

const dec949 = new TextDecoder('euc-kr')

async function get(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers ?? {}) } })
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`)
  return res
}

/** 게시판 1페이지에서 가장 최신 「N년 M월 기준 국민연금 (공표)통계」 게시물을 찾는다. */
async function findLatestPost() {
  const res = await get(LIST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...BOARD, pstId: '', pageIndex: '1' }),
  })
  const html = await res.text()

  const table = html.match(/<caption>\s*공공데이터 제공목록[\s\S]*?<\/table>/)
  if (!table) throw new Error('게시판 목록 테이블을 찾지 못했다 — 게시판 구조가 바뀌었다')

  const posts = []
  for (const row of table[0].match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
    const text = row.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    const m = text.match(/(\d{4})년\s*(\d{1,2})월?말?\s*기준 국민연금 (?:공표)?통계/)
    if (!m) continue
    const id = row.match(/pstId=(\w+)/)
    if (!id) continue
    posts.push({
      baseMonth: `${m[1]}-${String(Number(m[2])).padStart(2, '0')}`,
      pstId: id[1],
    })
  }
  if (posts.length === 0) throw new Error('공표통계 게시물이 1페이지에 없다 — 제목 형식이 바뀌었다')

  posts.sort((a, b) => b.baseMonth.localeCompare(a.baseMonth))
  const latest = posts[0]
  if (latest.baseMonth < SCHEMA_FROM) {
    throw new Error(`최신 게시물이 ${latest.baseMonth} 로 스키마 시작(${SCHEMA_FROM}) 이전이다`)
  }
  return latest
}

/** 상세 페이지에서 첨부 목록을 뽑는다. 파일명은 어긋날 수 있다 — 참고용이다. (함정 2·3) */
async function listAttachments(pstId) {
  const qs = new URLSearchParams({ menuId: 'MN24000873', pstId, ...BOARD })
  const html = await (await get(`${DETAIL}?${qs}`)).text()

  const out = []
  const re = /<a\b[^>]*fncAtchFileDownload\('([^']+)',\s*'([^']+)'[\s\S]*?<\/a>/g
  for (const m of html.matchAll(re)) {
    const name = m[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/ - 다운로드$/, '').trim()
    if (name) out.push({ atchFileId: m[1], atchFileSn: m[2], name })
  }
  if (out.length === 0) throw new Error(`첨부를 찾지 못했다 (pstId=${pstId})`)
  return out
}

async function download({ atchFileId, atchFileSn }) {
  const res = await get(`${HOST}/fileDown.do?atchFileId=${atchFileId}&atchFileSn=${atchFileSn}`)
  return Buffer.from(await res.arrayBuffer())
}

/** 따옴표 안 콤마를 지키는 최소 CSV 파서. (함정 6) */
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
  return rows.filter((r) => r.some((v) => v.trim() !== ''))
}

/**
 * 지역별 표인지 내용으로 판별한다. 헤더에 급여종류 6열이 있고 17개 시도 행이 있으면 맞다.
 * 2-3(수급자수)과 2-11(수급금액)은 **헤더도 행도 완전히 같아서** 이것만으로는 구분되지 않는다.
 */
function isRegionTable(rows) {
  if (rows.length !== 18) return false
  const h = rows[0].map((v) => v.trim())
  if (!TYPES.every((t) => h.includes(t.label))) return false
  return rows[1][0].trim() === '서울' && rows[17][0].trim() === '제주'
}

/**
 * 같은 모양의 두 표 중 어느 쪽이 수급자수이고 어느 쪽이 수급금액인지 가른다.
 *
 * 🔑 **일시금이 갈라준다.** 노령연금은 1인당 월 60만원대라 금액(백만원)이 인원보다 작지만,
 * 반환일시금은 1인당 수백만원이라 금액이 인원보다 **크다**. 두 조건이 동시에 성립하는
 * 배치가 정답이고, 아니면 죽는다 — 뒤집힌 채로 통과하는 경우가 없다.
 */
function orderTables(a, b) {
  const seoul = (rows) => {
    const h = rows[0].map((v) => v.trim())
    const r = rows[1]
    const at = (label) => Number(String(r[h.indexOf(label)]).replace(/[,\s]/g, ''))
    return { old: at('노령(연금)'), refund: at('반환(일시금)') }
  }
  const A = seoul(a), B = seoul(b)
  const ok = (cnt, amt) => cnt.old > amt.old && amt.refund > cnt.refund
  if (ok(A, B)) return { count: a, amount: b }
  if (ok(B, A)) return { count: b, amount: a }
  throw new Error(
    `수급자수/수급금액을 가르지 못했다 — 서울 노령 ${A.old}/${B.old}, 반환일시금 ${A.refund}/${B.refund}`
  )
}

/**
 * 게시물에서 지역별 표 두 장을 가져온다.
 * ZIP 이면 내부 파일명이 정확하므로 이름으로 고르고, 개별 첨부면 파일명을 믿을 수 없어
 * 전부 받아 내용으로 찾는다. (함정 2·3)
 */
async function fetchRegionTables(attachments) {
  const zip = attachments.find((a) => /\.zip$/i.test(a.name))

  let candidates
  if (zip) {
    const files = readZip(await download(zip))
    candidates = files
      .filter((f) => /\.csv$/i.test(f.name))
      .map((f) => ({ name: f.name, rows: parseCsv(dec949.decode(f.data)) }))
  } else {
    // 🚨 이름으로 거르지 않는다. 게시판이 파일명을 쪼개 놓아서(함정 3) 진짜 파일이
    // `현재) - 급여 종류별(…` 같은 유령 이름 뒤에 숨는다. 전부 받아 내용으로 판별한다.
    // 공표통계 CSV 는 한 장에 수 KB 라 26장을 받아도 부담이 없다.
    candidates = []
    for (const a of attachments) {
      const buf = await download(a)
      if (buf.length > 2_000_000) continue // 예상 밖의 대용량은 건너뛴다
      try {
        candidates.push({ name: a.name, rows: parseCsv(dec949.decode(buf)) })
      } catch { /* CSV 가 아니면 후보에서 빠진다 */ }
    }
  }

  const hits = candidates.filter((c) => isRegionTable(c.rows))
  if (hits.length !== 2) {
    throw new Error(
      `지역별 표가 2장이 아니라 ${hits.length}장이다 (후보 ${candidates.length}개). ` +
      `찾은 것: ${hits.map((h) => h.name).join(' / ') || '없음'}`
    )
  }
  return { ...orderTables(hits[0].rows, hits[1].rows), shape: zip ? 'zip' : 'files' }
}

/** 헤더 컬럼명으로 인덱스를 찾는다. 열 순서를 가정하지 않는다. */
function columnIndex(header, label) {
  const i = header.findIndex((h) => h.trim() === label)
  if (i < 0) throw new Error(`컬럼 '${label}' 이 없다. 헤더: ${header.join(',')}`)
  return i
}

const TYPES = [
  { key: 'old', label: '노령(연금)', ko: '노령연금' },
  { key: 'disabled', label: '장애(연금)', ko: '장애연금' },
  { key: 'survivor', label: '유족(연금)', ko: '유족연금' },
]

function build(baseMonth, cRows, aRows) {
  const cIdx = Object.fromEntries(TYPES.map((t) => [t.key, columnIndex(cRows[0], t.label)]))
  const aIdx = Object.fromEntries(TYPES.map((t) => [t.key, columnIndex(aRows[0], t.label)]))

  const num = (v) => {
    const n = Number(String(v).replace(/[,\s]/g, ''))
    if (!Number.isFinite(n)) throw new Error(`숫자가 아니다: ${JSON.stringify(v)}`)
    return n
  }
  const amountByRegion = new Map(aRows.slice(1).map((r) => [r[0].trim(), r]))

  const regions = cRows.slice(1).map((r) => {
    const name = r[0].trim()
    const ar = amountByRegion.get(name)
    if (!ar) throw new Error(`수급금액 CSV 에 '${name}' 이 없다 — 두 파일의 지역 목록이 어긋난다`)
    const entry = { name }
    for (const t of TYPES) {
      const count = num(r[cIdx[t.key]])
      // 원본 단위는 백만원이다. (함정 5)
      const amount = num(ar[aIdx[t.key]]) * 1_000_000
      entry[t.key] = { count, amount, avg: count > 0 ? Math.round(amount / count) : 0 }
    }
    return entry
  })

  // 노령연금 1인당 월평균 기준 순위.
  const ranked = [...regions].sort((a, b) => b.old.avg - a.old.avg)
  ranked.forEach((r, i) => { r.rank = i + 1 })

  const national = {}
  for (const t of TYPES) {
    const count = regions.reduce((s, r) => s + r[t.key].count, 0)
    const amount = regions.reduce((s, r) => s + r[t.key].amount, 0)
    national[t.key] = { count, amount, avg: count > 0 ? Math.round(amount / count) : 0 }
  }

  return {
    baseMonth,
    unit: '원',
    note: '원본 CSV 의 수급금액은 백만원 단위다. 여기서는 원으로 환산했다.',
    types: TYPES.map(({ key, ko }) => ({ key, ko })),
    national,
    regions: regions.sort((a, b) => a.rank - b.rank),
  }
}

/** 조용히 틀린 값을 커밋 전에 죽인다. */
function validate(data) {
  const fail = (m) => { throw new Error(`검증 실패: ${m}`) }

  if (!/^\d{4}-\d{2}$/.test(data.baseMonth)) fail(`baseMonth 형식 ${data.baseMonth}`)
  if (data.baseMonth < SCHEMA_FROM) fail(`baseMonth ${data.baseMonth} 가 스키마 시작 이전`)
  if (data.regions.length !== 17) fail(`시도가 17개가 아니라 ${data.regions.length}개`)

  const names = new Set(data.regions.map((r) => r.name))
  if (names.size !== 17) fail('지역명이 중복된다')

  for (const r of data.regions) {
    if (r.old.count <= 0) fail(`${r.name} 노령 수급자수가 0 이하`)
    if (r.old.amount <= 0) fail(`${r.name} 노령 수급금액이 0 이하`)
    // 단위를 잘못 읽으면 100만배 어긋난다. (함정 5)
    if (r.old.avg < 200_000 || r.old.avg > 2_000_000) {
      fail(`${r.name} 노령 평균이 ${r.old.avg}원 — 단위를 잘못 읽었을 가능성이 높다`)
    }
  }
  const n = data.national.old.avg
  if (n < 400_000 || n > 1_200_000) fail(`전국 노령 평균이 ${n}원 — 범위 밖`)

  const ranks = data.regions.map((r) => r.rank).sort((a, b) => a - b)
  if (ranks.some((v, i) => v !== i + 1)) fail('순위가 1..17 연속이 아니다')
}

async function main() {
  // 과거 게시물로 파서를 검증할 때 쓴다 (첨부 형태가 시기마다 다르다 — 함정 2).
  //   NPS_PST_ID=PU202400000000029549 NPS_BASE_MONTH=2024-01 node scripts/fetch-nps.mjs
  const post = process.env.NPS_PST_ID
    ? { pstId: process.env.NPS_PST_ID, baseMonth: process.env.NPS_BASE_MONTH ?? '' }
    : await findLatestPost()
  console.log(`· 최신 게시물: ${post.baseMonth} 기준 (pstId=${post.pstId})`)

  const attachments = await listAttachments(post.pstId)
  const { count, amount, shape } = await fetchRegionTables(attachments)
  console.log(`· 첨부 ${attachments.length}개, 형태=${shape}`)

  const data = build(post.baseMonth, count, amount)
  validate(data)

  await fs.mkdir(OUT_DIR, { recursive: true })
  await fs.writeFile(path.join(OUT_DIR, 'regions.json'), JSON.stringify(data, null, 1) + '\n')

  const meta = {
    baseMonth: data.baseMonth,
    fetchedAt: new Date().toISOString(),
    source: '국민연금공단 공공데이터 제공목록 — 월간 공표통계',
    sourceUrl: LIST,
    files: ['2-3 수급자 수 급여 종류별_지역별', '2-11 수급자 수급금액 급여 종류별_지역별'],
    regions: data.regions.length,
    nationalAvgOld: data.national.old.avg,
    // 공표는 기준월로부터 약 3~4개월 뒤에 올라온다. 앱은 이 기준월을 반드시 표시한다.
    lagNote: '공표 지연 평균 3.5개월. "실시간"으로 표기하지 않는다.',
  }
  await fs.writeFile(path.join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 1) + '\n')

  console.log(`✓ nps/regions.json — ${data.baseMonth} 기준, 시도 ${data.regions.length}개`)
  console.log(`  전국 노령 1인당 월평균 ${data.national.old.avg.toLocaleString()}원`)
  console.log(`  1위 ${data.regions[0].name} ${data.regions[0].old.avg.toLocaleString()}원 / ` +
    `17위 ${data.regions[16].name} ${data.regions[16].old.avg.toLocaleString()}원`)
}

main().catch((e) => { console.error('✗', e.message); process.exit(1) })
