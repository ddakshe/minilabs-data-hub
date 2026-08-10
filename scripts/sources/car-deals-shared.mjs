// fetch-car-deals.mjs(cheerio)와 fetch-car-deals-pw.mjs(Playwright)가 함께 쓰는 판정 규칙.
// 두 파일에 각각 정규식을 두면 한쪽만 고쳐져 조용히 어긋난다(실제로 ST1·Electric 접미사가 그렇게 누락됐다).

/**
 * 무공해차 여부. 앱에서 "보조금은 지역·잔여 대수에 따라 매일 달라진다"는 안내와
 * 무공해차 통합누리집 링크를 띄울지 판단하는 데 쓴다.
 *
 * 수소차(넥쏘)도 true다 — 보조금 창구가 같은 무공해차 통합누리집이라 안내가 유효하다.
 *
 * 이름 어디에 붙어도 잡아야 한다:
 *   앞  EV6, EV9
 *   뒤  봉고Ⅲ EV, 레이 EV
 *   접미 코나 Electric, 포터 II Electric, 더 뉴 스타리아 라운지 Electric
 *   전용 아이오닉 5, PV5 카고, ST1(현대 전기 상용밴), 넥쏘(수소)
 */
const EV_PATTERN = /\bEV\d?\b|\bElectric\b|일렉트릭|아이오닉|\bPV5\b|\bST1\b|넥쏘/i

export function isEvModel(model) {
  return EV_PATTERN.test(model || '')
}
