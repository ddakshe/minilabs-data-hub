/*
 * 국민연금공단 공공데이터 게시판 → nps/{regions,distribution,stats,meta}.json
 *
 * 사용법:
 *   node scripts/fetch-nps.mjs
 *
 * 소비자: nps-region-mini(우리동네 연금).
 *   regions.json      시도 17개의 1인당 월평균 수령액과 순위 (2-3 ÷ 2-11)
 *   distribution.json 월 수급금액 분포 × 성별 × 가입기간 (2-6-1) + 가입기간별 평균 (2-13)
 *   stats.json        21년 추이 (2-2·2-10) · 수급기간별 (2-4) · 연령대별 (2-5-1)
 *
 * 🔑 **분포가 이 데이터의 고유값이다.** 산정식만 있는 계산기 앱들은 "당신은 65만원"까지만
 *    말할 수 있다. 같은 65만원이 전체에서는 상위 34.3%, 남성 중에는 49.5%, 가입 20년 이상
 *    남성 중에는 93.5% 라는 건 실제 수급자 656만 명의 분포가 있어야 나온다.
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

/**
 * 현재 명명체계가 시작된 시점. 이보다 오래된 게시물은 파싱 규칙이 다르다. (함정 4)
 *
 * ⚠️ 지역별(2-3·2-11)은 2021-01 부터 있지만 **분포(2-6-1)는 더 늦게 추가됐다** —
 *    2021-01 에는 없고 2024-01 에는 있다(실측). 최신 게시물만 받으므로 실사용엔
 *    문제가 없지만, 과거 게시물로 파서를 검증할 때는 2024 이후를 쓴다.
 */
const SCHEMA_FROM = '2021-01'

const dec949 = new TextDecoder('euc-kr')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 개별 첨부 게시물은 한 번에 26개를 받는다. 쉬지 않고 때리면 서버가 연결을 끊는다
 * (실측: `fetch failed`). 요청 사이에 간격을 두고, 실패하면 물러섰다 다시 시도한다.
 */
