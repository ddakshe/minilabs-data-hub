// 경기남부경찰청 "오늘의 주요집회" 스크래퍼.
// 출력: protest/assemblies-gg.json (서울과 같은 스키마, region 만 다르다)
//
// 소스: https://www.ggpolice.go.kr/main/bbslist.do?bbsId=FD2
//
// 서울과 다른 점 넷:
//   1. WAF 가 307 로 쿠키를 심는다 → lib/gg-board.mjs 가 처리
//   2. 상세가 폼 POST (GET 은 500)
//   3. 본문에 텍스트가 없다. 표가 JPG 한 장으로만 올라온다 → macOS Vision OCR
//      (tesseract 는 인원 30 을 64 로 조용히 오독해서 못 쓴다)
//   4. **제목에 연도가 없다** ("9.4.(금) 주요 집회"). 서울은 "260907 월" 이라
//      연도가 있었다. 대신 요일이 붙어 있어서 연도 후보를 요일로 검증할 수 있다 —
//      서울에서 연도 오타에 데었던 것보다 오히려 나은 방어다.
//
// macOS 전용이다. Vision 프레임워크를 쓰므로 self-hosted 러너에서 돌려야 한다.
//
// Usage:
//   node scripts/fetch-protest-gg.mjs        # 목록 1페이지
//   node scripts/fetch-protest-gg.mjs 3      # 3페이지까지

import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeJar, fetchList, fetchDetail, fetchBuffer, LIST_URL } from './lib/gg-board.mjs'
import { parseTable } from './lib/gg-parse.mjs'
import { toCities } from './lib/gg-districts.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../protest/assemblies-gg.json')
const OCR_BIN = path.resolve(__dirname, 'lib/ocr-vision')
const OCR_SRC = path.resolve(__dirname, 'lib/ocr-vision.swift')

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

function todayKST() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
}

function weekdayOf(iso) {
  return WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()]
}

// 게시판이 다루는 범위. 지난 글을 거슬러 볼 수는 있어도 1년 뒤 집회를 올리진
// 않는다. 이 창을 넘어서면 연도 추론이 틀린 것이다.
const PAST_WINDOW_DAYS = 400
const FUTURE_WINDOW_DAYS = 60

/**
 * "9.4" + "금" → "2026-09-04".
 *
 * 연도가 원문에 없다. 요일로 검증하되, **먼저 상식적인 창 안으로 가둔다.**
 * 순서를 반대로 하면(요일 먼저) 원문 요일 오타 하나가 날짜를 1년 뒤로 보낸다.
 * 실제로 "8.26.(목)" 글이 있었는데 2026-08-26 은 수요일이라 2027-08-26 으로
 * 튀었다 — 게시판에 "8.26.(수)" 글이 따로 있는 걸 보면 원문 오타다.
 * 하루 어긋나는 것과 1년 어긋나는 것 중에는 하루가 낫다.
 */
function resolveDate(month, day, weekday, today = todayKST()) {
  const t = Date.parse(`${today}T00:00:00Z`)
  const thisYear = Number(today.slice(0, 4))
  const inWindow = []
  for (const y of [thisYear - 1, thisYear, thisYear + 1]) {
    const iso = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const d = new Date(`${iso}T00:00:00Z`)
    if (Number.isNaN(d.getTime()) || d.getUTCDate() !== day) continue // 2/30 같은 날짜
    const diff = (d.getTime() - t) / 86400000
    if (diff > FUTURE_WINDOW_DAYS || diff < -PAST_WINDOW_DAYS) continue
    inWindow.push(iso)
  }
  if (inWindow.length === 0) return null

  const matched = weekday ? inWindow.filter((iso) => weekdayOf(iso) === weekday) : inWindow
  const pool = matched.length > 0 ? matched : inWindow
  const pick = pool.sort(
    (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - t) - Math.abs(Date.parse(`${b}T00:00:00Z`) - t),
  )[0]

  if (weekday && matched.length === 0) {
    // 버리지 않는다. 월·일은 원문 그대로 믿고, 요일만 틀린 것으로 본다.
    console.warn(`⚠ 원문 요일 불일치: "${month}.${day}(${weekday})" → ${pick}(${weekdayOf(pick)}) 로 둔다`)
  }
  return pick
}

/** 제목에서 날짜들을 뽑는다. "9.5.(토)~9.7.(월) 주요 집회" → 시작·끝 */
function parseTitleDates(title, today) {
  const out = []
  for (const m of title.matchAll(/(\d{1,2})\.(\d{1,2})\.?\s*[([]\s*([월화수목금토일])\s*[)\]]/g)) {
    const iso = resolveDate(Number(m[1]), Number(m[2]), m[3], today)
    if (iso) out.push(iso)
  }
  return out
}

/** 행의 날짜 셀 "9.5(토)" → ISO. 없으면 null */
function parseRowDate(text, today) {
  if (!text) return null
  const m = text.match(/(\d{1,2})\.(\d{1,2})\s*[([]\s*([월화수목금토일])\s*[)\]]/)
  if (!m) return null
  return resolveDate(Number(m[1]), Number(m[2]), m[3], today)
}

/** "14:00~16:00" → { time, startTime, endTime } */
function parseTime(raw) {
  if (!raw) return { time: null, startTime: null, endTime: null }
  const t = raw.replace(/\s/g, '').replace(/[∼-]/g, '~')
  const m = t.match(/(\d{1,2}:\d{2})~(\d{1,2}:\d{2})?/)
  if (!m) return { time: raw.trim(), startTime: null, endTime: null }
  const pad = (s) => (s && s.length === 4 ? `0${s}` : s)
  return { time: t, startTime: pad(m[1]), endTime: pad(m[2]) ?? null }
}

