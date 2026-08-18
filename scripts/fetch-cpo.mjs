// 인증중고차(CPO) 매물 스크래퍼 — 국산·수입 브랜드 공식 소스만 사용.
// 출력: cpo/listings.json
//
// 설계: fetch-car-deals.mjs의 어댑터 레지스트리 패턴을 따른다.
//   - 어댑터 성공 → items에 정규화된 매물
//   - 어댑터 실패 → 직전 데이터 유지(빈 목록으로 덮어쓰지 않는다)
//
// 정규화에서 제일 중요한 두 가지:
//   1. 가격 단위가 브랜드마다 다르다. BMW·벤츠·볼보는 원, 렉서스·아우디·토요타는 만원.
//      섞으면 5,900원짜리 렉서스가 생긴다. 여기서 전부 원(KRW 정수)으로 통일한다.
//   2. 주행거리 타입도 다르다. 정수 / float / 콤마 포함 문자열이 섞여 있다 → 정수 km로 통일.
//
// 수집하지 않는 것: VIN, 차량번호판. BMW·벤츠 API가 그대로 주지만 개인정보라 버린다.
//
// fetch로 못 받는 세 브랜드는 fetch-cpo-pw.mjs가 담당한다:
//   포르쉐 — Vercel 봇 챌린지가 curl을 막는다.
//   볼보   — 페이지네이션이 URL로 안 움직인다("12개 더 로드하기" 클릭이 필요).
//   BMW    — WAF가 짧은 간격의 연속 요청을 막는다. 브라우저 컨텍스트 + 넓은 간격이 필요.
//
// Usage:
//   node scripts/fetch-cpo.mjs             # 전체
//   node scripts/fetch-cpo.mjs lexus,audi  # 특정 브랜드만(나머지는 기존 데이터 유지)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../cpo/listings.json')

const ONLY = process.argv[2]
  ? new Set(process.argv[2].split(',').map((s) => s.trim()).filter(Boolean))
  : null

// 전량을 긁지 않는다. 최신순으로 정렬해 브랜드당 이만큼만 받는다.
// 딥 페이징은 소스마다 다른 방식으로 깨진다(벤츠는 상한, BMW는 클릭 유실) — 애초에 안 하는 게 낫고
// 인증중고차 앱에서 중요한 건 최근 매물이다. 0이면 무제한.
// 빈 문자열도 "미지정"으로 본다 — Actions에서 입력을 비우면 env가 ''로 들어오고
// Number('')는 0(무제한)이 되어 기본값이 뒤집힌다.
const MAX_PER_BRAND = process.env.MAX_PER_BRAND ? Number(process.env.MAX_PER_BRAND) : 300
const capped = (n) => (MAX_PER_BRAND > 0 && n >= MAX_PER_BRAND)

// 소스가 알려주는 "전체 재고 수". 앱에서 "전체 1,344대 중 최신 300대"를 쓰려면 필요하다.
// 어댑터가 받은 값을 여기 적어두고 main()이 출력에 싣는다.
const sourceTotals = {}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function todayKST() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
}

/** '99,220' | 22815.0 | 8407 → 8407 (정수 km). 못 읽으면 null. */
function toKm(v) {
  if (v == null) return null
  const n = Math.round(Number(String(v).replace(/[^\d.]/g, '')))
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * 가격을 원(KRW) 정수로. 단위는 브랜드가 아니라 레코드 크기로 판정한다.
 *
 * 브랜드별로 고정하면 틀린다 — 아우디는 같은 응답 안에서 단위를 섞어 보낸다.
 * 67건 중 66건이 원(23000000 / '₩ 23,000,000')이고 1건만 만원(9700 / '₩ 9,700')이었다.
 * 100만원 미만인 중고차는 없으니 그 아래는 만원 표기로 본다.
 */
function priceToKrw(v) {
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n < 1_000_000 ? n * 10000 : n)
}

// ───────────────────────── 현대 인증중고차 ─────────────────────────
// POST /p/search/vehicle/list 가 목록을 **HTML 조각**으로 준다(JSON 아님). form-urlencoded 바디.
// 브라우저 없이 curl로도 열린다 → CI에서 돌 수 있다. robots.txt는 Allow: / 로 전면 허용.
//
// ⚠ sortType 유효값을 아직 popularity만 확인했다(recent·regDate·newest는 500).
//   최신순 값을 확인하기 전까지는 인기순으로 받는다 — 최신 N건 정책과 어긋나는 유일한 브랜드다.
const HYUNDAI_LIST = 'https://certified.hyundai.com/p/search/vehicle/list'
const HYUNDAI_PAGE_SIZE = 15

