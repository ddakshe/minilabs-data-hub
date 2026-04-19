// 전국 아울렛 이벤트·핫브랜드 스크래퍼 (Playwright)
//
// Usage:
//   node scripts/fetch-outlets.mjs          # 전체 체인 실행
//   node scripts/fetch-outlets.mjs lotte    # 특정 체인만
//
// 각 체인의 이벤트 페이지를 매일 긁어서 outlets/outlets.json 갱신.
// 정적 메타(아울렛명·주소·지도링크)는 건드리지 않고 events/hotBrands/updatedAt만 덮어씀.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../outlets/outlets.json')

const TARGET_CHAIN = process.argv[2] || null // 'lotte' | 'shinsegae' | 'hyundai' | 'mario' | 'nc' | null

// ───────────────────────── 날짜 헬퍼 ─────────────────────────

function todayKST() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
}

function daysLeft(endDateStr) {
  if (!endDateStr) return null
  const today = new Date(todayKST())
  const end = new Date(endDateStr)
  const diff = Math.ceil((end - today) / (1000 * 60 * 60 * 24))
  return diff >= 0 ? diff : -1 // -1 = 종료됨
}

// 한국어 날짜 문자열 → YYYY-MM-DD
// "2026.04.30", "2026-04-30", "04/30" 등 여러 형식 지원
function parseKoreanDate(str) {
  if (!str) return null
  const s = str.trim()
  // YYYY.MM.DD or YYYY-MM-DD
  const m1 = s.match(/(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/)
  if (m1) return `${m1[1]}-${m1[2].padStart(2, '0')}-${m1[3].padStart(2, '0')}`
  // MM.DD → 올해 기준
  const m2 = s.match(/(\d{1,2})[.\-\/](\d{1,2})/)
  if (m2) {
    const year = todayKST().slice(0, 4)
    return `${year}-${m2[1].padStart(2, '0')}-${m2[2].padStart(2, '0')}`
  }
  return null
}

// ───────────────────────── 체인별 스크래퍼 ─────────────────────────

// 롯데아울렛 — lotteshopping.com/outlet 이벤트 목록
async function scrapeLotte(page) {
  await page.goto('https://www.lotteshopping.com/outlet', {
    waitUntil: 'networkidle',
    timeout: 30000,
  })

  // 이벤트/기획전 섹션 탐색
  await page.waitForSelector('body', { timeout: 10000 })

  const events = await page.evaluate(() => {
    const results = []
    // 이벤트 카드 공통 패턴: 제목, 기간 텍스트 포함 요소 찾기
    const cards = document.querySelectorAll(
      '[class*="event"], [class*="promotion"], [class*="banner"], [class*="sale"]',
    )
    for (const card of cards) {
      const titleEl = card.querySelector('strong, h2, h3, [class*="title"], [class*="tit"]')
      const periodEl = card.querySelector(
        '[class*="period"], [class*="date"], [class*="term"], time',
      )
      if (!titleEl) continue
      const title = titleEl.innerText?.trim()
      const period = periodEl?.innerText?.trim() || ''
      if (title && title.length > 2) results.push({ title, period })
      if (results.length >= 10) break
    }
    return results
  })

  const today = todayKST()
  return events.map(({ title, period }) => {
    // "2026.04.01 ~ 2026.04.30" 형식 파싱
    const [startRaw, endRaw] = period.split(/~|–|-(?=\s*\d)/)
    const startDate = parseKoreanDate(startRaw?.trim()) || today
    const endDate = parseKoreanDate(endRaw?.trim())
    return {
      title,
      startDate,
      endDate,
      daysLeft: daysLeft(endDate),
    }
  }).filter(e => e.daysLeft === null || e.daysLeft >= 0)
}

// 신세계아울렛 — shinsegaeoutlet.com 이벤트
async function scrapeShinsegae(page) {
  await page.goto('https://www.shinsegaeoutlet.com/event/ongoing', {
    waitUntil: 'networkidle',
    timeout: 30000,
  })
  await page.waitForSelector('body', { timeout: 10000 })

  const events = await page.evaluate(() => {
    const results = []
    const cards = document.querySelectorAll(
      'li[class*="event"], article[class*="event"], [class*="eventItem"], [class*="event-item"]',
    )
    for (const card of cards) {
      const titleEl = card.querySelector('[class*="title"], [class*="tit"], strong, h2, h3')
      const dateEl = card.querySelector('[class*="date"], [class*="period"], time')
      if (!titleEl) continue
      const title = titleEl.innerText?.trim()
      const period = dateEl?.innerText?.trim() || ''
      if (title && title.length > 2) results.push({ title, period })
      if (results.length >= 10) break
    }
    return results
  })

  const today = todayKST()
  return events.map(({ title, period }) => {
    const [startRaw, endRaw] = period.split(/~|–/)
    const startDate = parseKoreanDate(startRaw?.trim()) || today
    const endDate = parseKoreanDate(endRaw?.trim())
    return { title, startDate, endDate, daysLeft: daysLeft(endDate) }
  }).filter(e => e.daysLeft === null || e.daysLeft >= 0)
}

// 현대아울렛 — thehyundai.com/outlet 이벤트
async function scrapeHyundai(page) {
  await page.goto('https://www.thehyundai.com/front/hout/eventList.do', {
    waitUntil: 'networkidle',
    timeout: 30000,
  })
  await page.waitForSelector('body', { timeout: 10000 })

  const events = await page.evaluate(() => {
    const results = []
    const cards = document.querySelectorAll(
      '[class*="event_list"] li, [class*="eventList"] li, [class*="event-item"]',
    )
    for (const card of cards) {
      const titleEl = card.querySelector('[class*="tit"], [class*="title"], strong, p')
      const dateEl = card.querySelector('[class*="date"], [class*="period"], span')
      if (!titleEl) continue
      const title = titleEl.innerText?.trim()
      const period = dateEl?.innerText?.trim() || ''
      if (title && title.length > 2) results.push({ title, period })
      if (results.length >= 10) break
    }
    return results
  })

  const today = todayKST()
  return events.map(({ title, period }) => {
    const [startRaw, endRaw] = period.split(/~|–/)
    const startDate = parseKoreanDate(startRaw?.trim()) || today
    const endDate = parseKoreanDate(endRaw?.trim())
    return { title, startDate, endDate, daysLeft: daysLeft(endDate) }
  }).filter(e => e.daysLeft === null || e.daysLeft >= 0)
}

// 마리오아울렛 — marioroutlet.com 이벤트
async function scrapeMario(page) {
  await page.goto('https://www.marioroutlet.com/event/list', {
    waitUntil: 'networkidle',
    timeout: 30000,
  })
  await page.waitForSelector('body', { timeout: 10000 })

  const events = await page.evaluate(() => {
    const results = []
    const cards = document.querySelectorAll('li, article, [class*="event"]')
    for (const card of cards) {
      const titleEl = card.querySelector('[class*="tit"], strong, h3')
      const dateEl = card.querySelector('[class*="date"], [class*="period"], span')
      if (!titleEl) continue
      const title = titleEl.innerText?.trim()
      const period = dateEl?.innerText?.trim() || ''
      if (title && title.length > 3 && /세일|이벤트|할인|기획/.test(title + period))
        results.push({ title, period })
      if (results.length >= 8) break
    }
    return results
  })

  const today = todayKST()
  return events.map(({ title, period }) => {
    const [startRaw, endRaw] = period.split(/~|–/)
    const startDate = parseKoreanDate(startRaw?.trim()) || today
    const endDate = parseKoreanDate(endRaw?.trim())
    return { title, startDate, endDate, daysLeft: daysLeft(endDate) }
  }).filter(e => e.daysLeft === null || e.daysLeft >= 0)
}

// ───────────────────────── 핫브랜드 추출 공통 로직 ─────────────────────────
// 각 사이트의 "브랜드관" 또는 "주요 브랜드" 섹션에서 브랜드명 수집

async function scrapeHotBrands(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
    const brands = await page.evaluate(() => {
      const brandEls = document.querySelectorAll(
        '[class*="brand"] a, [class*="brand"] li, [class*="Brand"] a',
      )
      const names = new Set()
      for (const el of brandEls) {
        const name = el.innerText?.trim().replace(/\s+/g, ' ')
        if (name && name.length >= 2 && name.length <= 30 && !/[<>]/.test(name)) {
          names.add(name)
        }
        if (names.size >= 20) break
      }
      return [...names]
    })
    return brands
  } catch {
    return []
  }
}

