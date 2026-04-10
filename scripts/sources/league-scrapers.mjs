// league-scrapers.mjs — ESPN API-based live league standings scrapers
//
// Usage:
//   node scripts/sources/league-scrapers.mjs          # self-test
//
// Each export returns an array of:
//   { rank, prev, name, value, detail, flag, highlight? }
//
// ESPN free JSON API (no auth needed):
//   https://site.api.espn.com/apis/v2/sports/{sport}/{league}/standings

// ───────────────────────── helpers ─────────────────────────

const ESPN_UA = 'minilabs-data-hub/1.0 (+https://github.com/ddakshe/minilabs-data-hub)'

async function fetchEspnStandings(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': ESPN_UA, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`ESPN API HTTP ${res.status}: ${url}`)
  const json = await res.json()
  if (!json.children || !Array.isArray(json.children) || json.children.length === 0) {
    throw new Error(`ESPN API: unexpected response structure (no children) — ${url}`)
  }
  return json
}

/** Extract a stat value by name from a stats array */
function getStat(stats, name) {
  const s = stats.find((st) => st.name === name || st.abbreviation === name)
  return s ? Number(s.value) : 0
}

/** Get current season string from ESPN response */
function getSeasonLabel(json) {
  // ESPN typically includes season info at top level
  const season = json.seasons?.[0] || json.season
  if (season) {
    const year = season.year || season.displayName
    return year ? String(year) : null
  }
  return null
}

// ───────────────────────── Korean team name maps ─────────────────────────

const EPL_TEAM_KR = {
  'Arsenal': '아스널', 'Liverpool': '리버풀', 'Manchester City': '맨체스터 시티',
  'Chelsea': '첼시', 'Manchester United': '맨체스터 유나이티드', 'Tottenham Hotspur': '토트넘',
  'Newcastle United': '뉴캐슬', 'Aston Villa': '아스톤 빌라', 'Brighton & Hove Albion': '브라이턴',
  'West Ham United': '웨스트햄', 'Fulham': '풀럼', 'Wolverhampton Wanderers': '울버햄튼',
  'Bournemouth': '본머스', 'Crystal Palace': '크리스탈 팰리스', 'Brentford': '브렌트포드',
  'Everton': '에버턴', 'Nottingham Forest': '노팅엄 포레스트', 'Leicester City': '레스터 시티',
  'Ipswich Town': '입스위치', 'Southampton': '사우샘프턴',
}

const LALIGA_TEAM_KR = {
  'Real Madrid': '레알 마드리드', 'Barcelona': '바르셀로나', 'Atletico Madrid': '아틀레티코 마드리드',
  'Athletic Club': '아틀레틱 빌바오', 'Real Sociedad': '레알 소시에다드',
  'Real Betis': '레알 베티스', 'Villarreal': '비야레알', 'Sevilla': '세비야',
  'Valencia': '발렌시아', 'Celta Vigo': '셀타 비고', 'Osasuna': '오사수나',
  'Getafe': '헤타페', 'Mallorca': '마요르카', 'Rayo Vallecano': '라요 바예카노',
  'Girona': '지로나', 'Las Palmas': '라스 팔마스', 'Alavés': '알라베스',
  'Espanyol': '에스파뇰', 'Valladolid': '바야돌리드', 'Leganés': '레가네스',
  'Deportivo Alavés': '알라베스', 'Real Valladolid': '바야돌리드',
  'CD Leganés': '레가네스', 'RCD Mallorca': '마요르카', 'RCD Espanyol': '에스파뇰',
}

