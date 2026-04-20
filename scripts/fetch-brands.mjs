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

// ───────────────────────── 현대 브랜드 ─────────────────────────
// https://www.ehyundai.com/newPortal/SH/SH_0101000.do?branchCd=B00172000

async function scrapeHyundaiBrands(page, branchCd) {
  const url = `https://www.ehyundai.com/newPortal/SH/SH_0101000.do?branchCd=${branchCd}`
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(1500)

  const brands = await page.evaluate((max) => {
    const seen = new Set()
    const out = []
    // 브랜드 이름은 보통 .brand-name, .shop-name, strong, b 등에 있음
    const selectors = [
      '.brand-name', '.shop-name', '.store-name',
      'li .name', 'li strong', '.list-item .tit',
      'ul.list li', '.brand-list li',
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
    // fallback: 알파벳+한글 2~20자 텍스트 노드 수집
    if (out.length < 5) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode()) && out.length < max) {
        const t = node.textContent?.trim()
        if (!t || t.length < 2 || t.length > 25) continue
        if (!/[가-힣A-Za-z]/.test(t)) continue
        if (/\d{4}|\s{2,}|http|\.com/.test(t)) continue
        if (seen.has(t)) continue
        seen.add(t)
        out.push(t)
      }
    }
    return out
  }, MAX_BRANDS)

  return brands
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
