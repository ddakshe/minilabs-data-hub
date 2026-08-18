// 인증중고차(CPO) — JS 상호작용이 필요한 사이트 전용 Playwright 스크래퍼.
// fetch-cpo.mjs(내장 fetch)가 못 긁는 브랜드를 담당하고, 같은 listings.json을 갱신한다.
//
// 담당:
//   포르쉐 — finder.porsche.com이 Vercel 봇 챌린지로 curl을 막는다(429). 브라우저로는 그냥 열린다.
//            매물은 SSR HTML에 있고 ?page=N이 정상 동작해서 페이지만 돌면 된다.
//   볼보   — 페이지네이션이 URL로 안 움직인다. page=2를 줘도(쿠키를 물려도, 헤드리스로도) 1페이지가 온다.
//            실제로는 "12개 더 로드하기"(a.load-type) 버튼을 눌러 이어붙이는 방식이라 클릭이 필요하다.
//   BMW    — WAF가 짧은 간격의 연속 요청을 막는다. 브라우저 컨텍스트로 호출해 지문을 맞추고,
//            무엇보다 요청 간격을 크게 벌린다. 아래 "BMW" 섹션의 주의사항을 먼저 읽을 것.
//
// Usage:
//   node scripts/fetch-cpo-pw.mjs           # 전체
//   node scripts/fetch-cpo-pw.mjs porsche   # 특정 브랜드만
//
// BMW 전용 환경변수:
//   BMW_PAGE_SIZE=12    한 요청당 매물 수. 12는 UI가 쓰는 확인된 값. 클수록 총 요청이 줄어든다.
//   BMW_DELAY_MS=45000  요청 간 대기. WAF 때문에 넉넉해야 한다.
//   BMW_MAX_REQUESTS=0  0이면 무제한. 상한 탐색이나 부분 수집 때 쓴다.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../cpo/listings.json')

const ONLY = process.argv[2]
  ? new Set(process.argv[2].split(',').map((s) => s.trim()).filter(Boolean))
  : null

/**
 * 쿠키 동의 배너가 화면을 덮어 클릭을 가로막는다(볼보는 OneTrust).
 * 동의 버튼을 누르는 게 아니라 오버레이 엘리먼트만 걷어낸다.
 */
async function dropConsentOverlay(page) {
  await page.evaluate(() => {
    for (const sel of ['#onetrust-consent-sdk', '#onetrust-banner-sdk', '.ot-sdk-container']) {
      document.querySelector(sel)?.remove()
    }
  })
}

// 전량을 긁지 않는다. 최신순으로 브랜드당 이만큼만. 0이면 무제한.
// 빈 문자열도 "미지정"으로 본다 — Actions에서 입력을 비우면 env가 ''로 들어오고
// Number('')는 0(무제한)이 되어 기본값이 뒤집힌다.
const MAX_PER_BRAND = process.env.MAX_PER_BRAND ? Number(process.env.MAX_PER_BRAND) : 300

// 소스가 알려주는 "전체 재고 수". 앱의 "전체 N대 중 최신 M대" 표시에 쓴다.
const sourceTotals = {}

function todayKST() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
}

function toKm(v) {
  if (v == null) return null
  const n = Math.round(Number(String(v).replace(/[^\d.]/g, '')))
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** fetch-cpo.mjs의 priceToKrw와 같은 규칙. 100만원 미만은 만원 표기로 본다. */
function priceToKrw(v) {
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n < 1_000_000 ? n * 10000 : n)
}

/** srcset("URL 320w, URL 640w, …")에서 가장 큰 폭의 URL을 고른다. */
function pickLargest(srcset) {
  if (!srcset) return null
  const best = srcset
    .split(',')
    .map((part) => part.trim().split(/\s+/))
    .map(([url, w]) => ({ url, w: Number(String(w ?? '').replace(/\D/g, '')) || 0 }))
    .sort((a, b) => b.w - a.w)[0]
  return best?.url ?? null
}

