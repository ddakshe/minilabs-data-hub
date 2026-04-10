// Playwright 기반 스크래퍼 — 로컬 전용
//
// Usage:
//   node scripts/fetch-rankings-pw.mjs          # 전체 실행
//   node scripts/fetch-rankings-pw.mjs kbo      # 특정 카테고리만
//
// cheerio로 안 되는 사이트(JS 동적 로딩, 봇 차단)를 Playwright로 처리.
// 실행 후 seed.json + 분리 JSON을 갱신하므로, git push하면 CDN에 반영됨.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

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

// ───────────────────────── scrapers ─────────────────────────

async function scrapeKleague(page) {
  await page.goto('https://www.kleague.com/record/team.do', { waitUntil: 'networkidle', timeout: 20000 })
  // AJAX 순위 데이터 로딩 대기 — 텍스트에 "승점"이 나타날 때까지
  await page.waitForFunction(() => document.body.innerText.includes('승점'), { timeout: 10000 })

  return await page.evaluate(() => {
    // innerText에서 순위 테이블 파싱
    const text = document.body.innerText
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)

    // "순위 ▾	클럽	경기	승점	..." 헤더 이후의 데이터 찾기
    const items = []
    const rankRegex = /^(\d+)\s+(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)/
    for (const line of lines) {
      if (items.length >= 10) break
      const m = line.match(rankRegex)
      if (m) {
        const [, rank, name, games, pts, wins, draws, losses, gf, ga, gd] = m
        items.push({
          rank: parseInt(rank),
          prev: parseInt(rank),
          name: name.trim(),
          value: `승점 ${pts}`,
          detail: `${games}경기 ${wins}승 ${draws}무 ${losses}패 (득실 ${gd}). K리그.`,
          flag: '🇰🇷',
        })
      }
    }
    return items
  })
}

async function scrapeKbo(page) {
  await page.goto('https://www.koreabaseball.com/Record/TeamRank/TeamRankDaily.aspx', { waitUntil: 'networkidle' })
  await page.waitForSelector('#cphContents_cphContents_cphContents_udpRecord table tbody tr', { timeout: 10000 })

  return await page.evaluate(() => {
    const rows = document.querySelectorAll('#cphContents_cphContents_cphContents_udpRecord table tbody tr')
    const items = []
    rows.forEach((row) => {
      const cells = row.querySelectorAll('td')
      if (cells.length < 8) return
      const rank = parseInt(cells[0]?.textContent?.trim()) || 0
      if (rank < 1 || rank > 10) return
      const name = cells[1]?.textContent?.trim() || ''
      const games = cells[2]?.textContent?.trim() || ''
      const wins = cells[3]?.textContent?.trim() || ''
      const losses = cells[4]?.textContent?.trim() || ''
      const draws = cells[5]?.textContent?.trim() || ''
      const pct = cells[6]?.textContent?.trim() || ''
      items.push({
        rank, prev: rank, name,
        value: `${wins}승 ${losses}패 (${pct})`,
        detail: `${games}경기 ${draws}무. KBO 정규시즌.`,
        flag: '🇰🇷',
      })
    })
    return items
  })
}

async function scrapeMarketCapKospi(page) {
  await page.goto('https://finance.daum.net/domestic/market_cap?view=pc', { waitUntil: 'networkidle' })
  await page.waitForSelector('table tbody tr', { timeout: 15000 })

  return await page.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr')
    const items = []
    rows.forEach((row) => {
      if (items.length >= 10) return
      const cells = row.querySelectorAll('td')
      if (cells.length < 6) return
      // 0:순위, 1:종목명, 2:현재가, 3:변동, 4:변동%, 5:거래량, 6(or5):시가총액
      const rankNum = parseInt(cells[0]?.textContent?.trim())
      const name = cells[1]?.textContent?.trim() || ''
      const price = cells[2]?.textContent?.trim() || ''
      // 시가총액은 마지막에서 두번째 또는 셀 인덱스 5
      const marketCap = cells[5]?.textContent?.trim() || ''
      if (!name || !rankNum) return
      items.push({
        rank: rankNum, prev: rankNum, name,
        value: `${marketCap}백만`,
        detail: `현재가 ${price}원. 다음 금융 기준.`,
        flag: '🇰🇷',
      })
    })
    return items
  })
}

