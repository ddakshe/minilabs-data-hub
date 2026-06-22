// 편의점 3사(CU·GS25·세븐일레븐) 이달의 행사상품(1+1/2+1/증정/할인) 스크래퍼.
// convenience-events-mini 앱용. fetch만 사용(playwright 불필요).
//
// Usage:
//   node scripts/fetch-convenience-events.mjs           # 전체
//   node scripts/fetch-convenience-events.mjs cu         # CU만
//   node scripts/fetch-convenience-events.mjs gs25       # GS25만
//   node scripts/fetch-convenience-events.mjs seven      # 세븐일레븐만
//
// 비공식 내부 AJAX 역공학. 사이트 구조가 바뀌면 해당 체인 파서만 깨진다.
//   CU    : POST /event/plusAjax.do (무인증, HTML)
//   GS25  : 페이지 GET→CSRF+쿠키 → POST /event-goods-search (이중 인코딩 JSON)
//   세븐  : PC POST /product/listMoreAjax.asp (intCurrentPage 무시→intPageSize가 총개수)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../convenience-events/products.json')
const TARGET = process.argv[2] || null

// ───────────────────────── 공용 헬퍼 ─────────────────────────

const UA_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function todayKST() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())
}

// 텍스트 GET/POST + 지수 백오프 재시도
async function http(url, { method = 'GET', headers = {}, body, retries = 3, timeoutMs = 30000 } = {}) {
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
  const products = []
  const counts = {}

  for (const [key, name, fn] of SOURCES) {
    if (TARGET && TARGET !== key) continue
    try {
      const items = await fn()
      products.push(...items)
      counts[name] = items.length
      console.log(`✓ ${name}: ${items.length}개`)
    } catch (err) {
      counts[name] = `ERROR: ${err.message}`
      console.error(`✗ ${name}: ${err.message}`)
    }
  }

  for (const p of products) p.category = categorize(p.name)

  // 특정 체인만 돌린 경우 기존 다른 체인 데이터를 보존
  const existing = await readExisting()
  let merged = products
  if (TARGET && existing?.products) {
    const targetChain = SOURCES.find((s) => s[0] === TARGET)?.[1]
    const kept = existing.products.filter((p) => p.chain !== targetChain)
    merged = [...kept, ...products]
  }

  // products가 동일하면(가격/구성 변화 없음) 커밋 노이즈 방지를 위해 쓰지 않음
  const prevProducts = JSON.stringify(existing?.products ?? null)
  if (prevProducts === JSON.stringify(merged)) {
    console.log('\n변경사항 없음 — 저장 생략')
    return
  }

  const payload = { updatedAt: todayKST(), counts, products: merged }
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2), 'utf-8')

  const byType = {}
  for (const p of merged) byType[p.eventType] = (byType[p.eventType] || 0) + 1
  console.log(`\n✓ products.json 저장 완료 (${payload.updatedAt}) — 총 ${merged.length}개`, byType)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
