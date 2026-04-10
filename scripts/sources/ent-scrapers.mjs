// Entertainment category scrapers — Wikipedia-based
import * as cheerio from 'cheerio'

const WIKI_UA = 'minilabs-data-hub/1.0 (+https://github.com/ddakshe/minilabs-data-hub)'

async function fetchWikiHtml(page, section, lang = 'en') {
  const host = lang === 'ko' ? 'ko.wikipedia.org' : 'en.wikipedia.org'
  const url = `https://${host}/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=text&section=${section}&format=json`
  const res = await fetch(url, { headers: { 'User-Agent': WIKI_UA } })
  if (!res.ok) throw new Error(`Wikipedia API HTTP ${res.status}: ${page}`)
  const json = await res.json()
  if (json.error) throw new Error(`Wikipedia: ${json.error.info}`)
  return cheerio.load(json.parse.text['*'])
}

function clean(text) {
  return text.replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim()
}

/** millions (e.g. 134.8 = 134.8 million) → 한국어 억/만 */
function fmtMillions(millions, unit = '명') {
  const man = millions * 100 // 만 단위
  if (man >= 10000) return `${(man / 10000).toFixed(1)}억 ${unit}`
  if (man >= 1) return `${Math.round(man).toLocaleString('ko-KR')}만 ${unit}`
  return `${millions} ${unit}`
}

// ── 1. Billboard Hot 100 #1 최다 아티스트 ──
export async function scrapeBillboard() {
  // 정확한 페이지명: "songs" not "singles"
  // sec1 = "Billboard Hot 100 List" (Rank | Artist | No. of hits | Songs)
  const $ = await fetchWikiHtml('List_of_artists_with_the_most_Billboard_Hot_100_number-one_songs', 1)
  const rows = []
  $('table.wikitable').first().find('tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 3) return
    const artist = clean($(cells[1]).text())
    const count = parseInt(clean($(cells[2]).text())) || 0
    if (artist && count > 0) rows.push({ artist, count })
  })
  if (rows.length === 0) throw new Error('billboard: parsed 0 rows')
  rows.sort((a, b) => b.count - a.count)
  return rows.slice(0, 10).map((r, i) => ({
    rank: i + 1, prev: i + 1, name: r.artist,
    value: `${r.count}곡`, detail: `Billboard Hot 100 역대 1위 곡 수. Wikipedia 기준.`, flag: '🎵',
  }))
}

// ── 2. Spotify 월간 리스너 ──
export async function scrapeSpotify() {
  // section 5 = "Most monthly listeners", col 2 = millions
  const $ = await fetchWikiHtml('List_of_most-streamed_artists_on_Spotify', 5)
  const rows = []
  $('table.wikitable').first().find('tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 3) return
    const rank = parseInt(clean($(cells[0]).text()))
    const artist = clean($(cells[1]).text())
    const millions = parseFloat(clean($(cells[2]).text())) || 0
    if (artist && millions > 0) rows.push({ rank: rank || i, artist, millions })
  })
  if (rows.length === 0) throw new Error('spotify: parsed 0 rows')
  rows.sort((a, b) => b.millions - a.millions)
  return rows.slice(0, 10).map((r, i) => ({
    rank: i + 1, prev: i + 1, name: r.artist,
    value: fmtMillions(r.millions, '명'),
    detail: `Spotify 월간 리스너 수. Wikipedia 기준.`, flag: '🎧',
  }))
}

// ── 3. YouTube 구독자 ──
export async function scrapeYoutubeSubs() {
  // section 1 = "100 most-subscribed channels"
  // columns: Name(0), Link(1), Subscribers(millions)(2), Language(3), Category(4), Joined(5), Country(6)
  const $ = await fetchWikiHtml('List_of_most-subscribed_YouTube_channels', 1)
  const rows = []
  $('table.wikitable').first().find('tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 7) return
    const name = clean($(cells[0]).text())
    const millions = parseFloat(clean($(cells[2]).text())) || 0
    const country = clean($(cells[6]).text())
    if (name && millions > 0) rows.push({ name, millions, country })
  })
  if (rows.length === 0) throw new Error('youtube-subs: parsed 0 rows')
  rows.sort((a, b) => b.millions - a.millions)
  return rows.slice(0, 10).map((r, i) => ({
    rank: i + 1, prev: i + 1, name: r.name,
    value: fmtMillions(r.millions, '명'),
    detail: `YouTube 구독자 수. ${r.country}. Wikipedia 기준.`, flag: '📺',
  }))
}

// ── 4. Instagram 팔로워 ──
export async function scrapeInstagram() {
  // section 1, SECOND table (first is legend). Cols: Username(0), Owner(1), Followers(millions)(2), Desc(3), Country(4)
  const $ = await fetchWikiHtml('List_of_most-followed_Instagram_accounts', 1)
  const tables = $('table.wikitable')
  if (tables.length < 2) throw new Error('instagram: expected 2 tables')
  const rows = []
  tables.eq(1).find('tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 5) return
    const owner = clean($(cells[1]).text()).replace(/†/g, '')
    const millions = parseFloat(clean($(cells[2]).text())) || 0
    const desc = clean($(cells[3]).text())
    const country = clean($(cells[4]).text())
    if (owner && millions > 0) rows.push({ owner, millions, desc, country })
  })
  if (rows.length === 0) throw new Error('instagram: parsed 0 rows')
  rows.sort((a, b) => b.millions - a.millions)
  return rows.slice(0, 10).map((r, i) => ({
    rank: i + 1, prev: i + 1, name: r.owner,
    value: fmtMillions(r.millions, '명'),
    detail: `Instagram 팔로워. ${r.desc}. Wikipedia 기준.`, flag: '📸',
  }))
}

