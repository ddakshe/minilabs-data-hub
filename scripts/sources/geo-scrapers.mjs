// geo-scrapers.mjs — Wikipedia-based scrapers for GEOGRAPHY & MISC categories
//
// Usage:
//   node scripts/sources/geo-scrapers.mjs          # self-test
//
// Exports: scrapeBuilding, scrapeBridge, scrapeFastestCar,
//          scrapeExpensivePainting, scrapeTouristCity, scrapeNobel

import * as cheerio from 'cheerio'

// ───────────────────────── helpers ─────────────────────────

const WIKI_UA = 'minilabs-data-hub/1.0 (+https://github.com/ddakshe/minilabs-data-hub)'

async function fetchWikiHtml(page, section) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=text&section=${section}&format=json`
  const res = await fetch(url, { headers: { 'User-Agent': WIKI_UA } })
  if (!res.ok) throw new Error(`Wikipedia API HTTP ${res.status}: ${page}`)
  const json = await res.json()
  if (json.error) throw new Error(`Wikipedia: ${json.error.info}`)
  return cheerio.load(json.parse.text['*'])
}

/** Fetch sections list for a page and return the index of the first section matching a pattern */
async function findSection(page, pattern) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=sections&format=json`
  const res = await fetch(url, { headers: { 'User-Agent': WIKI_UA } })
  if (!res.ok) throw new Error(`Wikipedia sections API HTTP ${res.status}: ${page}`)
  const json = await res.json()
  if (json.error) throw new Error(`Wikipedia sections: ${json.error.info}`)
  const sections = json.parse.sections || []
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i')
  const match = sections.find((s) => re.test(s.line))
  return match ? Number(match.index) : null
}

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
  AE: '아랍에미리트', SA: '사우디아라비아', MY: '말레이시아', TW: '대만',
  PK: '파키스탄', NP: '네팔', TH: '태국', TR: '튀르키예', EG: '이집트',
  BD: '방글라데시', NG: '나이지리아', PH: '필리핀', ID: '인도네시아',
  ET: '에티오피아', CD: '콩고민주', TZ: '탄자니아', AR: '아르헨티나',
  DZ: '알제리', SD: '수단', QA: '카타르', KZ: '카자흐스탄',
  SE: '스웨덴', NL: '네덜란드', CH: '스위스', AT: '오스트리아',
  NO: '노르웨이', DK: '덴마크', FI: '핀란드', PL: '폴란드',
  BE: '벨기에', IE: '아일랜드', PT: '포르투갈', CZ: '체코',
  GR: '그리스', HU: '헝가리', RO: '루마니아', IL: '이스라엘',
  SG: '싱가포르', VN: '베트남', HK: '홍콩', CL: '칠레',
  CO: '콜롬비아', PE: '페루', ZA: '남아공', NZ: '뉴질랜드',
  UA: '우크라이나', HR: '크로아티아', RS: '세르비아', BG: '불가리아',
  KW: '쿠웨이트', BH: '바레인', OM: '오만', PA: '파나마',
  LU: '룩셈부르크', MC: '모나코', IS: '아이슬란드',
}

function krName(code, fallback) { return COUNTRY_KR[code] || fallback }

// English country name → ISO2 code
const ENNAME_TO_ISO2 = {
  'United States': 'US', 'United Kingdom': 'GB', China: 'CN', Germany: 'DE',
  Japan: 'JP', France: 'FR', Italy: 'IT', Canada: 'CA', Brazil: 'BR',
  Russia: 'RU', India: 'IN', Australia: 'AU', Spain: 'ES', Mexico: 'MX',
  'South Korea': 'KR', 'North Korea': 'KP', Taiwan: 'TW', Thailand: 'TH',
  Turkey: 'TR', 'Saudi Arabia': 'SA', 'United Arab Emirates': 'AE',
  Malaysia: 'MY', Indonesia: 'ID', Pakistan: 'PK', Bangladesh: 'BD',
  Nigeria: 'NG', Egypt: 'EG', Philippines: 'PH', Vietnam: 'VN',
  Singapore: 'SG', 'Hong Kong': 'HK', Netherlands: 'NL', Belgium: 'BE',
  Sweden: 'SE', Switzerland: 'CH', Austria: 'AT', Norway: 'NO',
  Denmark: 'DK', Finland: 'FI', Poland: 'PL', Ireland: 'IE',
  Portugal: 'PT', 'Czech Republic': 'CZ', Czechia: 'CZ',
  Greece: 'GR', Hungary: 'HU', Romania: 'RO', Israel: 'IL',
  Argentina: 'AR', Chile: 'CL', Colombia: 'CO', Peru: 'PE',
  'South Africa': 'ZA', 'New Zealand': 'NZ', Ukraine: 'UA',
  Croatia: 'HR', Serbia: 'RS', Bulgaria: 'BG', Kuwait: 'KW',
  Qatar: 'QA', Bahrain: 'BH', Oman: 'OM', Panama: 'PA',
  Iran: 'IR', Iraq: 'IQ', Kazakhstan: 'KZ', Luxembourg: 'LU',
  Monaco: 'MC', Iceland: 'IS', Nepal: 'NP', Ethiopia: 'ET',
  Sudan: 'SD', Algeria: 'DZ', Morocco: 'MA', Kenya: 'KE',
  Cuba: 'CU', Azerbaijan: 'AZ', Mozambique: 'MZ',
  'Sri Lanka': 'LK', Myanmar: 'MM', Cambodia: 'KH', Laos: 'LA',
  'Soviet Union': 'RU',
}