// ───────────────────────── Porsche Approved ─────────────────────────
// 카드는 data-testid="result-N"(0~14, 15개/페이지). 스펙은 같은 클래스의 span에 순서 없이 들어 있어
// 인덱스가 아니라 텍스트 패턴으로 골라낸다(항목 수가 차량마다 다르다).
//
// condition=porsche_approved로 인증중고차만 받는다. 필터 없이 받으면 신차가 섞여 오고(439건 중 CPO 112),
// 상한에 걸려 끝까지 못 돌아 전체 재고 수도 알 수 없었다. 필터를 걸면 전량이 100건대라 끝까지 돌 수 있고
// sourceTotal을 추정 없이 정확히 알 수 있다.
// (`condition[]=…`이나 `filter=condition:…` 형식은 무효 — 필터가 안 걸린 결과가 온다)
const POR_LIST = 'https://finder.porsche.com/kr/ko-KR/search?condition=porsche_approved'
const POR_MAX_PAGES = 40

async function porsche(browser) {
  const page = await browser.newPage({ locale: 'ko-KR' })
  const items = []
  const seen = new Set()
  let emptyStreak = 0
  let reachedEnd = false

  for (let p = 1; p <= POR_MAX_PAGES; p += 1) {
    // networkidle은 쓰면 안 된다 — 애널리틱스가 계속 요청을 날려 idle이 오지 않는다.
    await page.goto(`${POR_LIST}&page=${p}`, { waitUntil: 'domcontentloaded', timeout: 90000 })
    await dropConsentOverlay(page)
    // 렌더가 늦었을 뿐인데 끊으면 뒤 페이지를 통째로 잃는다.
    // 한 번 재시도하고, 그래도 없으면 그때 끝으로 본다.
    let ready = true
    try {
      await page.waitForSelector('[data-testid^="result-"]', { timeout: 25000 })
    } catch {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 })
      await dropConsentOverlay(page)
      try {
        await page.waitForSelector('[data-testid^="result-"]', { timeout: 25000 })
      } catch {
        ready = false
      }
    }
    // 결과가 없는 페이지에는 result 카드가 아예 없어서 셀렉터 대기가 실패한다.
    // 앞 페이지들을 정상 수집한 뒤 도달한 지점이므로 렌더 실패가 아니라 목록의 끝으로 본다.
    if (!ready) {
      reachedEnd = items.length > 0
      break
    }
    const cards = await page.$$eval('[data-testid^="result-"]', (els) =>
      els.map((el) => ({
        title: el.querySelector('h2')?.textContent?.trim() ?? null,
        specs: [...el.querySelectorAll('span')].map((s) => s.textContent.trim()).filter(Boolean),
        text: el.textContent.replace(/\s+/g, ' '),
        href: el.querySelector('a[href*="/details/"]')?.getAttribute('href') ?? null,
        // 사진은 <img src>가 아니라 picture > source[srcset]에 있다.
        // srcset은 "URL 320w, URL 640w, …" 형태라 가장 큰 폭을 고른다.
        srcset:
          [...el.querySelectorAll('source[srcset], img[srcset]')]
            .map((n) => n.getAttribute('srcset'))
            .find((v) => v && v.includes('images.finder.porsche.com')) ?? null,
      }))
    )
    if (cards.length === 0) { reachedEnd = true; break }
    if (MAX_PER_BRAND > 0 && items.length >= MAX_PER_BRAND) break

    let fresh = 0
    for (const c of cards) {
      // href 뒤에 ?page=N이 붙어 오므로 쿼리를 떼고 ID를 뽑는다.
      const hrefPath = c.href ? c.href.split('?')[0] : null
      const id = hrefPath?.match(/-([A-Z0-9]{6})$/)?.[1] ?? null
      if (!id || seen.has(id)) continue
      seen.add(id)
      fresh += 1

      const pick = (re) => c.specs.find((s) => re.test(s)) ?? null
      const yearM = c.title?.match(/^(\d{4})/)
      const price = c.text.match(/₩\s?([\d,]{6,})/)
      const owners = pick(/이전 소유자/)
      const reg = pick(/^\d{1,2}월\/\d{4}년$/)

      items.push({
        brand: 'porsche',
        id,
        // 제목이 "2025 포르쉐 Taycan" 형태라 연식과 브랜드명을 떼어낸다.
        model: c.title?.replace(/^\d{4}\s*/, '').replace(/^포르쉐\s*/, '') ?? null,
        trim: null,
        year: yearM ? Number(yearM[1]) : null,
        mileageKm: toKm(pick(/km$/)),
        priceKrw: priceToKrw(price?.[1]),
        newPriceKrw: null,
        fuel: pick(/휘발유|디젤|전기|하이브리드|엔진/),
        transmission: pick(/^(자동|수동)/),
        bodyType: null,
        color: c.specs[0] ?? null,
        // "12월/2024년" → 2024-12
        firstRegistration: reg
          ? `${reg.split('/')[1].replace('년', '')}-${String(reg.split('월')[0]).padStart(2, '0')}`
          : null,
        accident: pick(/사고/),
        warranty: null,
        previousOwners: owners ? toKm(owners) : null,
        dealer: null,
        region: null,
        // 인증중고차(Porsche Approved)인지 카드가 직접 표기해준다. 신차도 같은 목록에 섞여 있다.
        certified: /승인 사전 소유/.test(c.text) || /-preowned-/.test(hrefPath ?? ''),
        url: hrefPath ? `https://finder.porsche.com${hrefPath}` : null,
        image: pickLargest(c.srcset),
      })
    }
    // 같은 매물만 다시 온 페이지가 연속 2번 나오면 끝으로 본다(1번은 일시적 중복일 수 있다).
    if (fresh === 0) {
      emptyStreak += 1
      if (emptyStreak >= 2) { reachedEnd = true; break }
    } else {
      emptyStreak = 0
    }
  }

  await page.close()
  // 끝까지 돌았을 때만 총량으로 기록한다. 상한에 걸려 끊긴 수를 전체 재고로 쓰면
  // 앱이 "전체 N대"를 틀리게 보여준다.
  if (reachedEnd) sourceTotals.porsche = items.length
  return items
}