async function get(url, init = {}) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': UA, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res
    } catch (e) {
      lastError = e
      if (attempt < 3) await sleep(attempt * 1500)
    }
  }
  throw new Error(`${lastError?.message ?? 'fetch 실패'} — ${url}`)
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
async function fetchTables(attachments) {
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
      if (candidates.length > 0) await sleep(250) // 정부 사이트다. 몰아서 때리지 않는다.
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

  return {
    ...orderTables(hits[0].rows, hits[1].rows),
    shape: zip ? 'zip' : 'files',
    /**
     * 모양이 같은 표가 여럿이라(2-4↔2-12, 2-2↔2-10) 전국 수급자 수를 기준선으로
     * 삼아야 가를 수 있다. 그 값은 지역표를 파싱해야 나오므로 두 단계로 나눈다.
     */
    resolve(referenceCount) {
      const pickOne = (test, what) => {
        const found = candidates.filter((c) => test(c.rows, referenceCount))
        if (found.length !== 1) throw new Error(`${what} 표가 1장이 아니라 ${found.length}장이다`)
        return found[0].rows
      }
      const years = candidates.filter((c) => isYearTable(c.rows))
      if (years.length !== 2) throw new Error(`연도표가 2장이 아니라 ${years.length}장이다`)

      return {
        dist: pickOne(isDistributionTable, '월 수급금액 분포(2-6-1)'),
        termAvg: pickOne(isTermAvgTable, '가입기간별 평균(2-13)'),
        years: [years[0].rows, years[1].rows],
        duration: pickOne(isDurationTable, '수급기간별(2-4)'),
        age: pickOne(isAgeTable, '연령대별(2-5-1)'),
      }
    },
  }
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

/**
 * 2-6-1 의 월 수급금액 구간. CSV 는 라벨만 주므로 경계값을 여기 적는다.
 * 마지막 '200만원 이상' 은 상한이 없어 300 으로 둔다 — 2-13 최고 수급금액이 330만원이라
 * 그보다 넓게 잡으면 상위 구간의 보간이 실제보다 완만해진다.
 */
const BANDS = [
  [0, 20], [20, 40], [40, 60], [60, 80], [80, 100],
  [100, 130], [130, 160], [160, 200], [200, 300],
]

/** 2-6-1 의 비교군 컬럼. 사용자가 고를 수 있는 축이 곧 이 목록이다. */
const GROUPS = [
  { key: 'maleAll', col: '남자', ko: '남성 전체' },
  { key: 'femaleAll', col: '여자', ko: '여성 전체' },
  { key: 'male20', col: '남자(가입기간 20년이상)', ko: '남성 · 가입 20년 이상' },
  { key: 'female20', col: '여자(가입기간 20년이상)', ko: '여성 · 가입 20년 이상' },
  { key: 'male10', col: '남자(가입기간 10~19년)', ko: '남성 · 가입 10~19년' },
  { key: 'female10', col: '여자(가입기간 10~19년)', ko: '여성 · 가입 10~19년' },
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

/**
 * 2-6-1(월 수급금액별 × 성별 × 가입기간) + 2-13(가입기간별 최고·평균)을 합쳐
 * 분포 스냅샷을 만든다.
 *
 * 앱은 이 파일 하나로 "내 금액이 상위 몇 %"를 비교군별로 전부 계산한다.
 * 누적을 서버에서 굽지 않고 구간 인원만 넘긴다 — 앱이 보간 방식을 바꿀 수 있어야 하고,
 * 6개 비교군 × 9구간이면 어차피 작다.
 */
function buildDistribution(baseMonth, dRows, avgRows) {
  const hdr = dRows[0].map((v) => v.trim())
  const body = dRows.slice(1)
  if (body.length !== BANDS.length) {
    throw new Error(`2-6-1 구간이 ${BANDS.length}개가 아니라 ${body.length}개다`)
  }

  const num = (v) => {
    const n = Number(String(v).replace(/[,\s]/g, ''))
    if (!Number.isFinite(n)) throw new Error(`숫자가 아니다: ${JSON.stringify(v)}`)
    return n
  }

  const groups = GROUPS.map((g) => {
    const i = hdr.indexOf(g.col)
    if (i < 0) throw new Error(`2-6-1 에 '${g.col}' 컬럼이 없다. 헤더: ${hdr.join(',')}`)
    const counts = body.map((r) => num(r[i]))
    return { key: g.key, ko: g.ko, total: counts.reduce((a, b) => a + b, 0), counts }
  })

  // 전체(남+여)는 원본에 없다. 두 컬럼을 더해 만든다.
  const mi = hdr.indexOf('남자'), fi = hdr.indexOf('여자')
  const all = body.map((r) => num(r[mi]) + num(r[fi]))
  groups.unshift({ key: 'all', ko: '전체 수급자', total: all.reduce((a, b) => a + b, 0), counts: all })

  // 2-13 — 가입기간별 실제 평균. "같은 조건 사람들은 얼마 받나"의 답이다.
  const aHdr = avgRows[0].map((v) => v.trim())
  const avgRow = avgRows.find((r) => r[0].trim() === '평균수급금액')
  const maxRow = avgRows.find((r) => r[0].trim() === '최고수급금액')
  if (!avgRow || !maxRow) throw new Error('2-13 에 평균/최고수급금액 행이 없다')
  const byTerm = {}
  for (const label of ['20년이상(노령)', '10~19년(노령)', '조기(노령)']) {
    const i = aHdr.indexOf(label)
    if (i < 0) throw new Error(`2-13 에 '${label}' 컬럼이 없다`)
    byTerm[label.replace('(노령)', '')] = { avg: num(avgRow[i]), max: num(maxRow[i]) }
  }

  return {
    baseMonth,
    unit: '원',
    bands: BANDS.map(([lo, hi], i) => ({
      label: body[i][0].trim(),
      from: lo * 10_000,
      to: hi * 10_000,
      // 마지막 구간은 상한이 없다. 보간할 때 이 표시를 봐야 한다.
      open: i === BANDS.length - 1,
    })),
    groups,
    byTerm,
  }
}

/** 2-6-1 인지 내용으로 판별한다. 구간 라벨이 '20만원 미만' 으로 시작하고 성별 컬럼이 있다. */
function isDistributionTable(rows) {
  if (rows.length !== BANDS.length + 1) return false
  const h = rows[0].map((v) => v.trim())
  return h.includes('남자(가입기간 20년이상)') && rows[1][0].trim().includes('20만원')
}

/** 2-13 인지. 행이 둘뿐이고 첫 열이 최고/평균수급금액이다. */
function isTermAvgTable(rows) {
  return rows.length === 3 &&
    rows[1][0].trim() === '최고수급금액' &&
    rows[0].some((v) => v.trim() === '20년이상(노령)')
}

/**
 * 통계 탭용 스냅샷 — 추이·수급기간·연령대.
 *
 * ⚠️ **2-10 은 연 누적 지급액이다.** 2-2 의 수급자 수는 그 시점 인원이라
 *    둘을 나누면 연중 유입을 반영하지 못해 월평균이 실제보다 낮게 나온다
 *    (2025년 근사 56만원 vs 실제 62만원). 그래서 **여기서 평균을 만들지 않는다.**
 *    두 실측치만 넘기고, 평균은 regions.json 의 정확한 값(2-3÷2-11)을 쓴다.
 *
 * 마지막 행은 연중 시점이라 지급액이 그 해의 일부다. `partial` 로 표시해
 * 앱이 추이 차트에서 빼거나 따로 그릴 수 있게 한다.
 */
function buildStats(baseMonth, yearCntRows, yearAmtRows, durRows, ageRows) {
  const num = (v) => {
    const n = Number(String(v).replace(/[,\s]/g, ''))
    if (!Number.isFinite(n)) throw new Error(`숫자가 아니다: ${JSON.stringify(v)}`)
    return n
  }
  const colOf = (rows, label) => {
    const i = rows[0].findIndex((h) => h.trim() === label)
    if (i < 0) throw new Error(`'${label}' 컬럼이 없다. 헤더: ${rows[0].join(',')}`)
    return i
  }

  // ── 21년 추이 ──────────────────────────────
  const ci = colOf(yearCntRows, '노령(연금)')
  const ai = colOf(yearAmtRows, '노령(연금)')
  const amtByDate = new Map(yearAmtRows.slice(1).map((r) => [r[0].trim(), r]))
  const trend = yearCntRows.slice(1).map((r) => {
    const date = r[0].trim()
    const ar = amtByDate.get(date)
    if (!ar) throw new Error(`2-10 에 '${date}' 행이 없다 — 두 파일의 연도가 어긋난다`)
    const [y, m] = date.split('-')
    return {
      year: Number(y),
      count: num(r[ci]),
      // 원본 단위는 백만원이다. 그 해 1월부터 이 시점까지의 누적 지급액.
      amount: num(ar[ai]) * 1_000_000,
      months: Number(m),
      partial: date.slice(5) !== '12-31',
    }
  })

  // ── 수급기간별 ─────────────────────────────
  const di = colOf(durRows, '노령연금')
  const byDuration = durRows.slice(1).map((r) => ({
    label: r[0].trim(),
    count: num(r[di]),
  }))

  // ── 연령대별 (성별) ────────────────────────
  const mi = colOf(ageRows, '남자'), fi = colOf(ageRows, '여자')
  const byAge = ageRows.slice(1)
    .map((r) => ({ label: r[0].trim(), male: num(r[mi]), female: num(r[fi]) }))
    // 수급자가 아예 없는 연령대(20~50세)는 차트에서 빈 칸만 만든다.
    .filter((r) => r.male + r.female > 0)

  return { baseMonth, unit: '원', trend, byDuration, byAge }
}

/**
 * 연도표 두 장 중 어느 쪽이 수급자 수(2-2)이고 어느 쪽이 지급액(2-10)인지 가른다.
 *
 * 🚨 지역표에 쓴 일시금 트릭이 여기선 안 통한다. 2-10 은 **연 누적**이라
 *    12월 기준이면 지급액이 인원의 7배지만 1월 기준이면 0.6배로 뒤집힌다.
 *    그래서 대신 **이미 아는 전국 노령 수급자 수(2-3 에서 온 값)** 와 대조한다.
 *    인원 표의 마지막 행은 그 값에 근접하고, 금액 표는 자릿수부터 다르다.
 */
function orderYearTables(a, b, referenceCount) {
  const lastOld = (rows) => {
    const i = rows[0].findIndex((h) => h.trim() === '노령(연금)')
    return Number(String(rows[rows.length - 1][i]).replace(/[,\s]/g, ''))
  }
  const da = Math.abs(lastOld(a) - referenceCount) / referenceCount
  const db = Math.abs(lastOld(b) - referenceCount) / referenceCount

  // 인원 표만 5% 안에 든다. 금액 표가 우연히 그 안에 들려면 평균×개월수 ≈ 100만원,
  // 즉 개월수가 1.7 이어야 하는데 개월수는 정수라 일어나지 않는다.
  // (1월 기준이면 0.6배, 2월이면 1.2배 — 어느 쪽도 5% 안에 못 든다.)
  const aMatch = da < 0.05, bMatch = db < 0.05
  if (aMatch && !bMatch) return { count: a, amount: b }
  if (bMatch && !aMatch) return { count: b, amount: a }
  throw new Error(
    `연도표를 가르지 못했다 — 마지막 노령값 ${lastOld(a)} / ${lastOld(b)}, 기준 ${referenceCount}`
  )
}

/** 2-2/2-10 인지. 첫 열이 'YYYY-MM-DD' 이고 급여 6종 컬럼이 있다. */
function isYearTable(rows) {
  if (rows.length < 10) return false
  const h = rows[0].map((v) => v.trim())
  return h.includes('노령(연금)') && /^\d{4}-\d{2}-\d{2}$/.test(rows[1][0].trim())
}

/**
 * 2-4 수급기간별. 행이 6개고 컬럼이 연금 3종이다.
 *
 * 🚨 2-12(수급금액 수급기간별)가 **모양이 완전히 같다.** 그래서 노령 열의 합이
 *    전국 노령 수급자 수에 붙는지로 가른다 — 금액 표는 자릿수부터 다르다.
 */
function isDurationTable(rows, referenceCount) {
  const h = rows[0].map((v) => v.trim())
  const shapeOk = rows.length === 7 && h.includes('노령연금') && h.includes('유족연금') &&
    rows[1][0].trim().includes('1년 미만')
  if (!shapeOk) return false
  const i = h.indexOf('노령연금')
  const sum = rows.slice(1).reduce((a, r) => a + Number(String(r[i]).replace(/[,\s]/g, '')), 0)
  return Math.abs(sum - referenceCount) / referenceCount < 0.05
}

/** 2-5-1 연령대별. 가입기간 컬럼이 있고 첫 행이 '20세 미만' 이다. */
function isAgeTable(rows) {
  const h = rows[0].map((v) => v.trim())
  return h.includes('남자(가입기간 20년이상)') && rows[1][0].trim().includes('20세 미만')
}

/** 추이·분류 통계도 조용히 틀릴 수 있다. */
function validateStats(stats, nationalOldCount) {
  const fail = (m) => { throw new Error(`통계 검증 실패: ${m}`) }

  if (stats.trend.length < 10) fail(`추이가 ${stats.trend.length}년치뿐이다`)

  // 수급자 수는 해마다 늘어왔다. 크게 꺾이면 두 표를 뒤바꿔 읽은 것이다.
  //
  // ⚠️ 완결된 연도끼리만 본다. 마지막 행은 연중 시점이라 직전 12월 말보다 소폭
  //    줄어들 수 있다(1월 말 기준 게시물에서 실제로 그랬다) — 수급권 상실 정리가
  //    반영되기 때문이고, 표를 잘못 읽은 것과는 다르다.
  //    이 검사의 목적은 표 뒤바뀜(자릿수가 통째로 다른 값)을 잡는 것이라 5% 를 준다.
  const full = stats.trend.filter((t) => !t.partial)
  for (let i = 1; i < full.length; i++) {
    if (full[i].count < full[i - 1].count * 0.95) {
      fail(`${full[i].year}년 수급자 수가 전년보다 5% 넘게 적다 — 표를 뒤바꿔 읽었을 수 있다`)
    }
  }
  const last = stats.trend[stats.trend.length - 1]
  if (Math.abs(last.count - nationalOldCount) / nationalOldCount > 0.05) {
    fail(`추이 마지막 수급자 수 ${last.count.toLocaleString()} 가 전국값 ${nationalOldCount.toLocaleString()} 와 5% 넘게 다르다`)
  }

  if (stats.byDuration.length !== 6) fail(`수급기간 구간이 6개가 아니라 ${stats.byDuration.length}개`)
  if (stats.byAge.length < 3) fail(`연령대가 ${stats.byAge.length}개뿐이다`)
  const ageSum = stats.byAge.reduce((s, a) => s + a.male + a.female, 0)
  if (Math.abs(ageSum - nationalOldCount) / nationalOldCount > 0.05) {
    fail(`연령대 합 ${ageSum.toLocaleString()} 이 전국값과 5% 넘게 다르다`)
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

/** 분포도 조용히 틀릴 수 있다. 합계와 단조성으로 막는다. */
function validateDistribution(dist, nationalOldCount) {
  const fail = (m) => { throw new Error(`분포 검증 실패: ${m}`) }

  if (dist.bands.length !== 9) fail(`구간이 9개가 아니라 ${dist.bands.length}개`)
  if (dist.groups.length !== 7) fail(`비교군이 7개가 아니라 ${dist.groups.length}개`)

  const all = dist.groups.find((g) => g.key === 'all')
  if (!all) fail("'all' 비교군이 없다")

  // 전체 분포의 합은 노령연금 수급자 수와 같아야 한다. 다르면 컬럼을 잘못 골랐다.
  const diff = Math.abs(all.total - nationalOldCount)
  if (diff / nationalOldCount > 0.02) {
    fail(`전체 분포 합 ${all.total.toLocaleString()} 이 노령 수급자 ${nationalOldCount.toLocaleString()} 와 2% 넘게 다르다`)
  }

  for (const g of dist.groups) {
    if (g.counts.length !== 9) fail(`${g.ko} 구간이 9개가 아니다`)
    if (g.counts.some((c) => c < 0)) fail(`${g.ko} 에 음수가 있다`)
    if (g.total <= 0) fail(`${g.ko} 합계가 0 이하`)
  }

  for (const [term, v] of Object.entries(dist.byTerm)) {
    if (v.avg <= 0 || v.max <= 0) fail(`${term} 평균/최고가 0 이하`)
    if (v.avg > v.max) fail(`${term} 평균(${v.avg})이 최고(${v.max})보다 크다`)
  }
}

async function main() {
  // 과거 게시물로 파서를 검증할 때 쓴다 (첨부 형태가 시기마다 다르다 — 함정 2).
  //   NPS_PST_ID=PU202400000000029549 NPS_BASE_MONTH=2024-01 node scripts/fetch-nps.mjs
  const post = process.env.NPS_PST_ID
    ? { pstId: process.env.NPS_PST_ID, baseMonth: process.env.NPS_BASE_MONTH ?? '' }
    : await findLatestPost()
  console.log(`· 최신 게시물: ${post.baseMonth} 기준 (pstId=${post.pstId})`)

  const attachments = await listAttachments(post.pstId)
  const tables = await fetchTables(attachments)
  console.log(`· 첨부 ${attachments.length}개, 형태=${tables.shape}`)

  const data = build(post.baseMonth, tables.count, tables.amount)
  validate(data)

  // 나머지 표는 전국 수급자 수를 기준선으로 삼아 가른다 — 모양이 같은 표가 여럿이다.
  const { dist: distRows, termAvg, years, duration, age } =
    tables.resolve(data.national.old.count)

  const dist = buildDistribution(post.baseMonth, distRows, termAvg)
  validateDistribution(dist, data.national.old.count)

  const yr = orderYearTables(years[0], years[1], data.national.old.count)
  const stats = buildStats(post.baseMonth, yr.count, yr.amount, duration, age)
  validateStats(stats, data.national.old.count)

  await fs.mkdir(OUT_DIR, { recursive: true })
  await fs.writeFile(path.join(OUT_DIR, 'regions.json'), JSON.stringify(data, null, 1) + '\n')
  await fs.writeFile(path.join(OUT_DIR, 'distribution.json'), JSON.stringify(dist, null, 1) + '\n')
  await fs.writeFile(path.join(OUT_DIR, 'stats.json'), JSON.stringify(stats, null, 1) + '\n')

  const meta = {
    baseMonth: data.baseMonth,
    fetchedAt: new Date().toISOString(),
    source: '국민연금공단 공공데이터 제공목록 — 월간 공표통계',
    sourceUrl: LIST,
    files: [
      '2-3 수급자 수 급여 종류별_지역별',
      '2-11 수급자 수급금액 급여 종류별_지역별',
      '2-6-1 노령연금 수급자 수 종류별성별_월 수급금액별',
      '2-13 연금 종류별 최고·평균 수급금액',
      '2-2 · 2-10 급여 종류별_연도별',
      '2-4 연금급여 종류별_수급기간별',
      '2-5-1 노령연금 종류별성별_연령별',
    ],
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
  const all = dist.groups.find((g) => g.key === 'all')
  console.log(`✓ nps/distribution.json — 비교군 ${dist.groups.length}개 × 구간 ${dist.bands.length}개`)
  console.log(`  전체 ${all.total.toLocaleString()}명 · 20년이상 평균 ${dist.byTerm['20년이상'].avg.toLocaleString()}원`)
  const t0 = stats.trend[0], t1 = stats.trend[stats.trend.length - 1]
  console.log(`✓ nps/stats.json — 추이 ${t0.year}~${t1.year} (${(t0.count / 1e4).toFixed(0)}만 → ${(t1.count / 1e4).toFixed(0)}만명)`)
  console.log(`  수급기간 ${stats.byDuration.length}구간 · 연령대 ${stats.byAge.length}구간`)
}

main().catch((e) => { console.error('✗', e.message); process.exit(1) })