// City → ISO2 (for tourist-city scraper)
const CITY_TO_ISO2 = {
  Bangkok: 'TH', Paris: 'FR', London: 'GB', Dubai: 'AE',
  Singapore: 'SG', Istanbul: 'TR', Tokyo: 'JP', Antalya: 'TR',
  Seoul: 'KR', Osaka: 'JP', Mecca: 'SA', Phuket: 'TH',
  Pattaya: 'TH', Milan: 'IT', Barcelona: 'ES', Bali: 'ID',
  'Hong Kong': 'HK', 'Kuala Lumpur': 'MY', 'New York': 'US',
  'New York City': 'US', Shenzhen: 'CN', Delhi: 'IN',
  'New Delhi': 'IN', Mumbai: 'IN', Taipei: 'TW', Rome: 'IT',
  Prague: 'CZ', Amsterdam: 'NL', Vienna: 'AT', 'Los Angeles': 'US',
  Lisbon: 'PT', Munich: 'DE', Athens: 'GR', Macau: 'MO',
  Doha: 'QA', Dublin: 'IE', Riyadh: 'SA', Hanoi: 'VN',
  'Ho Chi Minh City': 'VN', Jakarta: 'ID', Cairo: 'EG',
  Cancun: 'MX', Cancún: 'MX', Miami: 'US', Guangzhou: 'CN',
  Shanghai: 'CN', Beijing: 'CN', Sydney: 'AU', Melbourne: 'AU',
  Bucharest: 'RO', Budapest: 'HU', Moscow: 'RU',
  'St Petersburg': 'RU', 'Saint Petersburg': 'RU',
  Medina: 'SA', Jeddah: 'SA',
}

// Car manufacturer → ISO2
const CAR_MAKER_ISO2 = {
  bugatti: 'FR', ssc: 'US', koenigsegg: 'SE', hennessey: 'US',
  mclaren: 'GB', ferrari: 'IT', lamborghini: 'IT', porsche: 'DE',
  pagani: 'IT', rimac: 'HR', aston: 'GB', 'aston martin': 'GB',
  mercedes: 'DE', 'mercedes-benz': 'DE', bmw: 'DE', audi: 'DE',
  ford: 'US', chevrolet: 'US', dodge: 'US', shelby: 'US',
  toyota: 'JP', nissan: 'JP', honda: 'JP', lexus: 'JP',
  saleen: 'US', noble: 'GB', lotus: 'GB', jaguar: 'GB',
  zenvo: 'DK', czinger: 'US', devel: 'AE', 'devel sixteen': 'AE',
  tesla: 'US', pininfarina: 'IT', 'de tomaso': 'IT',
  hyundai: 'KR', kia: 'KR', genesis: 'KR',
  venom: 'US', tuatara: 'US', chiron: 'FR', jesko: 'SE',
}

function resolveCarCountry(carName) {
  const lower = carName.toLowerCase()
  for (const [key, iso2] of Object.entries(CAR_MAKER_ISO2)) {
    if (lower.includes(key)) return iso2
  }
  return null
}

function resolveCountryISO2(text) {
  const clean = text.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim()
  return ENNAME_TO_ISO2[clean] || null
}

// ───────────────────────── building ─────────────────────────

