/*
 * 오아시스 수집 — 카테고리 목록만 받는다. 상세 조회는 하지 않는다.
 *
 * ⚠️ 상세 페이지가 1.3MB(컬리 JSON 의 36배)다. 건당 호출하면 400건에 500MB 가 넘는다.
 *    카테고리 URL 이 이미 슬롯을 알려주므로 상세를 볼 이유가 없다.
 * ⚠️ page/pageNum/curPage/pageNo/offset 은 전부 무시되지만 **rows 는 동작한다**
 *    (페이지 폼 productSearchForm 의 hidden 필드에서 발견). rows=720 이면 카테고리
 *    전체가 한 응답에 온다 — 반찬 기준 675건, 6MB, 2초.
 * ⚠️ 이미지는 data-src 로 lazy-load 되지만 파싱하지 않는다. URL 이 상품 ID 로 결정된다.
 */
import { OASIS_CATEGORIES } from './slots.mjs'
import { parseOasisList } from './oasis-parse.mjs'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const BASE = 'https://www.oasis.co.kr'
const IMG = (id) => `https://oasisprodproduct.edge.naverncp.com/${id}/thumb/999`
const ROWS = 720 // 실측 최대 보유량(675)보다 크게. 넘겨도 보유량까지만 온다
const PRICE_CAP = 20000 // 선물세트·대용량 박스 배제. 컬리 수집기와 같은 값 (실측 최고가 152,230원 = 20kg 포기김치)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchCategory(id) {
  const url = `${BASE}/product/list?categoryId=${id}&rows=${ROWS}`
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`오아시스 HTTP ${res.status} (categoryId ${id})`)
  return await res.text()
}

/**
 * @param {{ minRate?: number }} [options] minRate 미만 할인율은 버린다.
 *   오아시스는 상품의 94%가 할인 표기라 그대로 쓰면 변별이 안 된다(스펙 §3.3).
 */
export async function collectOasis({ minRate = 25 } = {}) {
  const byId = new Map()
  let emptyCategories = 0

  for (const cat of OASIS_CATEGORIES) {
    const html = await fetchCategory(cat.id)
    const parsed = parseOasisList(html)
    if (parsed.length === 0) {
      emptyCategories++
      console.error(`⚠ 오아시스 ${cat.label}(${cat.id}) 0건 — 파서나 카테고리를 확인할 것`)
    }
    let kept = 0
    for (const p of parsed) {
      if (p.rate < minRate) continue
      if (p.price > PRICE_CAP) continue // 선물세트·대용량 박스 배제
      if (byId.has(p.id)) continue // 먼저 매칭된 슬롯이 이긴다
      byId.set(p.id, {
        id: p.id,
        slot: cat.slot,
        name: p.name,
        price: p.price,
        orig: p.orig,
        rate: p.rate,
        img: IMG(p.id),
        url: `${BASE}/product/detail/${p.id}`,
      })
      kept++
    }
    console.log(`▶ ${cat.label}(${cat.id}) → 파싱 ${parsed.length} / ${minRate}%+ 채택 ${kept}`)
    await sleep(1000) // 응답이 6MB 라 간격을 넉넉히 둔다
  }

  // 클래스명 의존 파서라 리뉴얼 시 전멸한다. 절반 이상이 0건이면 수집 실패로 본다.
  if (emptyCategories > OASIS_CATEGORIES.length / 2) {
    throw new Error(`오아시스 파서 실패 — ${OASIS_CATEGORIES.length}개 중 ${emptyCategories}개가 0건`)
  }
  return [...byId.values()]
}
