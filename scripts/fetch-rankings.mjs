// World Rankings → rankings/{index,group}.json
//
// Usage:
//   node scripts/fetch-rankings.mjs
//
// 출력:
//   rankings/index.json         ← groups + categories + 1위 preview
//   rankings/{groupId}.json     ← 그룹별 전체 랭킹 데이터
//
// seed.json → 스크래퍼 결과 반영 → 분리 출력

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SEED_PATH = path.resolve(__dirname, '../rankings/seed.json')
const OUTPUT_DIR = path.resolve(__dirname, '../rankings')

// ───────────────────────── helpers ─────────────────────────

function countryFlag(code) {
  if (!code || code.length !== 2) return '🌐'
  return String.fromCodePoint(
    ...code.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  )
}

const COUNTRY_KR = {
  US: '미국', CN: '중국', JP: '일본', DE: '독일', IN: '인도',
  GB: '영국', FR: '프랑스', IT: '이탈리아', CA: '캐나다', BR: '브라질',
  RU: '러시아', KR: '대한민국', AU: '호주', ES: '스페인', MX: '멕시코',
  ID: '인도네시아', NL: '네덜란드', SA: '사우디아라비아', TR: '튀르키예',
  CH: '스위스', PL: '폴란드', TW: '대만', BE: '벨기에', SE: '스웨덴',
  TH: '태국', AT: '오스트리아', NO: '노르웨이', IE: '아일랜드',
  IL: '이스라엘', SG: '싱가포르', DK: '덴마크', PH: '필리핀',
  MY: '말레이시아', NG: '나이지리아', BD: '방글라데시', PK: '파키스탄',
  EG: '이집트', VN: '베트남', CL: '칠레', CO: '콜롬비아',
  AR: '아르헨티나', ZA: '남아공', FI: '핀란드', AE: '아랍에미리트',
  PT: '포르투갈', CZ: '체코', RO: '루마니아', NZ: '뉴질랜드',
  QA: '카타르', KZ: '카자흐스탄', HU: '헝가리', LU: '룩셈부르크',
  DZ: '알제리', GR: '그리스', PE: '페루', CU: '쿠바', ET: '에티오피아',
  MM: '미얀마', CD: '콩고민주', TZ: '탄자니아', KE: '케냐', SD: '수단',
  UA: '우크라이나', IQ: '이라크', AF: '아프가니스탄', UZ: '우즈베키스탄',
  MA: '모로코', AO: '앙골라', MZ: '모잠비크', GH: '가나', NE: '니제르',
  MW: '말라위', CI: '코트디부아르', CM: '카메룬', MG: '마다가스카르',
  MC: '모나코', BM: '버뮤다', IS: '아이슬란드', LI: '리히텐슈타인',
}

function krName(code, fallback) {
  return COUNTRY_KR[code] || fallback
}

function fmtTrillionUSD(v) {
  const jo = v / 1e12
  if (jo >= 1) return `${jo.toFixed(1)}조 달러`
  return `${Math.round(v / 1e8).toLocaleString('ko-KR')}억 달러`
}

function fmtPopulation(v) {
  if (v >= 1e8) {
    const e = Math.floor(v / 1e8)
    const m = Math.floor((v % 1e8) / 1e4)
    return m > 0 ? `${e}억 ${m.toLocaleString('ko-KR')}만` : `${e}억`
  }
  if (v >= 1e4) return `${Math.round(v / 1e4).toLocaleString('ko-KR')}만`
  return v.toLocaleString('ko-KR')
}

function fmtPerCapitaUSD(v) {
  if (v >= 1e4) {
    const m = Math.floor(v / 1e4)
    const r = Math.round((v % 1e4) / 1000) * 1000
    if (r > 0) return `${m}만 ${r.toLocaleString('ko-KR')}달러`
    return `${m}만 달러`
  }
  return `${Math.round(v).toLocaleString('ko-KR')}달러`
}

// ───────────────────────── World Bank API ─────────────────────────

let _validCountries = null
async function getValidCountries() {
  if (_validCountries) return _validCountries
  const res = await fetch('https://api.worldbank.org/v2/country?format=json&per_page=400')
  if (!res.ok) throw new Error(`Countries API HTTP ${res.status}`)
  const json = await res.json()
  _validCountries = new Set(
    json[1].filter((c) => c.region?.value && c.region.value !== 'Aggregates').map((c) => c.iso2Code),
  )
  console.log(`  (${_validCountries.size} valid countries loaded)`)
  return _validCountries
}

