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
import * as cheerio from 'cheerio'

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

// ───────────────────────── F1 (Jolpica-F1 / ex-Ergast) ─────────────────────────
//
// 무료·무인증 JSON API. Ergast의 공식 후계자.
// 드라이버/컨스트럭터 포인트는 레이스 종료 직후 반영.
// 응답 구조는 레거시 XML 스타일이라 깊게 타고 들어가야 함.

const F1_API_BASE = 'https://api.jolpi.ca/ergast/f1'

// 국적(형용사형) → ISO2 국가 코드
// Jolpica는 "Italian", "British", "Monegasque" 등 형용사를 줌.
const NATIONALITY_TO_ISO2 = {
  Italian: 'IT', British: 'GB', German: 'DE', Dutch: 'NL',
  Spanish: 'ES', French: 'FR', Monegasque: 'MC', Australian: 'AU',
  Finnish: 'FI', Mexican: 'MX', Canadian: 'CA', Japanese: 'JP',
  Thai: 'TH', 'New Zealander': 'NZ', Danish: 'DK', Swiss: 'CH',
  Polish: 'PL', Russian: 'RU', Brazilian: 'BR', Argentine: 'AR',
  American: 'US', Chinese: 'CN', Swedish: 'SE', Austrian: 'AT',
  Belgian: 'BE', Hungarian: 'HU', Korean: 'KR', Indian: 'IN',
  Indonesian: 'ID', Malaysian: 'MY', Portuguese: 'PT',
  Venezuelan: 'VE', Colombian: 'CO', Irish: 'IE', Norwegian: 'NO',
}

// 팀 → 본사 국가 ISO2 (constructor standings용)
const F1_TEAM_ISO2 = {
  mercedes: 'DE', ferrari: 'IT', red_bull: 'AT', mclaren: 'GB',
  alpine: 'FR', aston_martin: 'GB', williams: 'GB', haas: 'US',
  rb: 'IT', alphatauri: 'IT', toro_rosso: 'IT',
  audi: 'DE', sauber: 'CH', alfa: 'CH',
  cadillac: 'US',
}

// 드라이버 driverId → 한글 이름 (주요 현역 + 일부 레전드)
// 없으면 Driver.familyName 그대로 사용 (폴백).
const F1_DRIVER_KR = {
  antonelli: '안드레아 키미 안토넬리', russell: '조지 러셀',
  leclerc: '샤를 르클레르', hamilton: '루이스 해밀턴',
  norris: '란도 노리스', piastri: '오스카 피아스트리',
  bearman: '올리버 베어먼', gasly: '피에르 가슬리',
  max_verstappen: '막스 페르스타펜', lawson: '리암 로슨',
  arvid_lindblad: '아르비드 린드블라드', hadjar: '이자크 아자르',
  bortoleto: '가브리엘 보르톨레토', sainz: '카를로스 사인스',
  ocon: '에스테반 오콘', colapinto: '프랑코 콜라핀토',
  hulkenberg: '니코 휠켄베르크', albon: '알렉산더 알본',
  bottas: '발테리 보타스', perez: '세르히오 페레스',
  alonso: '페르난도 알론소', stroll: '랜스 스트롤',
  ricciardo: '다니엘 리카르도', tsunoda: '유키 츠노다',
  zhou: '저우관위',
}

// 팀 constructorId → 한글 이름
const F1_TEAM_KR = {
  mercedes: '메르세데스', ferrari: '페라리', red_bull: '레드불',
  mclaren: '맥라렌', alpine: '알파인', aston_martin: '애스턴 마틴',
  williams: '윌리엄스', haas: '하스', rb: 'RB', audi: '아우디',
  cadillac: '캐딜락', sauber: '자우버', alphatauri: '알파타우리',
}

async function fetchF1Standings(type, season = 'current', round = null) {
  // type: 'driver' | 'constructor'
  const path = round == null
    ? `${season}/${type}Standings/`
    : `${season}/${round}/${type}Standings/`
  const url = `${F1_API_BASE}/${path}`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'minilabs-data-hub/1.0 (+https://github.com/ddakshe/minilabs-data-hub)',
    },
  })
  if (!res.ok) throw new Error(`F1 API HTTP ${res.status}: ${url}`)
  const json = await res.json()
  const list = json?.MRData?.StandingsTable?.StandingsLists?.[0]
  if (!list) throw new Error(`F1 API: empty standings list (${url})`)
  return {
    season: list.season,
    round: Number(list.round),
    drivers: list.DriverStandings || [],
    constructors: list.ConstructorStandings || [],
  }
}

