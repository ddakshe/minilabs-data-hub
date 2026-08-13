// 편의점 4사(CU·GS25·이마트24·세븐일레븐) 이달의 행사상품(1+1/2+1/증정/할인) 스크래퍼.
// convenience-events-mini 앱용. fetch만 사용(playwright 불필요).
//
// Usage (인자=긁을 체인 콤마목록, 생략=전체. 안 긁는 체인은 기존 데이터 유지):
//   node scripts/fetch-convenience-events.mjs                 # 전체(cu,gs25,emart24,seven) — 로컬(한국 IP)용
//   node scripts/fetch-convenience-events.mjs cu,gs25,emart24 # 세븐 제외 — GitHub Actions(해외 IP)용, 세븐 보존
//   node scripts/fetch-convenience-events.mjs seven          # 세븐만
//
// 하이브리드 운영: GitHub Action은 cu,gs25,emart24(세븐은 해외 IP 차단)·로컬 launchd는 전체(세븐 포함).
//
// 비공식 내부 AJAX/HTML 역공학. 사이트 구조가 바뀌면 해당 체인 파서만 깨진다.
//   CU     : POST /event/plusAjax.do (무인증, HTML)
//   GS25   : 페이지 GET→CSRF+쿠키 → POST /event-goods-search (이중 인코딩 JSON)
//   이마트24: GET /goods/event?page=N (서버렌더 HTML, 뱃지 class로 유형 판별)
//   세븐   : PC POST /product/listMoreAjax.asp (intCurrentPage 무시→intPageSize가 총개수)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../convenience-events/products.json')
// 긁을 체인 키 집합. 생략 시 null = 전체. 목록에 없는 체인은 기존 데이터 유지.
const ONLY = process.argv[2]
  ? new Set(process.argv[2].split(',').map((s) => s.trim()).filter(Boolean))
  : null

// 부분 수집 감지 임계치. 파서가 예외를 던지면 아래 catch가 직전 데이터로 막아주지만,
// 페이징이 조용히 일찍 끝나 "성공했는데 절반만" 가져오는 경우는 그대로 통과했다:
//   2026-07-14 이마트24 2262 → 1273 (-44%) — 3주간 반쪽 데이터가 라이브
//   2026-07-30 GS25    1665 →  708 (-57%) — 나흘간 라이브 (Action은 초록불)
// 정상 주간 변동은 5% 미만이라 20%를 이상 신호로 본다.
// 실제로 줄어든 게 맞으면 ALLOW_SHRINK=1 로 한 번 통과시킨다.
const SHRINK_LIMIT = Number(process.env.SHRINK_LIMIT ?? 0.2)
const ALLOW_SHRINK = process.env.ALLOW_SHRINK === '1'

// 완결성 검증: GS25·이마트24는 응답에 자기 총 개수를 실어 보낸다
// (GS25 pagination.totalNumberOfResults, 이마트24 totalCount).
// 그 값에 못 미치게 수집됐다면 페이징이 조기 종료된 것이므로 실행을 실패시킨다.
// 직전 대비 비율을 보는 SHRINK_LIMIT과 달리 이력이 필요 없고, 첫 실행에서 바로 잡힌다.
// (2026-07-30 GS25가 708건일 때 사이트는 1665건이라고 답하고 있었다)
class IncompleteError extends Error {}
// 이마트24는 바코드 중복 제거분 때문에 totalCount와 몇 건 어긋난다(관측 2364 vs 2361 = 0.13%). 2% 여유.
const E24_TOLERANCE = 0.02
const ALLOW_INCOMPLETE = process.env.ALLOW_INCOMPLETE === '1'

// ───────────────────────── 공용 헬퍼 ─────────────────────────

const UA_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function todayKST() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
}

// 텍스트 GET/POST + 지수 백오프 재시도
async function http(url, { method = 'GET', headers = {}, body, retries = 4, timeoutMs = 60000 } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': UA_DESKTOP, 'Accept-Language': 'ko-KR,ko;q=0.9', ...headers },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text()
      return { status: res.status, text, headers: res.headers }
    } catch (err) {
      lastErr = err
      if (attempt < retries) await sleep(500 * 2 ** attempt)
    }
  }
  throw lastErr
}

