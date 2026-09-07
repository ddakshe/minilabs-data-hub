// 서울경찰청 "오늘의 집회/시위" 스크래퍼 — hansanhae-mini(한산해) 집회 섹션용.
// 출력: protest/assemblies.json
//
// 소스: https://www.smpa.go.kr/user/nd54882.do (게시판)
//   - 목록의 링크는 javascript:goBoardView(...)지만 실제로는 단순 GET 이동이라
//     ?View&boardNo=00340056 형태로 바로 상세를 받을 수 있다. (JS 렌더링 아님)
//   - 제목이 "오늘의 집회 260907 월" 형식이라 제목만으로 대상 날짜가 나온다.
//   - 금요일에 토·일·월 3일치가 한꺼번에 올라온다. 즉 하루 이상 앞선 정보가 잡힌다.
//
// 본문은 HWP에서 붙여넣은 HTML이라 한 줄 = 하나의 <p>다. .bcontent 안의 <p>만
// 텍스트로 뽑으면 원본 줄바꿈이 그대로 복원된다.
//
//   1.
//   집회 일시 : 08:00~12:00
//   집회 장소 : 대우건설 앞 인도 <을지로4가>
//   신고 인원 : 100명
//   관할서 : 중부
//
// 주최·단체·목적은 원문에 아예 없다(일시/장소/인원/관할서 4개뿐). 정치색 없는
// 교통 정보로만 다룰 수 있는 이유다. 파생 필드도 그 범위를 넘지 않는다.
//
// Usage:
//   node scripts/fetch-protest.mjs          # 오늘~+7일
//   node scripts/fetch-protest.mjs 14       # 오늘~+14일

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../protest/assemblies.json')

const BOARD_URL = 'https://www.smpa.go.kr/user/nd54882.do'
const HORIZON_DAYS = Number(process.argv[2]) || 7

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function todayKST() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
}

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

async function httpText(url, { retries = 3, timeoutMs = 30000 } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (err) {
      lastErr = err
      if (attempt < retries) await sleep(500 * 2 ** attempt)
    }
  }
  throw lastErr
}

// ── 관할서 → 자치구 ───────────────────────────────────────────────────────────
// 본문에 좌표도 주소도 없지만 `관할서` 필드가 있다. 서울 경찰서 31개는 고정이라
// 이 표 하나면 지역 매칭이 끝난다 — 지오코딩도 법정동 코드도 필요 없다.
// (서부서는 은평서와 함께 은평구를 관할한다. 마포구 아님.)
const STATION_TO_DISTRICT = {
  중부: '중구',
  남대문: '중구',
  종로: '종로구',
  혜화: '종로구',
  용산: '용산구',
  서대문: '서대문구',
  서부: '은평구',
  은평: '은평구',
  마포: '마포구',
  성동: '성동구',
  광진: '광진구',
  동대문: '동대문구',
  중랑: '중랑구',
  성북: '성북구',
  종암: '성북구',
  강북: '강북구',
  도봉: '도봉구',
  노원: '노원구',
  양천: '양천구',
  강서: '강서구',
  구로: '구로구',
  금천: '금천구',
  영등포: '영등포구',
  동작: '동작구',
  관악: '관악구',
  서초: '서초구',
  방배: '서초구',
  강남: '강남구',
  수서: '강남구',
  송파: '송파구',
  강동: '강동구',
}

/**
 * 관할서는 행진일 때 "종로, 남대문"처럼 여러 개가 온다.
 * 한 지점 집회보다 행진이 통행 영향이 크므로, 지나는 구를 전부 잡아야 한다.
 * 반환은 항상 배열이고, 매핑 실패한 이름은 경고를 남기고 버린다.
 */