function parsePeople(raw) {
  if (!raw) return null
  const n = Number(raw.replace(/[^\d]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

// 등급 기준은 서울과 **같게** 둔다. 색이 "그 지역 기준 상대 규모"가 되어버리면
// 같은 색이 지역마다 다른 뜻이 된다. 경기 집회가 대부분 소규모로 나오는 건
// 왜곡이 아니라 사실이다 (관측 20건 중 500명 이상은 2건).
function gradeScale(people) {
  if (people == null) return null
  if (people >= 10000) return 'huge'
  if (people >= 3000) return 'large'
  if (people >= 500) return 'medium'
  return 'small'
}

const SCALE_LABEL = { small: '소규모', medium: '보통', large: '대규모', huge: '초대형' }

function normalizePlace(text) {
  return (text ?? '')
    .replace(/(\d+)\s*出/g, '$1번 출구')
    .replace(/\s*[-–]+>\s*/g, ' → ')
    .replace(/\s+/g, ' ')
    .trim()
}

// 바이너리는 커밋하지 않는다(플랫폼 종속). 소스보다 오래됐거나 없으면 다시 빌드한다.
async function ensureOcrBinary() {
  const [bin, src] = await Promise.all([
    fs.stat(OCR_BIN).catch(() => null),
    fs.stat(OCR_SRC),
  ])
  if (bin && bin.mtimeMs >= src.mtimeMs) return
  console.log('OCR 바이너리를 빌드한다…')
  execFileSync('swiftc', ['-O', OCR_SRC, '-o', OCR_BIN], { stdio: 'inherit' })
}

function ocr(file) {
  const out = execFileSync(OCR_BIN, [file], { encoding: 'utf8', maxBuffer: 8 << 20 })
  return JSON.parse(out)
}

async function main() {
  if (os.platform() !== 'darwin') {
    console.error('이 스크래퍼는 macOS Vision 을 쓴다. self-hosted 맥 러너에서 돌려야 한다.')
    process.exit(1)
  }
  await ensureOcrBinary()

  const today = todayKST()
  const jar = makeJar()
  const list = await fetchList(jar)
  console.log(`목록 ${list.length}건 · 오늘 ${today}`)

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gg-protest-'))
  const byDate = new Map()
  let ocrFail = 0
  let dropped = 0

  for (const post of list) {
    let boxes
    try {
      const { imageUrl } = await fetchDetail(jar, post.seq)
      if (!imageUrl) {
        console.warn(`⚠ 첨부 없음: ${post.title}`)
        continue
      }
      const file = path.join(tmp, `${post.seq}.jpg`)
      await fs.writeFile(file, await fetchBuffer(jar, imageUrl))
      boxes = ocr(file)
    } catch (err) {
      ocrFail++
      console.warn(`⚠ 실패 (${post.title}): ${err.message}`)
      continue
    }

    const rows = parseTable(boxes)
    const titleDates = parseTitleDates(post.title, today)
    if (rows.length === 0) {
      console.warn(`⚠ 표를 못 읽음: ${post.title}`)
      continue
    }

    for (const row of rows) {
      // 복수일 글은 행마다 날짜가 붙는다. 단일일 글은 제목 날짜를 쓴다.
      const date = parseRowDate(row.dateText, today) ?? (titleDates.length === 1 ? titleDates[0] : null)
      if (!date) {
        dropped++
        console.warn(`⚠ 날짜를 정하지 못함 → 버림: ${post.title} / ${row.station} ${row.place ?? ''}`)
        continue
      }
      const { stations, cities } = toCities(row.station)
      const people = parsePeople(row.peopleText)
      const scale = gradeScale(people)
      const item = {
        ...parseTime(row.timeText),
        place: normalizePlace(row.place),
        dong: null,
        people,
        peopleText: row.peopleText,
        stations,
        districts: cities,
        station: stations[0] ?? null,
        district: cities[0] ?? null,
        scale,
      }
      if (!byDate.has(date)) byDate.set(date, { boardNo: post.seq, title: post.title, items: [] })
      byDate.get(date).items.push(item)
    }
  }

  const days = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({
      date,
      boardNo: v.boardNo,
      title: v.title,
      postedAt: null,
      url: LIST_URL,
      items: v.items.sort((a, b) => (b.people ?? 0) - (a.people ?? 0)),
    }))

  const out = {
    updatedAt: today,
    region: 'gyeonggi-south',
    source: {
      name: '경기남부경찰청 오늘의 주요집회',
      url: LIST_URL,
      note: '경찰에 신고된 기준이며 실제 개최 여부·규모는 다를 수 있습니다. 표가 이미지로만 올라와 OCR 로 읽습니다.',
    },
    scaleLabels: SCALE_LABEL,
    days,
  }

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(out) + '\n', 'utf8')

  const itemCount = days.reduce((n, d) => n + d.items.length, 0)
  console.log(`\n저장: 날짜 ${days.length}일 · 집회 ${itemCount}건 (OCR 실패 ${ocrFail} · 날짜 불명 ${dropped})`)
  // "파싱 성공 = 데이터 있음"이 아니다. 날짜 수만 보고 안심하지 않는다.
  if (itemCount === 0) {
    console.error('집회가 0건이다. 표를 못 읽었을 가능성이 크다.')
    process.exit(1)
  }
}

await main()
