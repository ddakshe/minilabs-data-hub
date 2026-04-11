// records-scrapers.mjs — Wikipedia-based scrapers for RECORDS & DARK categories
//
// Usage:
//   node scripts/sources/records-scrapers.mjs    # self-test
//
// Exports: recordsScrapers, darkScrapers

import * as cheerio from 'cheerio'

const WIKI_UA = 'minilabs-data-hub/1.0 (+https://github.com/ddakshe/minilabs-data-hub)'

async function fetchWikiFullHtml(page) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json`
  const res = await fetch(url, { headers: { 'User-Agent': WIKI_UA } })
  if (!res.ok) throw new Error(`Wikipedia API HTTP ${res.status}: ${page}`)
  const json = await res.json()
  if (json.error) throw new Error(`Wikipedia: ${json.error.info}`)
  return cheerio.load(json.parse.text['*'])
}

function countryFlag(code) {
  if (!code || code.length !== 2) return '🌐'
  return String.fromCodePoint(
    ...code.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  )
}

const ENNAME_TO_ISO2 = {
  'United States': 'US', 'United Kingdom': 'GB', China: 'CN', Germany: 'DE',
  Japan: 'JP', France: 'FR', Italy: 'IT', Canada: 'CA', Brazil: 'BR',
  Russia: 'RU', India: 'IN', Australia: 'AU', Spain: 'ES', Mexico: 'MX',
  'South Korea': 'KR', 'North Korea': 'KP', Taiwan: 'TW', Thailand: 'TH',
  Turkey: 'TR', 'Saudi Arabia': 'SA', 'United Arab Emirates': 'AE',
  Iran: 'IR', 'El Salvador': 'SV', Cuba: 'CU', Bahamas: 'BS',
  Jamaica: 'JM', 'Saint Kitts and Nevis': 'KN',
  'Saint Vincent and the Grenadines': 'VC', 'Turks and Caicos Islands': 'TC',
  'U.S. Virgin Islands': 'VI', 'United States Virgin Islands': 'VI',
  Chile: 'CL', Argentina: 'AR', Netherlands: 'NL', Belgium: 'BE',
  Sweden: 'SE', Norway: 'NO', Denmark: 'DK', Finland: 'FI',
  Switzerland: 'CH', Austria: 'AT', Poland: 'PL', Portugal: 'PT',
  Ireland: 'IE', Israel: 'IL', Pakistan: 'PK', Indonesia: 'ID',
  Philippines: 'PH', Vietnam: 'VN', 'Hong Kong': 'HK', Singapore: 'SG',
  Venezuela: 'VE', Ecuador: 'EC', Honduras: 'HN', Guatemala: 'GT',
  Nicaragua: 'NI', 'Costa Rica': 'CR', Panama: 'PA', Colombia: 'CO',
  Peru: 'PE', Bolivia: 'BO', Uruguay: 'UY', Paraguay: 'PY',
  'South Africa': 'ZA', Nigeria: 'NG', Kenya: 'KE', Ethiopia: 'ET',
  Egypt: 'EG', Morocco: 'MA', Algeria: 'DZ', Tunisia: 'TN',
  Haiti: 'HT', 'Dominican Republic': 'DO', 'Puerto Rico': 'PR',
  'Trinidad and Tobago': 'TT', Belize: 'BZ', Guyana: 'GY', Suriname: 'SR',
}

function resolveCountryISO2(text) {
  if (!text) return null
  const clean = text.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim()
  return ENNAME_TO_ISO2[clean] || null
}

function parseFloatClean(s) {
  if (!s) return null
  const m = s.replace(/,/g, '').replace(/\[.*?\]/g, '').match(/-?\d+(\.\d+)?/)
  return m ? parseFloat(m[0]) : null
}

function parseIntClean(s) {
  if (!s) return null
  const m = s.replace(/,/g, '').replace(/\[.*?\]/g, '').match(/-?\d+/)
  return m ? parseInt(m[0]) : null
}

// ───────────────────────── oldest-person ─────────────────────────

export async function scrapeOldestPerson() {
  const $ = await fetchWikiFullHtml('List_of_the_verified_oldest_people')
  const tables = $('table.wikitable')
  if (tables.length === 0) throw new Error('oldest-person: no tables')

  // First sortable table is usually the women's list (overall top)
  const rows = []
  tables.first().find('tr').each(function (i) {
    if (i < 1) return
    if (rows.length >= 10) return
    const cells = $(this).find('td, th')
    if (cells.length < 4) return

    const rank = parseIntClean($(cells[0]).text())
    const name = $(cells[1]).text().replace(/\[.*?\]/g, '').trim()
    const birthDate = $(cells[2]).text().replace(/\[.*?\]/g, '').trim()
    // age col: look for text like "122 years, 164 days" or "122 y, 164 d"
    let ageText = ''
    for (let j = 3; j < cells.length; j++) {
      const t = $(cells[j]).text().trim()
      if (/\d+\s*years?/.test(t) || /\d+\s*y[\s,]/.test(t)) { ageText = t; break }
    }
    if (!name) return
    const yearsMatch = ageText.match(/(\d+)\s*(?:years?|y)/)
    const daysMatch = ageText.match(/(\d+)\s*(?:days?|d)/)
    const years = yearsMatch ? parseInt(yearsMatch[1]) : null
    const days = daysMatch ? parseInt(daysMatch[1]) : null
    if (!years) return
    rows.push({ rank: rank || rows.length + 1, name, years, days, birthDate })
  })

  if (rows.length === 0) throw new Error('oldest-person: no data parsed')
  return rows.slice(0, 10).map((r, i) => ({
    rank: i + 1,
    prev: i + 1,
    name: r.name,
    value: r.days ? `${r.years}년 ${r.days}일` : `${r.years}년`,
    detail: `역대 최고령 인물. 생년월일 ${r.birthDate}. Wikipedia 기준.`,
    flag: '👴',
  }))
}

// ───────────────────────── tallest-person ─────────────────────────

export async function scrapeTallestPerson() {
  const $ = await fetchWikiFullHtml('List_of_tallest_people')
  const tables = $('table.wikitable')
  if (tables.length === 0) throw new Error('tallest-person: no tables')

  const rows = []
  // Find a table with height data
  let targetTable = null
  tables.each(function () {
    const headerText = $(this).find('tr').first().text().toLowerCase()
    if (/height|feet|cm|metres|meters/.test(headerText)) {
      if (!targetTable) targetTable = $(this)
    }
  })
  if (!targetTable) targetTable = tables.first()

  targetTable.find('tr').each(function (i) {
    if (i < 1) return
    if (rows.length >= 15) return
    const cells = $(this).find('td, th')
    if (cells.length < 3) return

    const name = $(cells[0]).text().replace(/\[.*?\]/g, '').trim()
    if (!name || name.length > 60) return

    // Find height cell — prefer cm value
    let heightCm = null
    for (let j = 1; j < cells.length; j++) {
      const t = $(cells[j]).text()
      const cmMatch = t.match(/(\d+(?:\.\d+)?)\s*cm/)
      if (cmMatch) { heightCm = parseFloat(cmMatch[1]); break }
      const mMatch = t.match(/(\d+(?:\.\d+)?)\s*m(?![a-z])/)
      if (mMatch && !heightCm) { heightCm = parseFloat(mMatch[1]) * 100 }
    }
    if (!heightCm || heightCm < 200 || heightCm > 300) return

    // Find country
    let country = null
    for (let j = cells.length - 1; j > 1; j--) {
      const t = $(cells[j]).text().replace(/\[.*?\]/g, '').trim()
      const iso = resolveCountryISO2(t)
      if (iso) { country = iso; break }
    }
    rows.push({ name, heightCm, country })
  })

  rows.sort((a, b) => b.heightCm - a.heightCm)
  if (rows.length === 0) throw new Error('tallest-person: no data parsed')
  return rows.slice(0, 10).map((r, i) => ({
    rank: i + 1,
    prev: i + 1,
    name: r.name,
    value: `${Math.round(r.heightCm)}cm`,
    detail: `역대 최장신 인물. ${r.country ? '출신: ' + r.country + '. ' : ''}Wikipedia 기준.`,
    flag: r.country ? countryFlag(r.country) : '📏',
  }))
}

// ───────────────────────── hottest-pepper ─────────────────────────

export async function scrapeHottestPepper() {
  const $ = await fetchWikiFullHtml('Scoville_scale')
  const tables = $('table.wikitable')
  if (tables.length === 0) throw new Error('hottest-pepper: no tables')

  // Scoville tables — pick the one with most rows
  let targetTable = tables.first()
  let maxRows = 0
  tables.each(function () {
    const n = $(this).find('tr').length
    if (n > maxRows) { maxRows = n; targetTable = $(this) }
  })

  const rows = []
  targetTable.find('tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 2) return

    // Expect: SHU | Pepper name (or reverse). Find SHU col
    let shu = null
    let name = ''
    for (let j = 0; j < cells.length; j++) {
      const t = $(cells[j]).text().replace(/,/g, '').replace(/\[.*?\]/g, '').trim()
      const shuMatch = t.match(/(\d{5,})/)
      if (shuMatch && !shu) {
        // take upper bound of range if present
        const nums = t.match(/\d+/g)
        if (nums) shu = Math.max(...nums.map(Number))
      } else if (!name && /[A-Za-z]/.test(t) && t.length < 80 && !/^\d+$/.test(t)) {
        name = t.replace(/\s+/g, ' ').trim()
      }
    }
    if (shu && shu >= 100000 && name) rows.push({ name, shu })
  })

  rows.sort((a, b) => b.shu - a.shu)
  // Dedup by name
  const seen = new Set()
  const unique = []
  for (const r of rows) {
    if (!seen.has(r.name)) { seen.add(r.name); unique.push(r) }
    if (unique.length >= 10) break
  }

  if (unique.length === 0) throw new Error('hottest-pepper: no data parsed')
  return unique.map((r, i) => ({
    rank: i + 1,
    prev: i + 1,
    name: r.name,
    value: `${r.shu.toLocaleString('ko-KR')} SHU`,
    detail: `가장 매운 고추. 스코빌 지수(SHU) 기준. Wikipedia.`,
    flag: '🌶️',
  }))
}

// ───────────────────────── oldest-tree ─────────────────────────

export async function scrapeOldestTree() {
  const $ = await fetchWikiFullHtml('List_of_oldest_trees')
  const tables = $('table.wikitable')
  if (tables.length === 0) throw new Error('oldest-tree: no tables')

  // First table = "Individual non-clonal specimens" (가장 정확)
  const rows = []
  tables.first().find('tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 3) return

    const name = $(cells[0]).text().replace(/\[.*?\]/g, '').trim()
    if (!name || name.length > 60) return

    // Age column — look for 4-digit number (years)
    let ageYears = null
    for (let j = 1; j < cells.length; j++) {
      const t = $(cells[j]).text().replace(/,/g, '').replace(/\[.*?\]/g, '').trim()
      const m = t.match(/^(\d{3,5})/)
      if (m) { ageYears = parseInt(m[1]); break }
    }
    if (!ageYears || ageYears < 1000) return

    // species/location in subsequent cells
    let location = ''
    for (let j = 2; j < cells.length; j++) {
      const t = $(cells[j]).text().replace(/\[.*?\]/g, '').trim()
      if (t && !/^\d/.test(t) && t.length < 80) { location = t; break }
    }
    rows.push({ name, ageYears, location })
  })

  rows.sort((a, b) => b.ageYears - a.ageYears)
  if (rows.length === 0) throw new Error('oldest-tree: no data parsed')
  return rows.slice(0, 10).map((r, i) => ({
    rank: i + 1,
    prev: i + 1,
    name: r.name,
    value: `${r.ageYears.toLocaleString('ko-KR')}년`,
    detail: `세계 최고령 비클론 나무. ${r.location}. Wikipedia 기준.`,
    flag: '🌳',
  }))
}

// ───────────────────────── fastest-animal ─────────────────────────

const ANIMAL_KR = {
  'Peregrine falcon': '매',
  'Golden eagle': '황금수리',
  'White-throated needletail swift': '흰목잣새',
  'White-throated needletail': '흰목잣새',
  'Eurasian hobby': '쇠황조롱이',
  'Frigatebird': '군함새',
  'Frigate bird': '군함새',
  'Spur-winged goose': '며느리발톱거위',
  'Red-breasted merganser': '비오리',
  'Cheetah': '치타',
  'Black marlin': '흑새치',
  'Sailfish': '돛새치',
  'Pronghorn': '가지뿔영양',
  'Springbok': '스프링복',
  'Mexican free-tailed bat': '멕시코자유꼬리박쥐',
}

export async function scrapeFastestAnimal() {
  const $ = await fetchWikiFullHtml('Fastest_animals')
  const tables = $('table.wikitable')
  if (tables.length === 0) throw new Error('fastest-animal: no tables')

  const rows = []
  // Aggregate across all tables (overall/bird/land/water etc.)
  tables.each(function () {
    $(this).find('tr').each(function (i) {
      if (i < 1) return
      const cells = $(this).find('td, th')
      if (cells.length < 2) return

      // Find animal name and top speed (km/h)
      let name = ''
      let speedKmh = null
      cells.each(function () {
        const t = $(this).text().replace(/\[.*?\]/g, '').trim()
        const kmh = t.match(/(\d+(?:\.\d+)?)\s*km\/h/)
        if (kmh && !speedKmh) speedKmh = parseFloat(kmh[1])
        else if (!name && /[A-Za-z]/.test(t) && t.length < 50 && !/^\d/.test(t) && !/km\/h|mph/.test(t)) {
          name = t.replace(/\s+/g, ' ').trim()
        }
      })
      if (name && speedKmh && speedKmh > 30) rows.push({ name, speedKmh })
    })
  })

  rows.sort((a, b) => b.speedKmh - a.speedKmh)
  // Dedup by name
  const seen = new Set()
  const unique = []
  for (const r of rows) {
    const key = r.name.toLowerCase()
    if (!seen.has(key)) { seen.add(key); unique.push(r) }
    if (unique.length >= 10) break
  }

  if (unique.length === 0) throw new Error('fastest-animal: no data parsed')
  return unique.map((r, i) => ({
    rank: i + 1,
    prev: i + 1,
    name: ANIMAL_KR[r.name] || r.name,
    value: `${r.speedKmh} km/h`,
    detail: `세계에서 가장 빠른 동물 순위. Wikipedia 기준.`,
    flag: '🦅',
  }))
}

// ───────────────────────── largest-snake ─────────────────────────

const SNAKE_KR = {
  'Green anaconda': '그린 아나콘다',
  'Reticulated python': '그물무늬 비단뱀',
  'Burmese python': '버마 비단뱀',
  'Indian python': '인도 비단뱀',
  'African rock python': '아프리카 바위뱀',
  'Central African rock python': '중앙 아프리카 바위뱀',
  'Southern African rock python': '남부 아프리카 바위뱀',
  'Amethystine python': '아메시스틴 비단뱀',
  'Yellow anaconda': '옐로우 아나콘다',
  'Boa constrictor': '보아뱀',
  'King cobra': '킹코브라',
}

export async function scrapeLargestSnake() {
  const $ = await fetchWikiFullHtml('List_of_largest_snakes')
  const tables = $('table.wikitable')
  if (tables.length === 0) throw new Error('largest-snake: no tables')

  const rows = []
  tables.first().find('tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 3) return

    // First non-numeric cell = species name (skip rank column if present)
    let name = ''
    let lengthM = null
    for (let j = 0; j < cells.length; j++) {
      const t = $(cells[j]).text().replace(/\[.*?\]/g, '').replace(/\([^)]*\)/g, '').trim()
      if (!name && /[A-Za-z]{3,}/.test(t) && t.length < 60 && !/^\d+$/.test(t)) {
        name = t.replace(/\s+/g, ' ').trim()
      }
      const m = t.match(/(\d+(?:\.\d+)?)\s*m(?![a-z])/)
      if (m && !lengthM) lengthM = parseFloat(m[1])
    }
    if (!name || !lengthM || lengthM < 2 || lengthM > 15) return
    rows.push({ name, lengthM })
  })

  rows.sort((a, b) => b.lengthM - a.lengthM)
  // Dedup
  const seen = new Set()
  const unique = []
  for (const r of rows) {
    if (!seen.has(r.name)) { seen.add(r.name); unique.push(r) }
    if (unique.length >= 10) break
  }

  if (unique.length === 0) throw new Error('largest-snake: no data parsed')
  return unique.map((r, i) => ({
    rank: i + 1,
    prev: i + 1,
    name: SNAKE_KR[r.name] || r.name,
    value: `${r.lengthM}m`,
    detail: `세계에서 가장 큰 뱀 종. 최대 길이 기준. Wikipedia.`,
    flag: '🐍',
  }))
}

// ───────────────────────── incarceration-rate ─────────────────────────

const COUNTRY_KR_LOCAL = {
  US: '미국', CN: '중국', JP: '일본', SV: '엘살바도르', CU: '쿠바',
  TR: '튀르키예', BS: '바하마', KP: '북한', KR: '대한민국',
  JM: '자메이카', KN: '세인트키츠네비스', VC: '세인트빈센트',
  TC: '터크스 카이코스', VI: '미국령 버진아일랜드', HT: '아이티',
  TT: '트리니다드 토바고', HN: '온두라스', VE: '베네수엘라',
  RU: '러시아', BR: '브라질', TH: '태국', ZA: '남아공',
}

export async function scrapeIncarcerationRate() {
  const $ = await fetchWikiFullHtml('List_of_countries_by_incarceration_rate')
  const tables = $('table.wikitable')
  if (tables.length === 0) throw new Error('incarceration-rate: no tables')

  const rows = []
  tables.first().find('tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 3) return

    let country = ''
    let rate = null
    cells.each(function () {
      const txt = $(this).text().replace(/\[.*?\]/g, '').trim()
      if (!country) {
        const iso = resolveCountryISO2(txt)
        if (iso) country = iso
      }
      if (!rate) {
        const clean = txt.replace(/,/g, '')
        const numMatch = clean.match(/^(\d{2,5}(?:\.\d+)?)$/)
        if (numMatch) {
          const v = parseFloat(numMatch[1])
          if (v >= 50 && v <= 3000) rate = v
        }
      }
    })

    if (country && rate) rows.push({ country, rate })
  })

  rows.sort((a, b) => b.rate - a.rate)
  const seen = new Set()
  const unique = []
  for (const r of rows) {
    if (!seen.has(r.country)) { seen.add(r.country); unique.push(r) }
    if (unique.length >= 10) break
  }

  if (unique.length === 0) throw new Error('incarceration-rate: no data parsed')
  return unique.map((r, i) => ({
    rank: i + 1,
    prev: i + 1,
    name: COUNTRY_KR_LOCAL[r.country] || r.country,
    value: `${Math.round(r.rate).toLocaleString('ko-KR')}명/10만`,
    detail: `인구 10만 명당 수감자 수. Wikipedia 기준.`,
    flag: countryFlag(r.country),
    ...(r.country === 'KR' && { highlight: true }),
  }))
}

// ───────────────────────── homicide-rate ─────────────────────────

export async function scrapeHomicideRate() {
  const $ = await fetchWikiFullHtml('List_of_countries_by_intentional_homicide_rate')
  const tables = $('table.wikitable')
  if (tables.length === 0) throw new Error('homicide-rate: no tables')

  const rows = []
  // Main big sortable table
  tables.first().find('tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 3) return

    let country = ''
    let rate = null
    cells.each(function (idx) {
      const txt = $(this).text().replace(/\[.*?\]/g, '').trim()
      if (!country && /[A-Za-z]{4,}/.test(txt) && txt.length < 60) {
        const iso = resolveCountryISO2(txt)
        if (iso) country = iso
      }
      const numMatch = txt.match(/^(\d+(?:\.\d+)?)$/)
      if (numMatch && !rate) {
        const v = parseFloat(numMatch[1])
        if (v > 0 && v < 200) rate = v
      }
    })

    if (country && rate && rate >= 1) {
      rows.push({ country, rate })
    }
  })

  rows.sort((a, b) => b.rate - a.rate)
  const seen = new Set()
  const unique = []
  for (const r of rows) {
    if (!seen.has(r.country)) { seen.add(r.country); unique.push(r) }
    if (unique.length >= 10) break
  }

  if (unique.length === 0) throw new Error('homicide-rate: no data parsed')
  return unique.map((r, i) => ({
    rank: i + 1,
    prev: i + 1,
    name: COUNTRY_KR_LOCAL[r.country] || r.country,
    value: `${r.rate.toFixed(1)}명/10만`,
    detail: `인구 10만 명당 의도적 살인 발생률. Wikipedia 기준.`,
    flag: countryFlag(r.country),
    ...(r.country === 'KR' && { highlight: true }),
  }))
}

// ───────────────────────── exports ─────────────────────────

export const recordsScrapers = {
  'oldest-person': scrapeOldestPerson,
  'tallest-person': scrapeTallestPerson,
  'hottest-pepper': scrapeHottestPepper,
  'oldest-tree': scrapeOldestTree,
  'fastest-animal': scrapeFastestAnimal,
  'largest-snake': scrapeLargestSnake,
}

export const darkScrapers = {
  'incarceration-rate': scrapeIncarcerationRate,
  'homicide-rate': scrapeHomicideRate,
}

// ───────────────────────── self-test ─────────────────────────

async function selfTest() {
  console.log('▶ records-scrapers self-test\n')
  let passed = 0, failed = 0
  const all = { ...recordsScrapers, ...darkScrapers }
  for (const [id, scraper] of Object.entries(all)) {
    try {
      const items = await scraper()
      if (!Array.isArray(items) || items.length === 0) throw new Error('empty result')
      console.log(`  ✓ ${id} — ${items.length} items`)
      console.log(`    1위: ${items[0].flag} ${items[0].name} (${items[0].value})`)
      if (items[1]) console.log(`    2위: ${items[1].flag} ${items[1].name} (${items[1].value})`)
      passed++
    } catch (err) {
      console.error(`  ✗ ${id} — ${err.message}`)
      failed++
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.log(`\n✓ ${passed} passed, ✗ ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1]?.endsWith('records-scrapers.mjs')) {
  selfTest().catch((e) => {
    console.error('\n✗ fatal:', e.message)
    process.exit(1)
  })
}
