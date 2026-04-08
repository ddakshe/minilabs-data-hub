// World Rankings → rankings/rankings.json
//
// Usage:
//   node scripts/fetch-rankings.mjs
//
// 실제 API 스크래퍼 + seed 데이터 혼합 방식:
//   - scrapers 객체에 등록된 카테고리 → API에서 실시간 데이터 fetch
//   - 나머지 → 기존 seed 데이터 유지

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../rankings/rankings.json')

// ───────────────────────── helpers ─────────────────────────

function countryFlag(code) {
  if (!code || code.length !== 2) return '🌐'
  return String.fromCodePoint(
    ...code
      .toUpperCase()
      .split('')
      .map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
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
  MW: '말라위', CI: "코트디부아르", CM: '카메룬', MG: '마다가스카르',
}

function krName(code, fallback) {
  return COUNTRY_KR[code] || fallback
}

// ─── 숫자 포맷 (한국식) ───

function fmtTrillionUSD(v) {
  const jo = v / 1e12
  if (jo >= 1) return `${jo.toFixed(1)}조 달러`
  const eok = v / 1e8
  return `${Math.round(eok).toLocaleString('ko-KR')}억 달러`
}

function fmtPopulation(v) {
  const eok = 1e8
  const man = 1e4
  if (v >= eok) {
    const e = Math.floor(v / eok)
    const m = Math.floor((v % eok) / man)
    return m > 0 ? `${e}억 ${m.toLocaleString('ko-KR')}만` : `${e}억`
  }
  if (v >= man) return `${Math.round(v / man).toLocaleString('ko-KR')}만`
  return v.toLocaleString('ko-KR')
}

function fmtPerCapitaUSD(v) {
  const man = 10000
  if (v >= man) {
    const m = Math.floor(v / man)
    const r = Math.round((v % man) / 1000) * 1000
    if (r > 0) return `${m}만 ${r.toLocaleString('ko-KR')}달러`
    return `${m}만 달러`
  }
  return `${Math.round(v).toLocaleString('ko-KR')}달러`
}

// ───────────────────────── World Bank API ─────────────────────────

// 실제 국가 ISO2 코드 세트 (aggregates 제외)
let _validCountries = null
async function getValidCountries() {
  if (_validCountries) return _validCountries
  const res = await fetch(
    'https://api.worldbank.org/v2/country?format=json&per_page=400',
  )
  if (!res.ok) throw new Error(`Countries API HTTP ${res.status}`)
  const json = await res.json()
  _validCountries = new Set(
    json[1]
      .filter((c) => c.region?.value && c.region.value !== 'Aggregates')
      .map((c) => c.iso2Code),
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
  if (!Array.isArray(json) || json.length < 2 || !json[1]) {
    throw new Error('empty response')
  }

  // country.id = ISO2 코드, validCountries로 집계 제외
  const rows = json[1].filter(
    (d) => d.value != null && validCountries.has(d.country?.id),
  )

  // 연도별 그룹핑
  const byYear = {}
  for (const r of rows) (byYear[r.date] ??= []).push(r)

  const years = Object.keys(byYear).sort((a, b) => b - a)
  const latestYear = years.find((y) => byYear[y].length >= 40) || years[0]
  const prevYear = years.find((y) => y < latestYear && byYear[y].length >= 40)

  return {
    current: byYear[latestYear]?.sort((a, b) => b.value - a.value) || [],
    previous: prevYear
      ? byYear[prevYear]?.sort((a, b) => b.value - a.value)
      : [],
    year: latestYear,
  }
}

function buildRanking(data, count, formatValue, detailSuffix) {
  const { current, previous, year } = data
  return current.slice(0, count).map((item, i) => {
    const rank = i + 1
    const code = item.country.id
    const prevIdx = previous.findIndex((p) => p.country.id === code)
    const prevRank = prevIdx >= 0 ? prevIdx + 1 : rank

    return {
      rank,
      prev: prevRank,
      name: krName(code, item.country.value),
      value: formatValue(item.value),
      detail: `${item.country.value}. ${year}년 ${detailSuffix}`,
      flag: countryFlag(code),
      ...(code === 'KR' && { highlight: true }),
    }
  })
}

// ───────────────────────── scrapers ─────────────────────────
// 카테고리 ID → async () => ranking items[]

const scrapers = {
  // 경제 — World Bank API
  async gdp() {
    const data = await fetchWorldBank('NY.GDP.MKTP.CD')
    return buildRanking(data, 10, fmtTrillionUSD, 'World Bank 기준.')
  },

  'gdp-per-capita': async function () {
    const data = await fetchWorldBank('NY.GDP.PCAP.CD')
    return buildRanking(data, 10, fmtPerCapitaUSD, 'World Bank 기준.')
  },

  // 세상·지리 — World Bank API
  async population() {
    const data = await fetchWorldBank('SP.POP.TOTL')
    return buildRanking(data, 10, fmtPopulation, '기준 추정치.')
  },
}

// ───────────────────────── main ─────────────────────────

async function main() {
  const seed = JSON.parse(await fs.readFile(OUTPUT_PATH, 'utf-8'))
  const scraperIds = Object.keys(scrapers)
  console.log(
    `▶ Rankings update (${seed.categories.length} categories, ${scraperIds.length} scrapers)\n`,
  )

  let updated = 0
  let failed = 0

  for (const [catId, scraper] of Object.entries(scrapers)) {
    try {
      const items = await scraper()
      if (Array.isArray(items) && items.length > 0) {
        seed.rankings[catId] = items
        const cat = seed.categories.find((c) => c.id === catId)
        if (cat) cat.updatedAt = new Date().toISOString().split('T')[0]
        updated++
        console.log(`  ✓ ${catId} — ${items.length} items (1위: ${items[0]?.name})`)
      }
    } catch (err) {
      failed++
      console.error(`  ✗ ${catId} — ${err.message}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  seed.updatedAt = new Date().toISOString().split('T')[0]

  const json = JSON.stringify(seed, null, 2) + '\n'
  await fs.writeFile(OUTPUT_PATH, json, 'utf-8')

  const sizeKB = (Buffer.byteLength(json) / 1024).toFixed(1)
  console.log(
    `\n✓ rankings/rankings.json — ${seed.categories.length} categories, ${sizeKB}KB`,
  )
  console.log(
    `  scraped: ${updated}, seed: ${seed.categories.length - updated}, failed: ${failed}`,
  )

  if (failed > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('\n✗ fatal:', e.message)
  process.exit(1)
})
