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
  CARD.lastIndex = 0
  let m
  while ((m = CARD.exec(html)) !== null) {
    const [, id, rawName, , priceBlock] = m
    const rate = RATE.exec(priceBlock)
    if (!rate) continue
    const price = toNumber(DISC.exec(priceBlock)?.[1])
    const orig = toNumber(ORIG.exec(priceBlock)?.[1])
    const name = cleanName(rawName)
    if (!name || !price || !orig || price >= orig) continue
    out.push({ id: Number(id), name, price, orig, rate: Number(rate[1]) })
  }
  return out
}
