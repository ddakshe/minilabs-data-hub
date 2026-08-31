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
 * kurly-categories.json 의 ID 출처: 오염이 확인된 상품(예: 주걱이 섞여 나온 상품)의
 * ID로 https://api.kurly.com/showroom/v2/products/{id} 를 호출해 응답의 category_ids
 * 를 읽는다. category_ids 는 배열이고 index 1 이 대분류(KURLY_EXCLUDED 에 쓰는 값),
 * index 2 가 중분류(KURLY_SLOT 에 쓰는 값)다. 이 절차는 한 번 인라인으로 실행해 결과만
 * kurly-categories.json 에 옮겨 적었을 뿐 생성 스크립트 자체는 커밋된 적이 없다 — 그러니
 * "생성 스크립트가 만든다"는 옛 주석은 사실이 아니다. 오염이 새로 발견되면 위 호출을
 * 다시 해서 category_ids 를 읽고 이 JSON 을 손으로 고친다.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const table = JSON.parse(readFileSync(resolve(__dirname, 'kurly-categories.json'), 'utf8'))

export const SLOTS = ['soup', 'main', 'banchan', 'kimchi', 'tofu', 'snack']

/** 선물세트·대용량 박스 배제 가격선. 두 몰이 공유한다 — 갈라지면 안 된다(실측: 이미 한 번 갈라졌었다). */
export const PRICE_CAP = 20000

/** 오아시스 전용 할인율 하한. 오아시스는 상품의 94%가 할인 표기라 그대로 쓰면 변별이 안 된다(스펙 §3.3).
 *  컬리는 검색 API 가 discountRate > 0 만 돌려줘 별도 하한이 필요 없다 — 두 몰의 할인율 기준이 다른 것은
 *  의도한 차이다. */
export const OASIS_MIN_RATE = 25

/** 이 대분류가 붙어 있으면 상품 전체를 버린다 (실측). kurly-categories.json 의 excluded:
 *    11 주방용품, 15 과일, 27 양념/오일, 32 채소
 *  11·27 은 스펙 문서에도 나오지만, 15·32 는 이 주석이 유일한 근거다 — JSON 자체는
 *  주석을 못 달아서 여기 적는다. */
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
/*
 * ⚠️ slot: null 은 **배제**다. 그 카테고리의 상품 ID 를 자리만 선점해서 뒤에 오는
 *    카테고리가 못 채가게 한다. 할인율·가격 필터를 적용하지 않는다 — 조건과
 *    무관하게 막아야 하기 때문이다.
 *
 *    배제를 **밥상 슬롯 뒤, snack·main 앞**에 두는 것이 핵심이다 (2026-08-31 실측).
 *    앞에 두면 채소 카테고리가 나물·두부 상품을 먼저 채가서 tofu 가 77 → 54 로
 *    30% 날아간다. 뒤에 두면 정상 반찬은 이미 확정된 뒤라 손실이 0 이고, 아직
 *    아무 슬롯도 못 잡은 채소·과일·빵·주방용품만 버려진다.
 *
 *    snack 을 main 앞에 두는 것도 같은 장치다. 오아시스에는 "메인요리" 카테고리가
 *    없어서 간편식(53·57·247·120)을 main 으로 쓰는데, 그 안에 음료·시리얼이 섞여
 *    있다. snack 이 먼저 먹으면 그것들은 snack 으로 확정되고, 앱의 슬롯 환산이
 *    snack 을 0개로 잡으므로 밥상에 오르지 않는다.
 *
 *    실측 (같은 원본 기준, 밥상 슬롯 손실 없음):
 *      배제 없음:               soup 77 · main 209 · tofu 77 · banchan 220 · kimchi 39
 *      채소·과일 배제:          soup 77 · main 108 · tofu 77 · banchan 220 · kimchi 39
 *      + 베이커리·생활·유제품:  soup 77 · main  83 · tofu 77 · banchan 220 · kimchi 39
 *    main 209 → 83 은 손실이 아니라 정화다. 오트밀크·오곡라떼·스틱샐러리·
 *    카스테라·김밥발(27x23cm)이 여기서 빠진다 — 김밥발은 음식이 아니라 도구다.
 */
export const OASIS_CATEGORIES = [
  // ── 밥상 슬롯: 좁은 것부터 ────────────────────────────────
  { id: 241, slot: 'kimchi', label: '김치│절임' },
  { id: 114, slot: 'kimchi', label: '액젓│젓갈' },
  { id: 33, slot: 'soup', label: '국│찌개' },
  { id: 242, slot: 'tofu', label: '나물│두부' },
  { id: 21, slot: 'tofu', label: '어묵│가공' },
  { id: 243, slot: 'banchan', label: '1인 반찬' },
  { id: 123, slot: 'banchan', label: '오아시스반찬' },
  { id: 34, slot: 'banchan', label: '밑반찬│어묵' },
  { id: 44, slot: 'banchan', label: '반찬' },

  // ── 배제: 밥상 슬롯이 확정된 뒤에 온다 ──────────────────────
  { id: 11, slot: null, label: '친환경채소' },
  { id: 137, slot: null, label: '샐러드채소' },
  { id: 142, slot: null, label: '채소' },
  { id: 197, slot: null, label: '우리땅채소' },
  { id: 214, slot: null, label: '채소│농산' },
  { id: 5407, slot: null, label: '절임┃채소' },
  { id: 5411, slot: null, label: '농산 I 채소' },
  { id: 12, slot: null, label: '수입과일I농산' },
  { id: 122, slot: null, label: '우리땅과일' },
  { id: 141, slot: null, label: '과일│농산' },
  { id: 253, slot: null, label: '과일│수입' },
  { id: 118, slot: null, label: '베이커리' },
  { id: 219, slot: null, label: '빵│잼' },
  { id: 1101, slot: null, label: '빵' },
  { id: 1102, slot: null, label: '쿠키│케이크' },
  { id: 8, slot: null, label: '생활' },
  { id: 38, slot: null, label: '생활용품' },
  { id: 218, slot: null, label: '생활│주방' },
  { id: 148, slot: null, label: '마스크│구강' },
  { id: 868, slot: null, label: '영양제' },
  { id: 132, slot: null, label: '우유' },
  { id: 1184, slot: null, label: '유제품' },
  { id: 51, slot: null, label: '요거트' },
  { id: 1188, slot: null, label: '치즈┃버터' },

  // ── snack: main 보다 먼저. 음료·시리얼을 여기서 잡는다 ────────
  { id: 119, slot: 'snack', label: '간식' },
  { id: 217, slot: 'snack', label: '간식│음료' },

  // ── main: 남은 간편식 ───────────────────────────────────
  { id: 120, slot: 'main', label: '밀키트I도시락' },
  { id: 57, slot: 'main', label: '간편식사' },
  { id: 247, slot: 'main', label: '간편식' },
  { id: 53, slot: 'main', label: '간편식(2)' },
]
