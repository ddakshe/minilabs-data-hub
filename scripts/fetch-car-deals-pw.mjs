// 국산차 이달의 구매 혜택 — JS 렌더링 사이트 전용 Playwright 스크래퍼.
// fetch-car-deals.mjs(cheerio)가 못 긁는 브랜드를 담당하고, 같은 promotions.json을 갱신한다.
//
// 담당:
//   현대     — 차종별 최대할인 + 프로모션 내역. 제조사가 자체 계산한 "최대할인"을 그대로 쓴다.
//   제네시스  — 이벤트 제목·기간만 공개. 금액이 없어 amount:null로 넣는다.
//   KGM      — 차종별 할인액이 없고 전 차종 공통 혜택뿐. 브랜드 단위 카드 한 장으로 넣는다.
//
// Usage:
//   node scripts/fetch-car-deals-pw.mjs            # 전체
//   node scripts/fetch-car-deals-pw.mjs hyundai    # 특정 브랜드만
//
// 주의: 한국 제조사 사이트가 GitHub Actions 해외 IP를 막을 수 있다.
//       막히면 scripts/local-weekly-scrape.sh처럼 로컬(한국 IP) 실행으로 돌린다.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { isEvModel } from './sources/car-deals-shared.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../car-deals/promotions.json')

const ONLY = process.argv[2]
  ? new Set(process.argv[2].split(',').map((s) => s.trim()).filter(Boolean))
  : null

function todayKST() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
}