async function scrapeForbesBillionaires(page) {
  await page.goto('https://www.forbes.com/billionaires/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(3000)

  // "See List" 클릭해서 리스트 펼치기
  const seeList = page.locator('text=See List').first()
  if (await seeList.isVisible().catch(() => false)) {
    await seeList.click()
    await page.waitForTimeout(5000)
  }

  // innerText: "1\tElon Musk" + 다음 줄 "$839 B"
  return await page.evaluate(() => {
    const text = document.body.innerText
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    const items = []
    for (let i = 0; i < lines.length && items.length < 10; i++) {
      // "1\tElon Musk" 또는 "1 Elon Musk" 패턴
      const m = lines[i].match(/^(\d{1,2})\s+(.+)$/)
      if (!m) continue
      const rank = parseInt(m[1])
      if (rank < 1 || rank > 10) continue
      const name = m[2].trim()
      // 다음 줄에서 "$xxx B" 찾기
      let wealth = ''
      for (let j = i + 1; j < i + 3 && j < lines.length; j++) {
        const wm = lines[j].match(/^\$([\d.]+)\s*B$/)
        if (wm) { wealth = lines[j]; break }
      }
      if (name && wealth && name.length > 2 && !/Net Worth|See List|Country/.test(name)) {
        items.push({
          rank, prev: rank, name,
          value: wealth,
          detail: `Forbes World's Billionaires 2026 기준.`,
          flag: '🌐',
        })
      }
    }
    return items
  })
}

// rich-kr: Forbes 한국 부자는 별도 소스 없어 스킵 (Forbes 본체에서 한국인 필터 어려움)

async function scrapeCeoSalary(page) {
  await page.goto('https://aflcio.org/paywatch/highest-paid-ceos', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('table tbody tr', { timeout: 10000 })

  return await page.evaluate(() => {
    // 0:티커, 1:회사명, 2:CEO이름, 3:연도, 4:보수
    const rows = document.querySelectorAll('table tbody tr')
    const items = []
    rows.forEach((row) => {
      if (items.length >= 10) return
      const cells = row.querySelectorAll('td')
      if (cells.length < 5) return
      const rank = items.length + 1
      const company = cells[1]?.textContent?.trim() || ''
      const name = cells[2]?.textContent?.trim() || ''
      const pay = cells[4]?.textContent?.trim() || ''
      if (name && name.length > 1) {
        items.push({
          rank, prev: rank, name,
          value: pay,
          detail: `${company}. AFL-CIO Paywatch 기준.`,
          flag: '🇺🇸',
        })
      }
    })
    return items
  })
}

async function scrapeGolfEarn(page) {
  await page.goto('https://www.livesport.com/kr/golf/rankings/pga-money/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(5000) // JS 렌더링 대기

  // innerText에서 파싱: "1.\n제이콥 브리지먼\n미국\n$6,564,485" 패턴
  return await page.evaluate(() => {
    const text = document.body.innerText
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    const items = []
    const NATIONALITY = ['미국','잉글랜드','호주','스코틀랜드','스웨덴','오스트리아','노르웨이','덴마크','콜롬비아','일본','대한민국','아일랜드','캐나다','북아일랜드','남아공','스페인','프랑스','독일','이탈리아']

    for (let i = 0; i < lines.length && items.length < 10; i++) {
      const rankMatch = lines[i].match(/^(\d+)\.$/)
      if (rankMatch) {
        const rank = parseInt(rankMatch[1])
        if (rank < 1 || rank > 10) continue
        const name = lines[i + 1] || ''
        const country = lines[i + 2] || ''
        const money = lines[i + 3] || ''
        if (name && money.startsWith('$')) {
          items.push({
            rank, prev: rank, name,
            value: money,
            detail: `${country}. PGA Tour 시즌 상금. Livesport 기준.`,
            flag: country === '대한민국' ? '🇰🇷' : '🌐',
            ...(country === '대한민국' && { highlight: true }),
          })
        }
      }
    }
    return items
  })
}

async function scrapeTennisEarn(page) {
  await page.goto('https://www.perfect-tennis.com/prize-money/atp-all-time-career-prize-money/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('table tbody tr', { timeout: 10000 })

  // 테이블: 0:Rank, 1:Player, 2:Career, 3:YTD
  return await page.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr')
    const items = []
    rows.forEach((row) => {
      if (items.length >= 10) return
      const cells = row.querySelectorAll('td')
      if (cells.length < 3) return
      const rank = parseInt(cells[0]?.textContent?.trim())
      if (!rank || rank < 1 || rank > 10) return
      const name = cells[1]?.textContent?.trim() || ''
      const career = cells[2]?.textContent?.trim() || ''
      if (name && career) {
        items.push({
          rank, prev: rank, name,
          value: career,
          detail: `ATP 통산 상금. perfect-tennis.com 기준.`,
          flag: '🌐',
        })
      }
    })
    return items
  })
}

async function scrapeNbaSalary(page) {
  await page.goto('https://www.hoopshype.com/salaries/players/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('table tbody tr', { timeout: 10000 })

  // 0:순위, 1:이름, 2:2025-26 연봉
  return await page.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr')
    const items = []
    rows.forEach((row) => {
      if (items.length >= 10) return
      const cells = row.querySelectorAll('td')
      if (cells.length < 3) return
      const rankText = cells[0]?.textContent?.trim().replace('T', '')
      const rank = parseInt(rankText)
      if (!rank || rank > 10) return
      const name = cells[1]?.textContent?.trim() || ''
      const salary = cells[2]?.textContent?.trim() || ''
      if (name && salary) {
        items.push({
          rank: items.length + 1, prev: items.length + 1, name,
          value: salary,
          detail: `2025-26 시즌 연봉. HoopsHype 기준.`,
          flag: '🇺🇸',
        })
      }
    })
    return items
  })
}

async function scrapeMlbSalary(page) {
  await page.goto('https://www.spotrac.com/mlb/rankings', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(5000)

  // innerText 파싱
  return await page.evaluate(() => {
    const text = document.body.innerText
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    const items = []
    // "$xx,xxx,xxx" 패턴으로 연봉 줄 찾기
    for (let i = 0; i < lines.length && items.length < 10; i++) {
      const salaryMatch = lines[i].match(/^\$[\d,]+$/)
      if (salaryMatch && items.length < 10) {
        // 이전 줄에 선수 이름
        const name = lines[i - 1] || ''
        const salary = lines[i]
        if (name && name.length > 3 && !name.includes('SEASON') && !name.includes('TEAM') && !/^\$/.test(name)) {
          items.push({
            rank: items.length + 1, prev: items.length + 1, name,
            value: salary,
            detail: `MLB 시즌 연봉. Spotrac 기준.`,
            flag: '🇺🇸',
          })
        }
      }
    }
    return items
  })
}

async function scrapeFootballSalary(page) {
  await page.goto('https://www.salaryleaks.com/football', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(3000)

  return await page.evaluate(() => {
    const text = document.body.innerText
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    const items = []
    const seen = new Set()

    const all = []
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('Football •')) {
        const name = lines[i - 1] || ''
        const salary = lines[i + 1] || ''
        if (name && /^[€£$]/.test(salary) && !seen.has(name)) {
          seen.add(name)
          const team = lines[i].replace('Football • ', '')
          // 금액을 숫자로 변환 (€200m → 200000000)
          const m = salary.match(/^([€£$])([\d.]+)([mk]?)$/i)
          let numVal = 0
          if (m) {
            numVal = parseFloat(m[2])
            if (m[3].toLowerCase() === 'm') numVal *= 1e6
            if (m[3].toLowerCase() === 'k') numVal *= 1e3
          }
          all.push({ name, salary, team, numVal })
        }
      }
    }
    // 금액 내림차순 정렬
    all.sort((a, b) => b.numVal - a.numVal)
    return all.slice(0, 10).map((p, i) => ({
      rank: i + 1, prev: i + 1, name: p.name,
      value: p.salary,
      detail: `${p.team}. SalaryLeaks 기준.`,
      flag: '⚽',
    }))
  })
}

async function scrapeKlpga(page) {
  await page.goto('https://klpga.co.kr/web/record/publicRecord', { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForTimeout(3000)

  // innerText 기반 파싱: "상금순위\n1\n임진영\n대방건설\n222,950,000" 패턴
  return await page.evaluate(() => {
    const text = document.body.innerText
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    const items = []
    // "상금순위" 이후 데이터 찾기
    let foundSection = false
    for (let i = 0; i < lines.length && items.length < 10; i++) {
      if (lines[i] === '상금순위') { foundSection = true; continue }
      if (foundSection && /^FULL RANKING/.test(lines[i])) break // 다음 섹션
      if (foundSection) {
        const rankNum = parseInt(lines[i])
        if (rankNum >= 1 && rankNum <= 10) {
          const name = lines[i + 1] || ''
          const team = lines[i + 2] || ''
          const money = lines[i + 3] || ''
          // money가 숫자,숫자 형태인지 확인
          if (name && /[\d,]+/.test(money)) {
            const moneyNum = parseInt(money.replace(/,/g, ''))
            const fmtMoney = moneyNum >= 1e8
              ? `${(moneyNum / 1e8).toFixed(1)}억원`
              : `${(moneyNum / 1e4).toLocaleString('ko-KR')}만원`
            items.push({
              rank: rankNum, prev: rankNum, name,
              value: fmtMoney,
              detail: `${team}. KLPGA 시즌 상금. klpga.co.kr 기준.`,
              flag: '🇰🇷',
            })
          }
        }
      }
    }
    return items
  })
}

// ───────────────────────── registry ─────────────────────────

// daily: 매일 변동하는 데이터 (리그 순위, 시총)
// weekly: 주 1회면 충분한 데이터 (연봉, 상금, 부자 등)
const DAILY = {
  kleague: scrapeKleague,
  kbo: scrapeKbo,
  'market-cap-kospi': scrapeMarketCapKospi,
  'nba-salary': scrapeNbaSalary,
  'mlb-salary': scrapeMlbSalary,
}

const WEEKLY = {
  rich: scrapeForbesBillionaires,
  'ceo-salary': scrapeCeoSalary,
  'golf-earn': scrapeGolfEarn,
  'tennis-earn': scrapeTennisEarn,
  'golf-women': scrapeKlpga,
  'football-salary': scrapeFootballSalary,
}

const scrapers = { ...DAILY, ...WEEKLY }

// ───────────────────────── main ─────────────────────────

async function main() {
  const args = process.argv.slice(2)

  const seed = JSON.parse(await fs.readFile(SEED_PATH, 'utf-8'))
  const today = new Date().toISOString().split('T')[0]

  let toRun
  if (args.includes('--daily')) {
    toRun = Object.entries(DAILY)
  } else if (args.includes('--weekly')) {
    toRun = Object.entries(WEEKLY)
  } else if (args.length > 0 && !args[0].startsWith('--')) {
    toRun = Object.entries(scrapers).filter(([id]) => args.includes(id))
  } else {
    toRun = Object.entries(scrapers)
  }

  console.log(`▶ Playwright 스크래핑 (${toRun.length}개 카테고리)\n`)

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'ko-KR',
    viewport: { width: 1280, height: 800 },
  })

  let updated = 0
  let failed = 0

  for (const [catId, scraper] of toRun) {
    const page = await context.newPage()
    try {
      const items = await scraper(page)
      if (Array.isArray(items) && items.length > 0) {
        seed.rankings[catId] = items
        const cat = seed.categories.find((c) => c.id === catId)
        if (cat) cat.updatedAt = today
        updated++
        console.log(`  ✓ ${catId} — ${items.length} items (1위: ${items[0]?.name})`)
      } else {
        throw new Error('데이터 추출 실패 (0건)')
      }
    } catch (err) {
      failed++
      console.error(`  ✗ ${catId} — ${err.message}`)
    }
    await page.close()
    await new Promise((r) => setTimeout(r, 1000)) // 사이트 간 간격
  }

  await browser.close()

  // seed.json 갱신
  seed.updatedAt = today
  await fs.writeFile(SEED_PATH, JSON.stringify(seed, null, 2) + '\n')

  // index.json + 그룹별 JSON 재생성 (fetch-rankings.mjs와 동일)
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

  for (const group of seed.groups) {
    const catIds = seed.categories.filter((c) => c.groupId === group.id).map((c) => c.id)
    const rankings = {}
    for (const id of catIds) rankings[id] = seed.rankings[id] || []
    await fs.writeFile(
      path.join(OUTPUT_DIR, `${group.id}.json`),
      JSON.stringify({ updatedAt: today, rankings }, null, 2) + '\n',
    )
  }

  console.log(`\n✓ 완료: ${updated} 성공, ${failed} 실패`)
  if (failed > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('\n✗ fatal:', e.message)
  process.exit(1)
})