const BUILDING_KR = {
  'Burj Khalifa': '부르즈 할리파',
  'Merdeka 118': '메르데카 118',
  'Shanghai Tower': '상하이 타워',
  'Abraj Al-Bait Clock Tower': '메카 로얄 클락 타워',
  'Makkah Royal Clock Tower': '메카 로얄 클락 타워',
  'Abraj Al-Bait': '메카 로얄 클락 타워',
  'Ping An Finance Centre': '핑안 금융센터',
  'Ping An International Finance Centre': '핑안 금융센터',
  'Lotte World Tower': '롯데월드타워',
  'One World Trade Center': '원 월드 트레이드 센터',
  'Guangzhou CTF Finance Centre': '광저우 CTF 금융센터',
  'Tianjin CTF Finance Centre': '톈진 CTF 금융센터',
  'China Zun': '중국존 (CITIC 타워)',
  'CITIC Tower': '중국존 (CITIC 타워)',
  'Taipei 101': '타이베이 101',
  'Shanghai World Financial Center': '상하이 세계금융센터',
  'International Commerce Centre': '국제상업센터 (ICC)',
  'Wuhan Greenland Center': '우한 그린랜드 센터',
  'Landmark 81': '랜드마크 81',
  'Changsha IFS Tower T1': '창사 IFS 타워',
  'Petronas Tower 1': '페트로나스 트윈타워',
  'Petronas Towers': '페트로나스 트윈타워',
  'Zifeng Tower': '지펑 타워',
  'Suzhou IFS': '쑤저우 IFS',
  'Lakhta Center': '라흐타 센터',
  'Exchange 106': '익스체인지 106',
  'Vincom Landmark 81': '랜드마크 81',
  'Jeddah Tower': '제다 타워',
}

export async function scrapeBuilding() {
  // sec3 = "Tallest buildings in the world". Table index 1 (index 0 is a legend).
  // Row 0 = header, Row 1 = sub-header (m|ft). Data starts row 2.
  // Cols: Rank(0) | Name(1) | Height_m(2) | Height_ft(3) | Floors(4) | Image(5) | City(6) | Country(7) | Year(8)
  const $ = await fetchWikiHtml('List_of_tallest_buildings', 3)
  const tables = $('table.wikitable')
  if (tables.length < 2) throw new Error('building: expected 2+ tables in sec3')
  const rows = []
  tables.eq(1).find('tr').each(function (i) {
    if (i < 2) return // skip header + sub-header
    const cells = $(this).find('td, th')
    if (cells.length < 8) return
    const rank = parseInt($(cells[0]).text().trim())
    if (!rank || rank > 15) return
    const name = $(cells[1]).text().replace(/\[.*?\]/g, '').trim()
    const heightM = parseFloat($(cells[2]).text().replace(/,/g, '').trim()) || 0
    const floorsRaw = $(cells[4]).text().replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim()
    const floors = parseInt(floorsRaw) || 0
    const city = $(cells[6]).text().replace(/\[.*?\]/g, '').trim()
    const country = $(cells[7]).text().replace(/\[.*?\]/g, '').trim()
    const year = parseInt($(cells[8]).text().trim()) || 0
    const iso2 = resolveCountryISO2(country)
    if (name && heightM > 0) rows.push({ rank, name, heightM, floors, city, country, iso2, year })
  })
  if (rows.length === 0) throw new Error('building: no data parsed from Wikipedia table')
  rows.sort((a, b) => a.rank - b.rank)
  return rows.slice(0, 10).map((r, i) => {
    const displayName = BUILDING_KR[r.name] || r.name
    const floorStr = r.floors ? ` · ${r.floors}층` : ''
    const countryKr = r.iso2 ? krName(r.iso2, r.country) : r.country
    return {
      rank: i + 1, prev: i + 1,
      name: displayName,
      value: `${r.heightM}m${floorStr}`,
      detail: `${countryKr} ${r.city}. ${r.year}년 완공. Wikipedia.`,
      flag: r.iso2 ? countryFlag(r.iso2) : '🌐',
      ...(r.iso2 === 'KR' && { highlight: true }),
    }
  })
}

// ───────────────────────── bridge ─────────────────────────

const BRIDGE_KR = {
  'Danyang–Kunshan Grand Bridge': '단양-쿤산 대교',
  'Changhua–Kaohsiung Viaduct': '창화-카오슝 고가교',
  'Cangde Grand Bridge': '창더 대교',
  'Tianjin Grand Bridge': '톈진 대교',
  'Weinan Weihe Grand Bridge': '웨이난 웨이허 대교',
  'Bang Na Expressway': '방나 고속도로',
  'Beijing Grand Bridge': '베이징 대교',
  'Lake Pontchartrain Causeway': '폰차트레인 호수 둑길',
  'Manchac Swamp Bridge': '만착 습지 다리',
  'Yangcun Bridge': '양춘 대교',
  'Langfang–Qingxian Viaduct': '랑팡-칭셴 고가교',
  'Jining Grand Canal Bridge': '지닝 대운하 대교',
  'Wuhan Metro Bridge': '우한 지하철 교량',
  'Changde Grand Bridge': '창더 대교',
  'Jiaozhou Bay Bridge': '자오저우만 대교',
  'Haiwan Bridge': '하이완 대교',
  'Incheon Bridge': '인천대교',
  'Hong Kong–Zhuhai–Macau Bridge': '강주아오 대교',
  'Hangzhou Bay Bridge': '항저우만 대교',
  'Runyang Bridge': '룬양 대교',
}

