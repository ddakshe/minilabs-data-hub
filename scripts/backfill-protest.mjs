// 서울경찰청 집회 게시판 과거분 백필 → protest/history.json
//
// fetch-protest.mjs 는 "앞으로 며칠"만 본다. 이 스크립트는 반대로 과거를 긁어
// "이 장소가 원래 자주 막히는 곳인가"를 판단할 근거를 만든다.
//
// ── 정직하게 짚어둘 제약 ──────────────────────────────────────────────────
// 원문에 주최·단체·목적이 없다. 그래서 "이 집회가 몇 번째"는 셀 수 없다.
// 셀 수 있는 건 "이 장소에서 몇 번째"뿐이다. 집계 키는 장소이고,
// 앱 문구도 반드시 장소 기준으로 써야 한다. (없는 정보를 지어내지 않는다)
//
// 목록 페이징은 ?page=N GET으로 열린다. 2026-09 기준 562페이지(2011-02까지).
//
// Usage:
//   node scripts/backfill-protest.mjs           # 최근 2년
//   node scripts/backfill-protest.mjs 5         # 최근 5년
//   node scripts/backfill-protest.mjs 2 --resume  # 기존 history.json 에 이어붙임

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 앱이 받는 집계 파일과, 이어받기용 원본을 나눈다.
// 원본까지 앱에 내려보내면 쓰지도 않는 수천 건을 매번 받게 된다.
const OUTPUT_PATH = path.resolve(__dirname, '../protest/history.json')
const RAW_PATH = path.resolve(__dirname, '../protest/history-raw.json')
// 과거 날짜 조회용. 2년치를 한 파일로 내리면 미니앱엔 너무 무겁다.
// 사용자가 고른 달만 받도록 YYYY-MM 단위로 쪼갠다.
const DAYS_DIR = path.resolve(__dirname, '../protest/days')

const BOARD_URL = 'https://www.smpa.go.kr/user/nd54882.do'
const YEARS = Number(process.argv[2]) || 2
const RESUME = process.argv.includes('--resume')

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function todayKST() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
}

async function httpText(url, { retries = 3, timeoutMs = 30000 } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (err) {
      lastErr = err
      if (attempt < retries) await sleep(800 * 2 ** attempt)
    }
  }
  throw lastErr
}

// fetch-protest.mjs 와 같은 표. 두 곳에서 쓰지만 31줄짜리라 공유 모듈을 만들지
// 않았다 — 한쪽만 고치는 일이 없게 값이 바뀌면 둘 다 확인할 것.
const STATION_TO_DISTRICT = {
  중부: '중구', 남대문: '중구', 종로: '종로구', 혜화: '종로구', 용산: '용산구',
  서대문: '서대문구', 서부: '은평구', 은평: '은평구', 마포: '마포구',
  성동: '성동구', 광진: '광진구', 동대문: '동대문구', 중랑: '중랑구',
  성북: '성북구', 종암: '성북구', 강북: '강북구', 도봉: '도봉구', 노원: '노원구',
  양천: '양천구', 강서: '강서구', 구로: '구로구', 금천: '금천구',
  영등포: '영등포구', 동작: '동작구', 관악: '관악구', 서초: '서초구',
  방배: '서초구', 강남: '강남구', 수서: '강남구', 송파: '송파구', 강동: '강동구',
}

/**
 * 관할서는 행진일 때 "종로, 남대문"처럼 여러 개가 온다.
 * 한 지점 집회보다 행진이 통행 영향이 크므로, 지나는 구를 전부 잡아야 한다.
 * 반환은 항상 배열이고, 매핑 실패한 이름은 경고를 남기고 버린다.
 */
function toDistricts(raw) {
  const stations = (raw ?? '')
    .split(/[,·/]/)
    .map((s) => s.replace(/경찰서$/, '').trim())
    .filter(Boolean)
  const out = []
  for (const st of stations) {
    const d = STATION_TO_DISTRICT[st]
    if (!d) {
      console.warn(`⚠ 관할서 매핑 없음: "${st}"`)
      continue
    }
    if (!out.includes(d)) out.push(d)
  }
  return { stations, districts: out }
}

