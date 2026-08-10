// 국산차 이달의 구매 혜택 스크래퍼 — auto-deal-mini 앱용.
// 출력: car-deals/promotions.json
//
// 설계: fetch-chicken-events.mjs의 어댑터 레지스트리 패턴을 그대로 따른다.
//   - 어댑터 있고 성공 → items에 차종별 혜택
//   - 어댑터 실패/없음 → fallbacks에 링크전용 카드 (틀린 금액을 보여주는 것보다 낫다)
//
// 브랜드마다 혜택 합산 규칙이 다르다:
//   - 기아: 기본/특별/기타가 실제로 중첩 적용 → 그냥 합산
//   - 르노: 생산분별 택일 혜택이 나열됨 → exclusiveGroup으로 묶어 최댓값만 취함
//     (그랑콜레오스: 25년 생산분 400만 / 26년 1,2월 200만 / 26년 3,4,5월 150만 → 하나만 받음)
//
// Usage:
//   node scripts/fetch-car-deals.mjs          # 전체
//   node scripts/fetch-car-deals.mjs kia      # 특정 브랜드만(나머지는 기존 데이터 유지)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'
import { isEvModel } from './sources/car-deals-shared.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../car-deals/promotions.json')

const ONLY = process.argv[2]
  ? new Set(process.argv[2].split(',').map((s) => s.trim()).filter(Boolean))
  : null

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function todayKST() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
}