async function hyundaiPage(pageIdx) {
  const body = new URLSearchParams({
    ntcSeq: '',
    type: 'PLP',
    pageIdx: String(pageIdx),
    rowsPerPage: String(HYUNDAI_PAGE_SIZE),
    startNo: String((pageIdx - 1) * HYUNDAI_PAGE_SIZE),
    listCnt: String(HYUNDAI_PAGE_SIZE),
    sortType: 'popularity',
    srchType: 'srchWord',
    searchWord: '',
    sdStatCd: '',
    selectedCodeList: '',
    lowPrice: '0',
    highPrice: '0',
    lowMileage: '0',
    highMileage: '',
    lowModelYear: '',
    highModelYear: '',
  })
  const res = await fetch(HYUNDAI_LIST, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': UA,
      Referer: 'https://certified.hyundai.com/p/search/vehicle',
    },
    body,
  })
  if (!res.ok) throw new Error(`hyundai HTTP ${res.status}`)
  return res.text()
}

function parseHyundaiCards(html) {
  const $ = cheerio.load(html)
  const out = []

  // 총 재고 수는 <em id="totalVehicleCnt">1,064</em> 에 있다.
  const total = toKm($('#totalVehicleCnt').first().text())
  if (total) sourceTotals.hyundai = total

  // 구조: ul#productList > li > a[href="javascript:common.link.goodsDeatil('<ID>')"]
  //   .unit_info .name  → "2023 투싼(NX4) 하이브리드 2WD 모던"  (앞 4자리가 연식)
  //   .drive span       → [최초등록("23년 11월"), 주행거리, 번호판, 지역]
  //   .price .pay em    → 만원 단위 판매가. del.txt.del은 할인 전 가격이라 쓰지 않는다.
  $('#productList > li').each((_, li) => {
    const $li = $(li)
    const href = $li.find('a[href*="goodsDeatil"]').first().attr('href') ?? ''
    const id = href.match(/goodsDeatil\('([A-Z0-9]+)'\)/)?.[1] ?? null
    if (!id) return

    const name = $li.find('.unit_info .name').first().text().trim() || null
    const spans = $li
      .find('.drive span')
      .map((__, sp) => $(sp).text().trim())
      .get()

    // 번호판(예: 269로8643)은 개인정보라 담지 않는다. 지역만 취한다.
    const plateIdx = spans.findIndex((t) => /^\d{2,3}[가-힣]\d{4}$/.test(t))
    const region = plateIdx >= 0 ? (spans[plateIdx + 1] ?? null) : (spans[spans.length - 1] ?? null)

    const regTxt = spans.find((t) => /^\d{2}년\s*\d{1,2}월$/.test(t)) ?? null
    const firstRegistration = regTxt
      ? `20${regTxt.slice(0, 2)}-${String(regTxt.match(/(\d{1,2})월/)[1]).padStart(2, '0')}`
      : null

    out.push({
      brand: 'hyundai',
      id,
      model: name,
      trim: null,
      year: Number(name?.match(/^(\d{4})/)?.[1]) || null,
      mileageKm: toKm(spans.find((t) => /km$/.test(t))),
      priceKrw: priceToKrw($li.find('.price .pay em').first().text().trim()),
      newPriceKrw: null,
      fuel: null,
      transmission: null,
      bodyType: null,
      color: null,
      firstRegistration,
      accident: null,
      warranty: null,
      dealer: null,
      region,
      // 개별 상세 URL이 없다. goodsDetail.do는 브라우저에서도 400이고, JS가 만드는 경로를
      // 재현하지 못했다. 대신 ID로 검색하면 정확히 그 한 대만 나오므로 그 링크를 쓴다(실측 확인).
      url: `https://certified.hyundai.com/p/search/vehicle?srchType=srchWord&searchWord=${id}`,
      image: $li.find('img').first().attr('src') ?? null,
    })
  })

  return out
}

async function hyundai() {
  const items = []
  for (let pageIdx = 1; pageIdx <= 40; pageIdx += 1) {
    const cards = parseHyundaiCards(await hyundaiPage(pageIdx))
    if (cards.length === 0) break
    for (const c of cards) {
      if (capped(items.length)) break
      if (!items.some((x) => x.id === c.id)) items.push(c)
    }
    if (capped(items.length)) break
    await sleep(600)
  }
  return items
}