function toDistricts(raw) {
  const stations = (raw ?? '')
    .split(/[,·/]/)
    .map((s) => s.replace(/경찰서$/, '').trim())
    .filter(Boolean)
  const out = []
  for (const st of stations) {
    const d = STATION_TO_DISTRICT[st]
    if (!d) {
      console.warn(`⚠ 관할서 매핑 없음: "${st}"`)
      continue
    }
    if (!out.includes(d)) out.push(d)
  }
  return { stations, districts: out }
}

// 신고 인원 → 체감 등급. 원문은 100명과 50,000명을 똑같이 나열하지만
// 통행에 미치는 영향은 전혀 다르다. 가공 가치가 생기는 지점.
function gradeScale(people) {
  if (people == null) return null
  if (people >= 10000) return 'huge'
  if (people >= 3000) return 'large'
  if (people >= 500) return 'medium'
  return 'small'
}

const SCALE_LABEL = { small: '소규모', medium: '보통', large: '대규모', huge: '초대형' }

// 경찰 문서 관행상 한자가 섞여 나온다. "교대역 7出 앞" → "교대역 7번 출구 앞"
function normalizePlace(text) {
  return text
    .replace(/(\d+)\s*出/g, '$1번 출구')
    .replace(/出/g, '출구')
    .replace(/\s*-+>\s*/g, ' → ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── 목록 파싱 ────────────────────────────────────────────────────────────────
// <a href="javascript:goBoardView('/user/nd54882.do','View','00340056');">오늘의 집회 260907 월</a>
function parseList(html) {
  const $ = cheerio.load(html)
  const posts = []

  $('a[href*="goBoardView"]').each((_, el) => {
    const href = $(el).attr('href') || ''
    const boardNo = href.match(/'(\d{6,})'\s*\)/)?.[1]
    const title = $(el).text().replace(/\s+/g, ' ').trim()
    if (!boardNo || !title) return

    // "오늘의 집회 260907 월" → 2026-09-07
    const ymd = title.match(/(\d{2})(\d{2})(\d{2})/)
    if (!ymd) return
    const date = `20${ymd[1]}-${ymd[2]}-${ymd[3]}`

    const postedAt = $(el).closest('tr').find('td').eq(-2).text().trim()
    posts.push({
      date,
      boardNo,
      title,
      postedAt: /^\d{4}-\d{2}-\d{2}$/.test(postedAt) ? postedAt : null,
      url: `${BOARD_URL}?View&boardNo=${boardNo}`,
    })
  })

  // 같은 날짜가 재공지되면 최신 boardNo(=큰 번호)만 남긴다.
  const byDate = new Map()
  for (const p of posts) {
    const prev = byDate.get(p.date)
    if (!prev || p.boardNo > prev.boardNo) byDate.set(p.date, p)
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

// ── 상세 파싱 ────────────────────────────────────────────────────────────────
function parseDetail(html) {
  const $ = cheerio.load(html)
  const scope = $('.bcontent').length ? $('.bcontent') : $('body')

  // HWP 붙여넣기 HTML은 한 줄 = <p><span>텍스트</span></p> 구조다.
  // p와 span을 함께 훑으면 같은 줄이 두 번 잡히므로 <p>만 본다.
  // (<p>가 하나도 없는 다른 형식이면 블록 요소로 폴백)
  let nodes = scope.find('p')
  if (nodes.length === 0) nodes = scope.find('div, td, li')

  const lines = []
  nodes.each((_, el) => {
    const $el = $(el)
    if ($el.children('p, div, table, ul').length) return // 컨테이너는 건너뜀
    const t = $el.text().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
    if (t) lines.push(t)
  })

  const items = []
  let cur = null
  const push = () => {
    if (cur && (cur.time || cur.place)) items.push(cur)
    cur = null
  }

  for (const line of lines) {
    const m = line.match(/^(집회\s*일시|집회\s*장소|신고\s*인원|관할서)\s*[:：]\s*(.*)$/)
    if (!m) continue
    const key = m[1].replace(/\s+/g, '')
    const val = m[2].trim()

    if (key === '집회일시') {
      push()
      cur = { time: null, startTime: null, endTime: null, place: null, dong: null, people: null, peopleText: null, stations: [], districts: [], station: null, district: null, scale: null }
      cur.time = val || null
      const t = val.match(/(\d{1,2}:\d{2})\s*[~\-–]\s*(\d{1,2}:\d{2})/)
      if (t) {
        cur.startTime = t[1].padStart(5, '0')
        cur.endTime = t[2].padStart(5, '0')
      }
      continue
    }
    if (!cur) continue

    if (key === '집회장소') {
      // "대우건설 앞 인도 <을지로4가>" → place + dong
      const d = val.match(/[<〈＜]([^>〉＞]+)[>〉＞]\s*$/)
      cur.dong = d ? d[1].trim() : null
      const place = val.replace(/[<〈＜][^>〉＞]+[>〉＞]\s*$/, '').trim() || val
      cur.place = normalizePlace(place)
    } else if (key === '신고인원') {
      cur.peopleText = val || null
      const n = val.replace(/[,\s]/g, '').match(/(\d+)\s*명/)
      cur.people = n ? Number(n[1]) : null
      cur.scale = gradeScale(cur.people)
    } else if (key === '관할서') {
      const { stations, districts } = toDistricts(val)
      cur.stations = stations
      cur.districts = districts
      // 표시용 대표값 — 행진이면 첫 관할구
      cur.station = stations[0] ?? null
      cur.district = districts[0] ?? null
    }
  }
  push()

  return items
}

async function readExisting() {
  try {
    return JSON.parse(await fs.readFile(OUTPUT_PATH, 'utf8'))
  } catch {
    return { days: [] }
  }
}

async function main() {
  const today = todayKST()
  const until = addDays(today, HORIZON_DAYS)

  console.log(`대상 기간: ${today} ~ ${until}`)

  const listHtml = await httpText(BOARD_URL)
  const posts = parseList(listHtml).filter((p) => p.date >= today && p.date <= until)
  console.log(`게시글 ${posts.length}건 (오늘 이후)`)

  const existing = await readExisting()
  const prevByDate = new Map((existing.days || []).map((d) => [d.date, d]))

  const days = []
  for (const post of posts) {
    try {
      const html = await httpText(post.url)
      const items = parseDetail(html)
      if (items.length === 0) throw new Error('본문에서 집회 항목을 찾지 못함')
      days.push({ ...post, items })
      console.log(`✓ ${post.date} (${post.title}): ${items.length}건`)
    } catch (err) {
      // 상세 실패 → 직전 수집분 유지. 소스가 잠깐 죽어도 앱이 빈 화면이 되지 않게.
      const prev = prevByDate.get(post.date)
      if (prev) {
        days.push(prev)
        console.warn(`⚠ ${post.date}: 파싱 실패(${err.message}) → 직전 데이터 ${prev.items.length}건 유지`)
      } else {
        console.warn(`⚠ ${post.date}: 파싱 실패(${err.message}) → 건너뜀`)
      }
    }
    await sleep(600) // 정부 사이트라 넉넉히 쉰다
  }

  days.sort((a, b) => a.date.localeCompare(b.date))

  const out = {
    updatedAt: today,
    source: {
      name: '서울경찰청 오늘의 집회/시위',
      url: BOARD_URL,
      note: '신고 기준이며 실제 개최 여부·규모는 다를 수 있음. 주최·목적 정보는 원문에 없음.',
    },
    scaleLabels: SCALE_LABEL,
    days,
  }

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8')

  const total = days.reduce((n, d) => n + d.items.length, 0)
  const unmapped = days.flatMap((d) => d.items).filter((i) => i.stations?.length && !i.districts?.length).length
  console.log(`\n✅ ${OUTPUT_PATH}\n   ${days.length}일 · 집회 ${total}건 · ${out.updatedAt}`)
  if (unmapped) console.warn(`   ⚠ 자치구 미매핑 ${unmapped}건`)
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