// ───────────────────────── 체인 설정 ─────────────────────────

const CHAINS = {
  lotte: {
    scrapeEvents: scrapeLotte,
    brandUrl: 'https://www.lotteshopping.com/outlet/brand',
    outletIds: ['lotte-seoul-station', 'lotte-gimpo', 'lotte-gwangmyeong', 'lotte-icheon', 'lotte-dongbusan'],
  },
  shinsegae: {
    scrapeEvents: scrapeShinsegae,
    brandUrl: 'https://www.shinsegaeoutlet.com/brand',
    outletIds: ['shinsegae-yeoju', 'shinsegae-siheung', 'shinsegae-paju', 'shinsegae-busan-centum'],
  },
  hyundai: {
    scrapeEvents: scrapeHyundai,
    brandUrl: 'https://www.thehyundai.com/front/hout/brandList.do',
    outletIds: ['hyundai-gimpo', 'hyundai-spaceone', 'hyundai-dongdaemun'],
  },
  mario: {
    scrapeEvents: scrapeMario,
    brandUrl: 'https://www.marioroutlet.com/brand',
    outletIds: ['mario'],
  },
  nc: {
    scrapeEvents: null, // NC는 Playwright 대신 별도 처리 (봇 차단 강함)
    brandUrl: null,
    outletIds: ['nc-gangnam'],
  },
}

