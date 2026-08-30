/*
 * 오아시스 카테고리 목록(/product/list?categoryId=) HTML 파서.
 *
 * ⚠️ 클래스명이 계약이다. 프론트 리뉴얼 한 번에 전멸할 수 있으므로, 호출부는
 *    반드시 "0건 = 실패"로 처리해야 한다. 빈 배열을 조용히 넘기면 앱에서는
 *    "오늘 특가 없음"으로 보인다 — 가장 위험한 실패는 에러가 아니라 빈 결과다.
 */

const CARD = /<a href="\/product\/detail\/(\d+)[^"]*"\s+class="listTit">([\s\S]*?)<\/a>([\s\S]*?)<div class="info_price">([\s\S]*?)<\/div>/g
const RATE = /class="price_discountRate[^"]*">(\d+)%/
const DISC = /class="price_discount"><b>([\d,]+)<\/b>/
const ORIG = /class="price_original[^"]*"><b>([\d,]+)<\/b>/
const IMG_ALT = /<img[^>]*\salt="([^"]*)"/

const toNumber = (s) => (s == null ? null : Number(String(s).replace(/,/g, '')))

/** 개행·탭·연속공백을 하나로 접고 HTML 엔티티를 푼다 */
function cleanName(raw) {
  let s = raw.replace(/<[^>]+>/g, '').trim()
  if (!s) {
    const alt = IMG_ALT.exec(raw)
    if (alt) s = alt[1]
  }
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @param {string} html 카테고리 목록 페이지 전체
 * @returns {{ id: number, name: string, price: number, orig: number, rate: number }[]}
 *   할인 표기가 없는 카드는 제외된다
 */
export function parseOasisList(html) {
  if (!html) return []
  const out = []
  // 지금은 루프가 끝까지 돌아서 exec 가 알아서 lastIndex 를 0 으로 되돌린다 —
  // 즉 이 줄을 지워도 당장은 아무 일도 안 일어난다. 지우지 말 것:
  // 훗날 루프에 상한이나 조기 return 이 들어오는 순간, 이 줄이 없으면
  // 두 번째 호출이 중간부터 파싱한다. oasis-parse.test.mjs 의 재진입 테스트가
  // 그 조합을 잡는다.
  CARD.lastIndex = 0
  let m
  while ((m = CARD.exec(html)) !== null) {
    const [, id, rawName, , priceBlock] = m
    const rateMatch = RATE.exec(priceBlock)
    if (!rateMatch) continue
    const rate = Number(rateMatch[1])
    const price = toNumber(DISC.exec(priceBlock)?.[1])
    const orig = toNumber(ORIG.exec(priceBlock)?.[1])
    const name = cleanName(rawName)
    if (!name || !price || !orig || price >= orig) continue
    if (!(rate > 0)) continue // "할인됐다"는 price>=orig 로 간접 판단하지 않고 표기된 rate 로 직접 확인한다
    out.push({ id: Number(id), name, price, orig, rate })
  }
  return out
}
