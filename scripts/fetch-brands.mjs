// 아울렛별 입점 브랜드 스크래퍼 (Playwright)
//
// Usage:
//   node scripts/fetch-brands.mjs              # 전체
//   node scripts/fetch-brands.mjs hyundai      # 현대만
//   node scripts/fetch-brands.mjs shinsegae    # 신세계만
//   node scripts/fetch-brands.mjs lotte        # 롯데만
//
// events/updatedAt 등 나머지 필드는 건드리지 않고 hotBrands만 갱신.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../outlets/outlets.json')
const TARGET_CHAIN = process.argv[2] || null

const MAX_BRANDS = 20

// 에러 페이지 텍스트로 보이는 경우 필터링
const ERROR_PHRASES = ['찾을 수 없습니다', '잘못 입력', '변경되어', '다시 확인', '존재하지 않']
function isValidBrand(name) {
  if (!name || name.length < 2 || name.length > 25) return false
  if (ERROR_PHRASES.some(p => name.includes(p))) return false
  if (/\d{4}|\s{2,}|http|\.com|주소|페이지/.test(name)) return false
  return true
}

// ───────────────────────── 현대 브랜드 ─────────────────────────
// 현대는 층별 안내 페이지에서 shop 목록 추출
// https://www.ehyundai.com/newPortal/DP/DP_0101000.do?branchCd=B00172000

async function scrapeHyundaiBrands(page, branchCd) {
  // 층별 안내 페이지: 입점 매장 전체 목록
  const url = `https://www.ehyundai.com/newPortal/DP/DP_0101000.do?branchCd=${branchCd}`
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(2000)

  const brands = await page.evaluate((max) => {
    const seen = new Set()
    const out = []
    const selectors = [
      '.shop-name', '.store-name', '.brand-name',
      '.shop-list li .name', '.floor-list .name',
      'li .shop_name', 'li .storeName', '.tit',
      'a.shop', '.list-shop .name',
    ]
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const name = el.innerText?.trim().split('\n')[0].trim()
        if (!name || name.length < 2 || name.length > 25) continue
        if (seen.has(name)) continue
        seen.add(name)
        out.push(name)
        if (out.length >= max) return out
      }
    }
    return out
  }, MAX_BRANDS)

  return brands.filter(isValidBrand)
}

// ───────────────────────── 신세계 브랜드 ─────────────────────────
// https://www.premiumoutlets.co.kr/rpage/store/brand/list?storeCode=01

async function scrapeShinsegaeBrands(page, storeCode) {
  const url = `https://www.premiumoutlets.co.kr/rpage/store/brand/list?storeCode=${storeCode}`
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(2000)

  const brands = await page.evaluate((max) => {
    const seen = new Set()
    const out = []
    const selectors = [
      '.brand-name', '.store-name', '.brand-item .name',
      '.list-item .title', '.brand-list li', 'li .tit',
      '[class*="brand"] [class*="name"]', '[class*="store"] [class*="name"]',
    ]
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const name = el.innerText?.trim().split('\n')[0].trim()
        if (!name || name.length < 2 || name.length > 30) continue
        if (seen.has(name)) continue
        seen.add(name)
        out.push(name)
        if (out.length >= max) return out
      }
    }
    return out
  }, MAX_BRANDS)

  return brands
}

// ───────────────────────── 롯데 브랜드 ─────────────────────────
// https://www.lotteshopping.com/brand/brandList?cstrCd=0352

async function scrapeLotteBrands(page, cstrCd) {
  const url = `https://www.lotteshopping.com/brand/brandList?cstrCd=${cstrCd}`
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(2000)

  const brands = await page.evaluate((max) => {
    const seen = new Set()
    const out = []
    const selectors = [
      '.brand-name', '.shop-name', '.brand-list li',
      'li.brand-item', '.list-brand li', '[class*="brand"] span',
      'ul li .name', 'li strong',
    ]
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const name = el.innerText?.trim().split('\n')[0].trim()
        if (!name || name.length < 2 || name.length > 30) continue
        if (seen.has(name)) continue
        seen.add(name)
        out.push(name)
        if (out.length >= max) return out
      }
    }
    return out
  }, MAX_BRANDS)

  return brands
}

// ───────────────────────── 메인 ─────────────────────────

async function main() {
  const outlets = JSON.parse(await fs.readFile(OUTPUT_PATH, 'utf-8'))
  const outletMap = Object.fromEntries(outlets.map(o => [o.id, o]))

  const browser = await chromium.launch({ headless: true })
  const shouldRun = (chain) => !TARGET_CHAIN || TARGET_CHAIN === chain
  let anyUpdated = false

  try {
    // ── 현대 ──
    if (shouldRun('hyundai')) {
      console.log('\n▶ 현대 브랜드 스크래핑...')
      const page = await browser.newPage()
      for (const outlet of outlets.filter(o => o.chain === 'hyundai' && o.branchCd)) {
        try {
          console.log(`  ${outlet.name} (${outlet.branchCd})...`)
          const brands = await scrapeHyundaiBrands(page, outlet.branchCd)
          if (brands.length >= 3) {
            outletMap[outlet.id].hotBrands = brands
            anyUpdated = true
            console.log(`    → ${brands.length}개: ${brands.slice(0, 5).join(', ')}`)
          } else {
            console.log(`    → 브랜드 부족(${brands.length}개) — 기존 유지`)
          }
        } catch (err) {
          console.error(`    ✗ ${outlet.name}:`, err.message)
        }
      }
      await page.close()
    }

    // ── 신세계 ──
    if (shouldRun('shinsegae')) {
      console.log('\n▶ 신세계 브랜드 스크래핑...')
      const page = await browser.newPage()
      for (const outlet of outlets.filter(o => o.chain === 'shinsegae' && o.storeCode)) {
        try {
          console.log(`  ${outlet.name} (${outlet.storeCode})...`)
          const brands = await scrapeShinsegaeBrands(page, outlet.storeCode)
          if (brands.length >= 3) {
            outletMap[outlet.id].hotBrands = brands
            anyUpdated = true
            console.log(`    → ${brands.length}개: ${brands.slice(0, 5).join(', ')}`)
          } else {
            console.log(`    → 브랜드 부족(${brands.length}개) — 기존 유지`)
          }
        } catch (err) {
          console.error(`    ✗ ${outlet.name}:`, err.message)
        }
      }
      await page.close()
    }

    // ── 롯데 ──
    if (shouldRun('lotte')) {
      console.log('\n▶ 롯데 브랜드 스크래핑...')
      const page = await browser.newPage()
      for (const outlet of outlets.filter(o => o.chain === 'lotte' && o.cstrCd)) {
        try {
          console.log(`  ${outlet.name} (${outlet.cstrCd})...`)
          const brands = await scrapeLotteBrands(page, outlet.cstrCd)
          if (brands.length >= 3) {
            outletMap[outlet.id].hotBrands = brands
            anyUpdated = true
            console.log(`    → ${brands.length}개: ${brands.slice(0, 5).join(', ')}`)
          } else {
            console.log(`    → 브랜드 부족(${brands.length}개) — 기존 유지`)
          }
        } catch (err) {
          console.error(`    ✗ ${outlet.name}:`, err.message)
        }
      }
      await page.close()
    }

  } finally {
    await browser.close()
  }

  if (anyUpdated) {
    const result = outlets.map(o => outletMap[o.id] ?? o)
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(result, null, 2), 'utf-8')
    console.log('\n✓ outlets.json hotBrands 저장 완료')
  } else {
    console.log('\n변경사항 없음')
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