// fetch-protest.mjs 와 같은 기준. 한쪽만 바꾸면 과거·현재 등급이 어긋난다.
function gradeScale(people) {
  if (people == null) return null
  if (people >= 10000) return 'huge'
  if (people >= 3000) return 'large'
  if (people >= 500) return 'medium'
  return 'small'
}

function normalizePlace(text) {
  return text
    .replace(/(\d+)\s*出/g, '$1번 출구')
    .replace(/出/g, '출구')
    .replace(/\s*-+>\s*/g, ' → ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 장소 표기가 해마다 조금씩 흔들린다("광화문광장 앞 인도" / "광화문광장앞 인도").
 * 집계 키는 공백·괄호·조사류를 걷어낸 형태로 만든다. 완벽하진 않지만
 * 같은 장소를 다른 것으로 세는 실수를 크게 줄인다.
 */
export function placeKey(place) {
  return (place ?? '')
    .replace(/[()（）<>《》]/g, ' ')
    .replace(/\s+/g, '')
    .replace(/(앞|일대|인근|부근|맞은편|건너편)$/, '')
}

function parseList(html) {
  const $ = cheerio.load(html)
  const posts = []
  $('a[href*="goBoardView"]').each((_, el) => {
    const href = $(el).attr('href') || ''
    const boardNo = href.match(/'(\d{6,})'\s*\)/)?.[1]
    const title = $(el).text().replace(/\s+/g, ' ').trim()
    if (!boardNo || !title) return
    // 구형 제목은 "오늘의 집회(110214 월)" 꼴이라 괄호를 허용한다
    const ymd = title.match(/(\d{2})(\d{2})(\d{2})/)
    if (!ymd) return
    posts.push({
      date: `20${ymd[1]}-${ymd[2]}-${ymd[3]}`,
      title,
      boardNo,
      url: `${BOARD_URL}?View&boardNo=${boardNo}`,
    })
  })
  return fixTypoYears(posts)
}

/**
 * 원문 제목에 연도 오타가 있다.
 * 실측: 260228 토 / **250227** 금 / **250226** 목 / 260225 수 — 2026년 글에 25를 적었다.
 * 그대로 두면 2025년 2월에 집회가 있었던 것처럼 유령 이력이 생긴다.
 *
 * 주의: 목록은 날짜순이 아니라 **작성순**이다. 뒤늦게 올린 글이 중간에 끼어
 * 날짜가 역행하는 경우가 실제로 있다(page 26: …251228 **251217** 251226…).
 * 그래서 "직전 날짜"를 기준점으로 누적하면 이상치 하나가 뒤를 전부 오염시킨다.
 *
 * 대신 한 페이지 안의 **최빈 연도**를 기준으로 삼는다. 페이지는 대체로 같은
 * 시기의 글로 채워지므로, 연도가 혼자 튀는 글만 후보가 되고 순서가 어긋난
 * 정상 글은 건드리지 않는다.
 */
function fixTypoYears(posts) {
  if (posts.length < 3) return posts

  const years = posts.map((p) => Number(p.date.slice(0, 4)))
  const tally = new Map()
  for (const y of years) tally.set(y, (tally.get(y) ?? 0) + 1)
  const [modalYear, modalCount] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]

  // 연도가 갈리는 페이지(연말·연초 경계)에서는 손대지 않는다
  if (modalCount < posts.length * 0.7) return posts

  // 기준 시점 = 최빈 연도 글들의 가운데 날짜
  const modalDates = posts.filter((p) => Number(p.date.slice(0, 4)) === modalYear).map((p) => p.date).sort()
  const median = modalDates[Math.floor(modalDates.length / 2)]
  const medianMs = Date.parse(`${median}T00:00:00Z`)
  const WINDOW_MS = 45 * 86400000

  for (const post of posts) {
    if (Number(post.date.slice(0, 4)) === modalYear) continue
    const candidate = `${modalYear}${post.date.slice(4)}`
    // 최빈 연도로 바꿨을 때 기준 시점 근처로 들어와야 오타로 인정한다
    if (Math.abs(Date.parse(`${candidate}T00:00:00Z`) - medianMs) <= WINDOW_MS) {
      console.warn(`⚠ 제목 연도 오타 교정: "${post.title}" ${post.date} → ${candidate}`)
      post.date = candidate
    }
  }
  return posts
}

