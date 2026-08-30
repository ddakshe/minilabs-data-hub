/*
 * 밥상 슬롯 정의와 몰별 카테고리 매핑.
 *
 * ⚠️ 컬리는 두 개의 카테고리 체계를 갖는다.
 *    - 검색 응답 filterSections: 911002(밑반찬) 같은 911xxx
 *    - 상세 API category_ids : 1174(국/탕/찌개) 같은 4자리
 *    둘은 서로 다른 값이다. 우리는 **상세 API 기준**만 쓴다. 검색 필터는 요청
 *    파라미터로 넘겨도 무시되기 때문에(실측) 애초에 쓸 수 없다.
 *
 * ⚠️ 배제가 슬롯 매핑보다 중요하다. 슬롯이 비면 "오늘 국 특가 없어요"로 넘어가지만,
 *    주걱이 밥상에 오르면 사용자가 앱을 다시 열지 않는다.
 *
 * kurly-categories.json 은 scripts/grocery-deals/kurly-categories.json 생성 스크립트가
 * 만든다(사람이 ID를 옮겨적지 않는다). 오염이 발견되면 JSON만 고치면 된다.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const table = JSON.parse(readFileSync(resolve(__dirname, 'kurly-categories.json'), 'utf8'))

export const SLOTS = ['soup', 'main', 'banchan', 'kimchi', 'tofu', 'snack']

/** 이 대분류가 붙어 있으면 상품 전체를 버린다. 11=주방용품, 27=양념/오일 (실측) */
export const KURLY_EXCLUDED = new Set(table.excluded)

/** 중분류 ID → 슬롯 */
export const KURLY_SLOT = new Map(
  Object.entries(table.slots).map(([id, slot]) => [Number(id), slot]),
)

/**
 * @param {number[]} categoryIds 컬리 상세 API 의 category_ids
 * @returns {string | null} 슬롯명. 배제 대상이거나 매핑에 없으면 null
 */
export function slotForKurly(categoryIds) {
  if (!Array.isArray(categoryIds) || categoryIds.length === 0) return null
  for (const id of categoryIds) {
    if (KURLY_EXCLUDED.has(id)) return null
  }
  for (const id of categoryIds) {
    const slot = KURLY_SLOT.get(id)
    if (slot) return slot
  }
  return null
}

/**
 * 오아시스는 URL 이 곧 카테고리다. 목록만 받으면 슬롯이 확정되므로 상세 조회가 없다.
 * 페이지네이션이 동작하지 않아 카테고리당 60건이 상한이다 — 슬롯마다 ID 를 여러 개 둔다.
 */
export const OASIS_CATEGORIES = [
  { id: 33, slot: 'soup', label: '국│찌개' },
  { id: 4, slot: 'main', label: '수산' },
  { id: 1151, slot: 'main', label: '유기농소고기' },
  { id: 44, slot: 'banchan', label: '반찬' },
  { id: 34, slot: 'banchan', label: '밑반찬│어묵' },
  { id: 243, slot: 'banchan', label: '1인 반찬' },
  { id: 123, slot: 'banchan', label: '오아시스반찬' },
  { id: 241, slot: 'kimchi', label: '김치│절임' },
  { id: 114, slot: 'kimchi', label: '액젓│젓갈' },
  { id: 242, slot: 'tofu', label: '나물│두부' },
  { id: 21, slot: 'tofu', label: '어묵│가공' },
  { id: 119, slot: 'snack', label: '간식' },
  { id: 217, slot: 'snack', label: '간식│음료' },
]