const NBA_TEAM_KR = {
  'Boston Celtics': '보스턴 셀틱스', 'Denver Nuggets': '덴버 너기츠',
  'Milwaukee Bucks': '밀워키 벅스', 'Philadelphia 76ers': '필라델피아 76ers',
  'Phoenix Suns': '피닉스 선즈', 'LA Clippers': 'LA 클리퍼스',
  'Los Angeles Lakers': 'LA 레이커스', 'Los Angeles Clippers': 'LA 클리퍼스',
  'New York Knicks': '뉴욕 닉스', 'Cleveland Cavaliers': '클리블랜드 캐벌리어스',
  'Sacramento Kings': '새크라멘토 킹스', 'Memphis Grizzlies': '멤피스 그리즐리스',
  'Golden State Warriors': '골든스테이트 워리어스', 'Dallas Mavericks': '댈러스 매버릭스',
  'Miami Heat': '마이애미 히트', 'Atlanta Hawks': '애틀랜타 호크스',
  'Brooklyn Nets': '브루클린 네츠', 'Toronto Raptors': '토론토 랩터스',
  'Minnesota Timberwolves': '미네소타 팀버울브스', 'New Orleans Pelicans': '뉴올리언스 펠리컨스',
  'Oklahoma City Thunder': '오클라호마시티 선더', 'Indiana Pacers': '인디애나 페이서스',
  'Chicago Bulls': '시카고 불스', 'Orlando Magic': '올랜도 매직',
  'Houston Rockets': '휴스턴 로키츠', 'San Antonio Spurs': '샌안토니오 스퍼스',
  'Utah Jazz': '유타 재즈', 'Portland Trail Blazers': '포틀랜드 트레일블레이저스',
  'Charlotte Hornets': '샬럿 호네츠', 'Detroit Pistons': '디트로이트 피스톤스',
  'Washington Wizards': '워싱턴 위저즈',
}

const MLB_TEAM_KR = {
  'New York Yankees': '뉴욕 양키스', 'Los Angeles Dodgers': 'LA 다저스',
  'Houston Astros': '휴스턴 애스트로스', 'Atlanta Braves': '애틀랜타 브레이브스',
  'Tampa Bay Rays': '탬파베이 레이스', 'Baltimore Orioles': '볼티모어 오리올스',
  'Texas Rangers': '텍사스 레인저스', 'Minnesota Twins': '미네소타 트윈스',
  'Toronto Blue Jays': '토론토 블루제이스', 'Philadelphia Phillies': '필라델피아 필리스',
  'Seattle Mariners': '시애틀 매리너스', 'Milwaukee Brewers': '밀워키 브루어스',
  'Chicago Cubs': '시카고 컵스', 'San Diego Padres': '샌디에이고 파드레스',
  'Boston Red Sox': '보스턴 레드삭스', 'Arizona Diamondbacks': '애리조나 다이아몬드백스',
  'Miami Marlins': '마이애미 말린스', 'San Francisco Giants': 'SF 자이언츠',
  'Cleveland Guardians': '클리블랜드 가디언스', 'Cincinnati Reds': '신시내티 레즈',
  'St. Louis Cardinals': '세인트루이스 카디널스', 'Kansas City Royals': '캔자스시티 로열스',
  'Detroit Tigers': '디트로이트 타이거스', 'Pittsburgh Pirates': '피츠버그 파이리츠',
  'Los Angeles Angels': 'LA 에인절스', 'Chicago White Sox': '시카고 화이트삭스',
  'New York Mets': '뉴욕 메츠', 'Washington Nationals': '워싱턴 내셔널스',
  'Oakland Athletics': '오클랜드 애슬레틱스', 'Colorado Rockies': '콜로라도 로키스',
}

// ───────────────────────── soccer standings (EPL / La Liga) ─────────────────────────

