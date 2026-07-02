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

function parseGsBody(text) {
  let data = JSON.parse(text)
  if (typeof data === 'string') data = JSON.parse(data)
  return data?.results ?? []
}

async function scrapeGS25({ maxPages = 200 } = {}) {
  const first = await http(GS_PAGE)
  const cookie = collectCookies(first.headers)
  const token = first.text.match(/name="CSRFToken"[^>]*value="([^"]+)"/)?.[1]
  if (!token) throw new Error('GS25 CSRFToken 추출 실패')

  const out = []
  for (const t of GS_TYPES) {
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
      const results = parseGsBody(text)
      if (!results.length) break
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
  }
  const seen = new Set()
  return out.filter((p) => (seen.has(p.id) ? false : seen.add(p.id)))
}

// ───────────────────────── 세븐일레븐 ─────────────────────────
// PC 목록(이름·가격 인라인). intCurrentPage 무시 → intPageSize 크게 한방.
// pTab: 1=1+1, 2=2+1, 3=증정, 4=할인. 이미지는 일부만(상대경로).

const SV_ENDPOINT = 'https://www.7-eleven.co.kr/product/listMoreAjax.asp'
const SV_REFERER = 'https://www.7-eleven.co.kr/product/presentList.asp'
const SV_ORIGIN = 'https://www.7-eleven.co.kr'
const SV_TABS = [
  { pTab: '1', label: '1+1' },
  { pTab: '2', label: '2+1' },
  { pTab: '3', label: '증정' },
  { pTab: '4', label: '할인' },
]

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

async function scrapeSeven({ pageSize = 3000 } = {}) {
  const out = []
  for (const tab of SV_TABS) {
    const { status, text } = await http(SV_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: SV_REFERER,
      },
      body: `intPageSize=${pageSize}&intCurrentPage=1&pTab=${tab.pTab}&pCd=`,
    })
    if (status !== 200) throw new Error(`7-Eleven HTTP ${status} (pTab ${tab.pTab})`)
    const blocks = text.split('<li>').slice(1)
    out.push(...blocks.map((b) => parseSvBlock(b, tab.label)).filter(Boolean))
  }
  const seen = new Set()
  return out.filter((p) => (seen.has(p.id) ? false : seen.add(p.id)))
}

// ───────────────────────── 이마트24 ─────────────────────────
// /goods/event 페이지네이션(page=N, 20개/페이지). 상품 뱃지 class로 행사유형 판별.
// 세일→할인으로 통일. 이미지는 절대경로(msave...), 기본이미지(productPlaceHolder)는 제외.
const E24_BASE = 'https://emart24.co.kr/goods/event'
const E24_TYPE = { onepl: '1+1', twopl: '2+1', threepl: '3+1', sale: '할인' }

function parseE24Block(block) {
  const cls = block.match(/class="(onepl|twopl|threepl|sale)[^"]*floatR/)?.[1]
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
  for (let page = 1; page <= maxPages; page++) {
    const { status, text } = await http(
      `${E24_BASE}?search=&category_seq=&base_category_seq=&align=&page=${page}`
    )
    if (status !== 200) throw new Error(`emart24 HTTP ${status} (page ${page})`)
    const parsed = text.split('<div class="itemWrap">').slice(1).map(parseE24Block).filter(Boolean)
    if (parsed.length === 0) break
    let fresh = 0
    for (const p of parsed) if (!seen.has(p.id)) (seen.add(p.id), out.push(p), fresh++)
    if (fresh === 0) break // 마지막 페이지 이후 같은 내용 반복 방지
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
      console.log(`✓ ${name}: ${items.length}개`)
    } catch (err) {
      // 실패 시 직전 데이터 유지 (해외 IP 차단 등 일시/지속 실패에도 라이브 데이터 보존)
      const prev = prevByChain[name] || []
      byChain[name] = prev
      counts[name] = `실패→직전유지(${prev.length}): ${err.message}`
      console.error(`✗ ${name}: ${err.message} → 직전 ${prev.length}개 유지`)
    }
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