async function fetchWorldBank(indicator) {
  const validCountries = await getValidCountries()
  const year = new Date().getFullYear()
  const url = `https://api.worldbank.org/v2/country/all/indicator/${indicator}?date=${year - 4}:${year}&format=json&per_page=1500`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  if (!Array.isArray(json) || json.length < 2 || !json[1]) throw new Error('empty response')

  const rows = json[1].filter((d) => d.value != null && validCountries.has(d.country?.id))
  const byYear = {}
  for (const r of rows) (byYear[r.date] ??= []).push(r)

  const years = Object.keys(byYear).sort((a, b) => b - a)
  const latestYear = years.find((y) => byYear[y].length >= 40) || years[0]
  const prevYear = years.find((y) => y < latestYear && byYear[y].length >= 40)

  return {
    current: byYear[latestYear]?.sort((a, b) => b.value - a.value) || [],
    previous: prevYear ? byYear[prevYear]?.sort((a, b) => b.value - a.value) : [],
    year: latestYear,
  }
}

function buildRanking(data, count, formatValue, detailSuffix) {
  return data.current.slice(0, count).map((item, i) => {
    const rank = i + 1
    const code = item.country.id
    const prevIdx = data.previous.findIndex((p) => p.country.id === code)
    return {
      rank,
      prev: prevIdx >= 0 ? prevIdx + 1 : rank,
      name: krName(code, item.country.value),
      value: formatValue(item.value),
      detail: `${item.country.value}. ${data.year}년 ${detailSuffix}`,
      flag: countryFlag(code),
      ...(code === 'KR' && { highlight: true }),
    }
  })
}

// ───────────────────────── scrapers ─────────────────────────

const scrapers = {
  async gdp() {
    return buildRanking(await fetchWorldBank('NY.GDP.MKTP.CD'), 10, fmtTrillionUSD, 'World Bank 기준.')
  },
  'gdp-per-capita': async function () {
    return buildRanking(await fetchWorldBank('NY.GDP.PCAP.CD'), 10, fmtPerCapitaUSD, 'World Bank 기준.')
  },
  async population() {
    return buildRanking(await fetchWorldBank('SP.POP.TOTL'), 10, fmtPopulation, '기준 추정치.')
  },
}

// ───────────────────────── main ─────────────────────────

async function main() {
  const seed = JSON.parse(await fs.readFile(SEED_PATH, 'utf-8'))
  const today = new Date().toISOString().split('T')[0]
  const scraperIds = Object.keys(scrapers)

  console.log(`▶ Rankings update (${seed.categories.length} categories, ${scraperIds.length} scrapers)\n`)

  // 1) 스크래퍼 실행 → seed 데이터 업데이트
  let updated = 0
  let failed = 0

  for (const [catId, scraper] of Object.entries(scrapers)) {
    try {
      const items = await scraper()
      if (Array.isArray(items) && items.length > 0) {
        seed.rankings[catId] = items
        const cat = seed.categories.find((c) => c.id === catId)
        if (cat) cat.updatedAt = today
        updated++
        console.log(`  ✓ ${catId} — ${items.length} items (1위: ${items[0]?.name})`)
      }
    } catch (err) {
      failed++
      console.error(`  ✗ ${catId} — ${err.message}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  // 2) seed.json 갱신 (스크래핑 결과 반영)
  seed.updatedAt = today
  await fs.writeFile(SEED_PATH, JSON.stringify(seed, null, 2) + '\n')

  // 3) index.json 출력 (groups + categories + 1위 preview)
  const index = {
    updatedAt: today,
    groups: seed.groups,
    categories: seed.categories.map((cat) => {
      const top = seed.rankings[cat.id]?.[0]
      return {
        ...cat,
        top: top ? { name: top.name, value: top.value, flag: top.flag } : null,
      }
    }),
  }
  await fs.writeFile(path.join(OUTPUT_DIR, 'index.json'), JSON.stringify(index, null, 2) + '\n')

  // 4) 그룹별 JSON 출력
  for (const group of seed.groups) {
    const catIds = seed.categories.filter((c) => c.groupId === group.id).map((c) => c.id)
    const rankings = {}
    for (const id of catIds) rankings[id] = seed.rankings[id] || []

    await fs.writeFile(
      path.join(OUTPUT_DIR, `${group.id}.json`),
      JSON.stringify({ updatedAt: today, rankings }, null, 2) + '\n',
    )
  }

  // 5) 요약
  const indexSize = (Buffer.byteLength(JSON.stringify(index)) / 1024).toFixed(1)
  const groupFiles = seed.groups.map((g) => g.id + '.json')
  console.log(`\n✓ output:`)
  console.log(`  index.json — ${indexSize}KB (${seed.categories.length} categories)`)
  for (const g of seed.groups) {
    const catCount = seed.categories.filter((c) => c.groupId === g.id).length
    console.log(`  ${g.id}.json — ${catCount} categories`)
  }
  console.log(`  scraped: ${updated}, seed: ${seed.categories.length - updated}, failed: ${failed}`)

  if (failed > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('\n✗ fatal:', e.message)
  process.exit(1)
})