// ── 5. TikTok 팔로워 ──
export async function scrapeTiktok() {
  // section 1. Cols: Rank(0), Username(1), Owner(2), Brand(3), Followers(millions)(4), Likes(5), Desc(6), Country(7)
  const $ = await fetchWikiHtml('List_of_most-followed_TikTok_accounts', 1)
  const rows = []
  $('table.wikitable').first().find('tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 5) return
    const owner = clean($(cells[2]).text())
    const millions = parseFloat(clean($(cells[4]).text())) || 0
    const desc = cells.length > 6 ? clean($(cells[6]).text()) : ''
    if (owner && millions > 0) rows.push({ owner, millions, desc })
  })
  if (rows.length === 0) throw new Error('tiktok: parsed 0 rows')
  rows.sort((a, b) => b.millions - a.millions)
  return rows.slice(0, 10).map((r, i) => ({
    rank: i + 1, prev: i + 1, name: r.owner,
    value: fmtMillions(r.millions, '명'),
    detail: `TikTok 팔로워. ${r.desc}. Wikipedia 기준.`, flag: '🎵',
  }))
}

// ── 6. Netflix 역대 시청 시간 ──
export async function scrapeNetflix() {
  const $ = await fetchWikiHtml('List_of_most-watched_Netflix_original_programming', 1)
  const table = $('table.wikitable').first()
  const headerCells = table.find('tr').first().find('th')
  let titleCol = 1, hoursCol = 2
  headerCells.each(function (idx) {
    const h = $(this).text().toLowerCase()
    if (h.includes('title') || h.includes('show') || h.includes('series')) titleCol = idx
    if (h.includes('hour') || h.includes('view')) hoursCol = idx
  })
  const rows = []
  table.find('tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 3) return
    const title = clean($(cells[titleCol]).text())
    const hoursText = clean($(cells[hoursCol]).text())
    const hours = parseInt(hoursText.replace(/,/g, '')) || 0
    if (title && hours > 0) rows.push({ title, hours })
  })
  if (rows.length === 0) throw new Error('netflix: parsed 0 rows')
  rows.sort((a, b) => b.hours - a.hours)
  return rows.slice(0, 10).map((r, i) => ({
    rank: i + 1, prev: i + 1, name: r.title,
    value: `${(r.hours / 1e8).toFixed(1)}억 시간`,
    detail: `넷플릭스 총 시청 시간. Wikipedia 기준.`, flag: '🎬',
  }))
}

// ── 7. 아카데미상 최다 수상 ──
export async function scrapeOscar() {
  // sec1: table has merged headers. Row structure: Ceremony(0)|Year(1)|Film(2)|...|Awards(5)|Noms(6)
  // BUT some rows have fewer cells due to rowspan. We collect all (film, awards, noms) tuples.
  const $ = await fetchWikiHtml('List_of_films_with_the_most_Academy_Awards_per_ceremony', 1)
  const rows = []
  $('table.wikitable').first().find('tr').each(function (i) {
    if (i < 2) return // skip header rows
    const cells = $(this).find('td, th')
    if (cells.length < 5) return
    // Find film name (bold link in a th with scope=row, or just the first text with a link)
    let film = ''
    let awards = 0, noms = 0
    cells.each(function () {
      const text = clean($(this).text())
      const link = $(this).find('a').first().text().trim()
      const num = parseInt(text)
      if (!film && link && link.length > 2 && !link.match(/^\d/) && !link.match(/^(ceremony|year|film|best|award)/i)) {
        film = link
      }
      if (num > 0 && num <= 20 && !awards) { awards = num; return }
      if (num > 0 && num <= 20 && awards && !noms) { noms = num }
    })
    if (film && awards > 0) rows.push({ film, awards, noms })
  })
  if (rows.length === 0) throw new Error('oscar: parsed 0 rows')
  // Deduplicate by film, keeping highest awards
  const byFilm = new Map()
  for (const r of rows) {
    const existing = byFilm.get(r.film)
    if (!existing || r.awards > existing.awards) byFilm.set(r.film, r)
  }
  const unique = [...byFilm.values()]
  unique.sort((a, b) => b.awards - a.awards || b.noms - a.noms)
  return unique.slice(0, 10).map((r, i) => ({
    rank: i + 1, prev: i + 1, name: r.film,
    value: `${r.awards}개 수상`,
    detail: `${r.noms ? '후보 ' + r.noms + '개. ' : ''}아카데미상. Wikipedia 기준.`, flag: '🏆',
  }))
}

// ── 8. K-드라마 역대 시청률 ──
// Wikipedia 구조가 불안정 → seed 값 유지
export async function scrapeKdrama() {
  throw new Error('kdrama: Wikipedia 구조 불안정 — seed 유지')
}

// ── exports ──
export const entScrapers = {
  billboard: scrapeBillboard,
  spotify: scrapeSpotify,
  'youtube-subs': scrapeYoutubeSubs,
  instagram: scrapeInstagram,
  tiktok: scrapeTiktok,
  netflix: scrapeNetflix,
  oscar: scrapeOscar,
  kdrama: scrapeKdrama,
}

// ── self-test ──
if (process.argv[1]?.endsWith('ent-scrapers.mjs')) {
  let passed = 0, failed = 0
  for (const [id, fn] of Object.entries(entScrapers)) {
    try {
      const items = await fn()
      console.log(`✓ ${id} — ${items.length} items (1위: ${items[0]?.name})`)
      passed++
    } catch (err) {
      console.error(`✗ ${id} — ${err.message}`)
      failed++
    }
    await new Promise(r => setTimeout(r, 300))
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}