// ───────────────────────── 기아 인증중고차 ─────────────────────────
// 순수 JSON API. 브라우저·키·쿠키 전부 불필요하고 curl로 그냥 열린다.
// sort=DISPLAYED_AT_DESC = **매물 등록일 최신순**. 다른 브랜드는 연식·생산일로 대신했는데
// 기아는 진짜 "최근 올라온 매물"로 정렬할 수 있는 유일한 소스다.
// 페이지네이션은 커서 방식: 응답 레코드의 cursors 배열을 다음 요청에 그대로 넘긴다.
const KIA_API = 'https://cpo.kia.com/api/search/'
const KIA_PAGE_SIZE = 50

async function kia() {
  const items = []
  let cursors = null

  for (let page = 0; page < 40; page += 1) {
    const qs = new URLSearchParams({
      size: String(KIA_PAGE_SIZE),
      sort: 'DISPLAYED_AT_DESC',
      displayChannel: 'GENERAL',
    })
    for (const c of cursors ?? []) qs.append('cursors[]', String(c))

    const res = await fetch(`${KIA_API}?${qs}`, {
      headers: { Accept: 'application/json', 'User-Agent': UA, Referer: 'https://cpo.kia.com/products/' },
    })
    if (!res.ok) throw new Error(`kia HTTP ${res.status}`)
    const json = await res.json()
    if (json.totalElements) sourceTotals.kia = json.totalElements

    const rows = json.content ?? []
    if (rows.length === 0) break

    for (const c of rows) {
      if (capped(items.length)) break
      items.push({
        brand: 'kia',
        id: c.id != null ? String(c.id) : null,
        model: c.modelName ?? null,
        trim: c.modelTrim ?? null,
        year: c.modelYear ? Number(c.modelYear) : null,
        mileageKm: toKm(c.drivingDistance),
        priceKrw: priceToKrw(c.price),
        newPriceKrw: null,
        fuel: c.modelEngine ?? null,
        transmission: c.modelMission ?? null,
        bodyType: null,
        color: c.exteriorColorCodeName ?? null,
        firstRegistration: c.firstRegisteredOn ?? null,
        accident: null,
        warranty: null,
        // 기아만 주는 두 필드. listedAt은 매물이 올라온 시각(최신순 정렬 기준),
        // reserved는 예약중 여부다. 앱에서 "이미 빠진 차" 신호로 쓸 수 있다.
        listedAt: c.displayedAt ?? null,
        reserved: c.reserved ?? null,
        // 목록 응답에 판매점 정보가 없다. plateNumber(번호판)는 오지만 개인정보라 담지 않는다.
        dealer: null,
        region: null,
        // 상세 경로는 /products/detail/?id=N 이다(/products/N 은 404).
        url: c.id != null ? `https://cpo.kia.com/products/detail/?id=${c.id}` : null,
        image: c.exteriorImageUrl ?? null,
      })
    }

    if (capped(items.length)) break
    cursors = rows[rows.length - 1]?.cursors ?? null
    if (!cursors) break
    await sleep(500)
  }

  return items
}

// ───────────────────────── Mercedes-Benz ─────────────────────────
// commerce/onesearch GraphQL. (viss/graphql은 단건 조회용이라 목록엔 못 쓴다)
// profileId·vehicleCategory는 configuration 쿼리가 알려주는 값을 그대로 쓴다.
const MB_URL = 'https://ap.api.oneweb.mercedes-benz.com/commerce/onesearch/graphql'
const MB_KEY = 'd1dcd3a9-25fd-4896-b041-4d35cfdbb482'
const MB_PAGE_SIZE = 50
const MB_MAX_PAGES = 80 // 안전장치. 정상 재고라면 여기 닿지 않는다.

// registrationYear-desc = 최초등록 연도 내림차순. configuration 쿼리의 sortingOptions에서 확인한 값이다.
const MB_QUERY = `query Search($page: Int!, $limit: Int!) {
  search(profileId: "KR-USED_VEHICLES", vehicleCategory: "PASSENGER-CARS", language: "ko", sortingType: "registrationYear-desc", page: $page, limit: $limit) {
    navigation { totalResults totalPages currentPage }
    results {
      identification { code dealerId }
      vehicleModel { name modelYear typeClass bodyType { value } vehicleClass { value } }
      usedVehicleData {
        mileage { value unit }
        firstRegistrationDate
        numberPreviousOwners
        damagesRepairedFlag
      }
      technicalInformation { transmission { value } engine { fuelType { value } } }
      color { text group }
      images { default }
      price { grossValue }
      dealer { nameLocalLanguage addressLocalLanguage }
      pdpLink
    }
  }
}`