function collectCookies(headers) {
  const raw = headers.getSetCookie ? headers.getSetCookie() : []
  return raw.map((c) => c.split(';')[0]).join('; ')
}

const decode = (s) =>
  (s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()

const toPrice = (s) => {
  if (s == null) return null
  const n = String(s).replace(/[^0-9]/g, '')
  return n ? Number(n) : null
}

// 체인별 제각각인 라벨을 4종으로 정규화
const TYPE_MAP = { '1+1': '1+1', '2+1': '2+1', 증정: '증정', 덤증정: '증정', 할인: '할인' }
const normalizeEventType = (raw) => TYPE_MAP[(raw ?? '').trim()] ?? null

// ───────────────────────── CU ─────────────────────────
// searchCondition: ''=전체, 23=1+1, 24=2+1. listType=0(새 목록). 무인증.

const CU_ENDPOINT = 'https://cu.bgfretail.com/event/plusAjax.do'
const CU_REFERER = 'https://cu.bgfretail.com/event/plus.do?category=service&depth2=1'

function parseCuBlock(block) {
  const id = block.match(/view\((\d+)\)/)?.[1]
  const name = decode(block.match(/<div class="name">\s*<p>([\s\S]*?)<\/p>/)?.[1])
  const price = toPrice(block.match(/<div class="price">\s*<strong>([\d,]+)<\/strong>/)?.[1])
  let img = block.match(/<img\s+src="([^"]+)"[^>]*class="prod_img"/)?.[1] || ''
  if (img.startsWith('//')) img = 'https:' + img
  let eventType = null
  if (/class="plus1"/.test(block)) eventType = '1+1'
  else if (/class="plus2"/.test(block)) eventType = '2+1'
  if (!id || !name || !eventType) return null
  return { id: `cu-${id}`, chain: 'CU', name, price, eventType, image: img, category: null }
}

async function scrapeCU({ maxPages = 200 } = {}) {
  const out = []
  for (let page = 1; page <= maxPages; page++) {
    const { status, text } = await http(CU_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Referer: CU_REFERER,
      },
      body: `pageIndex=${page}&listType=0&searchCondition=&searchUseYn=N`,
    })
    if (status !== 200) throw new Error(`CU HTTP ${status} (page ${page})`)
    if (/조회된 상품이 없습니다/.test(text)) break
    const blocks = text.split('<li class="prod_list">').slice(1)
    if (blocks.length === 0) break
    const parsed = blocks.map(parseCuBlock).filter(Boolean)
    if (parsed.length === 0) break
    out.push(...parsed)
  }
  const seen = new Set()
  return out.filter((p) => (seen.has(p.id) ? false : seen.add(p.id)))
}

// ───────────────────────── GS25 ─────────────────────────
// 페이지 GET으로 CSRF+쿠키 → event-goods-search POST. 응답은 이중 인코딩 JSON.

const GS_PAGE = 'http://gs25.gsretail.com/gscvs/ko/products/event-goods'
const GS_SEARCH = 'http://gs25.gsretail.com/gscvs/ko/products/event-goods-search'
const GS_TYPES = [
  { code: 'ONE_TO_ONE', label: '1+1' },
  { code: 'TWO_TO_ONE', label: '2+1' },
  { code: 'GIFT', label: '증정' },
]

// 이중 인코딩 JSON. results뿐 아니라 pagination(총 개수)도 쓰므로 통째로 돌려준다.
function parseGsBody(text) {
  let data = JSON.parse(text)
  if (typeof data === 'string') data = JSON.parse(data)
  return data ?? {}
}