export async function scrapeBridge() {
  // Try section 0 first (intro usually has "List of longest bridges" main table)
  let $
  try {
    $ = await fetchWikiHtml('List_of_longest_bridges', 1)
    if ($('table.wikitable').length === 0) throw new Error('no table')
  } catch {
    $ = await fetchWikiHtml('List_of_longest_bridges', 0)
  }

  const rows = []
  const tables = $('table.wikitable')
  // Pick the first sortable table with length data
  let targetTable = tables.first()

  targetTable.find('tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 3) return

    const texts = []
    cells.each(function () { texts.push($(this).text().trim()) })

    // Find name and length
    let rank = null
    let name = ''
    let lengthKm = null
    let country = null

    // Try to parse rank
    for (let j = 0; j < Math.min(texts.length, 2); j++) {
      const n = parseInt(texts[j])
      if (n > 0 && n <= 30) { rank = n; break }
    }

    // Find name: usually first cell with a link
    cells.each(function () {
      if (name) return
      const link = $(this).find('a').first()
      const linkText = link.text().trim()
      if (linkText && linkText.length > 3 && !linkText.match(/^\d/) && !resolveCountryISO2(linkText)) {
        name = linkText
      }
    })

    if (!name) {
      // Fallback: use longest text cell
      let maxLen = 0
      for (const t of texts) {
        if (t.length > maxLen && !t.match(/^\d/) && t.length < 80) {
          maxLen = t.length
          name = t
        }
      }
    }
    name = name.replace(/\[.*?\]/g, '').replace(/†|‡|\*/g, '').trim()

    // Find length in km or meters
    for (const t of texts) {
      const clean = t.replace(/,/g, '').replace(/\[.*?\]/g, '').trim()
      // km pattern
      const kmMatch = clean.match(/([\d.]+)\s*(?:km|kilometres|kilometers)/i)
      if (kmMatch) { lengthKm = parseFloat(kmMatch[1]); continue }
      // meters pattern → convert to km
      const mMatch = clean.match(/([\d,]+)\s*(?:m|metres|meters)\b/i)
      if (mMatch) {
        const meters = parseFloat(mMatch[1].replace(/,/g, ''))
        if (meters > 1000) { lengthKm = meters / 1000; continue }
      }
      // bare number that looks like km (> 1)
      const numMatch = clean.match(/^([\d.]+)$/)
      if (numMatch && !lengthKm) {
        const val = parseFloat(numMatch[1])
        if (val > 1 && val < 500) lengthKm = val
      }
    }

    // Country
    cells.each(function () {
      if (country) return
      const cellText = $(this).text().replace(/\[.*?\]/g, '').trim()
      const iso = resolveCountryISO2(cellText)
      if (iso) country = iso
      // Also check link titles
      $(this).find('a').each(function () {
        if (country) return
        const title = $(this).attr('title') || ''
        const iso2 = resolveCountryISO2(title)
        if (iso2) country = iso2
      })
    })

    if (name && lengthKm) {
      if (!rank) rank = rows.length + 1
      rows.push({ rank, name, lengthKm, country })
    }
  })

  if (rows.length === 0) throw new Error('bridge: no data parsed from Wikipedia table')

  // Sort by length descending
  rows.sort((a, b) => b.lengthKm - a.lengthKm)
  return rows.slice(0, 10).map((r, i) => {
    const displayName = BRIDGE_KR[r.name] || r.name
    const iso2 = r.country || null
    const countryKr = iso2 ? krName(iso2, '') : ''
    const lenStr = r.lengthKm >= 1
      ? `${r.lengthKm % 1 === 0 ? r.lengthKm.toFixed(0) : r.lengthKm.toFixed(1)}km`
      : `${(r.lengthKm * 1000).toFixed(0)}m`
    return {
      rank: i + 1,
      prev: i + 1,
      name: displayName,
      value: lenStr,
      detail: `${countryKr || r.name}. Wikipedia.`,
      flag: iso2 ? countryFlag(iso2) : '🌐',
      ...(iso2 === 'KR' && { highlight: true }),
    }
  })
}

// ───────────────────────── fastest-car ─────────────────────────