async function scrapeSoccerStandings(url, teamKrMap, leagueFlag, leagueName) {
  const json = await fetchEspnStandings(url)

  // ESPN soccer: children[0].standings.entries (single group = overall table)
  // Each entry: { team: { displayName, ... }, stats: [{ name, value }, ...] }
  const standings = json.children[0]?.standings
  if (!standings || !standings.entries) {
    throw new Error(`ESPN: no standings entries found for ${leagueName}`)
  }

  const seasonYear = getSeasonLabel(json) || new Date().getFullYear().toString()

  // Collect all entries and sort by points (descending), then by rank stat
  const entries = standings.entries.map((entry) => {
    const teamName = entry.team?.displayName || entry.team?.name || 'Unknown'
    const stats = entry.stats || []
    const points = getStat(stats, 'points')
    const wins = getStat(stats, 'wins')
    const losses = getStat(stats, 'losses')
    const draws = getStat(stats, 'ties') || getStat(stats, 'draws')
    const gamesPlayed = getStat(stats, 'gamesPlayed')
    const rankStat = getStat(stats, 'rank')

    return { teamName, points, wins, losses, draws, gamesPlayed, rankStat }
  })

  // Sort: by rank stat if available, otherwise by points descending
  entries.sort((a, b) => {
    if (a.rankStat && b.rankStat) return a.rankStat - b.rankStat
    return b.points - a.points
  })

  return entries.map((e, i) => {
    const rank = i + 1
    const nameKr = teamKrMap[e.teamName] || e.teamName
    return {
      rank,
      prev: rank, // ESPN doesn't provide previous rank
      name: nameKr,
      value: `승점 ${e.points}pts`,
      detail: `${e.wins}승 ${e.draws}무 ${e.losses}패. ${seasonYear} 시즌.`,
      flag: leagueFlag,
      highlight: false,
    }
  })
}

async function scrapeEpl() {
  return scrapeSoccerStandings(
    'https://site.api.espn.com/apis/v2/sports/soccer/eng.1/standings',
    EPL_TEAM_KR,
    '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}', // 🏴󠁧󠁢󠁥󠁮󠁧󠁿
    'EPL',
  )
}

async function scrapeLaliga() {
  return scrapeSoccerStandings(
    'https://site.api.espn.com/apis/v2/sports/soccer/esp.1/standings',
    LALIGA_TEAM_KR,
    '🇪🇸',
    'La Liga',
  )
}

// ───────────────────────── NBA standings ─────────────────────────

async function scrapeNbaTeam() {
  const url = 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings'
  const json = await fetchEspnStandings(url)

  const seasonYear = getSeasonLabel(json) || new Date().getFullYear().toString()

  // NBA: children[] = conferences (East, West). Collect all teams.
  const allTeams = []
  for (const group of json.children) {
    const confName = group.name || group.abbreviation || ''
    const standings = group.standings
    if (!standings || !standings.entries) continue

    for (const entry of standings.entries) {
      const teamName = entry.team?.displayName || entry.team?.name || 'Unknown'
      const stats = entry.stats || []
      const wins = getStat(stats, 'wins')
      const losses = getStat(stats, 'losses')
      const winPct = getStat(stats, 'winPercent') || getStat(stats, 'winPct')
      const gamesBack = getStat(stats, 'gamesBehind') || getStat(stats, 'gamesBack')

      // Determine conference label
      let conf = ''
      if (confName.toLowerCase().includes('east')) conf = '동부'
      else if (confName.toLowerCase().includes('west')) conf = '서부'

      allTeams.push({ teamName, wins, losses, winPct, gamesBack, conf })
    }
  }

  if (allTeams.length === 0) {
    throw new Error('ESPN NBA: no team entries found')
  }

  // Sort by wins descending (overall ranking)
  allTeams.sort((a, b) => b.wins - a.wins || a.losses - b.losses)

  return allTeams.map((t, i) => {
    const rank = i + 1
    const nameKr = NBA_TEAM_KR[t.teamName] || t.teamName
    const confLabel = t.conf ? ` ${t.conf} 컨퍼런스.` : ''
    return {
      rank,
      prev: rank,
      name: nameKr,
      value: `${t.wins}승 ${t.losses}패`,
      detail: `승률 ${(t.winPct > 1 ? t.winPct / 100 : t.winPct).toFixed(3)}.${confLabel} ${seasonYear} 시즌.`,
      flag: '🏀',
      highlight: false,
    }
  })
}

// ───────────────────────── MLB standings ─────────────────────────