// PDF 표를 항목 배열로. pdftotext -layout 기준.
//   (앞줄) 장소명
//   시간  (행진로)  인원  관할서      ← 앵커 행
//   (뒷줄) <동>
// 관할서 이름은 31개로 고정이다. "끝에 오는 한글"로 추측하지 말고
// 아는 이름과 대조한다 — PDF 열 정렬이 어긋나 장소와 붙는 경우가 많다.
const STATION_NAMES = Object.keys(STATION_TO_DISTRICT).sort((a, b) => b.length - a.length)

/** 줄 끝에서 알려진 관할서를 찾아 [관할서, 관할서를 뗀 나머지] 반환 */
function splitStation(line) {
  if (!line) return [null, line]
  const compact = line.replace(/\s+/g, '')
  for (const name of STATION_NAMES) {
    if (!compact.endsWith(name)) continue
    // 원본에서 해당 부분을 제거 (사이 공백 허용: "서 부")
    const pattern = name.split('').join('\\s*') + '\\s*$'
    return [name, line.replace(new RegExp(pattern), '').replace(/\s+$/, '')]
  }
  return [null, line]
}

/**
 * PDF 표를 항목 배열로. pdftotext -layout 기준.
 *
 * 행이 한 줄로 끝나지 않는다. 장소가 길면 접히고, 그때 관할서가 시간 행이
 * 아니라 장소 행 끝에 놓인다(실측: "서울혁신파크 정문 ⇄ 불광역R  서 부").
 * 그래서 시간 행 하나만 보지 말고 **행 블록 전체**에서 관할서를 찾는다.
 */
function parsePdfText(text) {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''))
  const TIME = /(\d{1,2}:\d{2})\s*[~∼～〜\-–]\s*(\d{1,2}:\d{2})/
  const isDong = (l) => /^\s*[<〈＜].+[>〉＞]\s*$/.test(l)
  const isNoise = (l) => /집회\s*일시|주요집회|기준 작성|신고\s*인원|관할서|^\s*비고/.test(l)
  const clean = (s) => s.replace(/\s+/g, ' ').trim()

  // 시간 행 위치 = 각 항목의 앵커
  const anchors = []
  for (let i = 0; i < lines.length; i++) if (TIME.test(lines[i])) anchors.push(i)

  const items = []
  for (let a = 0; a < anchors.length; a++) {
    const i = anchors[a]
    const prevAnchor = a > 0 ? anchors[a - 1] : -1
    const nextAnchor = a + 1 < anchors.length ? anchors[a + 1] : lines.length

    const t = lines[i].match(TIME)
    const after = lines[i].slice(lines[i].indexOf(t[0]) + t[0].length)

    // 인원 먼저. "300명 용 산"에서 명이 관할서에 섞이지 않게.
    const pM = [...after.matchAll(/([\d,]+)\s*(명)?/g)].filter((m) => m[1]).pop()
    const people = pM ? Number(pM[1].replace(/,/g, '')) : null
    const tailAfterPeople = pM ? after.slice(pM.index + pM[0].length) : after

    // 관할서: 시간 행 꼬리 → 앞쪽 줄들(장소 행) 순으로 찾는다
    let station = splitStation(tailAfterPeople)[0]
    const block = [] // 장소 후보 줄들
    for (let j = prevAnchor + 1; j < i; j++) {
      const raw = lines[j]
      if (!raw.trim() || isDong(raw) || isNoise(raw)) continue
      const [st, rest] = splitStation(raw)
      if (st && !station) station = st
      const body = clean(st ? rest : raw)
      if (body) block.push(body)
    }

    // 동: 앵커 아래 또는 블록 안
    let dong = null
    for (let j = i + 1; j < nextAnchor + 2 && j < lines.length; j++) {
      if (isDong(lines[j])) { dong = clean(lines[j]).replace(/^[<〈＜]|[>〉＞]$/g, ''); break }
      if (lines[j].trim() && !isNoise(lines[j])) break
    }
    if (!dong) {
      for (let j = prevAnchor + 1; j < i; j++) {
        if (isDong(lines[j])) { dong = clean(lines[j]).replace(/^[<〈＜]|[>〉＞]$/g, ''); break }
      }
    }

    // 장소: 행진경로 주석(※)은 부가 정보라 뒤로 뺀다
    const main = block.filter((b) => !/^[※*]/.test(b))
    const note = block.filter((b) => /^[※*]/.test(b))
    let place = main[0] ?? note[0] ?? null

    // 시간 행 안의 괄호 행진로도 장소에 붙인다
    const routeM = tailAfterPeople.match(/[(（]([^)）]+)[)）]/)
    if (routeM && place) place = `${place} (${clean(routeM[1])})`

    if (!place && people == null) continue

    items.push({
      time: `${t[1]}~${t[2]}`,
      startTime: t[1].padStart(5, '0'),
      endTime: t[2].padStart(5, '0'),
      place,
      dong,
      people,
      peopleText: people != null ? `${people.toLocaleString('ko-KR')}명` : null,
      station,
    })
  }
  return items
}