export async function scrapeFastestCar() {
  // Find the section with the records table
  let sectionIdx = await findSection('List_of_fastest_production_cars', /Records|Fastest|top speed/i)
  if (sectionIdx === null) sectionIdx = 0

  let $ = await fetchWikiHtml('List_of_fastest_production_cars', sectionIdx)
  if ($('table.wikitable').length === 0 && sectionIdx !== 0) {
    $ = await fetchWikiHtml('List_of_fastest_production_cars', 0)
  }

  const rows = []
  const tables = $('table.wikitable')

  // Parse all wikitables looking for speed data
  tables.each(function () {
    $(this).find('tr').each(function (i) {
      if (i < 1) return
      const cells = $(this).find('td, th')
      if (cells.length < 2) return

      const texts = []
      cells.each(function () { texts.push($(this).text().trim()) })

      let name = ''
      let speedKmh = null

      // Find car name (first long text cell, often with a link)
      cells.each(function () {
        if (name) return
        const link = $(this).find('a').first()
        const linkText = link.text().trim()
        if (linkText && linkText.length > 3 && !linkText.match(/^\d/) && !linkText.match(/^(km|mph|hp)/i)) {
          name = linkText
        }
      })
      if (!name) {
        for (const t of texts) {
          if (t.length > 3 && !t.match(/^\d/) && t.length < 80) { name = t; break }
        }
      }
      name = name.replace(/\[.*?\]/g, '').replace(/†|‡|\*/g, '').trim()

      // Find speed: km/h or mph
      for (const t of texts) {
        const clean = t.replace(/,/g, '').replace(/\[.*?\]/g, '').trim()
        const kmhMatch = clean.match(/([\d.]+)\s*(?:km\/h|km\/hr|kmh|kph)/i)
        if (kmhMatch) { speedKmh = parseFloat(kmhMatch[1]); continue }
        const mphMatch = clean.match(/([\d.]+)\s*(?:mph|mi\/h)/i)
        if (mphMatch) { speedKmh = Math.round(parseFloat(mphMatch[1]) * 1.60934); continue }
      }

      if (name && speedKmh && speedKmh > 200) {
        const iso2 = resolveCarCountry(name)
        rows.push({ name, speedKmh, country: iso2 })
      }
    })
  })

  if (rows.length === 0) throw new Error('fastest-car: no data parsed from Wikipedia table')

  // Deduplicate by name (keep fastest)
  const seen = new Map()
  for (const r of rows) {
    const key = r.name.toLowerCase()
    if (!seen.has(key) || seen.get(key).speedKmh < r.speedKmh) {
      seen.set(key, r)
    }
  }
  const unique = [...seen.values()]
  unique.sort((a, b) => b.speedKmh - a.speedKmh)

  return unique.slice(0, 10).map((r, i) => {
    const iso2 = r.country
    return {
      rank: i + 1,
      prev: i + 1,
      name: r.name,
      value: `${Math.round(r.speedKmh)}km/h`,
      detail: `양산차 기준 최고속도. Wikipedia.`,
      flag: iso2 ? countryFlag(iso2) : '🏁',
      ...(iso2 === 'KR' && { highlight: true }),
    }
  })
}

// ───────────────────────── expensive-painting ─────────────────────────

const PAINTING_KR = {
  'Salvator Mundi': '살바토르 문디',
  'Interchange': '인터체인지',
  'The Card Players': '카드놀이 하는 사람들',
  "Nafea Faa Ipoipo": '언제 결혼하니',
  "When Will You Marry?": '언제 결혼하니',
  'Number 17A': '넘버 17A',
  'No. 6 (Violet, Green and Red)': '넘버 6 (바이올렛, 그린, 레드)',
  'Wasserschlangen II': '물뱀 II',
  'Pendant portraits of Maerten Soolmans and Oopjen Coppit': '마르텐과 오프옌 초상화',
  'Les Femmes d\'Alger': '알제의 여인들',
  "Les femmes d'Alger (Version 'O')": '알제의 여인들 (버전 O)',
  'Nu couché': '누워있는 나부',
  'Shot Sage Blue Marilyn': '샷 세이지 블루 마릴린',
  'Bal du moulin de la Galette': '물랭 드 라 갈레트의 무도회',
  'Garçon à la pipe': '파이프를 든 소년',
  "Dora Maar au Chat": '고양이와 도라 마르',
  'Portrait of Adele Bloch-Bauer I': '아델레 블로흐-바우어의 초상',
  'Portrait of Dr. Gachet': '가셰 박사의 초상',
  'Irises': '아이리스',
  'Portrait of Joseph Roulin': '조제프 룰랭의 초상',
  "Bal du moulin de la Galette": '물랭 드 라 갈레트의 무도회',
  "Femme assise près d'une fenêtre (Marie-Thérèse)": '창가에 앉은 여인',
  'Meule': '건초더미',
  'Young Man Holding a Roundel': '원형화를 든 청년',
  'Rabbit (sculpture)': '래빗 (조각)',
}

// painter name → nationality
const PAINTER_KR = {
  'Leonardo da Vinci': '레오나르도 다빈치',
  'Willem de Kooning': '빌럼 데 쿠닝',
  'Paul Cézanne': '폴 세잔',
  'Paul Gauguin': '폴 고갱',
  'Jackson Pollock': '잭슨 폴록',
  'Mark Rothko': '마크 로스코',
  'Gustav Klimt': '구스타프 클림트',
  'Rembrandt': '렘브란트',
  'Pablo Picasso': '파블로 피카소',
  'Amedeo Modigliani': '아메데오 모딜리아니',
  'Andy Warhol': '앤디 워홀',
  'Francis Bacon': '프랜시스 베이컨',
  'Claude Monet': '클로드 모네',
  'Sandro Botticelli': '산드로 보티첼리',
  'Peter Paul Rubens': '루벤스',
  'Qi Baishi': '치바이스',
  'Vincent van Gogh': '빈센트 반 고흐',
}