// ───────────────────────── 메인 ─────────────────────────

async function main() {
  const outlets = JSON.parse(await fs.readFile(OUTPUT_PATH, 'utf-8'))
  const outletMap = Object.fromEntries(outlets.map(o => [o.id, o]))

  const browser = await chromium.launch({ headless: true })
  const today = todayKST()
  let anyUpdated = false

  const chainsToRun = TARGET_CHAIN
    ? { [TARGET_CHAIN]: CHAINS[TARGET_CHAIN] }
    : CHAINS

  for (const [chainName, config] of Object.entries(chainsToRun)) {
    if (!config.scrapeEvents) {
      console.log(`⚠ ${chainName}: 스크래퍼 미구현, 스킵`)
      continue
    }

    console.log(`\n▶ ${chainName} 스크래핑 시작...`)
    const page = await browser.newPage()
    page.setDefaultTimeout(30000)

    try {
      // 이벤트 수집 (체인 단위 — 지점 공통)
      const events = await config.scrapeEvents(page)
      console.log(`  이벤트 ${events.length}건 수집`)

      // 핫브랜드 수집
      const hotBrands = config.brandUrl
        ? await scrapeHotBrands(page, config.brandUrl)
        : []
      console.log(`  브랜드 ${hotBrands.length}건 수집`)

      // 해당 체인 모든 지점에 동일하게 적용
      for (const id of config.outletIds) {
        if (!outletMap[id]) continue
        outletMap[id].events = events
        outletMap[id].hotBrands = hotBrands
        outletMap[id].updatedAt = today
        anyUpdated = true
      }
    } catch (err) {
      console.error(`  ✗ ${chainName} 실패:`, err.message)
    } finally {
      await page.close()
    }
  }

  await browser.close()

  if (anyUpdated) {
    const result = outlets.map(o => outletMap[o.id] ?? o)
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(result, null, 2), 'utf-8')
    console.log(`\n✓ outlets.json 저장 완료 (${today})`)
  } else {
    console.log('\n변경사항 없음')
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