async function fetchF1Previous(type, season, currentRound) {
  // 이전 라운드 순위 조회 — prev 필드 계산용.
  // round 1이면 이전 없음 → null 반환.
  if (currentRound <= 1) return null
  try {
    return await fetchF1Standings(type, season, currentRound - 1)
  } catch (err) {
    console.warn(`    (prev round unavailable: ${err.message})`)
    return null
  }
}

async function scrapeF1Drivers() {
  const current = await fetchF1Standings('driver')
  const prev = await fetchF1Previous('driver', current.season, current.round)

  const prevRankById = new Map()
  if (prev) {
    for (const d of prev.drivers) {
      prevRankById.set(d.Driver.driverId, Number(d.position))
    }
  }

  return current.drivers.slice(0, 10).map((d) => {
    const rank = Number(d.position)
    const driverId = d.Driver.driverId
    const iso2 = NATIONALITY_TO_ISO2[d.Driver.nationality] || null
    const nameKr = F1_DRIVER_KR[driverId] || `${d.Driver.givenName} ${d.Driver.familyName}`
    const team = d.Constructors?.[0]
    const teamKr = team ? (F1_TEAM_KR[team.constructorId] || team.name) : '-'
    const wins = Number(d.wins)
    const countryKr = iso2 ? krName(iso2, d.Driver.nationality) : d.Driver.nationality
    return {
      rank,
      prev: prevRankById.get(driverId) ?? rank,
      name: nameKr,
      value: `${d.points}점`,
      detail: `${countryKr} · ${teamKr} · ${wins}승. ${current.season} 시즌 R${current.round}.`,
      flag: iso2 ? countryFlag(iso2) : '🏁',
      ...(iso2 === 'KR' && { highlight: true }),
    }
  })
}

async function scrapeF1Teams() {
  const current = await fetchF1Standings('constructor')
  const prev = await fetchF1Previous('constructor', current.season, current.round)

  const prevRankById = new Map()
  if (prev) {
    for (const c of prev.constructors) {
      prevRankById.set(c.Constructor.constructorId, Number(c.position))
    }
  }

  return current.constructors.slice(0, 10).map((c) => {
    const rank = Number(c.position)
    const id = c.Constructor.constructorId
    const iso2 = F1_TEAM_ISO2[id] || NATIONALITY_TO_ISO2[c.Constructor.nationality] || null
    const nameKr = F1_TEAM_KR[id] || c.Constructor.name
    const countryKr = iso2 ? krName(iso2, c.Constructor.nationality) : c.Constructor.nationality
    return {
      rank,
      prev: prevRankById.get(id) ?? rank,
      name: nameKr,
      value: `${c.points}점`,
      detail: `${countryKr} · ${c.wins}승. ${current.season} 시즌 R${current.round}.`,
      flag: iso2 ? countryFlag(iso2) : '🏁',
      ...(iso2 === 'KR' && { highlight: true }),
    }
  })
}

// ───────────────────────── Wikipedia (cheerio) ─────────────────────────
//
// 공통: MediaWiki parse API로 HTML을 가져와 cheerio로 파싱.
// en.wikipedia.org는 User-Agent를 요구함.

const WIKI_UA = 'minilabs-data-hub/1.0 (+https://github.com/ddakshe/minilabs-data-hub)'