async function scrapeMlbTeam() {
  const url = 'https://site.api.espn.com/apis/v2/sports/baseball/mlb/standings'
  const json = await fetchEspnStandings(url)

  const seasonYear = getSeasonLabel(json) || new Date().getFullYear().toString()

  // MLB: children[] = leagues (AL, NL) or divisions. Collect all teams.
  const allTeams = []
  for (const group of json.children) {
    // MLB may have nested children (league -> division)
    const subGroups = group.children || [group]
    for (const sub of subGroups) {
      const standings = sub.standings
      if (!standings || !standings.entries) continue

      for (const entry of standings.entries) {
        const teamName = entry.team?.displayName || entry.team?.name || 'Unknown'
        const stats = entry.stats || []
        const wins = getStat(stats, 'wins')
        const losses = getStat(stats, 'losses')
        const winPct = getStat(stats, 'winPercent') || getStat(stats, 'winPct')
        const gamesBack = getStat(stats, 'gamesBehind') || getStat(stats, 'gamesBack')

        allTeams.push({ teamName, wins, losses, winPct, gamesBack })
      }
    }
  }

  if (allTeams.length === 0) {
    throw new Error('ESPN MLB: no team entries found')
  }

  // Sort by wins descending
  allTeams.sort((a, b) => b.wins - a.wins || a.losses - b.losses)

  return allTeams.map((t, i) => {
    const rank = i + 1
    const nameKr = MLB_TEAM_KR[t.teamName] || t.teamName
    return {
      rank,
      prev: rank,
      name: nameKr,
      value: `${t.wins}승 ${t.losses}패`,
      detail: `승률 ${(t.winPct > 1 ? t.winPct / 100 : t.winPct).toFixed(3)}. ${seasonYear} 시즌.`,
      flag: '⚾',
      highlight: false,
    }
  })
}

// ───────────────────────── exports ─────────────────────────

export {
  scrapeEpl,
  scrapeLaliga,
  scrapeNbaTeam,
  scrapeMlbTeam,
}

export const leagueScrapers = {
  epl: scrapeEpl,
  laliga: scrapeLaliga,
  'nba-team': scrapeNbaTeam,
  'mlb-team': scrapeMlbTeam,
}

// ───────────────────────── self-test ─────────────────────────

async function selfTest() {
  console.log('=== League Scrapers Self-Test ===\n')

  const entries = Object.entries(leagueScrapers)
  let passed = 0
  let failed = 0

  for (const [id, fn] of entries) {
    try {
      const items = await fn()
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('returned empty or non-array')
      }
      // Validate schema
      for (const item of items) {
        if (typeof item.rank !== 'number') throw new Error(`rank not number: ${JSON.stringify(item)}`)
        if (typeof item.prev !== 'number') throw new Error(`prev not number: ${JSON.stringify(item)}`)
        if (typeof item.name !== 'string' || !item.name) throw new Error(`name empty: ${JSON.stringify(item)}`)
        if (typeof item.value !== 'string') throw new Error(`value not string: ${JSON.stringify(item)}`)
        if (typeof item.detail !== 'string') throw new Error(`detail not string: ${JSON.stringify(item)}`)
        if (typeof item.flag !== 'string') throw new Error(`flag not string: ${JSON.stringify(item)}`)
      }
      console.log(`  ✓ ${id} — ${items.length} items (1위: ${items[0].name} ${items[0].value})`)
      passed++
    } catch (err) {
      console.error(`  ✗ ${id} — ${err.message}`)
      failed++
    }
    // Rate limit between API calls
    await new Promise((r) => setTimeout(r, 500))
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed out of ${entries.length} ===`)
  if (failed > 0) process.exitCode = 1
}

// Run self-test if executed directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith('league-scrapers.mjs') ||
  process.argv[1].includes('league-scrapers')
)
if (isMain) {
  selfTest().catch((e) => {
    console.error('\n✗ fatal:', e.message)
    process.exit(1)
  })
}
