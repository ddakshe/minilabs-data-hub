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
 *
 * 생물(수산·유기농소고기)은 담지 않는다 — 이 앱은 완성품만 모은다(생물은 조리 시간·
 * 실력을 요구해 "끼당 N원" 약속이 깨진다). 같은 이유로 컬리 쪽도 채소/정육 대분류를
 * 배제한다(kurly-categories.json 의 excluded 참고).
 *
 * ⚠️ 배열 순서가 우선순위다 — 장식이 아니다. Task 3의 수집기는 상품이 처음 매치되는
 *    슬롯을 취하고 그 다음은 건너뛴다. 규칙은 **좁은 카테고리가 넓은 카테고리보다
 *    먼저 와야 한다** — 넓은 잡화 카테고리가 앞에 있으면 뒤에 오는 좁은 카테고리의
 *    상품을 먼저 채간다. `44 반찬`(382건)과 `34 밑반찬│어묵`(188건)이 그런 잡화
 *    카테고리다 — 김치·나물/두부 상품이 실제로 여기 섞여 있어서(실측: 241 김치│절임의
 *    25%+ 할인 38건 전부를 반찬 카테고리가 먼저 채감), banchan 을 kimchi/tofu 보다
 *    앞에 두면 kimchi/tofu 슬롯이 거의 빈다. 간편식·밀키트 카테고리(53·57·247·120)도
 *    반찬·국 상품을 섞어 담고 있으므로([1등반찬]도라지오이무침 이 53에, 한우 얼큰
 *    소고기뭇국 이 247에 있음, 실측) 다른 슬롯보다 뒤에 둔다.
 *
 *    실측 비교 (같은 원본 853건 기준, 분포만 다름):
 *      반찬 먼저(구 순서): {soup:88, banchan:340, kimchi:3,  tofu:17,  main:219, snack:186}
 *      좁은 것 먼저(현재): {kimchi:49, soup:86, tofu:78, banchan:235, main:219, snack:186}
 *    kimchi 3→49, tofu 17→78. 총합은 동일 — 슬롯 간 배분만 바뀐다.
 *
 *    알파벳순 등으로 재정렬하지 말 것.
 */
export const OASIS_CATEGORIES = [
  { id: 241, slot: 'kimchi', label: '김치│절임' },
  { id: 114, slot: 'kimchi', label: '액젓│젓갈' },
  { id: 33, slot: 'soup', label: '국│찌개' },
  { id: 242, slot: 'tofu', label: '나물│두부' },
  { id: 21, slot: 'tofu', label: '어묵│가공' },
  { id: 243, slot: 'banchan', label: '1인 반찬' },
  { id: 123, slot: 'banchan', label: '오아시스반찬' },
  { id: 34, slot: 'banchan', label: '밑반찬│어묵' },
  { id: 44, slot: 'banchan', label: '반찬' },
  { id: 120, slot: 'main', label: '밀키트I도시락' },
  { id: 57, slot: 'main', label: '간편식사' },
  { id: 247, slot: 'main', label: '간편식' },
  { id: 53, slot: 'main', label: '간편식(2)' },
  { id: 119, slot: 'snack', label: '간식' },
  { id: 217, slot: 'snack', label: '간식│음료' },
]