async function mbPage(page) {
  const res = await fetch(MB_URL, {
    method: 'POST',
    headers: {
      'x-api-key': MB_KEY,
      'Content-Type': 'application/json',
      'User-Agent': UA,
      Origin: 'https://www.mercedes-benz.co.kr',
    },
    body: JSON.stringify({ query: MB_QUERY, variables: { page, limit: MB_PAGE_SIZE } }),
  })
  if (!res.ok) throw new Error(`benz HTTP ${res.status}`)
  const json = await res.json()
  if (json.errors?.length) throw new Error(`benz GraphQL: ${json.errors[0].message}`)
  return json.data.search
}

async function benz() {
  const items = []

  // totalPages·totalResults를 믿고 돌면 안 된다.
  // limit=100이면 page 7(601번째부터)이 0건인데 limit=50이면 page 13(같은 601번째)이 정상으로 온다.
  // totalResults도 700으로 딱 떨어져서 실제 재고가 아니라 상한값으로 보인다.
  // 그래서 빈 페이지가 나올 때까지 도는 방식으로 간다.
  for (let page = 1; page <= MB_MAX_PAGES; page += 1) {
    const s = await mbPage(page)
    if (s.navigation?.totalResults) sourceTotals.benz = s.navigation.totalResults
    const rows = s.results ?? []
    if (rows.length === 0) break

    for (const v of rows) {
      if (capped(items.length)) break
      const uv = v.usedVehicleData ?? {}
      const ti = v.technicalInformation ?? {}
      items.push({
        brand: 'benz',
        id: v.identification?.code ?? null,
        model: v.vehicleModel?.name ?? null,
        // 벤츠는 마케팅 트림을 따로 주지 않는다. typeClass는 차대코드(W177)라
        // trim에 넣으면 오해를 부르므로 비워 둔다. 등급은 model 문자열에 들어 있다.
        trim: null,
        year: v.vehicleModel?.modelYear ?? null,
        mileageKm: toKm(uv.mileage?.value),
        priceKrw: priceToKrw(v.price?.grossValue),
        newPriceKrw: null,
        fuel: ti.engine?.fuelType?.value ?? null,
        transmission: ti.transmission?.value ?? null,
        bodyType: v.vehicleModel?.bodyType?.value ?? null,
        color: v.color?.text ?? v.color?.group ?? null,
        firstRegistration: uv.firstRegistrationDate ? uv.firstRegistrationDate.slice(0, 10) : null,
        // 스키마에는 있으나 한국 재고는 값이 비어 있다(전 건 null 확인).
        accident: uv.damagesRepairedFlag ?? null,
        warranty: null,
        previousOwners: uv.numberPreviousOwners ?? null,
        vehicleClass: v.vehicleModel?.vehicleClass?.value ?? null,
        chassisCode: v.vehicleModel?.typeClass ?? null,
        dealer: v.dealer?.nameLocalLanguage ?? null,
        region: v.dealer?.addressLocalLanguage ?? null,
        url: v.pdpLink ?? null,
        image: v.images?.default ?? null,
      })
    }
    if (capped(items.length)) break
    await sleep(600)
  }

  return items
}

