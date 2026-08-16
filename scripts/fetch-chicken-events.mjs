// 치킨 프랜차이즈 진행 중 이벤트 스크래퍼 — chicken-event-mini 앱용.
// 출력: chicken-events/events.json
//
// 설계: 브랜드별 "어댑터" 레지스트리. 사이트 구조가 제각각이라 브랜드마다 파서를 둔다.
//   - 어댑터 있는 브랜드 → 이벤트 자동 수집(source:auto)
//   - 어댑터 없는 브랜드 → events:[] 링크전용 폴백 (앱 하단 "바로가기" 카드)
//   - JS렌더링(BBQ·굽네 등)·403(BHC)은 추후 Playwright 어댑터 or 로컬 전용으로 확장
//
// Usage:
//   node scripts/fetch-chicken-events.mjs            # 전체 어댑터 실행
//   node scripts/fetch-chicken-events.mjs cheogajip  # 특정 브랜드만(나머지 기존 데이터 유지)
//
// 사이트 구조가 바뀌면 해당 브랜드 어댑터만 깨진다. 깨진 어댑터는 자동으로 링크전용 폴백 처리.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../chicken-events/events.json')

const ONLY = process.argv[2]
  ? new Set(process.argv[2].split(',').map((s) => s.trim()).filter(Boolean))
  : null

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
      if (attempt < retries) await sleep(500 * 2 ** attempt)
    }
  }
  throw lastErr
}

// "2026-06-12 ~ 2026-07-05" / "2026.06.12~2026.07.05" → { startDate, endDate }
function parseRange(text) {
  const dates = (text.match(/\d{4}[.\-]\d{1,2}[.\-]\d{1,2}/g) || []).map((d) =>
    d.replace(/\./g, '-').replace(/-(\d)(?=-|$)/g, '-0$1'),
  )
  if (dates.length === 0) return null
  return { startDate: dates[0], endDate: dates[1] || dates[0] }
}

// 제목에서 배달앱/채널 플랫폼 추출
const PLATFORM_RULES = [
  [/배달의?민족|배민/i, '배민'],
  [/요기요/i, '요기요'],
  [/쿠팡이?츠/i, '쿠팡이츠'],
  [/배달특급/i, '배달특급'],
  [/배달이음/i, '배달이음'],
  [/땡겨요/i, '땡겨요'],
  [/포장/i, '포장'],
]
function detectPlatforms(title) {
  const out = []
  for (const [re, label] of PLATFORM_RULES) if (re.test(title)) out.push(label)
  return [...new Set(out)]
}

// 진행 중(마감일이 오늘 이후)만 남긴다.
function activeOnly(events) {
  const today = todayKST()
  return events.filter((e) => e.endDate >= today)
}

// ───────────────────────── 브랜드 어댑터 ─────────────────────────
// 각 어댑터: () => Promise<event[]>  (event = {title,startDate,endDate,summary,platforms,source})

// 처갓집양념치킨 — 그누보드 갤러리 스킨. li.gall_text_href=제목, p.gall_moreview=기간 범위.
async function cheogajip() {
  const url = 'https://www.cheogajip.co.kr/bbs/board.php?bo_table=event'
  const $ = cheerio.load(await httpText(url))
  const events = []
  $('li.gall_li').each((_, el) => {
    const title = $(el).find('li.gall_text_href a').first().text().trim()
    const range = parseRange($(el).find('p.gall_moreview').text())
    if (!title || !range) return
    events.push({
      title,
      startDate: range.startDate,
      endDate: range.endDate,
      summary: '',
      platforms: detectPlatforms(title),
      source: 'auto',
    })
  })
  return events
}

