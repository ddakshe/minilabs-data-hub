// World Rankings → rankings/rankings.json
//
// Usage:
//   node scripts/fetch-rankings.mjs
//
// 현재: seed 데이터(rankings.json) 기반 — 타임스탬프만 갱신
// 목표: 카테고리별 위키피디아/공식 API 스크래핑으로 점진 교체
//
// 스크래퍼 추가 방법:
//   1. scrapers 객체에 카테고리 ID → fetch 함수 추가
//   2. fetch 함수는 [{ rank, prev, name, value, detail, flag, highlight? }] 반환
//   3. 나머지는 seed 데이터에서 유지

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../rankings/rankings.json')

// ───────────────────────── scrapers ─────────────────────────
// 카테고리 ID → async () => ranking items[]
// 구현된 스크래퍼만 여기에 추가. 나머지는 seed 데이터 유지.

const scrapers = {
  // 예시 (주석 해제 후 사용):
  //
  // 'tennis-rank': async () => {
  //   const html = await fetch('https://en.wikipedia.org/wiki/ATP_rankings').then(r => r.text());
  //   // parse html...
  //   return [
  //     { rank: 1, prev: 1, name: '...', value: '...', detail: '...', flag: '🇮🇹' },
  //     ...
  //   ];
  // },
  //
  // 'football-team': async () => {
  //   const html = await fetch('https://en.wikipedia.org/wiki/FIFA_World_Rankings').then(r => r.text());
  //   // parse html...
  //   return [...];
  // },
}

// ───────────────────────── main ─────────────────────────

async function main() {
  // seed 데이터 읽기
  const seed = JSON.parse(await fs.readFile(OUTPUT_PATH, 'utf-8'))

  const scraperIds = Object.keys(scrapers)
  console.log(`▶ Rankings update (${seed.categories.length} categories, ${scraperIds.length} scrapers)\n`)

  // 스크래퍼가 있는 카테고리만 업데이트
  let updated = 0
  let failed = 0

  for (const [catId, scraper] of Object.entries(scrapers)) {
    try {
      const items = await scraper()
      if (Array.isArray(items) && items.length > 0) {
        seed.rankings[catId] = items
        updated++
        console.log(`  ✓ ${catId} — ${items.length} items`)
      }
    } catch (err) {
      failed++
      console.error(`  ✗ ${catId} — ${err.message}`)
    }
    // rate limit
    await new Promise((r) => setTimeout(r, 200))
  }

  // 카테고리별 updatedAt 갱신 (스크래핑된 것만)
  const today = new Date().toISOString().split('T')[0]
  if (updated > 0) {
    for (const catId of Object.keys(scrapers)) {
      const cat = seed.categories.find((c) => c.id === catId)
      if (cat) cat.updatedAt = today
    }
  }

  seed.updatedAt = today

  // 출력
  const json = JSON.stringify(seed)
  await fs.writeFile(OUTPUT_PATH, json, 'utf-8')

  const sizeKB = (Buffer.byteLength(json) / 1024).toFixed(1)
  console.log(`\n✓ rankings/rankings.json — ${seed.categories.length} categories, ${sizeKB}KB`)
  if (updated > 0) console.log(`  scraped: ${updated}, failed: ${failed}`)
  if (scraperIds.length === 0) console.log('  (no scrapers yet — seed data only)')

  if (failed > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('\n✗ fatal:', e.message)
  process.exit(1)
})