async function scrapeGS25({ maxPages = 200 } = {}) {
  const first = await http(GS_PAGE)
  const cookie = collectCookies(first.headers)
  const token = first.text.match(/name="CSRFToken"[^>]*value="([^"]+)"/)?.[1]
  if (!token) throw new Error('GS25 CSRFToken 추출 실패')

  const out = []
  for (const t of GS_TYPES) {
    let expected = null // 이 유형의 총 개수(페이지1 응답이 알려준다)
    let got = 0 // 서버가 실제로 돌려준 건수(중복 제거 전 — 상류 총계와 같은 기준)
    let emptyRetry = 0
    for (let page = 1; page <= maxPages; page++) {
      const { status, text } = await http(GS_SEARCH, {
        method: 'POST',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: GS_PAGE,
          Cookie: cookie,
        },
        body: `CSRFToken=${token}&pageNum=${page}&pageSize=20&searchType=&searchWord=&parameterList=${t.code}`,
      })
      if (status !== 200) throw new Error(`GS25 HTTP ${status} (${t.code} p${page})`)
      const body = parseGsBody(text)
      const results = body.results ?? []
      expected ??= body.pagination?.totalNumberOfResults ?? null
      if (!results.length) {
        // 아직 총 개수를 못 채웠는데 빈 응답이면 일시적일 수 있다 → 같은 페이지를 재시도한다.
        // 예전엔 여기서 곧바로 break 해서, 빈 응답 한 번에 708/1665처럼 반쪽만 수집하고
        // "성공"으로 끝났다(2026-07-30 사고).
        if (expected != null && got < expected && emptyRetry < 2) {
          emptyRetry++
          console.warn(`  GS25 ${t.label} p${page} 빈 응답 — 재시도 ${emptyRetry}/2 (${got}/${expected})`)
          page--
          await sleep(1500)
          continue
        }
        break
      }
      emptyRetry = 0
      got += results.length
      for (const r of results) {
        out.push({
          id: `gs25-${r.attFileId || r.goodsNm}`,
          chain: 'GS25',
          name: (r.goodsNm || '').trim(),
          price: r.price != null ? Math.round(r.price) : null,
          eventType: normalizeEventType(r.eventTypeNm) ?? t.label,
          image: r.attFileNm || '',
          category: null,
        })
      }
    }
    // 상류가 말한 총 개수를 못 채웠으면 조기 종료다 — 반쪽 데이터를 커밋하지 않는다.
    if (expected != null && got < expected) {
      throw new IncompleteError(`GS25 ${t.label} ${got}/${expected}건만 수집(페이징 조기 종료)`)
    }
  }
  const seen = new Set()
  return out.filter((p) => (seen.has(p.id) ? false : seen.add(p.id)))
}

// ───────────────────────── 세븐일레븐 ─────────────────────────
// PC 목록(이름·가격 인라인). pTab: 1=1+1, 2=2+1, 3=증정, 4=할인. 이미지는 일부만(상대경로).
//
// 페이지 파라미터는 intCurrentPage가 아니라 intCurrPage다(presentList.asp의 $.ajax 참고).
// 예전엔 틀린 이름을 보내 서버가 무시 → "페이지네이션 불가"로 오해하고 intPageSize=3000 한방으로 긁었다.
// 그 방식의 문제 두 가지:
//   1) 서버가 항목당 ~0.13s를 쓰는데 ASP 스크립트 타임아웃이 ~120s → 1000건 넘는 탭(2+1: 1064건)은
//      매번 302 → /500.asp 로 튕겼다.
//   2) 페이지 미지정 시 서버가 초기 렌더분 13건을 건너뛴 위치부터 반환 → 성공한 탭도 앞 13건이 누락,
//      2건짜리 증정 탭은 통째로 0건이 됐다.
// → 올바른 이름으로 잘게 페이징한다. page=1은 초기 렌더분 13건만, page>=2는 그 뒤로 SV_PAGE_SIZE씩.

const SV_ENDPOINT = 'https://www.7-eleven.co.kr/product/listMoreAjax.asp'
const SV_REFERER = 'https://www.7-eleven.co.kr/product/presentList.asp'
const SV_ORIGIN = 'https://www.7-eleven.co.kr'
const SV_TABS = [
  { pTab: '1', label: '1+1' },
  { pTab: '2', label: '2+1' },
  { pTab: '3', label: '증정' },
  { pTab: '4', label: '할인' },
]
// 항목당 ~0.13s → 300건 ≈ 40s. 서버 타임아웃(~120s)까지 3배 여유.
const SV_PAGE_SIZE = 300
// page=1이 반환하는 초기 렌더분 개수(presentList.asp의 intPageSize 기본값).
const SV_FIRST_PAGE_COUNT = 13
// 종료조건이 어긋나도 무한루프하지 않도록. 300*40 = 12000건까지 커버.
const SV_MAX_PAGES = 40