// ───────────────────────── Volvo Selekt ─────────────────────────
// "12개 더 로드하기"(a.load-type)를 버튼이 사라질 때까지 누른 뒤 한 번에 파싱한다.
// 스펙은 li[title="…"]에 하나씩 들어 있다. 카드 전체 텍스트를 정규식으로 긁으면
// 인접 항목이 공백 없이 붙어 '2021'과 '99,220 km'가 202199220으로 합쳐진다.
// modelYear:DESC = 연식 내림차순. 정렬 드롭다운에서 확인한 값이다.
const VOLVO_LIST = 'https://selekt.volvocars.co.kr/kr/vehicles/volvo/all-models?sort=modelYear:DESC'
const VOLVO_MAX_CLICKS = 60

async function volvo(browser) {
  const page = await browser.newPage({ locale: 'ko-KR' })
  await page.goto(VOLVO_LIST, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForSelector('article[id^="vehicleMDX-"]', { timeout: 30000 })
  await dropConsentOverlay(page)

  const found = Number(await page.getAttribute('#results', 'data-found')) || 0
  if (found) sourceTotals.volvo = found
  const count = () => page.$$eval('article[id^="vehicleMDX-"]', (e) => e.length)

  for (let i = 0; i < VOLVO_MAX_CLICKS; i += 1) {
    const before = await count()
    if (found && before >= found) break
    if (MAX_PER_BRAND > 0 && before >= MAX_PER_BRAND) break
    const more = await page.$('a.load-type')
    if (!more) break
    try {
      await more.click({ timeout: 10000 })
    } catch {
      await dropConsentOverlay(page)
      await more.click({ timeout: 10000, force: true })
    }
    // 카드 수가 늘어날 때까지 기다린다. 안 늘면 더 없는 것으로 본다.
    try {
      await page.waitForFunction(
        (n) => document.querySelectorAll('article[id^="vehicleMDX-"]').length > n,
        before,
        { timeout: 15000 }
      )
    } catch {
      break
    }
  }

  const rows = await page.$$eval('article[id^="vehicleMDX-"]', (els) =>
    els.map((el) => {
      const spec = (t) => el.querySelector(`li[title="${t}"]`)?.textContent?.trim() || null
      return {
        id: el.id.replace('vehicleMDX-', ''),
        link: el.getAttribute('data-link'),
        title: el.querySelector('a.title')?.getAttribute('title') ?? null,
        year: spec('모델 년도'),
        km: spec('마일리지'),
        fuel: spec('연료 유형'),
        gear: spec('트랜스미션'),
        priceText: el.querySelector('.price .h3')?.textContent?.trim() ?? '',
        dealer: [...el.querySelectorAll('li,span,div')]
          .map((n) => n.textContent.trim())
          .find((t) => /전시장$/.test(t)) ?? null,
        img: el.querySelector('figure img')?.getAttribute('src') ?? null,
      }
    })
  )

  await page.close()

  return (MAX_PER_BRAND > 0 ? rows.slice(0, MAX_PER_BRAND) : rows).map((r) => ({
    brand: 'volvo',
    id: r.id,
    model: r.title,
    trim: null, // 모델명 문자열에 섞여 있어 분리하지 않는다(잘못 자르면 더 나쁘다)
    year: r.year ? Number(r.year) : null,
    mileageKm: toKm(r.km),
    priceKrw: priceToKrw(r.priceText.match(/([\d,]{7,})/)?.[1]),
    newPriceKrw: null,
    fuel: r.fuel,
    transmission: r.gear,
    bodyType: null,
    color: null,
    firstRegistration: null,
    accident: null,
    warranty: null,
    dealer: r.dealer,
    region: null,
    url: r.link ? `https://selekt.volvocars.co.kr${r.link}` : null,
    image: r.img,
  }))
}

// ───────────────────────── BMW · MINI ─────────────────────────
// 직접 API를 부르는 길은 막혀 있다. 요청 내용을 완벽히 복제해도(hash·buNos·x-api-key까지)
// 게이트웨이가 "SPA가 보낸 요청"만 통과시킨다:
//   · ctx.request로 재생        → 403
//   · 페이지 내 fetch로 재생    → CORS 프리플라이트에서 죽음
//   · page.route로 URL 바꿔치기 → 요청 자체가 죽음
//   · 번들 Chromium(헤드리스/헤드드) → search가 200(빈 응답)만 오고 화면에 에러가 뜬다
//   · 실제 Chrome + headed      → 201 + 정상 데이터  ← 이것만 된다
//
// 그래서 우리가 요청을 만들지 않는다. 페이지를 열고 "더보기"를 눌러 **SPA가 받는 201 응답을
// 가로채** 모은다. DOM을 긁는 것보다 낫다 — API 원본 그대로라 필드가 훨씬 풍부하다.
//
// ⚠ 실제 Chrome + headed가 필수다. 헤드리스로는 데이터가 오지 않는다.
//   → GitHub Actions에서는 돌지 않는다. 로컬(맥) 실행 전용이고, 워크플로는 bmw를 건너뛴다.
const BMW_PAGE_URL =
  'https://www.bmw.co.kr/ko-kr/sl/usedcarfinder/results?sorting=PRODUCTION_DATE_DESC'
const BMW_PAGE_STEP = 12 // UI가 "더보기" 한 번에 불러오는 수
const BMW_MAX_CLICKS = Number(process.env.BMW_MAX_CLICKS ?? 200)

// 중간에 막혀 전량을 못 받았는지. main()이 이 값을 보고 기존 데이터와 합칠지 결정한다.
let bmwPartial = false

function mapBmwHit(hit) {
  const v = hit?.vehicle
  if (!v) return null
  const mo = v.vehicleSpecification?.modelAndOption ?? {}
  const lc = v.vehicleLifeCycle ?? {}
  // 딜러별 제안가가 여러 개 붙어 있다. 값은 대체로 동일하니 첫 번째를 쓴다.
  const offer = Object.values(v.offering?.offerPrices ?? {})[0]
  const custom = new Map((lc.customFields ?? []).map((c) => [c.key, c.value]))

  return {
    brand: mo.brand === 'MINI' ? 'mini' : 'bmw',
    id: v.documentId ?? null,
    model: mo.model?.modelName ?? null,
    trim: mo.model?.derivative ?? null,
    year: mo.modelYear ?? null,
    mileageKm: toKm(lc.mileage?.km),
    priceKrw: priceToKrw(offer?.offerGrossPrice),
    // netListPrice는 부가세 제외라 판매가(포함)와 기준이 달라 쓰지 않는다.
    newPriceKrw: null,
    fuel: mo.baseFuelType ?? null,
    transmission: mo.transmission ?? null,
    bodyType: mo.bodyType ?? null,
    color: mo.color?.clusterFine ?? null,
    firstRegistration: null,
    accident: lc.vehicleDamage?.damageDescription ?? null,
    warranty: custom.get('newcarWarrantyCompDate') ?? null,
    // buNo 코드만 와서 dealer/showAll과 조인해야 이름이 나온다.
    dealer: null,
    region: null,
    url: v.documentId
      ? `https://www.bmw.co.kr/ko-kr/sl/usedcarfinder/details/${v.documentId}`
      : null,
    // media.usedCarImageList = 실제 차량 사진(카테고리별). cosyImages는 사양 기반 CGI 렌더라
    // 실사진이 있으면 그쪽을 쓴다. 정면측면 → 측면 → 아무거나 순으로 고른다.
    image: pickBmwPhoto(v.media),
  }
}

function pickBmwPhoto(media) {
  const list = media?.usedCarImageList
  if (!list) return null
  for (const key of ['FRONTSIDE', 'SIDE', 'FRONT', 'REARSIDE']) {
    const url = (list[key] ?? [])[0]
    if (url) return url
  }
  const any = Object.values(list).flat().find(Boolean)
  return any ?? null
}

/** BMW는 epaas 동의 배너를 쓴다. 클릭을 가로막으므로 오버레이를 걷어낸다. */
async function dropBmwConsent(page) {
  await page
    .evaluate(() => {
      const sels = [
        '#epaas-container',
        '[id^="epaas"]',
        '[class*="epaas"]',
        '[class*="consent"][class*="overlay"]',
        '[class*="cookie"][class*="banner"]',
      ]
      for (const sel of sels) document.querySelectorAll(sel).forEach((n) => n.remove())
      document.documentElement.style.overflow = 'auto'
      document.body.style.overflow = 'auto'
    })
    .catch(() => {})
}

async function bmw(browser, { launchBmw }) {
  // 번들 Chromium으로는 데이터가 오지 않는다. 별도로 실제 Chrome을 headed로 띄운다.
  const b = await launchBmw()
  const ctx = await b.newContext({ locale: 'ko-KR' })
  const page = await ctx.newPage()

  const byId = new Map()
  let total = null
  page.on('response', async (r) => {
    if (!/vehiclesearch\/search/.test(r.url()) || r.status() !== 201) return
    try {
      const j = await r.json()
      total = j?.metadata?.totalCount ?? total
      if (total) sourceTotals.bmw = total
      for (const h of j?.hits ?? []) {
        const rec = mapBmwHit(h)
        if (rec?.id) byId.set(rec.id, rec)
      }
    } catch {
      /* 응답 본문을 못 읽는 경우는 넘긴다 */
    }
  })

  await page.goto(BMW_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await dropBmwConsent(page)

  // 첫 응답을 기다린다. 여기서 아무것도 안 오면 headed/Chrome 조건이 안 맞는 것이다.
  for (let i = 0; i < 40 && byId.size === 0; i += 1) await page.waitForTimeout(500)
  if (byId.size === 0) {
    await b.close()
    bmwPartial = true
    throw new Error('첫 응답 없음 — 실제 Chrome + headed 조건을 확인할 것')
  }

  // UI가 몇 건 로드했는지는 "N 중 M" 카운터가 알려준다.
  // 내가 가로챈 개수로 루프를 돌리면 응답 하나만 놓쳐도 "더 없음"으로 오판해 멈춘다
  // (실측: 화면은 216건인데 가로챈 건 204건이었고 거기서 정지했다).
  const uiLoaded = async () => {
    const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
    // "12 중 1,341" 형태. 콤마를 허용한다.
    return Number((/([\d,]+)\s*중\s*([\d,]+)/.exec(t)?.[1] ?? '0').replace(/,/g, ''))
  }

  const target = MAX_PER_BRAND > 0 ? Math.min(MAX_PER_BRAND, total ?? MAX_PER_BRAND) : total

  // "더보기"는 a/button이 아니라 텍스트 노드다. Playwright 로케이터는 리렌더 사이에
  // 간헐적으로 count 0을 돌려주므로(실측), 페이지 안에서 텍스트로 직접 찾아 누른다.
  const clickMore = () =>
    page.evaluate(() => {
      const leaf = [...document.querySelectorAll('*')].find(
        (e) => e.children.length === 0 && (e.textContent || '').trim() === '더보기'
      )
      if (!leaf) return false
      const target = leaf.closest('a,button,[role="button"]') ?? leaf
      target.scrollIntoView({ block: 'center' })
      target.click()
      return true
    })

  // 목록 UI가 뜰 때까지 기다린다(카운터가 생기면 준비된 것).
  for (let i = 0; i < 60; i += 1) {
    if ((await uiLoaded()) > 0) break
    await page.waitForTimeout(500)
  }

  let stalled = 0
  let stop = null
  for (let click = 0; click < BMW_MAX_CLICKS; click += 1) {
    // 판정은 실제로 가로챈 개수로 한다. UI 카운터("N 중 M")는 렌더 타이밍에 따라
    // 0을 돌려주는 일이 잦아서 신뢰할 수 없다 — 보조 로그로만 쓴다.
    const before = byId.size
    if (target != null && before >= target) { stop = `목표 ${target}건 도달`; break }

    let ok = false
    try {
      ok = await clickMore()
    } catch {
      /* 렌더 중이면 다음 회차에 다시 시도한다 */
    }
    if (!ok) {
      await dropBmwConsent(page)
      stalled += 1
      await page.waitForTimeout(2500)
      if (stalled >= 5) { stop = `더보기를 못 찾음 (${before}건)`; break }
      continue
    }

    // 새 응답이 들어올 때까지 기다린다.
    for (let w = 0; w < 24 && byId.size === before; w += 1) await page.waitForTimeout(500)

    if (byId.size === before) {
      stalled += 1
      await page.waitForTimeout(1500)
      if (stalled >= 5) { stop = `증가 없음 (${before}건)`; break }
    } else {
      stalled = 0
      if ((click + 1) % 10 === 0) {
        console.log(`  · bmw 수집 ${byId.size}/${target ?? total ?? '?'} (더보기 ${click + 1}회, UI ${await uiLoaded()})`)
      }
    }
  }
  if (stop) console.log(`  · bmw 루프 종료: ${stop}`)

  // 마지막 응답들이 도착할 여유를 준다.
  await page.waitForTimeout(2500)

  await b.close()

  const items = [...byId.values()]
  const goal = MAX_PER_BRAND > 0 ? Math.min(MAX_PER_BRAND, total ?? MAX_PER_BRAND) : total
  // 상한만큼 받았으면 부분 수집이 아니다(전량을 의도한 게 아니므로).
  bmwPartial = goal != null && items.length < goal
  if (bmwPartial) {
    console.warn(`  ⚠ bmw 부분 수집: ${items.length}/${goal}건 — 다시 실행하면 이어붙는다`)
  } else {
    console.log(`  · bmw 최신 ${items.length}건 (전체 ${total ?? '?'}건 중)`)
  }
  return items.slice(0, MAX_PER_BRAND > 0 ? MAX_PER_BRAND : items.length)
}

const ADAPTERS = { bmw, porsche, volvo }

async function readExisting() {
  try {
    return JSON.parse(await fs.readFile(OUTPUT_PATH, 'utf8'))
  } catch {
    return { items: [] }
  }
}

async function main() {
  const existing = await readExisting()
  const prevItems = new Map()
  for (const it of existing.items ?? []) {
    if (!prevItems.has(it.brand)) prevItems.set(it.brand, [])
    prevItems.get(it.brand).push(it)
  }

  const browser = await chromium.launch()
  // BMW만 예외다. 번들 Chromium·헤드리스로는 데이터가 오지 않아서 실제 Chrome을 headed로 띄운다.
  // (headless로 바꾸면 search가 200 빈 응답만 준다 — 조용히 0건이 되니 주의)
  const launchBmw = () =>
    chromium.launch({
      headless: false,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled'],
    })
  const collected = new Map()
  const failed = []

  for (const brand of Object.keys(ADAPTERS)) {
    if (ONLY && !ONLY.has(brand)) continue
    try {
      const got = await ADAPTERS[brand](browser, { launchBmw })
      if (got.length === 0) throw new Error('0건 파싱됨')
      collected.set(brand, got)
      console.log(`✓ ${brand}: ${got.length}건`)
    } catch (err) {
      failed.push(brand)
      console.warn(`⚠ ${brand}: 실패(${err.message}) → 기존 데이터 유지`)
    }
  }
  await browser.close()

  // bmw 어댑터는 bmw·mini 두 브랜드를 함께 만들어낸다. 수집 결과를 브랜드별로 흩어 놓는다.
  const gotByBrand = new Map()
  for (const rows of collected.values()) {
    for (const r of rows) {
      if (!gotByBrand.has(r.brand)) gotByBrand.set(r.brand, [])
      gotByBrand.get(r.brand).push(r)
    }
  }

  // 이 스크립트가 담당하지 않은 브랜드는 기존 데이터를 그대로 둔다.
  const items = []
  const brands = new Set([...prevItems.keys(), ...gotByBrand.keys()])
  for (const b of brands) {
    const got = gotByBrand.get(b)
    const prev = prevItems.get(b) ?? []
    if (!got) {
      items.push(...prev)
      continue
    }
    // BMW·MINI가 부분 수집으로 끝났다면 기존 데이터를 버리지 않고 id 기준으로 합친다.
    // 그러면 여러 번 나눠 돌려서 채울 수 있다. 전량을 받았을 때는 합치지 않는다 —
    // 팔린 매물이 영구히 남으면 안 되기 때문이다.
    if ((b === 'bmw' || b === 'mini') && bmwPartial) {
      const byId = new Map(prev.map((x) => [x.id, x]))
      for (const r of got) byId.set(r.id, r)
      const merged = [...byId.values()]
      console.log(`  · ${b}: 부분 수집 → 기존과 병합 ${prev.length} + ${got.length} → ${merged.length}건`)
      items.push(...merged)
    } else {
      items.push(...got)
    }
  }

  // 두 스크립트(fetch / pw)가 같은 파일을 갱신하므로 순서를 고정한다.
  // 안 하면 브랜드 순서만 달라져도 매일 diff가 나서 커밋 노이즈가 생긴다.
  items.sort((a, b) => a.brand.localeCompare(b.brand) || String(a.id).localeCompare(String(b.id)))

  const byBrand = {}
  for (const it of items) byBrand[it.brand] = (byBrand[it.brand] ?? 0) + 1

  // brands 메타(name·searchUrl)는 fetch 스크립트가 만든다. 여기서는 이 실행에서 알게 된
  // collected·sourceTotal만 갱신하고 나머지는 그대로 물려받는다.
  const today = todayKST()
  // 이번 실행에서 실제로 새로 받은 브랜드만 날짜를 갱신한다.
  // 파일 전체 updatedAt 은 CI 덕에 항상 오늘이라 브랜드별 신선도를 못 나타낸다.
  const refreshed = new Set()
  for (const rows of collected.values()) for (const r of rows) refreshed.add(r.brand)

  const brandMeta = { ...(existing.brands ?? {}) }
  for (const [b, n] of Object.entries(byBrand)) {
    brandMeta[b] = {
      ...(brandMeta[b] ?? { name: null, searchUrl: null }),
      collected: n,
      sourceTotal: sourceTotals[b] ?? brandMeta[b]?.sourceTotal ?? null,
      updatedAt: refreshed.has(b) ? today : (brandMeta[b]?.updatedAt ?? null),
    }
  }

  const out = {
    updatedAt: today,
    maxPerBrand: MAX_PER_BRAND,
    total: items.length,
    byBrand,
    brands: brandMeta,
    failed: [...new Set([...(existing.failed ?? []).filter((b) => !collected.has(b)), ...failed])],
    items,
  }

  const nextJson = JSON.stringify({ ...out, updatedAt: null }, null, 2)
  const prevJson = JSON.stringify({ ...existing, updatedAt: null }, null, 2)
  if (nextJson === prevJson) {
    console.log('\n· 변경 없음 → 저장 생략')
    return
  }

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8')

  const summary = Object.entries(byBrand)
    .sort((a, b) => b[1] - a[1])
    .map(([b, n]) => `${b} ${n}`)
    .join(' · ')
  console.log(`\n✅ ${OUTPUT_PATH}\n   총 ${items.length}건 — ${summary}`)
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