/** 이번 달 마지막 날. 제조사 프로모션은 대부분 월말 종료라 명시가 없으면 이걸 쓴다. */
function endOfMonthKST() {
  const today = todayKST()
  const [y, m] = today.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`
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

/** 줄바꿈·연속 공백을 한 칸으로. 사이트 마크업에 개행이 많아 라벨이 지저분해진다. */
function clean(text) {
  return (text || '').replace(/\s+/g, ' ').trim()
}

/**
 * 라벨에서 UI 텍스트를 걷어낸다.
 * 모달 트리거의 스크린리더용 문구("안내 팝업 열기")가 제목 안에 들어 있어 그대로 두면
 * "휴가비 지원 혜택 안내 팝업 열기"처럼 화면에 노출된다.
 */
function cleanLabel(text) {
  return clean(text)
    .replace(/안내\s*팝업\s*열기/g, '')
    .replace(/자세히\s*보기|내용보기|더\s*알아보기/g, '')
    .replace(/\s{2,}/g, ' ')
    // 금액을 잘라내면서 남은 수식어 꼬리("… 재구매 고객 최대")
    .replace(/[\s,]*(?:최대|약)$/, '')
    .trim()
}

/**
 * 생산분 조건이 붙은 혜택은 택일이다 — 내 차는 한 생산분에만 속한다.
 * 나열된 걸 다 더하면 실제로 못 받는 금액이 나오므로 같은 그룹으로 묶어 최댓값만 취한다.
 * (기아 봉고Ⅲ: 26년 6월 생산분 100만 + 26년 5월 생산분 150만 → 실제로는 하나만)
 */
function tagExclusive(benefit) {
  if (/생산분/.test(benefit.label)) benefit.exclusiveGroup = '생산분'
  return benefit
}

// ───────────────────────── 금액 파싱 ─────────────────────────

/**
 * "100만" / "70만원" / "20/30만" / "최대 400만 원" → 원 단위 숫자.
 * 슬래시 범위는 **최솟값**을 쓴다. 과장을 피하는 쪽이 안전하다.
 * 원본 표기는 note에 남겨 상세 화면에서 그대로 보여준다.
 */
function parseAmount(text) {
  if (!text) return null
  const t = text.replace(/\s+/g, '')

  // "20/30만", "10/20/30/40만" → 최솟값
  const multi = t.match(/([\d,]+(?:\/[\d,]+)+)\s*만/)
  if (multi) {
    const nums = multi[1].split('/').map((n) => Number(n.replace(/,/g, '')))
    return Math.min(...nums) * 10000
  }

  const man = t.match(/([\d,]+)\s*만/)
  if (man) return Number(man[1].replace(/,/g, '')) * 10000

  const won = t.match(/([\d,]{4,})\s*원/)
  if (won) return Number(won[1].replace(/,/g, ''))

  return null
}

/** "51,500,000" → 51500000 */
function parsePrice(text) {
  const m = (text || '').replace(/\s+/g, '').match(/([\d,]{5,})/)
  return m ? Number(m[1].replace(/,/g, '')) : null
}

// ───────────────────────── 브랜드 어댑터 ─────────────────────────
// 각 어댑터: () => Promise<Promotion[]>

/**
 * 기아 — AEM. `.buy_accordion_item` = 차종 1개.
 *   .buy_car_name              모델명
 *   .price                     최다 판매 트림 가격
 *   .benefit_detail_item       혜택 카테고리 묶음
 *     .benefit_detail_tit        카테고리명 (기본 혜택 / 특별 혜택 / 기타 혜택 / 트레이드인 혜택)
 *     .benefit_detail_article    개별 혜택
 *       .detail_tit span.text      라벨
 *       .detail_cont               금액
 *
 * "기본/특별"은 누구나 받는 혜택, "기타/트레이드인"은 조건부(금융상품 가입·내차팔기 진행 등).
 * 사이트 자체 분류를 그대로 따른다 — 임의로 재분류하면 근거를 잃는다.
 */
async function kia() {
  const url = 'https://www.kia.com/kr/buy/special-offers'
  const $ = cheerio.load(await httpText(url))
  const endsAt = endOfMonthKST()
  const items = []

  $('.buy_accordion_item').each((_, el) => {
    const $el = $(el)
    const model = clean($el.find('.buy_car_name').first().text())
    if (!model) return

    const basePrice = parsePrice($el.find('.price').first().text())
    // 차종별 시승신청 링크(rcCode로 차종이 구분된다). 없으면 앱이 브랜드 공통 링크로 폴백한다.
    const td = $el.find('a[href*="book-a-test-drive/form"]').first().attr('href')
    const testDriveUrl = td ? new URL(td, 'https://www.kia.com').toString() : null

    const benefits = []
    const conditionalBenefits = []

    $el.find('.benefit_detail_item').each((__, sec) => {
      const $sec = $(sec)
      const category = clean($sec.find('.benefit_detail_tit').first().text())
      const isConditional = /기타|트레이드인/.test(category)

      $sec.find('.benefit_detail_article').each((___, art) => {
        const $art = $(art)
        const label = cleanLabel($art.find('.detail_tit').first().text())
        const raw = clean($art.find('.detail_cont').first().text())
        const amount = parseAmount(raw)
        if (!label || amount === null) return

        const benefit = { label, amount }
        // "20/30만"처럼 범위면 원문을 남겨 상세에서 그대로 보여준다
        if (/\//.test(raw)) benefit.note = raw
        ;(isConditional ? conditionalBenefits : benefits).push(tagExclusive(benefit))
      })
    })

    if (benefits.length === 0 && conditionalBenefits.length === 0) return

    items.push({
      brand: 'kia',
      model,
      basePrice,
      benefits,
      conditionalBenefits,
      testDriveUrl,
      endsAt,
      isEv: isEvModel(model),
    })
  })

  return items
}

/**
 * 르노코리아 — `.accordion_item` = 차종 1개.
 * 혜택이 시맨틱 클래스 없이 헤딩 텍스트로만 구분돼서, 텍스트 라인 단위로 섹션을 나눈다.
 *
 * 섹션:
 *   "한정 수량 현장 특별 할인" / "이달의 특별 혜택"  → benefits
 *   "기본 혜택"                                    → benefits (전시차 할인 등)
 *   "재구매 고객", "노후차", "침수 피해"             → conditionalBenefits (대상 한정)
 *
 * 생산분별 혜택("25년 생산분", "26년 1,2월 생산분")은 택일이므로 exclusiveGroup으로 묶는다.
 */
async function renault() {
  const url = 'https://www.renault.co.kr/ko/buy/tm_purchasing.jsp'
  const $ = cheerio.load(await httpText(url))
  const endsAt = endOfMonthKST()
  const items = []

  $('.accordion_item').each((_, el) => {
    const $el = $(el)
    const text = $el.text().replace(/\s+/g, ' ').trim()

    const model = clean($el.find('h3, h2, .model_name, strong').first().text())
      || text.split(/\s+/)[0]
    if (!model) return

    let section = ''

    const basePrice = (() => {
      // "차량가 4,763만 9천 원" / "가솔린 차량가 3,936만 원"
      const m = text.match(/차량가\s*([\d,]+)만(?:\s*([\d,]+)천)?\s*원/)
      if (!m) return null
      return Number(m[1].replace(/,/g, '')) * 10000 + (m[2] ? Number(m[2]) * 1000 : 0)
    })()

    // 차종별 시승신청 링크(h_carsel로 차종이 구분된다). 상단·하단 공통 배너 링크는 제외한다.
    const td = $el.find('a[href*="app_testdrive"][href*="h_carsel"]').first().attr('href')
    const testDriveUrl = td ? new URL(td, 'https://www.renault.co.kr').toString() : null

    const benefits = []
    const conditionalBenefits = []

    // .benefit_box.special_benefit 안에서 span=섹션 제목, li=개별 혜택.
    // 문서 순서대로 훑으면서 현재 섹션을 추적한다. "유의 사항" 섹션은 통째로 버린다
    // (트림 기준·금리 조건 같은 각주라 혜택이 아니다).
    $el.find('.benefit_box.special_benefit').find('span, li').each((__, node) => {
      const tag = node.tagName
      const raw = clean($(node).text())
      if (!raw) return

      if (tag === 'span') {
        section = /유의\s*사항/.test(raw) ? 'skip' : raw
        return
      }
      if (section === 'skip') return

      // 한 항목에 금액이 여럿이면("유류비 200만 원 지원 또는 옵션 최대 250만 원") 택일이므로 큰 쪽.
      const amounts = [...raw.matchAll(/([\d,]+)\s*만\s*원/g)].map(
        (mm) => Number(mm[1].replace(/,/g, '')) * 10000
      )
      if (amounts.length === 0) return
      const amount = Math.max(...amounts)

      // 라벨은 첫 금액 앞까지. 뒤쪽은 "~ 지원/증정" 같은 서술이라 잘라도 뜻이 산다.
      const label = cleanLabel(raw.split(/[\d,]+\s*만\s*원/)[0]).replace(/[,\s]+$/, '') || raw.slice(0, 40)

      const benefit = { label, amount }
      if (amounts.length > 1) benefit.note = raw

      if (/재구매|노후차|침수|보유\s*고객|중고차\s*보유/.test(raw)) {
        conditionalBenefits.push(benefit)
        return
      }
      benefits.push(tagExclusive(benefit))
    })

    if (benefits.length === 0 && conditionalBenefits.length === 0) return

    items.push({
      brand: 'renault',
      model,
      basePrice,
      benefits,
      conditionalBenefits,
      testDriveUrl,
      endsAt,
      isEv: false,
    })
  })

  return items
}

// 어댑터 레지스트리: 여기 추가하면 자동 수집 대상이 된다.
// 현대·KGM은 JS 렌더링이라 fetch-car-deals-pw.mjs(Playwright)에서 처리한다.
const ADAPTERS = { kia, renault }

// ───────────────────────── 브랜드 메타 ─────────────────────────
// 국산 5사. 수입차는 다루지 않는다.
const BRANDS = [
  { id: 'hyundai', name: '현대', url: 'https://www.hyundai.com/kr/ko/e/vehicles/monthly-benefit' },
  { id: 'kia', name: '기아', url: 'https://www.kia.com/kr/buy/special-offers' },
  { id: 'genesis', name: '제네시스', url: 'https://www.genesis.com/kr/ko/support/genesis-events.html' },
  { id: 'kgm', name: 'KGM', url: 'https://www.kg-mobility.com/od/promotion/monthly-benefits' },
  { id: 'renault', name: '르노코리아', url: 'https://www.renault.co.kr/ko/buy/tm_purchasing.jsp' },
]

async function readExisting() {
  try {
    return JSON.parse(await fs.readFile(OUTPUT_PATH, 'utf8'))
  } catch {
    return { items: [], fallbacks: [] }
  }
}

async function main() {
  const existing = await readExisting()
  const prevItems = new Map()
  for (const it of existing.items ?? []) {
    if (!prevItems.has(it.brand)) prevItems.set(it.brand, [])
    prevItems.get(it.brand).push(it)
  }

  const items = []
  const fallbacks = []

  for (const meta of BRANDS) {
    const run = !ONLY || ONLY.has(meta.id)
    const adapter = ADAPTERS[meta.id]

    if (!adapter) {
      fallbacks.push({ brand: meta.id, titles: [] })
      console.log(`· ${meta.id}: 어댑터 없음 → 링크전용`)
      continue
    }

    if (!run) {
      const prev = prevItems.get(meta.id) ?? []
      items.push(...prev)
      console.log(`· ${meta.id}: 이번 실행 대상 아님 → 기존 ${prev.length}건 유지`)
      continue
    }

    try {
      const got = await adapter()
      if (got.length === 0) throw new Error('0건 파싱됨')
      items.push(...got)
      console.log(`✓ ${meta.id}: ${got.length}개 차종`)
    } catch (err) {
      // 파싱 실패 → 직전 데이터 유지, 없으면 링크전용 폴백.
      // 틀린 금액을 보여주느니 링크로 넘긴다.
      const prev = prevItems.get(meta.id) ?? []
      if (prev.length > 0) {
        items.push(...prev)
        console.warn(`⚠ ${meta.id}: 파싱 실패(${err.message}) → 기존 ${prev.length}건 유지`)
      } else {
        fallbacks.push({ brand: meta.id, titles: [] })
        console.warn(`⚠ ${meta.id}: 파싱 실패(${err.message}) → 링크전용 폴백`)
      }
    }
  }

  const today = todayKST()
  const out = {
    month: today.slice(0, 7),
    updatedAt: today,
    items,
    fallbacks,
  }

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8')

  console.log(
    `\n✅ ${OUTPUT_PATH}\n   ${out.month} · 차종 ${items.length}개 · 링크전용 ${fallbacks.length}개 브랜드`
  )
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