/**
 * 첨부 PDF에서 항목을 뽑는다.
 * 2025-12 이전 글은 본문이 비어 있고 내용이 HWP/PDF/JPG 첨부에만 있다.
 * PDF는 pdftotext -layout 으로 표 구조가 그대로 나온다(2019년 글까지 확인).
 * 2015년 이전 글은 PDF 자체가 없어 HWP만 있고, 그건 다루지 않는다.
 */
async function fetchPdfItems(html) {
  const $ = cheerio.load(html)
  let attachNo = null
  $('a.doc_link').each((_, el) => {
    const name = $(el).text().trim()
    const no = ($(el).attr('onclick') || '').match(/'(\d+)'\s*\)/)?.[1]
    if (no && /\.pdf$/i.test(name)) attachNo = no
  })
  if (!attachNo) return []

  const url = `https://www.smpa.go.kr/common/attachfile/attachfileDownload.do?attachNo=${attachNo}`
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`PDF HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())

  const tmp = path.join(os.tmpdir(), `smpa-${attachNo}.pdf`)
  await fs.writeFile(tmp, buf)
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-layout', tmp, '-'], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    })
    return parsePdfText(stdout)
  } finally {
    await fs.rm(tmp, { force: true })
  }
}

function parseDetail(html) {
  const $ = cheerio.load(html)
  const scope = $('.bcontent').length ? $('.bcontent') : $('body')
  let nodes = scope.find('p')
  if (nodes.length === 0) nodes = scope.find('div, td, li')

  const lines = []
  nodes.each((_, el) => {
    const $el = $(el)
    if ($el.children('p, div, table, ul').length) return
    const t = $el.text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim()
    if (t) lines.push(t)
  })

  const items = []
  let cur = null
  const push = () => {
    if (cur && (cur.time || cur.place)) items.push(cur)
    cur = null
  }

  for (const line of lines) {
    const m = line.match(/^(집회\s*일시|집회\s*장소|신고\s*인원|관할서)\s*[:：]\s*(.*)$/)
    if (!m) continue
    const key = m[1].replace(/\s+/g, '')
    const val = m[2].trim()

    if (key === '집회일시') {
      push()
      cur = {
        time: val || null, startTime: null, endTime: null,
        place: null, dong: null, people: null, peopleText: null,
        districts: [], scale: null,
      }
      const t = val.match(/(\d{1,2}:\d{2})\s*[~\-–]\s*(\d{1,2}:\d{2})/)
      if (t) {
        cur.startTime = t[1].padStart(5, '0')
        cur.endTime = t[2].padStart(5, '0')
      } else {
        const one = val.match(/(\d{1,2}:\d{2})/)
        if (one) cur.startTime = one[1].padStart(5, '0')
      }
      continue
    }
    if (!cur) continue

    if (key === '집회장소') {
      const d = val.match(/[<〈＜]([^>〉＞]+)[>〉＞]\s*$/)
      cur.dong = d ? d[1].trim() : null
      const place = val.replace(/[<〈＜][^>〉＞]+[>〉＞]\s*$/, '').trim() || val
      cur.place = normalizePlace(place)
    } else if (key === '신고인원') {
      cur.peopleText = val || null
      const n = val.replace(/[,\s]/g, '').match(/(\d+)\s*명/)
      cur.people = n ? Number(n[1]) : null
      cur.scale = gradeScale(cur.people)
    } else if (key === '관할서') {
      cur.districts = toDistricts(val).districts
    }
  }
  push()
  return items
}

/**
 * 연 단위 소수(0.5년 등)도 받는다. 문자열로 연도를 빼면 "2025.92-09-07" 같은
 * 깨진 cutoff가 만들어지고, 문자열 비교라 에러 없이 엉뚱한 범위를 긁는다.
 */
function minusYears(isoDate, years) {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - Math.round(years * 12))
  return d.toISOString().slice(0, 10)
}

async function readExistingRaw() {
  try {
    return JSON.parse(await fs.readFile(RAW_PATH, 'utf8'))
  } catch {
    return null
  }
}

async function main() {
  const today = todayKST()
  const cutoff = minusYears(today, YEARS)
  console.log(`백필 대상: ${cutoff} ~ ${today} (${YEARS}년)`)

  const existing = RESUME ? await readExistingRaw() : null
  const seen = new Set(existing?.boardNos ?? [])
  if (existing) console.log(`이어붙이기: 기존 ${seen.size}개 글 건너뜀`)

  // date → items[]
  const byDate = new Map(Object.entries(existing?.days ?? {}))
  const boardNos = new Set(seen)

  let page = 1
  let stop = false
  let fetched = 0
  let failed = 0
  let pdfUsed = 0

  while (!stop && page <= 600) {
    const listHtml = await httpText(`${BOARD_URL}?page=${page}`)
    const posts = parseList(listHtml)
    if (posts.length === 0) {
      console.log(`page ${page}: 글 없음 — 종료`)
      break
    }

    // 페이지의 글이 "전부" 범위 밖일 때만 멈춘다. 오타·고정글 하나가
    // 앞쪽에 끼면 첫 글에서 break 하는 방식은 수집을 통째로 중단시킨다.
    if (posts.every((p) => p.date < cutoff)) {
      stop = true
      break
    }

    for (const post of posts) {
      if (post.date < cutoff) continue
      if (boardNos.has(post.boardNo)) continue

      try {
        const html = await httpText(post.url)
        let items = parseDetail(html)
        if (items.length === 0) {
          // 본문이 빈 옛 글 → 첨부 PDF로 폴백
          items = (await fetchPdfItems(html)).map((it) => {
            const { stations, districts } = toDistricts(it.station ?? '')
            return {
              ...it,
              place: normalizePlace(it.place ?? ''),
              scale: gradeScale(it.people),
              stations,
              districts,
            }
          })
          if (items.length > 0) pdfUsed++
        }
        // 같은 날짜가 재공지되면 항목이 더 많은 쪽을 남긴다
        const prev = byDate.get(post.date)
        if (!prev || items.length > prev.length) byDate.set(post.date, items)
        boardNos.add(post.boardNo)
        fetched++
      } catch (err) {
        failed++
        console.warn(`  ⚠ ${post.date} (${post.boardNo}): ${err.message}`)
      }
      await sleep(500) // 정부 사이트다. 서두르지 않는다.
    }

    console.log(`page ${page} 완료 · 누적 ${fetched}건 · 날짜 ${byDate.size}개 · PDF폴백 ${pdfUsed}건`)
    // 페이지마다 저장한다. 중단되어도 --resume 으로 여기서 이어받는다.
    await save(byDate, boardNos, today, cutoff, failed)
    page++
  }

  await save(byDate, boardNos, today, cutoff, failed)

  console.log(`\n✅ 완료`)
}

// ── 장소별 집계 + 저장 ────────────────────────────────────────────────────
// 페이지마다 호출된다. 1시간짜리 작업이라 중간에 죽어도 지금까지 받은 건
// 남아야 하고, --resume 이 이어받을 수 있어야 한다.
async function save(byDate, boardNos, today, cutoff, failed) {
  const places = new Map() // placeKey → 집계
  for (const [date, items] of byDate) {
    for (const it of items) {
      const key = placeKey(it.place)
      let agg = places.get(key)
      if (!agg) {
        agg = {
          key,
          place: it.place,
          districts: new Set(),
          dates: [],
          people: [],
          weekdays: [0, 0, 0, 0, 0, 0, 0],
        }
        places.set(key, agg)
      }
      // 행진은 여러 구를 지난다. 지나는 구를 전부 모아둔다.
      for (const d of it.districts ?? []) agg.districts.add(d)
      agg.dates.push(date)
      agg.people.push(it.people)
      agg.weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()]++
    }
  }

  const placeList = [...places.values()]
    .map((a) => {
      const dates = [...new Set(a.dates)].sort()
      return {
        key: a.key,
        place: a.place,
        districts: [...a.districts],
        count: a.dates.length,
        days: dates.length,
        first: dates[0],
        last: dates[dates.length - 1],
        // 최근 10회만 남긴다. 전부 실으면 파일이 감당이 안 된다.
        recent: dates.slice(-10),
        weekdays: a.weekdays,
        peopleAvg: Math.round(
          a.people.filter((p) => p != null).reduce((s, p) => s + p, 0) /
            Math.max(1, a.people.filter((p) => p != null).length),
        ),
        peopleMax: Math.max(0, ...a.people.filter((p) => p != null)),
      }
    })
    .sort((x, y) => y.count - x.count)

  const out = {
    generatedAt: today,
    range: { from: cutoff, to: today },
    note:
      '원문에 주최·목적이 없어 "같은 집회"를 식별할 수 없다. 모든 집계는 장소 기준이다.',
    postCount: boardNos.size,
    dateCount: byDate.size,
    itemCount: [...byDate.values()].reduce((n, v) => n + v.length, 0),
    places: placeList,
  }

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8')

  // 월별 파일 — 앱이 과거 날짜를 볼 때 이 달치만 받는다
  await fs.mkdir(DAYS_DIR, { recursive: true })
  const byMonth = new Map()
  for (const [date, items] of byDate) {
    const m = date.slice(0, 7)
    if (!byMonth.has(m)) byMonth.set(m, {})
    byMonth.get(m)[date] = items
  }
  const months = [...byMonth.keys()].sort()
  for (const [m, days] of byMonth) {
    await fs.writeFile(
      path.join(DAYS_DIR, `${m}.json`),
      JSON.stringify({ month: m, days }) + '\n',
      'utf8',
    )
  }
  await fs.writeFile(
    path.join(DAYS_DIR, 'index.json'),
    JSON.stringify({ generatedAt: today, months }, null, 2) + '\n',
    'utf8',
  )

  // 이어받기용 원본. boardNos 와 날짜별 원자료를 그대로 들고 있어야
  // --resume 이 이미 받은 글을 건너뛸 수 있다.
  await fs.writeFile(
    RAW_PATH,
    JSON.stringify({ generatedAt: today, boardNos: [...boardNos], days: Object.fromEntries(byDate) }) + '\n',
    'utf8',
  )

  console.log(
    `   저장: 글 ${out.postCount}개 · 날짜 ${out.dateCount}일 · 집회 ${out.itemCount}건 · 장소 ${placeList.length}곳 (실패 ${failed}건)`,
  )
  return placeList
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