export async function scrapeExpensivePainting() {
  // sec2 = "List of highest prices paid"
  // Cols: Adjusted$(0) | Original$(1) | Name(2) | Image(3) | Artist(4) | Year(5) | Date(6) | RankAtSale(7)
  const $ = await fetchWikiHtml('List_of_most_expensive_paintings', 2)
  const rows = []
  $('table.wikitable').first().find('tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 7) return
    const priceText = $(cells[1]).text().replace(/[~+,\[\]]/g, '').trim()
    const priceMatch = priceText.match(/\$([\d.]+)/)
    const priceUSD = priceMatch ? parseFloat(priceMatch[1]) : 0
    const name = $(cells[2]).text().replace(/\[.*?\]/g, '').trim()
    const artist = $(cells[4]).find('a').first().text().trim() || $(cells[4]).text().replace(/\[.*?\]/g, '').trim()
    const yearMatch = $(cells[6]).text().match(/((?:19|20)\d{2})/)
    const year = yearMatch ? parseInt(yearMatch[1]) : null
    if (name && priceUSD > 0) rows.push({ name, artist, priceUSD, year })
  })

  if (rows.length === 0) throw new Error('expensive-painting: no data parsed from Wikipedia table')

  rows.sort((a, b) => b.priceUSD - a.priceUSD)
  // Deduplicate
  const seen = new Set()
  const unique = rows.filter((r) => {
    const key = r.name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return unique.slice(0, 10).map((r, i) => {
    const nameKr = PAINTING_KR[r.name] || r.name
    const artistKr = r.artist ? (PAINTER_KR[r.artist] || r.artist) : ''
    const displayName = artistKr ? `${nameKr} (${artistKr})` : nameKr
    const priceStr = r.priceUSD >= 1000
      ? `${(r.priceUSD / 100).toFixed(1)}억 달러`
      : `${r.priceUSD.toFixed(0)}00만 달러`
    const yearStr = r.year ? `${r.year}년.` : ''
    return {
      rank: i + 1,
      prev: i + 1,
      name: displayName,
      value: priceStr,
      detail: `${yearStr} Wikipedia.`,
      flag: '🎨',
    }
  })
}

// ───────────────────────── tourist-city ─────────────────────────

export async function scrapeTouristCity() {
  const page = 'List_of_cities_by_international_visitors'
  // Try to find Euromonitor or main ranking section
  let sectionIdx = await findSection(page, /Euromonitor|Mastercard|Most visited|Global/i)
  if (sectionIdx === null) sectionIdx = 1

  let $ = await fetchWikiHtml(page, sectionIdx)
  if ($('table.wikitable').length === 0) {
    $ = await fetchWikiHtml(page, 0)
  }

  const rows = []
  const tables = $('table.wikitable')
  const targetTable = tables.first()

  targetTable.find('tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 2) return

    const texts = []
    cells.each(function () { texts.push($(this).text().trim()) })

    let city = ''
    let visitors = null
    let country = null
    let rank = null

    // Extract city name from links
    cells.each(function (idx) {
      if (idx > 3) return
      const links = []
      $(this).find('a').each(function () { links.push($(this).text().trim()) })

      // Check for city in CITY_TO_ISO2
      for (const link of links) {
        if (CITY_TO_ISO2[link] && !city) {
          city = link
          country = CITY_TO_ISO2[link]
        }
      }
      // Also check cell text
      const cellClean = $(this).text().replace(/\[.*?\]/g, '').trim()
      if (!city && CITY_TO_ISO2[cellClean]) {
        city = cellClean
        country = CITY_TO_ISO2[cellClean]
      }
    })

    // If no city found via lookup, use first link text
    if (!city) {
      cells.each(function () {
        if (city) return
        const link = $(this).find('a').first().text().trim()
        if (link && link.length > 1 && !link.match(/^\d/)) city = link
      })
    }

    // Find visitor count (millions)
    for (const t of texts) {
      const clean = t.replace(/,/g, '').replace(/\[.*?\]/g, '').trim()
      const mMatch = clean.match(/([\d.]+)\s*(?:million|M)/i)
      if (mMatch) { visitors = parseFloat(mMatch[1]); continue }
      // Bare decimal that looks like millions (1-100)
      const numMatch = clean.match(/^([\d.]+)$/)
      if (numMatch && !visitors) {
        const val = parseFloat(numMatch[1])
        if (val > 0.5 && val < 200) visitors = val
      }
    }

    // Rank
    for (const t of texts) {
      const n = parseInt(t)
      if (n > 0 && n <= 30 && !rank) { rank = n; break }
    }

    // Country from table
    if (!country) {
      cells.each(function () {
        if (country) return
        const cellText = $(this).text().replace(/\[.*?\]/g, '').trim()
        const iso = resolveCountryISO2(cellText)
        if (iso) country = iso
        $(this).find('a').each(function () {
          if (country) return
          const title = $(this).attr('title') || ''
          const iso2 = resolveCountryISO2(title)
          if (iso2) country = iso2
        })
      })
    }
    // Also try CITY_TO_ISO2 on cleaned city name
    if (!country && city) {
      country = CITY_TO_ISO2[city] || null
    }

    if (city && visitors) {
      if (!rank) rank = rows.length + 1
      rows.push({ rank, city, visitors, country })
    }
  })

  if (rows.length === 0) throw new Error('tourist-city: no data parsed from Wikipedia table')

  rows.sort((a, b) => b.visitors - a.visitors)
  // Deduplicate
  const seen = new Set()
  const unique = rows.filter((r) => {
    const key = r.city.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const CITY_KR = {
    Bangkok: '방콕', Paris: '파리', London: '런던', Dubai: '두바이',
    Singapore: '싱가포르', Istanbul: '이스탄불', Tokyo: '도쿄',
    Antalya: '안탈리아', Seoul: '서울', Osaka: '오사카',
    Mecca: '메카', Phuket: '푸켓', Pattaya: '파타야',
    Milan: '밀라노', Barcelona: '바르셀로나', Bali: '발리',
    'Hong Kong': '홍콩', 'Kuala Lumpur': '쿠알라룸푸르',
    'New York': '뉴욕', 'New York City': '뉴욕',
    Shenzhen: '선전', Delhi: '델리', 'New Delhi': '뉴델리',
    Mumbai: '뭄바이', Taipei: '타이베이', Rome: '로마',
    Prague: '프라하', Amsterdam: '암스테르담', Vienna: '비엔나',
    'Los Angeles': '로스앤젤레스', Lisbon: '리스본',
    Munich: '뮌헨', Athens: '아테네', Macau: '마카오',
    Doha: '도하', Dublin: '더블린', Riyadh: '리야드',
    Hanoi: '하노이', 'Ho Chi Minh City': '호치민',
    Jakarta: '자카르타', Cairo: '카이로', Cancún: '칸쿤',
    Cancun: '칸쿤', Miami: '마이애미', Guangzhou: '광저우',
    Shanghai: '상하이', Beijing: '베이징', Sydney: '시드니',
    Melbourne: '멜버른', Bucharest: '부쿠레슈티',
    Budapest: '부다페스트', Moscow: '모스크바',
    Medina: '메디나', Jeddah: '제다',
  }

  return unique.slice(0, 10).map((r, i) => {
    const cityKr = CITY_KR[r.city] || r.city
    const iso2 = r.country
    const countryKr = iso2 ? krName(iso2, '') : ''
    const visitorStr = r.visitors >= 1
      ? `${(r.visitors * 100).toFixed(0)}만 명`
      : `${(r.visitors * 1000000).toLocaleString('ko-KR')} 명`
    return {
      rank: i + 1,
      prev: i + 1,
      name: cityKr,
      value: visitorStr,
      detail: `${countryKr}. 국제 방문객 수. Wikipedia.`,
      flag: iso2 ? countryFlag(iso2) : '🌐',
      ...(iso2 === 'KR' && { highlight: true }),
    }
  })
}

// ───────────────────────── nobel ─────────────────────────

const NOBEL_COUNTRIES = [
  // Ordered by approximate laureate count — used as fallback
  { name: 'United States', iso2: 'US', count: 403 },
  { name: 'United Kingdom', iso2: 'GB', count: 137 },
  { name: 'Germany', iso2: 'DE', count: 114 },
  { name: 'France', iso2: 'FR', count: 73 },
  { name: 'Sweden', iso2: 'SE', count: 33 },
  { name: 'Russia', iso2: 'RU', count: 32 },
  { name: 'Japan', iso2: 'JP', count: 29 },
  { name: 'Canada', iso2: 'CA', count: 28 },
  { name: 'Switzerland', iso2: 'CH', count: 28 },
  { name: 'Netherlands', iso2: 'NL', count: 22 },
  { name: 'Austria', iso2: 'AT', count: 22 },
  { name: 'Italy', iso2: 'IT', count: 21 },
  { name: 'Poland', iso2: 'PL', count: 20 },
  { name: 'Norway', iso2: 'NO', count: 14 },
  { name: 'Denmark', iso2: 'DK', count: 14 },
  { name: 'Israel', iso2: 'IL', count: 13 },
  { name: 'India', iso2: 'IN', count: 12 },
  { name: 'Australia', iso2: 'AU', count: 12 },
  { name: 'South Korea', iso2: 'KR', count: 2 },
  { name: 'China', iso2: 'CN', count: 9 },
]

export async function scrapeNobel() {
  // Try "List_of_countries_by_Nobel_laureates" which sometimes has a summary table
  const page = 'List_of_countries_by_Nobel_laureates'
  let $ = await fetchWikiHtml(page, 0)

  const rows = []
  const tables = $('table.wikitable')

  if (tables.length > 0) {
    tables.first().find('tr').each(function (i) {
      if (i < 1) return
      const cells = $(this).find('td, th')
      if (cells.length < 2) return

      const texts = []
      cells.each(function () { texts.push($(this).text().replace(/\[.*?\]/g, '').trim()) })

      let countryName = ''
      let count = null
      let iso2 = null

      // Find country name (first cell with a link usually)
      cells.each(function (idx) {
        if (countryName && iso2) return
        const link = $(this).find('a').first().text().trim()
        const cellText = $(this).text().replace(/\[.*?\]/g, '').trim()
        if (!countryName && link && link.length > 2 && !link.match(/^\d/)) {
          countryName = link
          iso2 = resolveCountryISO2(link) || resolveCountryISO2(cellText)
        }
        if (!iso2 && cellText) iso2 = resolveCountryISO2(cellText)
      })

      // Find count (a number)
      for (const t of texts) {
        const n = parseInt(t.replace(/,/g, ''))
        if (n > 0 && n < 1000 && !count) { count = n; continue }
      }

      if (countryName && count && iso2) {
        rows.push({ name: countryName, count, iso2 })
      }
    })
  }

  // If we got enough data from Wikipedia, use it
  if (rows.length >= 8) {
    rows.sort((a, b) => b.count - a.count)
    // Deduplicate
    const seen = new Set()
    const unique = rows.filter((r) => {
      if (seen.has(r.iso2)) return false
      seen.add(r.iso2)
      return true
    })

    return unique.slice(0, 10).map((r, i) => ({
      rank: i + 1,
      prev: i + 1,
      name: krName(r.iso2, r.name),
      value: `수상자 ${r.count}명`,
      detail: `${r.name}. 노벨상 수상자 수. Wikipedia.`,
      flag: countryFlag(r.iso2),
      ...(r.iso2 === 'KR' && { highlight: true }),
    }))
  }

  // Fallback: use the curated NOBEL_COUNTRIES data
  console.warn('  (nobel: Wikipedia table not found or insufficient, using curated data)')
  return NOBEL_COUNTRIES.slice(0, 10).map((r, i) => ({
    rank: i + 1,
    prev: i + 1,
    name: krName(r.iso2, r.name),
    value: `수상자 ${r.count}명`,
    detail: `${r.name}. 노벨상 수상자 수. Wikipedia 기준.`,
    flag: countryFlag(r.iso2),
    ...(r.iso2 === 'KR' && { highlight: true }),
  }))
}

// ───────────────────────── self-test ─────────────────────────

export const geoScrapers = {
  building: scrapeBuilding,
  bridge: scrapeBridge,
  'fastest-car': scrapeFastestCar,
  'expensive-painting': scrapeExpensivePainting,
  'tourist-city': scrapeTouristCity,
  nobel: scrapeNobel,
}

async function selfTest() {
  console.log('▶ geo-scrapers self-test\n')
  let passed = 0
  let failed = 0

  for (const [id, fn] of Object.entries(geoScrapers)) {
    try {
      const items = await fn()
      if (!Array.isArray(items) || items.length === 0) throw new Error('empty result')
      // Validate schema
      for (const item of items) {
        if (typeof item.rank !== 'number') throw new Error(`rank missing: ${JSON.stringify(item)}`)
        if (typeof item.name !== 'string' || !item.name) throw new Error(`name missing: ${JSON.stringify(item)}`)
        if (typeof item.value !== 'string' || !item.value) throw new Error(`value missing: ${JSON.stringify(item)}`)
      }
      console.log(`  ✓ ${id} — ${items.length} items`)
      console.log(`    1위: ${items[0].flag} ${items[0].name} (${items[0].value})`)
      if (items.length > 1) {
        console.log(`    2위: ${items[1].flag} ${items[1].name} (${items[1].value})`)
      }
      passed++
    } catch (err) {
      console.error(`  ✗ ${id} — ${err.message}`)
      failed++
    }
    // Be polite to Wikipedia
    await new Promise((r) => setTimeout(r, 1000))
  }

  console.log(`\n✓ ${passed} passed, ✗ ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

// Run self-test when executed directly
if (process.argv[1]?.endsWith('geo-scrapers.mjs')) {
  selfTest().catch((e) => {
    console.error('\n✗ fatal:', e.message)
    process.exit(1)
  })
}