function parseSvBlock(block, fallbackLabel) {
  const id = block.match(/fncGoView\('([^']+)'\)/)?.[1]
  const name = decode(block.match(/<div class=['"]name['"][^>]*>([^<]+)<\/div>/)?.[1])
  const price = toPrice(block.match(/<div class=['"]price['"][^>]*>\s*<span>([\d,]+)<\/span>/)?.[1])
  const tagText = decode(block.match(/ico_tag_\d+['"]>([^<]+)</)?.[1])
  const eventType = normalizeEventType(tagText) ?? fallbackLabel
  const rel = block.match(/<img\s+src="(\/upload\/product\/[^"]+)"/)?.[1] || ''
  if (!id || !name) return null
  return { id: `seven-${id}`, chain: '7-ELEVEN', name, price, eventType, image: rel ? SV_ORIGIN + rel : '', category: null }
}

// 탭 목록 페이지의 intTotalCount = 그 탭의 총 상품 수. 종료조건 겸 수집 누락 검증용.
async function svTotalCount(pTab, cookie) {
  try {
    const res = await http(`${SV_REFERER}?pTab=${pTab}`, {
      headers: { Referer: SV_ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
      timeoutMs: 30000,
    })
    const n = Number(res.text.match(/intTotalCount\s*=\s*"(\d+)"/)?.[1])
    return Number.isFinite(n) ? n : null
  } catch {
    return null // 못 읽어도 짧은 페이지로 종료 판정 가능
  }
}

async function svFetchPage(pTab, page, cookieRef) {
  let res
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await http(SV_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: SV_REFERER,
        ...(cookieRef.value ? { Cookie: cookieRef.value } : {}),
      },
      body: `intPageSize=${SV_PAGE_SIZE}&intCurrPage=${page}&pTab=${pTab}&cateCd1=&cateCd2=&cateCd3=&pCd=`,
      timeoutMs: 120000,
    })
    const setCookie = collectCookies(res.headers)
    if (setCookie) cookieRef.value = setCookie
    if (res.status === 200) return res
    await sleep(2000 * (attempt + 1)) // 302(→/500.asp) 등 → 잠깐 쉬고 재시도
  }
  throw new Error(`7-Eleven HTTP ${res.status} (pTab ${pTab} page ${page})`)
}

async function scrapeSeven() {
  const out = []
  // ASP 세션 쿠키를 먼저 확보한다. 세션 없이 연속 요청하면 간헐적으로 302로 튕긴다.
  const cookieRef = { value: '' }
  try {
    const seed = await http(SV_REFERER, { headers: { Referer: SV_ORIGIN }, timeoutMs: 30000 })
    cookieRef.value = collectCookies(seed.headers)
  } catch {
    /* 시드 실패해도 탭 요청은 진행 */
  }

  for (const tab of SV_TABS) {
    const total = await svTotalCount(tab.pTab, cookieRef.value)
    const seen = new Set()
    const items = []

    for (let page = 1; page <= SV_MAX_PAGES; page++) {
      const res = await svFetchPage(tab.pTab, page, cookieRef)
      const parsed = res.text
        .split('<li>')
        .slice(1)
        .map((b) => parseSvBlock(b, tab.label))
        .filter(Boolean)

      let added = 0
      for (const p of parsed) {
        if (seen.has(p.id)) continue
        seen.add(p.id)
        items.push(p)
        added++
      }

      // page=1은 초기 렌더분(13건)만 주는 특수 케이스 → 짧다고 끝으로 판정하면 안 된다.
      if (page === 1) {
        if (total !== null && total <= SV_FIRST_PAGE_COUNT) break
        await sleep(800)
        continue
      }
      if (added === 0) break // 새 항목 없음 = 끝
      if (total !== null && items.length >= total) break
      if (parsed.length < SV_PAGE_SIZE) break // 마지막 페이지
      await sleep(800) // 연속 대용량 요청에 대한 서버 방어 완화
    }

    // intTotalCount는 사이트 자체 집계라 실제 노출 건수와 몇 건 어긋난다(할인 탭: 540 표기 / 536 노출).
    // 그런 상시 오차로 경고가 울면 무뎌지므로, 2% 넘게 빌 때만 = 진짜 중도 절단일 때만 알린다.
    if (total !== null && items.length < total * 0.98) {
      console.warn(`  ⚠ 7-ELEVEN ${tab.label}: ${items.length}/${total}개만 수집 — 중도 절단 의심`)
    }
    out.push(...items)
    await sleep(1500) // 탭 사이 간격
  }

  const seen = new Set()
  return out.filter((p) => (seen.has(p.id) ? false : seen.add(p.id)))
}

// ───────────────────────── 이마트24 ─────────────────────────
// /goods/event 페이지네이션(page=N, 20개/페이지). 상품 뱃지 class로 행사유형 판별.
// 세일→할인으로 통일. 이미지는 절대경로(msave...), 기본이미지(productPlaceHolder)는 제외.
const E24_BASE = 'https://emart24.co.kr/goods/event'
// 뱃지 class → 행사유형. 세일→할인 통일. gola=골라담기(이마트24 고유).
const E24_TYPE = { onepl: '1+1', twopl: '2+1', tripl: '3+1', sale: '할인', gola: '골라담기' }

function parseE24Block(block) {
  const cls = block.match(/class="(onepl|twopl|tripl|sale|gola)[^"]*floatR/)?.[1]
  const eventType = E24_TYPE[cls]
  const name = decode(block.match(/<div class="itemtitle">[\s\S]*?<a[^>]*>([^<]+)<\/a>/)?.[1])
  const price = toPrice(block.match(/class="price"[^>]*>\s*([\d,]+)\s*원/)?.[1])
  let img = block.match(/<div class="itemSpImg">[\s\S]*?<img[^>]*\ssrc="([^"]+)"/)?.[1] || ''
  if (img.includes('productPlaceHolder')) img = ''
  if (!eventType || !name) return null
  const barcode = img.match(/\/(\d{8,})\.\w+$/i)?.[1]
  return { id: `emart24-${barcode || name}`, chain: 'EMART24', name, price, eventType, image: img, category: null }
}

async function scrapeEmart24({ maxPages = 200 } = {}) {
  const out = []
  const seen = new Set()
  let expected = null // 페이지1 HTML의 totalCount = 전체 행사상품 수
  let dupRetry = 0
  for (let page = 1; page <= maxPages; page++) {
    const { status, text } = await http(
      `${E24_BASE}?search=&category_seq=&base_category_seq=&align=&page=${page}`
    )
    if (status !== 200) throw new Error(`emart24 HTTP ${status} (page ${page})`)
    if (expected == null) {
      const raw = text.match(/totalCount["'\s:=]+([\d,]+)/i)?.[1]
      if (raw) expected = Number(raw.replace(/,/g, ''))
    }
    const blocks = text.split('<div class="itemWrap">').slice(1)
    if (blocks.length === 0) break // 상품 없는 페이지 = 진짜 끝
    const parsed = blocks.map(parseE24Block).filter(Boolean)
    let fresh = 0
    for (const p of parsed) if (!seen.has(p.id)) (seen.add(p.id), out.push(p), fresh++)
    // 매핑된 상품이 있는데 전부 중복이면 마지막 페이지 반복 → 종료.
    // (매핑 안 되는 유형만 있는 페이지는 건너뛰고 계속 진행)
    if (parsed.length > 0 && fresh === 0) {
      // 아직 총 개수를 못 채웠다면 서버가 같은 페이지를 되돌려준 일시적 현상일 수 있다 → 다음 페이지로 계속.
      if (expected != null && out.length < expected && dupRetry < 2) {
        dupRetry++
        console.warn(`  이마트24 p${page} 전부 중복 — 다음 페이지로 계속 ${dupRetry}/2 (${out.length}/${expected})`)
        continue
      }
      break
    }
  }
  // 상류가 말한 총 개수에 크게 못 미치면 조기 종료다(중복 제거분만큼의 여유는 둔다).
  if (expected != null && out.length < Math.floor(expected * (1 - E24_TOLERANCE))) {
    throw new IncompleteError(`이마트24 ${out.length}/${expected}건만 수집(페이징 조기 종료)`)
  }
  return out
}

// ───────────────────────── 카테고리 자동분류 ─────────────────────────
// 상품명 키워드 기반(위에서부터 우선). 추가 스크래핑 없음.

const CATEGORY_RULES = [
  ['커피', ['아메리카노', '카페', '라떼', '콜드브루', '바리스타', '카누', '마키아토', '에스프레소', 'TOP', '칸타타', '조지아', '맥심']],
  ['주류', ['맥주', '소주', '막걸리', '와인', '하이볼', '위스키', '칭따오', '카스', '테라', '클라우드', '하이트', '참이슬', '처음처럼', '발포주', 'OB', '버드와이저', '아사히', '산토리']],
  ['아이스크림', ['아이스크림', '아이스', '월드콘', '메로나', '스크류바', '빵빠레', '설레임', '투게더', '바밤바', '수박바', '죠스바', '보석바', '구구콘', '탱크보이']],
  ['라면/면', ['라면', '우동', '짜장', '짬뽕', '비빔면', '냉면', '쌀국수', '컵누들', '큰사발', '왕뚜껑', '신라면', '진라면', '너구리']],
  ['베이커리', ['빵', '케이크', '샌드위치', '도넛', '카스테라', '베이글', '크로플', '크림빵', '소보로', '단팥', '롤']],
  ['간편식사', ['도시락', '김밥', '삼각김밥', '주먹밥', '버거', '햄버거', '핫도그', '만두', '죽', '국밥', '덮밥', '볶음밥']],
  ['유제품', ['우유', '두유', '요거트', '요구르트', '치즈', '버터', '생크림', '연유']],
  ['스낵/과자', ['스낵', '칩', '새우깡', '포카칩', '프링글스', '꼬깔', '빼빼로', '과자', '쿠키', '비스킷', '팝콘', '젤리', '초콜릿', '초코', '사탕', '캔디', '크래커', '나초', '감자', '콘칩']],
  ['안주/간식', ['오징어', '육포', '견과', '땅콩', '아몬드', '쥐포', '노가리', '황태', '어묵', '소시지', '후랑크', '닭', '족발', '닭발']],
  ['음료', ['콜라', '사이다', '스프라이트', '환타', '주스', '에이드', '워터', '생수', '탄산', '이온', '토레타', '게토레이', '포카리', '식혜', '수정과', '차', '티', '콤부차', '스무디', '쉐이크', 'ml', 'L)', '데미소다', '밀키스', '펩시', '마운틴듀']],
  ['생활용품', ['칫솔', '치약', '샴푸', '린스', '비누', '세제', '면도', '마스크', '물티슈', '휴지', '배터리', '건전지', '스타킹', '양말', '핸드워시', '왁스', '스프레이']],
  ['위생용품', ['라이너', '순면', '울날', '오버나이트', '생리대', '패드', '탐폰', '기저귀', '콘돔']],
]

function categorize(name) {
  const n = (name || '').toLowerCase()
  for (const [cat, kws] of CATEGORY_RULES) {
    if (kws.some((k) => n.includes(k.toLowerCase()))) return cat
  }
  return '기타'
}

// ───────────────────────── 메인 ─────────────────────────

const SOURCES = [
  ['cu', 'CU', scrapeCU],
  ['gs25', 'GS25', scrapeGS25],
  ['emart24', 'EMART24', scrapeEmart24],
  // 세븐일레븐: 한국 IP(로컬)에선 정상, GitHub Actions 해외 IP에선 TCP 연결 차단(UND_ERR_CONNECT_TIMEOUT).
  // 따라서 로컬 실행에서만 갱신되고, GitHub Action(cu,gs25,emart24)에선 직전 데이터가 유지된다.
  ['seven', '7-ELEVEN', scrapeSeven],
]

async function readExisting() {
  try {
    return JSON.parse(await fs.readFile(OUTPUT_PATH, 'utf-8'))
  } catch {
    return null
  }
}

async function main() {
  // 기존 데이터를 체인별로 모아둔다 — 실패/미실행 체인은 직전 데이터를 그대로 유지(증발 방지).
  const existing = await readExisting()
  const prevByChain = {}
  if (existing?.products) for (const p of existing.products) (prevByChain[p.chain] ||= []).push(p)

  const byChain = {}
  const counts = {}
  const shrunk = [] // 직전 대비 급감한 체인 (상대 검증)
  const incomplete = [] // 상류 총계에 못 미친 체인 (절대 검증) — 둘 중 하나라도 있으면 저장하지 않는다

  for (const [key, name, fn] of SOURCES) {
    if (ONLY && !ONLY.has(key)) {
      byChain[name] = prevByChain[name] || []
      counts[name] = `유지(${byChain[name].length})`
      continue
    }
    try {
      const items = await fn()
      for (const p of items) p.category = categorize(p.name)
      byChain[name] = items
      counts[name] = items.length
      // 예외 없이 성공했어도 직전 대비 급감이면 부분 수집으로 간주한다.
      // (직전이 0이면 신규 체인 추가이므로 비교 대상 없음)
      const prevCount = (prevByChain[name] || []).length
      const drop = prevCount > 0 ? 1 - items.length / prevCount : 0
      if (drop > SHRINK_LIMIT) {
        shrunk.push(`${name}: ${prevCount} → ${items.length} (-${Math.round(drop * 100)}%)`)
        console.error(`⚠ ${name}: 직전 ${prevCount}개 대비 ${Math.round(drop * 100)}% 급감`)
      } else {
        console.log(`✓ ${name}: ${items.length}개`)
      }
    } catch (err) {
      // 실패 시 직전 데이터 유지 (해외 IP 차단 등 일시/지속 실패에도 라이브 데이터 보존)
      const prev = prevByChain[name] || []
      byChain[name] = prev
      counts[name] = `실패→직전유지(${prev.length}): ${err.message}`
      console.error(`✗ ${name}: ${err.message} → 직전 ${prev.length}개 유지`)
      // 단순 실패(네트워크·IP차단)는 직전 유지로 넘어가지만, 완결성 위반은 실행을 실패시킨다.
      // 상류가 "1665건 있다"고 답했는데 708건만 받은 상황은 조용히 넘길 일이 아니다.
      if (err instanceof IncompleteError) incomplete.push(`${name} — ${err.message}`)
    }
  }

  // 급감한 체인이 있으면 아무것도 쓰지 않고 실패한다(fail closed).
  // 급감분만 직전 데이터로 되돌려 저장할 수도 있지만, 그러면 실행이 초록불로 끝나
  // 원인을 아무도 안 본다 — 조용한 반쪽 데이터가 3주를 간 게 정확히 그 실패 방식이었다.
  // 저장을 건너뛰면 라이브 데이터는 직전 정상본 그대로 유지되고(신선도만 한 주기 손해),
  // 실행은 빨간불로 남아 원인을 보게 된다. 주 2회(월·목) 주기라 회복도 빠르다.
  if (incomplete.length && !ALLOW_INCOMPLETE) {
    console.error('\n✗ 완결성 위반 — 상류가 알려준 총 개수를 못 채웠다. 저장을 건너뛰고 중단한다:')
    for (const s of incomplete) console.error(`   - ${s}`)
    console.error('  사이트 구조 변경이나 페이징 파라미터를 확인할 것.')
    console.error('  상류 총계 쪽이 틀린 게 확실하면 ALLOW_INCOMPLETE=1 로 재실행한다.')
    process.exit(1)
  }
  if (shrunk.length && !ALLOW_SHRINK) {
    console.error('\n✗ 수집량 급감 — 저장을 건너뛰고 중단한다(직전 데이터 유지):')
    for (const s of shrunk) console.error(`   - ${s}`)
    console.error('  사이트 구조 변경이나 페이징 종료조건을 먼저 확인할 것.')
    console.error('  실제로 줄어든 게 맞으면 ALLOW_SHRINK=1 로 재실행한다.')
    process.exit(1)
  }
  if (shrunk.length && ALLOW_SHRINK) {
    console.warn('\n⚠ 급감했지만 ALLOW_SHRINK=1 이라 그대로 저장한다:', shrunk.join(', '))
  }

  const merged = SOURCES.flatMap(([, name]) => byChain[name] || [])

  // 동일하면 커밋 노이즈 방지를 위해 쓰지 않음
  if (JSON.stringify(existing?.products ?? null) === JSON.stringify(merged)) {
    console.log('\n변경사항 없음 — 저장 생략')
    return
  }

  const today = todayKST()
  const payload = { updatedAt: today, month: today.slice(0, 7), counts, products: merged }
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2), 'utf-8')

  const byType = {}
  for (const p of merged) byType[p.eventType] = (byType[p.eventType] || 0) + 1
  console.log(`\n✓ products.json 저장 완료 (${today}) — 총 ${merged.length}개`, byType)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
