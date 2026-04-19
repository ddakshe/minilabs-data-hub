// 전국 아울렛 이벤트·핫브랜드 스크래퍼 (Playwright)
//
// Usage:
//   node scripts/fetch-outlets.mjs              # 전체 실행
//   node scripts/fetch-outlets.mjs hyundai      # 현대만
//   node scripts/fetch-outlets.mjs shinsegae    # 신세계만
//
// 현대(ehyundai.com), 신세계(premiumoutlets.co.kr)는 지점별 개별 스크래핑.
// 롯데·마리오는 체인 공통 이벤트 페이지 스크래핑.
// 정적 메타(아울렛명·주소 등)는 건드리지 않고 events/hotBrands/updatedAt만 덮어씀.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../outlets/outlets.json')

const TARGET_CHAIN = process.argv[2] || null

// ───────────────────────── 날짜 헬퍼 ─────────────────────────

function todayKST() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
}

function daysLeft(endDateStr) {
  if (!endDateStr) return null
  const today = new Date(todayKST())
  const end = new Date(endDateStr)
  const diff = Math.ceil((end - today) / 86_400_000)
  return diff >= 0 ? diff : -1
}

function parseKoreanDate(str) {
  if (!str) return null
  const s = str.trim()
  const m1 = s.match(/(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/)
  if (m1) return `${m1[1]}-${m1[2].padStart(2, '0')}-${m1[3].padStart(2, '0')}`
  const m2 = s.match(/(\d{1,2})[.\-\/](\d{1,2})/)
  if (m2) {
    const year = todayKST().slice(0, 4)
    return `${year}-${m2[1].padStart(2, '0')}-${m2[2].padStart(2, '0')}`
  }
  return null
}

// 이벤트 제목 → type 추론
function inferType(title = '') {
  if (/팝업|pop.?up/i.test(title)) return 'popup'
  if (/전시|갤러리|아트|art|exhibition/i.test(title)) return 'exhibition'
  if (/추가.?할인|extra|쿠폰|포인트/i.test(title)) return 'discount'
  if (/세일|sale|기획전|특가|시즌|할인|promotion|festa|week/i.test(title)) return 'sale'
  return 'etc'
}

// ───────────────────────── 현대 지점별 스크래퍼 ─────────────────────────
// https://www.ehyundai.com/newPortal/SN/SN_0101000.do?branchCd=B00172000

async function scrapeHyundaiBranch(page, branchCd) {
  const url = `https://www.ehyundai.com/newPortal/SN/SN_0101000.do?branchCd=${branchCd}`
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(1500)

  // 이벤트는 goDetail JS 호출을 href로 가진 <a> 태그로 렌더링됨
  const items = await page.evaluate(() => {
    const anchors = document.querySelectorAll('a[href*="goDetail"]')
    const seen = new Set()
    const out = []

    for (const a of anchors) {
      const raw = a.innerText?.trim()
      if (!raw || raw.length < 3) continue

      // "제목\n기간\n날짜범위\n장소\n위치" 형태 파싱
      const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
      const periodIdx = lines.indexOf('기간')
      const placeIdx = lines.indexOf('장소')

      const titleLines = lines.slice(0, periodIdx >= 0 ? periodIdx : (placeIdx >= 0 ? placeIdx : lines.length))
      const title = titleLines.join(' ').replace(/\s+/g, ' ').trim()
      const period = periodIdx >= 0 ? (lines[periodIdx + 1] || '') : ''

      if (!title || title.length < 2) continue
      if (seen.has(title)) continue
      seen.add(title)

      // href에서 eventId 추출: goDetail('branchCd', 'eventId', ...)
      const match = a.href?.match(/goDetail\(['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/)
      const eventId = match?.[2] || ''
      const eventType = a.href?.match(/,\s*['"](\w+)['"]\s*\)/)?.[1] || 'event'

      out.push({ title, period, eventId, eventType })
      if (out.length >= 10) break
    }
    return out
  })

  const results = []
  for (const { title, period, eventId, eventType } of items) {
    const [startRaw, endRaw] = period.split(/~|–/)
    const startDate = parseKoreanDate(startRaw?.trim()) || todayKST()
    const endDate = parseKoreanDate(endRaw?.trim())
    const dl = daysLeft(endDate)
    if (dl !== null && dl < 0) continue

    const url = eventId
      ? `https://www.ehyundai.com/mobile/SN/SN_0201000.do?category=${eventType}&branchCd=${branchCd}&evntCrdCd=${eventId}`
      : undefined

    results.push({ type: inferType(title), title, startDate, endDate, daysLeft: dl, ...(url ? { url } : {}) })
  }

  return results
}

// ───────────────────────── 신세계 지점별 스크래퍼 ─────────────────────────
// https://www.premiumoutlets.co.kr/rpage/shopping-info/news/01#special (쇼핑뉴스 탭)

async function scrapeShinsegaeBranch(page, storeCode) {
  const url = `https://www.premiumoutlets.co.kr/rpage/shopping-info/news/${storeCode}`
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(1500)

  // 쇼핑뉴스 탭 클릭 (hash가 #special로 바뀜)
  try {
    const tab = page.locator('li').filter({ hasText: /^쇼핑뉴스$/ }).first()
    if (await tab.count() > 0) {
      await tab.click()
      await page.waitForTimeout(800)
    }
  } catch { /* 탭 없으면 현재 탭 그대로 */ }

  const items = await page.evaluate(() => {
    const BASE = 'https://www.premiumoutlets.co.kr'
    const cards = document.querySelectorAll('.list-item')
    const out = []
    for (const card of cards) {
      const titleEl = card.querySelector('p, strong, [class*="tit"], [class*="title"]')
      const dateEl = card.querySelector('span, [class*="date"], [class*="period"]')
      if (!titleEl) continue
      const title = titleEl.innerText?.trim()
      const period = dateEl?.innerText?.trim() || ''
      const href = card.querySelector('a[href]')?.getAttribute('href') || ''
      const url = href && href.startsWith('/') ? BASE + href : (href || null)
      if (title && title.length > 3) out.push({ title, period, url })
      if (out.length >= 10) break
    }
    return out
  })

  return items.map(({ title, period, url }) => {
    const [startRaw, endRaw] = period.split(/~|–/)
    const startDate = parseKoreanDate(startRaw?.trim()) || todayKST()
    const endDate = parseKoreanDate(endRaw?.trim())
    const dl = daysLeft(endDate)
    if (dl !== null && dl < 0) return null
    return { type: inferType(title), title, startDate, endDate, daysLeft: dl, ...(url ? { url } : {}) }
  }).filter(Boolean)
}

// ───────────────────────── 롯데 지점별 스크래퍼 ─────────────────────────
// https://www.lotteshopping.com/shopnow/cntsList?cstrCd=0352

async function scrapeLotteBranch(page, cstrCd) {
  const url = `https://www.lotteshopping.com/shopnow/cntsList?cstrCd=${cstrCd}`
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(2000)

  const BASE = 'https://www.lotteshopping.com'
  const items = await page.evaluate((base) => {
    const BADGES = new Set(['쇼핑뉴스', '사은', '문화/이벤트', '문화', '이벤트'])
    const seen = new Set()
    const out = []

    for (const li of document.querySelectorAll('li.content-item')) {
      const lines = (li.innerText || '').split('\n').map(l => l.trim()).filter(Boolean)
      if (lines.length < 2) continue

      // 첫 줄이 배지면 제거
      const start = BADGES.has(lines[0]) ? 1 : 0
      const title = lines[start] || ''
      if (!title || title.length < 2 || seen.has(title)) continue
      seen.add(title)

      // "4.17(금) ~ 4.19(일)" 패턴 날짜 찾기
      const period = lines.find(l => /\d+[./]\d+/.test(l) && /~|–/.test(l)) || ''

      const a = li.querySelector('a[href]')
      const href = a?.getAttribute('href') || ''
      const url = href && !href.startsWith('javascript') ? base + href : null

      out.push({ title, period, url })
      if (out.length >= 10) break
    }
    return out
  }, BASE)

  return items.map(({ title, period, url }) => {
    const [startRaw, endRaw] = period.split(/~|–/)
    const startDate = parseKoreanDate(startRaw?.trim()) || todayKST()
    const endDate = parseKoreanDate(endRaw?.trim())
    const dl = daysLeft(endDate)
    if (dl !== null && dl < 0) return null
    return { type: inferType(title), title, startDate, endDate, daysLeft: dl, ...(url ? { url } : {}) }
  }).filter(Boolean)
}

// ───────────────────────── 마리오 스크래퍼 ─────────────────────────
// http://www.mariooutlet.co.kr/Event/Shopping

async function scrapeMario(page) {
  await page.goto('http://www.mariooutlet.co.kr/Event/Shopping', { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForSelector('ul.saleInfo', { timeout: 10000 })

  const items = await page.evaluate(() => {
    const BASE = 'http://www.mariooutlet.co.kr'
    const seen = new Set()
    const results = []
    const cards = document.querySelectorAll('ul.saleInfo li')
    for (const li of cards) {
      const titleEl = li.querySelector('strong')
      const dateEl = li.querySelector('span')
      if (!titleEl) continue
      const title = titleEl.innerText?.trim()
      if (!title || seen.has(title)) continue
      seen.add(title)
      const period = dateEl?.innerText?.trim() || ''
      const href = li.querySelector('a')?.getAttribute('href') || ''
      const url = href ? BASE + href : null
      results.push({ title, period, url })
      if (results.length >= 10) break
    }
    return results
  })

  return items.map(({ title, period, url }) => {
    const [startRaw, endRaw] = period.split('~')
    const startDate = parseKoreanDate(startRaw?.trim()) || todayKST()
    const endDate = parseKoreanDate(endRaw?.trim())
    const dl = daysLeft(endDate)
    if (dl !== null && dl < 0) return null
    return { type: inferType(title), title, startDate, endDate, daysLeft: dl, url }
  }).filter(Boolean)
}

// ───────────────────────── 메인 ─────────────────────────

async function main() {
  const outlets = JSON.parse(await fs.readFile(OUTPUT_PATH, 'utf-8'))
  const outletMap = Object.fromEntries(outlets.map(o => [o.id, o]))

  const browser = await chromium.launch({ headless: true })
  const today = todayKST()
  let anyUpdated = false

  const shouldRun = (chain) => !TARGET_CHAIN || TARGET_CHAIN === chain

  try {
    // ── 현대: 지점별 개별 스크래핑 ──
    if (shouldRun('hyundai')) {
      console.log('\n▶ 현대 지점별 스크래핑 시작...')
      const hyundaiOutlets = outlets.filter(o => o.chain === 'hyundai' && o.branchCd)
      const page = await browser.newPage()
      for (const outlet of hyundaiOutlets) {
        try {
          console.log(`  ${outlet.name} (${outlet.branchCd})...`)
          const events = await scrapeHyundaiBranch(page, outlet.branchCd)
          console.log(`    → 이벤트 ${events.length}건`)
          outletMap[outlet.id].events = events
          outletMap[outlet.id].updatedAt = today
          anyUpdated = true
        } catch (err) {
          console.error(`    ✗ ${outlet.name} 실패:`, err.message)
        }
      }
      await page.close()
    }

    // ── 신세계: 지점별 개별 스크래핑 ──
    if (shouldRun('shinsegae')) {
      console.log('\n▶ 신세계 지점별 스크래핑 시작...')
      const ssOutlets = outlets.filter(o => o.chain === 'shinsegae' && o.storeCode)
      const page = await browser.newPage()
      for (const outlet of ssOutlets) {
        try {
          console.log(`  ${outlet.name} (${outlet.storeCode})...`)
          const events = await scrapeShinsegaeBranch(page, outlet.storeCode)
          console.log(`    → 이벤트 ${events.length}건`)
          outletMap[outlet.id].events = events
          outletMap[outlet.id].updatedAt = today
          anyUpdated = true
        } catch (err) {
          console.error(`    ✗ ${outlet.name} 실패:`, err.message)
        }
      }
      await page.close()
    }

    // ── 롯데: 지점별 개별 스크래핑 ──
    if (shouldRun('lotte')) {
      console.log('\n▶ 롯데 지점별 스크래핑 시작...')
      const lotteOutlets = outlets.filter(o => o.chain === 'lotte' && o.cstrCd)
      const page = await browser.newPage()
      for (const outlet of lotteOutlets) {
        try {
          console.log(`  ${outlet.name} (${outlet.cstrCd})...`)
          const events = await scrapeLotteBranch(page, outlet.cstrCd)
          console.log(`    → 이벤트 ${events.length}건`)
          outletMap[outlet.id].events = events
          outletMap[outlet.id].updatedAt = today
          anyUpdated = true
        } catch (err) {
          console.error(`    ✗ ${outlet.name} 실패:`, err.message)
        }
      }
      await page.close()
    }

    // ── 마리오: 단일 지점 ──
    if (shouldRun('mario')) {
      console.log('\n▶ 마리오 스크래핑 시작...')
      const page = await browser.newPage()
      try {
        const events = await scrapeMario(page)
        console.log(`  이벤트 ${events.length}건`)
        outletMap['mario'].events = events
        outletMap['mario'].updatedAt = today
        anyUpdated = true
      } catch (err) {
        console.error('  ✗ 마리오 실패:', err.message)
      }
      await page.close()
    }

  } finally {
    await browser.close()
  }

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