// ───────────────────────── Lexus · Toyota ─────────────────────────
// 토요타코리아가 두 브랜드를 같은 시스템으로 돌린다. API 프리픽스만 다르다.
// 페이징 파라미터는 page가 아니라 cur_page — page를 주면 200이 오지만 내용은 계속 1페이지다.
// 가격은 만원 단위. release_price(신차가)가 있어 감가율 계산이 가능한 유일한 축이다.
function toyotaFamily(brand, origin, apiPrefix) {
  return async function () {
    const items = []
    let page = 1
    let totalPage = 1

    while (page <= totalPage) {
      const url = `${origin}/${apiPrefix}/json/getList_search.json.php?cur_page=${page}`
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: `${origin}/car-list/` },
      })
      if (!res.ok) throw new Error(`${brand} HTTP ${res.status}`)
      const json = await res.json()
      const list = json?.search_list
      if (!list) throw new Error(`${brand}: search_list 없음`)
      totalPage = list.total_page ?? 1
      if (list.total_list_num) sourceTotals[brand] = list.total_list_num

      for (const c of list.car_list ?? []) {
        if (capped(items.length)) break
        items.push({
          brand,
          id: c.idx != null ? String(c.idx) : null,
          model: c.model_name ?? null,
          trim: c.class_name ?? null,
          year: c.year ? Number(c.year) : null,
          mileageKm: toKm(c.mileage),
          priceKrw: priceToKrw(c.price),
          newPriceKrw: priceToKrw(c.release_price),
          fuel: null,
          transmission: null,
          bodyType: null,
          color: c.color?.title ?? null,
          firstRegistration: null,
          accident: null,
          warranty: null,
          dealer: c.branch?.title ?? null,
          region: c.branch?.title ?? null,
          url: c.idx != null ? `${origin}/car-detail/?idx=${c.idx}` : null,
          image: c.thumb_url ?? null,
        })
      }

      if (capped(items.length)) break
      page += 1
      if (page <= totalPage) await sleep(500)
    }

    return items
  }
}

const lexus = toyotaFamily('lexus', 'https://certified.lexus.co.kr', 'api')
const toyota = toyotaFamily('toyota', 'https://certified.toyota.co.kr', 'tc_api')