function endOfMonthKST() {
  const [y, m] = todayKST().split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`
}

/**
 * 접힘 UI 안에서 제목이 두 번 반복돼 나오는 경우가 잦다
 * ("전시차 구매 전시차 구매 조건- …", "A 프로모션 A 프로모션").
 * 바로 이어지는 반복을 한 번으로 접는다.
 */
function dedupeRepeat(text) {
  return (text || '').replace(/^(.{4,}?)\s*\1/, '$1').trim()
}

/** "280만" / "30만/50만" → 원. 슬래시는 최솟값(과장 회피). */
function parseAmount(text) {
  if (!text) return null
  const t = String(text).replace(/\s+/g, '')
  const multi = t.match(/([\d,]+(?:만?\/[\d,]+)+)만/)
  if (multi) {
    const nums = multi[1].split('/').map((n) => Number(n.replace(/[만,]/g, '')))
    return Math.min(...nums) * 10000
  }
  const man = t.match(/([\d,]+)만/)
  if (man) return Number(man[1].replace(/,/g, '')) * 10000
  return null
}

async function newPage(browser) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
    locale: 'ko-KR',
  })
  return page
}

// ───────────────────────── 현대 ─────────────────────────

/**
 * 현대 — 이달의 구매혜택. Vue 앱이라 정적 HTML에는 "혜택이 없습니다"만 나온다.
 *
 * 렌더 후 구조: li 하나가 차종 하나.
 *   strong             모델명
 *   span.start         "2,141 만원 부터"
 *   strong.point[0]    금리할인
 *   strong.point[1]    최대할인  ← 제조사가 직접 계산한 값
 *   table tbody tr     [프로모션, 조건, 금액] 또는 [조건, 금액](직전 프로모션의 생산월 변형)
 *
 * 최대할인을 그대로 쓰는 이유: 그랜저 = 썸머페스타 200만(생산월 택일) + 전시차 30 + 세이브오토 50 = 280만.
 * 생산월 택일과 슬래시 범위 처리가 이미 반영돼 있어, 우리가 다시 계산하면 오히려 어긋난다.
 */
async function hyundai(browser) {
  const page = await newPage(browser)
  try {
    await page.goto('https://www.hyundai.com/kr/ko/e/vehicles/monthly-benefit', {
      waitUntil: 'networkidle',
      timeout: 60000,
    })
    await page.waitForSelector('strong.point', { timeout: 30000 })
    await page.waitForTimeout(1500)

    const raw = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()

      // 셀 전체 텍스트에는 툴팁으로 접혀 있는 유의사항 전문이 딸려 온다
      // ("노후차 트레이드-인 특별조건- 대상 : … ※ … 닫기 정보 열기").
      // .detail-title에 깨끗한 제목이 따로 있으므로 그걸 우선 쓰고,
      // 없으면 자식 요소를 제외한 직접 텍스트만 취해 툴팁 내용을 배제한다.
      const cellText = (c) => {
        const title = clean(c.querySelector('.detail-title')?.textContent)
        if (title) return title
        const own = clean(
          [...c.childNodes]
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent)
            .join(' ')
        )
        return own || clean(c.textContent)
      }

      const lis = [...document.querySelectorAll('li')].filter(
        (li) => /최대할인/.test(li.textContent) && li.querySelector('strong.point')
      )
      return lis.map((li) => {
        const table = li.querySelector('table')
        return {
          model: clean(li.querySelector('strong')?.textContent),
          priceText: clean(li.querySelector('span.start')?.textContent),
          points: [...li.querySelectorAll('strong.point')].map((e) => clean(e.textContent)),
          rows: table
            ? [...table.querySelectorAll('tbody tr')].map((tr) =>
                [...tr.querySelectorAll('th,td')].map(cellText)
              )
            : [],
        }
      })
    })

    const endsAt = endOfMonthKST()
    const items = []
    const seen = new Set()

    for (const r of raw) {
      if (!r.model || seen.has(r.model)) continue
      seen.add(r.model)

      // "2,141 만원 부터" → 21410000
      const pm = r.priceText.match(/([\d,]+)\s*만원/)
      const basePrice = pm ? Number(pm[1].replace(/,/g, '')) * 10000 : null

      const officialMaxAmount = parseAmount(r.points[1])

      const benefits = []
      const conditionalBenefits = []
      let promo = ''

      for (const cells of r.rows) {
        if (cells.length === 0) continue
        let label, amountText

        // "└"는 바로 위 항목의 하위 조건이라는 표시다. 기호는 빼고 뜻만 남긴다.
        const sub = (s) => dedupeRepeat(s.replace(/^└\s*/, '').trim())

        if (cells.length >= 3) {
          promo = sub(cells[0])
          const cond = sub(cells[1])
          label = cond && cond !== promo ? `${promo} · ${cond}` : promo
          amountText = cells[cells.length - 1]
        } else {
          // 2셀: 첫 셀이 날짜꼴이면 직전 프로모션의 생산월 변형, 아니면 새 프로모션.
          const first = sub(cells[0])
          const isMonthVariant = /\d{4}\s*년|\d+\s*월/.test(first)
          label = isMonthVariant && promo ? `${promo} · ${first}` : first
          if (!isMonthVariant) promo = first
          amountText = cells[1]
        }

        const amount = parseAmount(amountText)
        if (!label || amount === null) continue

        const benefit = { label }
        benefit.amount = amount
        if (/\//.test(amountText)) benefit.note = amountText
        // 생산월별 혜택은 택일
        if (/\d{4}\s*년|\d+\s*월/.test(label)) benefit.exclusiveGroup = promo || '생산월'

        // 재고·금융상품·재구매 조건은 누구나 받는 게 아니다
        if (/전시차|세이브오토|재구매|중고차|보유\s*고객/.test(label)) {
          conditionalBenefits.push(benefit)
        } else {
          benefits.push(benefit)
        }
      }

      if (officialMaxAmount === null && benefits.length === 0 && conditionalBenefits.length === 0) {
        continue
      }

      items.push({
        brand: 'hyundai',
        model: r.model,
        basePrice,
        benefits,
        conditionalBenefits,
        officialMaxAmount,
        // 현대는 월별 혜택 페이지에 차종별 시승 링크가 없다. 브랜드 공통 페이지로 보낸다.
        testDriveUrl: 'https://www.hyundai.com/kr/ko/e/vehicles/test-driving',
        endsAt,
        isEv: isEvModel(r.model),
      })
    }

    return items
  } finally {
    await page.close()
  }
}

// ───────────────────────── 제네시스 ─────────────────────────

/**
 * 제네시스 — 이벤트 목록만 공개하고 금액은 상세 페이지에도 잘 안 적힌다.
 * 프리미엄 브랜드라 현금할인을 걸지 않으므로, 금액 카드 대신 "진행 중" 카드로 넣는다.
 * (amount: null → 앱이 금액 대신 "진행 중"으로 렌더링)
 */
async function genesis(browser) {
  const page = await newPage(browser)
  try {
    await page.goto('https://www.genesis.com/kr/ko/support/genesis-events.html', {
      waitUntil: 'networkidle',
      timeout: 60000,
    })
    await page.waitForTimeout(2500)

    const events = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const out = []
      document.querySelectorAll('li, article, div').forEach((el) => {
        const t = clean(el.textContent)
        // "제목 … 2026.08.01 ~ 2026.08.31 … 진행중" 꼴이면서 너무 길지 않은 것
        if (t.length > 260) return
        const m = t.match(/(\d{4}\.\d{2}\.\d{2})\s*~\s*(\d{4}\.\d{2}\.\d{2})/)
        if (!m || !/진행중/.test(t)) return
        const title = clean(t.slice(0, t.indexOf(m[1])))
        if (!title) return
        out.push({ title, start: m[1], end: m[2] })
      })
      return out
    })

    // 같은 이벤트가 중첩 요소마다 잡히고, 제목이 두 번 반복되거나
    // "행사가 종료되었습니다" 같은 상태 문구가 앞에 붙어 나온다.
    // 기간이 같으면 같은 이벤트로 보고, 그중 가장 짧은(=가장 덜 오염된) 제목을 고른다.
    const byPeriod = new Map()
    for (const e of events) {
      let title = dedupeRepeat(e.title.replace(/행사가\s*종료되었습니다\.?/g, '').trim())
      // 목록에서 제목 뒤에 부제가 이어 붙는다
      // ("… 라운지 프로모션 제네시스 오너를 위한 특별한 휴식, 제주 … 프로모션").
      // 제목이 끝나는 말머리에서 자른다. 문장 끝이면 매칭되지 않아 원문이 유지된다.
      const head = title.match(/^(.+?(?:프로모션|이벤트|혜택 안내))\s+\S/)
      if (head && head[1].length >= 8) title = head[1]
      if (!title) continue
      const key = `${e.start}~${e.end}`
      const prev = byPeriod.get(key)
      if (!prev || title.length < prev.title.length) byPeriod.set(key, { ...e, title })
    }

    const list = [...byPeriod.values()]
    if (list.length === 0) return []

    // 제네시스는 차종별로 안 나뉘므로 브랜드 단위 카드 하나로 묶는다.
    return [
      {
        brand: 'genesis',
        model: '전 차종',
        basePrice: null,
        benefits: list.map((e) => ({
          label: e.title,
          amount: null,
          note: `${e.start} ~ ${e.end}`,
        })),
        conditionalBenefits: [],
        endsAt: list
          .map((e) => e.end.replace(/\./g, '-'))
          .sort()
          .at(-1),
        isEv: false,
      },
    ]
  } finally {
    await page.close()
  }
}

// ───────────────────────── KGM (구 쌍용) ─────────────────────────

/**
 * KGM — 차종별 할인 금액이 아예 없다. 혜택이 전 차종 공통(금융 프로모션·재구매 로열티)이라
 * 차종마다 카드를 만들면 같은 내용이 10번 반복되고 "최대 0원"이 된다.
 * 그래서 제네시스처럼 브랜드 단위 카드 한 장으로 넣는다.
 *
 * 구조: p.benefits-special__title = 섹션 제목, 부모 텍스트에 내용이 이어진다.
 */
async function kgm(browser) {
  const page = await newPage(browser)
  try {
    await page.goto('https://www.kg-mobility.com/od/promotion/monthly-benefits', {
      waitUntil: 'networkidle',
      timeout: 60000,
    })
    await page.waitForSelector('.benefits-special__title', { timeout: 30000 })
    await page.waitForTimeout(1500)

    const raw = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const titles = [...document.querySelectorAll('.benefits-special__title')]
      const monthly = titles.find((el) => /이달의 혜택/.test(el.textContent))
      return {
        monthly: monthly ? clean(monthly.parentElement?.textContent) : '',
        models: [...document.querySelectorAll('*')]
          .map((el) => clean(el.textContent))
          .filter((t) => /^[가-힣A-Za-z0-9 ]{2,14}[\d,]{9,}원 부터/.test(t))
          .slice(0, 20),
      }
    })

    if (!raw.monthly) throw new Error('이달의 혜택 섹션 없음')

    const conditionalBenefits = []
    // "재구매 혜택 로열티 · 2대째 : 10만원 · 3대째 : 20만원"
    for (const m of raw.monthly.matchAll(/·\s*([^·:]{1,20}?)\s*:\s*([\d,]+)\s*만원/g)) {
      conditionalBenefits.push({
        label: `재구매 로열티 · ${m[1].trim()}`,
        amount: Number(m[2].replace(/,/g, '')) * 10000,
      })
    }

    // "할부 혜택 8월 금융 프로모션 · 무이자 12개월 … · 5.5% 72개월 …" → 재구매 항목 전까지
    const finance = raw.monthly.match(/할부 혜택\s*(.+?)(?:재구매 혜택|$)/)
    const financing = finance ? finance[1].trim() : undefined

    if (conditionalBenefits.length === 0 && !financing) throw new Error('파싱된 혜택 없음')

    return [
      {
        brand: 'kgm',
        model: '전 차종',
        basePrice: null,
        benefits: [],
        conditionalBenefits,
        financing,
        endsAt: endOfMonthKST(),
        isEv: false,
      },
    ]
  } finally {
    await page.close()
  }
}

const ADAPTERS = { hyundai, genesis, kgm }

const LINK_ONLY = []

async function main() {
  let data
  try {
    data = JSON.parse(await fs.readFile(OUTPUT_PATH, 'utf8'))
  } catch {
    console.error(`먼저 fetch-car-deals.mjs를 실행해 ${OUTPUT_PATH}를 만드세요.`)
    process.exit(1)
  }

  const browser = await chromium.launch()
  const collected = new Map()

  try {
    for (const [id, adapter] of Object.entries(ADAPTERS)) {
      if (ONLY && !ONLY.has(id)) continue
      try {
        const got = await adapter(browser)
        if (got.length === 0) throw new Error('0건 파싱됨')
        collected.set(id, got)
        console.log(`✓ ${id}: ${got.length}건`)
      } catch (err) {
        console.warn(`⚠ ${id}: 실패(${err.message}) → 기존 데이터 유지`)
      }
    }
  } finally {
    await browser.close()
  }

  // 이번에 성공한 브랜드만 교체하고 나머지는 그대로 둔다.
  const replaced = new Set(collected.keys())
  const items = [
    ...(data.items ?? []).filter((i) => !replaced.has(i.brand)),
    ...[...collected.values()].flat(),
  ]

  const covered = new Set(items.map((i) => i.brand))
  const fallbacks = [...new Set([...LINK_ONLY, ...(data.fallbacks ?? []).map((f) => f.brand)])]
    .filter((b) => !covered.has(b))
    .map((b) => ({ brand: b, titles: [] }))

  const today = todayKST()
  const out = { month: today.slice(0, 7), updatedAt: today, items, fallbacks }
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8')

  console.log(
    `\n✅ ${OUTPUT_PATH}\n   ${out.month} · 차종 ${items.length}개 · 링크전용 ${fallbacks.map((f) => f.brand).join(', ') || '없음'}`
  )
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
