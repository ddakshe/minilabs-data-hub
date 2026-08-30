/*
 * 컬리 수집 — 2단계다.
 *   1단계 키워드 검색으로 후보를 넓게 모은다 (할인·재고 필터, ID 중복 제거)
 *   2단계 상세 API 로 category_ids 를 받아 슬롯을 확정하고 비식품을 배제한다
 *
 * ⚠️ 1단계만으로 분류하면 안 된다. 컬리 검색은 상품명 외에 설명·카테고리도 매칭해서
 *    '볶음'이 볶음고추장을, '손질'이 주걱을 끌고 온다(실측).
 * ⚠️ 검색 API 는 keyword 만 유효하다. per_page·sort_type 은 200 을 주지만 무시된다.
 *    페이지당 96건 고정이므로 키워드를 넓게 깔아 물량을 확보한다.
 * ⚠️ 카테고리 웹페이지는 CSR 이라 12KB 셸만 온다. 2단계를 우회할 방법이 없다.
 */
import { slotForKurly } from './slots.mjs'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const SEARCH = 'https://api.kurly.com/search/v4/sites/market/normal-search'
const DETAIL = 'https://api.kurly.com/showroom/v2/products'
const PRICE_CAP = 20000 // 선물세트·대용량 박스 배제 (실측 최대 205,200원)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const KEYWORDS = [
  '국', '탕', '찌개', '국물', '전골',
  '불고기', '갈비', '생선', '돈까스', '장조림', '제육',
  '밑반찬', '나물', '무침', '조림', '볶음',
  '김치', '젓갈', '장아찌',
  '두부', '어묵', '부침개',
  '간식', '빵',
]

async function getJson(url, { retries = 3 } = {}) {
  let lastErr
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`)
      return await res.json()
    } catch (err) {
      lastErr = err
      if (attempt < retries) await sleep(1000 * attempt)
    }
  }
  throw lastErr
}

async function search(keyword) {
  const url = `${SEARCH}?keyword=${encodeURIComponent(keyword)}&page=1`
  const d = await getJson(url)
  const sections = d?.data?.listSections ?? []
  return sections.flatMap((s) => (s.view.sectionCode === 'PRODUCT_LIST' ? s.data.items : []))
}

export async function collectKurly() {
  // ── 1단계: 후보 수집 ──
  const candidates = new Map()
  for (const kw of KEYWORDS) {
    const items = await search(kw)
    for (const it of items) {
      if (!(it.discountRate > 0)) continue
      if (it.isSoldOut) continue
      if (!it.discountedPrice || it.discountedPrice > PRICE_CAP) continue
      if (candidates.has(it.no)) continue // 먼저 매칭된 키워드가 이긴다
      candidates.set(it.no, {
        id: it.no,
        name: it.name,
        price: it.discountedPrice,
        orig: it.salesPrice,
        rate: it.discountRate,
        img: it.listImageUrl ?? '',
        url: `https://www.kurly.com/goods/${it.no}`,
      })
    }
    console.log(`▶ 검색 '${kw}' → 누적 후보 ${candidates.size}`)
    await sleep(250)
  }

  if (candidates.size === 0) throw new Error('컬리 1단계 0건 — 검색 API 응답 구조를 확인할 것')

  // ── 2단계: 슬롯 확정 + 비식품 배제 ──
  const out = []
  let excluded = 0
  let failed = 0
  for (const [id, base] of candidates) {
    // 페이싱은 루프 맨 앞에서 무조건 건다. 뒤쪽에 두면 continue 하는 경로(실패·배제)가
    // 건너뛰어, 호출의 3분의 1이 무지연으로 나간다(실측: 795건 중 262건).
    await sleep(200)
    let ids
    try {
      const d = await getJson(`${DETAIL}/${id}`)
      ids = d?.data?.category_ids ?? []
    } catch {
      failed++
      continue
    }
    const slot = slotForKurly(ids)
    if (!slot) { excluded++; continue }
    out.push({ ...base, slot })
  }
  const mark = failed > candidates.size / 2 ? '✗' : '▶'
  console.log(`${mark} 상세 조회 ${candidates.size}건 → 채택 ${out.length} / 배제 ${excluded} / 실패 ${failed}`)

  // 상세 API 가 광범위하게 죽으면 out 은 "작지만 0 은 아닌" 값이 되어 조용히 성공한다.
  // oasis.mjs 의 카테고리 절반 가드와 같은 성격의 비율 가드를 둔다.
  if (failed > candidates.size / 2) {
    throw new Error(`컬리 2단계 실패율 과다 — ${candidates.size}건 중 ${failed}건 실패`)
  }

  if (out.length === 0) throw new Error('컬리 2단계 0건 — slots.mjs 의 KURLY_SLOT 매핑을 확인할 것')
  return out
}