// ───────────────────────── Audi Approved :plus ─────────────────────────
// SCS. 헤더 이름이 Token이다(x-api-key 아님 — 틀리면 401).
// 마켓 코드는 신차 kr / 인증중고차 kruc. 없는 코드는 404가 아니라 500으로 떨어진다.
// 한 번의 요청으로 전량이 온다(size=200. 500을 주면 400이 난다).
async function audi() {
  const res = await fetch('https://scs.audi.de/api/v2/search/filter/kruc/ko?size=200', {
    headers: { Token: 'FJ54W6H', Accept: 'application/json', 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`audi HTTP ${res.status}`)
  const json = await res.json()

  const rows = json.vehicleBasic ?? []
  if (json.totalCount) sourceTotals.audi = json.totalCount
  return (MAX_PER_BRAND > 0 ? rows.slice(0, MAX_PER_BRAND) : rows).map((a) => ({
    brand: 'audi',
    id: a.carId ?? null,
    model: a.model?.description ?? null,
    trim: a.trimline?.description ?? null,
    year: a.modelYear ?? null,
    mileageKm: toKm(a.used?.mileage),
    priceKrw: priceToKrw((a.typedPrices ?? [])[0]?.amount),
    newPriceKrw: null,
    fuel: a.fuel?.description ?? null,
    transmission: a.gearType?.description ?? null,
    bodyType: a.bodyType?.description ?? null,
    color: a.extColor?.description ?? null,
    firstRegistration: a.used?.initialRegistration ?? null,
    accident: null,
    warranty: (a.used?.warrantyTypes ?? [])[0]?.description ?? null,
    dealer: a.dealer?.name ?? null,
    region: a.dealer?.city ?? null,
    url: a.weblink ?? null,
    // 아우디는 이 엔드포인트로 실제 차량 사진을 주지 않는다(67건 전부 tilesPictures 없음).
    // fallbackPictures에는 아우디 로고 플레이스홀더만 있어서 채우면 사진이 있는 것처럼 보인다.
    image: null,
  }))
}

// 어댑터 레지스트리: 여기 추가하면 자동 수집 대상이 된다.
// 포르쉐(봇 챌린지)·볼보(클릭 페이지네이션)는 fetch-cpo-pw.mjs에서 처리한다.
const ADAPTERS = { hyundai, kia, benz, lexus, audi, toyota }

// ───────────────────────── 브랜드 메타 ─────────────────────────
// searchUrl = 앱의 "나머지는 공식 사이트에서" 링크. 최신 N건만 보여주고 전체는 여기로 넘긴다.
const BRANDS = [
  {
    id: 'hyundai',
    name: '현대 인증중고차',
    searchUrl: 'https://certified.hyundai.com/p/search/vehicle',
  },
  { id: 'kia', name: '기아 인증중고차', searchUrl: 'https://cpo.kia.com/products/' },
  {
    id: 'bmw',
    name: 'BMW Premium Selection',
    pw: true,
    searchUrl: 'https://www.bmw.co.kr/ko-kr/sl/usedcarfinder/results',
  },
  {
    id: 'mini',
    name: 'MINI NEXT',
    pw: true,
    searchUrl: 'https://www.mini.co.kr/ko-kr/sl/usedcarfinder/results',
  },
  {
    id: 'benz',
    name: 'Mercedes-Benz 인증중고차',
    searchUrl: 'https://www.mercedes-benz.co.kr/passengercars/buy/used-car/search-results.html',
  },
  {
    id: 'volvo',
    name: 'Volvo Selekt',
    pw: true,
    searchUrl: 'https://selekt.volvocars.co.kr/kr/vehicles/volvo/all-models',
  },
  {
    id: 'porsche',
    name: 'Porsche Approved',
    pw: true,
    // 앱이 CPO만 보여주므로 링크도 인증중고차 필터가 걸린 검색으로 보낸다.
    searchUrl: 'https://finder.porsche.com/kr/ko-KR/search?condition=porsche_approved',
  },
  { id: 'lexus', name: 'Lexus Certified', searchUrl: 'https://certified.lexus.co.kr/car-list/' },
  {
    id: 'audi',
    name: 'Audi Approved :plus',
    searchUrl: 'https://www.audi.co.kr/ko/kr-used-car-search/',
  },
  { id: 'toyota', name: 'Toyota Certified', searchUrl: 'https://certified.toyota.co.kr/car-list/' },
]

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
  const items = []
  const failed = []

  for (const meta of BRANDS) {
    const adapter = ADAPTERS[meta.id]
    const prev = prevItems.get(meta.id) ?? []

    if (!adapter) {
      // Playwright 담당 브랜드는 이 스크립트가 건드리지 않고 기존 데이터를 그대로 넘긴다.
      items.push(...prev)
      console.log(`· ${meta.id}: ${meta.pw ? 'Playwright 담당' : '어댑터 없음'} → 기존 ${prev.length}건 유지`)
      continue
    }

    if (ONLY && !ONLY.has(meta.id)) {
      items.push(...prev)
      console.log(`· ${meta.id}: 이번 실행 대상 아님 → 기존 ${prev.length}건 유지`)
      continue
    }

    try {
      const got = await adapter()
      if (got.length === 0) throw new Error('0건 파싱됨')
      items.push(...got)
      console.log(`✓ ${meta.id}: ${got.length}건`)
    } catch (err) {
      // 실패 → 직전 데이터 유지. 빈 목록으로 덮어써서 앱 화면을 비우는 것이 최악이다.
      items.push(...prev)
      failed.push(meta.id)
      console.warn(`⚠ ${meta.id}: 실패(${err.message}) → 기존 ${prev.length}건 유지`)
    }
  }

  // 두 스크립트(fetch / pw)가 같은 파일을 갱신하므로 순서를 고정한다.
  // 안 하면 브랜드 순서만 달라져도 매일 diff가 나서 커밋 노이즈가 생긴다.
  items.sort((a, b) => a.brand.localeCompare(b.brand) || String(a.id).localeCompare(String(b.id)))

  const byBrand = {}
  for (const it of items) byBrand[it.brand] = (byBrand[it.brand] ?? 0) + 1

  // 앱이 "최신 N건만 보여주고 나머지는 공식 사이트로" 화면을 만들 수 있게
  // 브랜드별 수집 수 · 소스 전체 재고 수 · 전체보기 링크를 함께 싣는다.
  const prevBrands = existing.brands ?? {}
  const brands = {}
  for (const meta of BRANDS) {
    const collected = byBrand[meta.id] ?? 0
    if (collected === 0 && !prevBrands[meta.id]) continue
    brands[meta.id] = {
      name: meta.name,
      collected,
      // 이번에 안 돌린 브랜드는 직전 값을 유지한다(모르는 걸 0으로 쓰지 않는다).
      sourceTotal: sourceTotals[meta.id] ?? prevBrands[meta.id]?.sourceTotal ?? null,
      searchUrl: meta.searchUrl ?? null,
    }
  }

  const out = {
    updatedAt: todayKST(),
    maxPerBrand: MAX_PER_BRAND,
    total: items.length,
    byBrand,
    brands,
    failed,
    items,
  }

  // 변경 없으면 저장 생략 — 매일 커밋 노이즈를 막는다.
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
  if (failed.length) console.log(`   ⚠ 실패: ${failed.join(', ')}`)
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