// 교촌치킨 — ASP. li 안에 span.progress(진행/종료), dl>dt>a(제목), dl>dd(이벤트기간).
// 사이트가 "진행"으로 표시한 항목만 수집한다.
async function kyochon() {
  const url = 'https://www.kyochon.com/event/ing.asp'
  const $ = cheerio.load(await httpText(url))
  const events = []
  $('li').each((_, el) => {
    const status = $(el).find('span.progress').first().text().trim()
    if (!status.includes('진행')) return
    const a = $(el).find('dl dt a').first()
    const title = a.text().trim()
    const range = parseRange($(el).find('dl dd').text())
    if (!title || !range) return
    events.push({
      title,
      startDate: range.startDate,
      endDate: range.endDate,
      summary: '',
      platforms: detectPlatforms(title),
      source: 'auto',
    })
  })
  return events
}

// 어댑터 레지스트리: id → fn. 여기 추가하면 자동 수집 대상이 된다.
const ADAPTERS = {
  cheogajip,
  kyochon,
}

// ───────────────────────── 브랜드 메타 ─────────────────────────
// 모든 브랜드는 여기 등록. 어댑터 없는 브랜드는 events:[] 링크전용으로 출력된다.
const BRANDS = [
  { id: 'cheogajip', name: '처갓집양념치킨', stores: 1233, eventUrl: 'https://www.cheogajip.co.kr/bbs/board.php?bo_table=event' },
  { id: 'kyochon', name: '교촌치킨', stores: 1377, eventUrl: 'https://www.kyochon.com/event/ing.asp' },
  { id: 'puradak', name: '푸라닭치킨', stores: 714, eventUrl: 'https://www.puradakchicken.com/news/event.asp' },
  { id: '60chicken', name: '60계치킨', stores: 661, eventUrl: 'https://60chicken.co.kr/bbs/board.php?bo_table=event02' },
  { id: 'norangtongdak', name: '노랑통닭', stores: 650, eventUrl: 'https://www.norangtongdak.co.kr/community/event_list.html' },
  { id: 'nuguna', name: '누구나홀딱반한닭', stores: 243, eventUrl: 'https://www.nuguna-banhandak.co.kr/board/event' },
  // 자동수집 불가(추후 Playwright/로컬 확장) — 링크전용
  { id: 'bhc', name: 'BHC', stores: 2291, eventUrl: 'https://www.bhc.co.kr/event/currentEvent' },
  { id: 'bbq', name: 'BBQ치킨', stores: 2238, eventUrl: 'https://bbq.co.kr/events' },
]

async function readExisting() {
  try {
    return JSON.parse(await fs.readFile(OUTPUT_PATH, 'utf8'))
  } catch {
    return { brands: [] }
  }
}

async function main() {
  const existing = await readExisting()
  const prevById = new Map(existing.brands.map((b) => [b.id, b]))

  const brands = []
  for (const meta of BRANDS) {
    const run = !ONLY || ONLY.has(meta.id)
    const adapter = ADAPTERS[meta.id]

    let events = []
    if (adapter && run) {
      try {
        events = activeOnly(await adapter())
        console.log(`✓ ${meta.id}: ${events.length}건`)
      } catch (err) {
        // 어댑터 실패 → 직전 데이터 유지(있으면), 없으면 링크전용
        const prev = prevById.get(meta.id)
        events = prev ? activeOnly(prev.events || []) : []
        console.warn(`⚠ ${meta.id}: 파싱 실패(${err.message}) → ${events.length}건 유지`)
      }
    } else if (adapter && !run) {
      // 이번 실행 대상 아님 → 기존 데이터 유지
      const prev = prevById.get(meta.id)
      events = prev ? activeOnly(prev.events || []) : []
    } // 어댑터 없으면 events:[] (링크전용)

    brands.push({ ...meta, events })
  }

  const out = { updatedAt: todayKST(), brands }
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8')

  const total = brands.reduce((n, b) => n + b.events.length, 0)
  console.log(`\n✅ ${OUTPUT_PATH}\n   브랜드 ${brands.length}개 · 진행 중 이벤트 ${total}건 · ${out.updatedAt}`)
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