async function fetchWikiHtml(page, section) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=text&section=${section}&format=json`
  const res = await fetch(url, { headers: { 'User-Agent': WIKI_UA } })
  if (!res.ok) throw new Error(`Wikipedia API HTTP ${res.status}: ${page}`)
  const json = await res.json()
  if (json.error) throw new Error(`Wikipedia: ${json.error.info}`)
  return cheerio.load(json.parse.text['*'])
}

// IOC 코드 / 영문 국가명 → ISO2 (올림픽·노벨용)
const IOC_TO_ISO2 = {
  USA: 'US', URS: 'RU', CHN: 'CN', GER: 'DE', GBR: 'GB', FRA: 'FR',
  ITA: 'IT', NOR: 'NO', SWE: 'SE', JPN: 'JP', RUS: 'RU', GDR: 'DE',
  AUS: 'AU', HUN: 'HU', KOR: 'KR', CUB: 'CU', ROU: 'RO', NED: 'NL',
  CAN: 'CA', BRA: 'BR', ESP: 'ES', FIN: 'FI', DEN: 'DK', NZL: 'NZ',
  SUI: 'CH', AUT: 'AT', CRO: 'HR', POL: 'PL', CZE: 'CZ', BEL: 'BE',
  RSA: 'ZA', ETH: 'ET', KEN: 'KE', JAM: 'JA', PRK: 'KP', IRI: 'IR',
  TUR: 'TR', UKR: 'UA', TPE: 'TW', IND: 'IN', BLR: 'BY', GRE: 'GR',
  ARG: 'AR', MEX: 'MX', COL: 'CO', THA: 'TH',
}

const ENNAME_TO_ISO2 = {
  'United States': 'US', 'United Kingdom': 'GB', 'Soviet Union': 'RU',
  China: 'CN', Germany: 'DE', 'Great Britain': 'GB', France: 'FR',
  Italy: 'IT', Norway: 'NO', Sweden: 'SE', Japan: 'JP', Russia: 'RU',
  'East Germany': 'DE', Australia: 'AU', Hungary: 'HU', 'South Korea': 'KR',
  Cuba: 'CU', Romania: 'RO', Netherlands: 'NL', Canada: 'CA', Brazil: 'BR',
  Spain: 'ES', Finland: 'FI', Denmark: 'DK', Switzerland: 'CH',
  Austria: 'AT', Poland: 'PL', 'Czech Republic': 'CZ', Belgium: 'BE',
  'South Africa': 'ZA', Kenya: 'KE', Ethiopia: 'ET', India: 'IN',
  'New Zealand': 'NZ', 'North Korea': 'KP', Turkey: 'TR', Ukraine: 'UA',
  Taiwan: 'TW', Thailand: 'TH', Argentina: 'AR', Mexico: 'MX', Iran: 'IR',
  Croatia: 'HR', Greece: 'GR', Ireland: 'IE', Portugal: 'PT', Israel: 'IL',
  'Unified Team': 'RU',
}

function resolveISO2(name) {
  // 1) IOC 코드 추출 시도 (예: "[USA]")
  const iocMatch = name.match(/\[([A-Z]{3})\]/)
  if (iocMatch && IOC_TO_ISO2[iocMatch[1]]) return IOC_TO_ISO2[iocMatch[1]]
  // 2) 영문 국가명 매칭
  const clean = name.replace(/\[.*?\]/g, '').trim()
  return ENNAME_TO_ISO2[clean] || null
}

// ── 올림픽 역대 금메달 ──
async function scrapeOlympic() {
  const $ = await fetchWikiHtml('All-time_Olympic_Games_medal_table', 1)
  const rows = []
  $('table.wikitable tr').each(function (i) {
    if (i < 2) return // 헤더 2줄
    const cells = $(this).find('td, th')
    if (cells.length < 16) return
    const rawTeam = $(cells[0]).text().trim()
    const team = rawTeam.replace(/\[.*?\]/g, '').trim()
    if (team.startsWith('Total')) return
    const gold = parseInt($(cells[12]).text().replace(/,/g, '')) || 0
    const total = parseInt($(cells[15]).text().replace(/,/g, '')) || 0
    if (gold <= 0) return
    const iso2 = resolveISO2(rawTeam)
    rows.push({ team, gold, total, iso2 })
  })
  rows.sort((a, b) => b.gold - a.gold || b.total - a.total)
  return rows.slice(0, 10).map((r, i) => ({
    rank: i + 1,
    prev: i + 1,
    name: r.iso2 ? krName(r.iso2, r.team) : r.team,
    value: `금 ${r.gold.toLocaleString('ko-KR')}개`,
    detail: `총 메달 ${r.total.toLocaleString('ko-KR')}개. Wikipedia 기준.`,
    flag: r.iso2 ? countryFlag(r.iso2) : '🏳️',
    ...(r.iso2 === 'KR' && { highlight: true }),
  }))
}

// ── 글로벌 역대 박스오피스 ──
async function scrapeBoxOfficeGlobal() {
  const $ = await fetchWikiHtml('List_of_highest-grossing_films', 1)
  const rows = []
  $('table.wikitable tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 5) return
    const rankText = $(cells[0]).text().trim()
    const rank = parseInt(rankText)
    if (!rank || rank > 10) return
    // title is in a `th` cell (scope="row") or cells[2]
    const title = $(cells[2]).text().trim().replace(/^'+|'+$/g, '')
    const grossText = $(cells[3]).text().trim()
    const grossMatch = grossText.match(/\$([\d,]+)/)
    const gross = grossMatch ? parseInt(grossMatch[1].replace(/,/g, '')) : 0
    const year = parseInt($(cells[4]).text().trim()) || 0
    rows.push({ rank, title, gross, year })
  })
  rows.sort((a, b) => a.rank - b.rank)
  return rows.slice(0, 10).map((r) => ({
    rank: r.rank,
    prev: r.rank,
    name: r.title,
    value: `$${(r.gross / 1e9).toFixed(1)}B`,
    detail: `${r.year}년. 월드와이드 흥행 수익. Box Office Mojo 기준.`,
    flag: '🎬',
  }))
}

// ── 노벨상 수상 국가별 ──
async function scrapeNobel() {
  // 한국어 위키의 "노벨상 수상자 목록" 대신 영문 위키 사용 (더 정확)
  const $ = await fetchWikiHtml('List_of_countries_by_Nobel_laureates_per_capita', 0)
  // 이 페이지 대신 절대 수로 정렬된 "List of Nobel laureates by country" 사용
  // 해당 페이지는 단순 국가별 수상자 수 목록
  throw new Error('nobel: needs different Wikipedia page — skipping for now')
}

// 노벨상은 복잡한 페이지라서 직접 "List of Nobel laureates by country" 의 도입부 표를 쓴다
async function scrapeNobelByCountry() {
  const $ = await fetchWikiHtml('List_of_Nobel_laureates_by_country', 0)
  // 이 페이지는 국가별 섹션이라 표가 없다. 대안: top-level 통계 표가 있는 페이지 사용.
  // 대안: "Nobel Prize" 메인 문서의 국가별 표
  // 실질적으로 수치 테이블이 없으므로 이 스크래퍼는 후순위.
  throw new Error('nobel: structured table not found — skipping')
}

// ── 한국 역대 박스오피스 (관객수 기준) ──
async function scrapeBoxOfficeKr() {
  const $ = await fetchWikiHtml('List_of_highest-grossing_films_in_South_Korea', 2)
  const rows = []
  $('table.wikitable tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 7) return
    const rank = parseInt($(cells[0]).text().trim())
    if (!rank || rank > 10) return
    const titleKr = $(cells[2]).text().trim()
    const titleEn = $(cells[1]).text().trim()
    const admissions = parseInt($(cells[5]).text().replace(/,/g, '')) || 0
    const year = parseInt($(cells[6]).text().trim()) || 0
    const director = $(cells[3]).text().trim()
    rows.push({ rank, titleKr, titleEn, admissions, year, director })
  })
  rows.sort((a, b) => a.rank - b.rank)
  return rows.slice(0, 10).map((r) => ({
    rank: r.rank,
    prev: r.rank,
    name: r.titleKr || r.titleEn,
    value: `${(r.admissions / 1e4).toFixed(0)}만 명`,
    detail: `${r.year}년 · 감독 ${r.director}. 전국 관객수 기준.`,
    flag: '🇰🇷',
  }))
}

// ───────────────────────── external source modules ─────────────────────────

import { entScrapers } from './sources/ent-scrapers.mjs'
import { geoScrapers } from './sources/geo-scrapers.mjs'
import { sportsScrapers } from './sources/sports-scrapers.mjs'
import { leagueScrapers } from './sources/league-scrapers.mjs'

// ───────────────────────── scrapers ─────────────────────────

// daily: 매일 변동 (리그 순위, F1)
const DAILY_SCRAPERS = {
  'f1-driver': scrapeF1Drivers,
  'f1-team': scrapeF1Teams,
  ...leagueScrapers, // epl, laliga, nba-team, mlb-team
}

// weekly: 주 1회면 충분 (경제, 역대 기록, SNS, 스포츠 랭킹 등)
const WEEKLY_SCRAPERS = {
  async gdp() {
    return buildRanking(await fetchWorldBank('NY.GDP.MKTP.CD'), 10, fmtTrillionUSD, 'World Bank 기준.')
  },
  'gdp-per-capita': async function () {
    return buildRanking(await fetchWorldBank('NY.GDP.PCAP.CD'), 10, fmtPerCapitaUSD, 'World Bank 기준.')
  },
  async population() {
    return buildRanking(await fetchWorldBank('SP.POP.TOTL'), 10, fmtPopulation, '기준 추정치.')
  },
  olympic: scrapeOlympic,
  'box-office-global': scrapeBoxOfficeGlobal,
  'box-office-kr': scrapeBoxOfficeKr,
  ...entScrapers,
  ...geoScrapers,
  ...sportsScrapers,
}

const scrapers = { ...DAILY_SCRAPERS, ...WEEKLY_SCRAPERS }

// ───────────────────────── main ─────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const seed = JSON.parse(await fs.readFile(SEED_PATH, 'utf-8'))
  const today = new Date().toISOString().split('T')[0]

  let toRun
  if (args.includes('--daily')) {
    toRun = Object.entries(DAILY_SCRAPERS)
  } else if (args.includes('--weekly')) {
    toRun = Object.entries(WEEKLY_SCRAPERS)
  } else {
    toRun = Object.entries(scrapers)
  }

  console.log(`▶ Rankings update (${seed.categories.length} categories, ${toRun.length} scrapers${args[0] ? ' [' + args[0] + ']' : ''})\n`)

  // 1) 스크래퍼 실행 → seed 데이터 업데이트
  let updated = 0
  let failed = 0

  for (const [catId, scraper] of toRun) {
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
