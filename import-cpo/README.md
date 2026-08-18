# import-cpo — 수입차 인증중고차(CPO) 매물

브랜드 공식 소스만 사용한다. 애그리게이터(엔카·KB차차차·케이카)는 쓰지 않는다 —
robots에서 상세를 막고 있고 DB권 침해 판례 리스크가 있다.

- 산출: `import-cpo/listings.json`
- 앱 설계 전제: **최신 N건만 보여주고 나머지는 브랜드 공식 사이트로 링크**한다.
  완전한 매물 검색을 흉내내지 않는다 — `brands[].searchUrl`이 그 링크다.
- 소비: `https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/import-cpo/listings.json`
- 스크래퍼: `scripts/fetch-import-cpo.mjs`(API 기반) + `scripts/fetch-import-cpo-pw.mjs`(브라우저 필요)
- 워크플로: `.github/workflows/fetch-import-cpo.yml` (매일 09:20 KST)

## CI에서 도는 것과 로컬에서만 도는 것

2026-08-18 실측(run 32106585398, 2분 24초, 전 단계 success):

| 브랜드 | CI | 비고 |
|---|---|---|
| Mercedes-Benz · Lexus · Audi · Toyota | ✅ | 해외 IP에서도 정상. 한국 호스팅인 렉서스·토요타도 문제없다 |
| Volvo | ✅ | Playwright 클릭 페이지네이션이 러너에서도 동작 |
| **Porsche** | ❌ | Vercel 봇 챌린지가 Actions 데이터센터 IP를 통과시키지 않는다.<br>실측: 셀렉터 대기 25초 × 2 = **51초 타임아웃 후 0건**. 로컬 맥에서는 같은 코드가 300건을 받는다 |
| **BMW · MINI** | ❌ | 실제 Chrome + headed 필수. 헤드리스는 조용히 0건 |

그래서 워크플로의 Playwright 단계 기본값은 **`volvo`만**이다.
BMW·포르쉐는 로컬에서 돌린다:

```bash
node scripts/fetch-import-cpo-pw.mjs bmw,porsche
```

**주기: 매일이면 충분하다.** 상한 300 기준 실측 소요는 bmw+porsche+volvo 전부 돌려 **3분 51초**,
볼보는 CI가 커버하니 로컬에서 필요한 bmw+porsche만 돌리면 **약 3분**이다.
(상한이 없던 시절엔 BMW만 클릭 111회여서 주 1회를 고민할 만했지만, 지금은 24회다.)

최신순 슬라이스는 전체 재고보다 회전이 빠르다 — 신규 유입이 전부 상위 300에 들어오기 때문에
주기를 길게 잡으면 놓치는 매물이 생긴다. 창을 넓히는(`MAX_PER_BRAND`↑) 것보다 자주 돌리는 게 낫다.

CI가 실패해도 데이터는 파괴되지 않는다. 담당하지 않는 브랜드와 실패한 브랜드는
기존 데이터를 그대로 유지하도록 만들어서, 포르쉐가 0건으로 끝난 실행에서도
기존 300건과 BMW 300건이 온전히 남았다.

## 수집 정책: 전량이 아니라 최신 N건

브랜드당 **`MAX_PER_BRAND`(기본 300)건만** 최신순으로 받는다. 전량을 긁지 않는 이유:

- **딥 페이징이 소스마다 다른 방식으로 깨진다.** 벤츠는 601번째부터 조합에 따라 0건이 오고
  (`totalResults: 700`도 실제 재고가 아닌 상한값), BMW는 "더보기" 111회 중 한 번만 응답을
  놓치면 멈춘다(실측: 396건에서 한 번, 204건에서 한 번 — 비결정적).
- 인증중고차 앱에서 중요한 건 최근 매물이다. 2017년식까지 다 받을 이유가 없다.
- 매일 갱신 비용이 크게 줄고 상대 서버 부담도 줄어든다.

```bash
MAX_PER_BRAND=0    node scripts/fetch-import-cpo.mjs      # 0이면 무제한(전량 시도)
MAX_PER_BRAND=1000 node scripts/fetch-import-cpo-pw.mjs
```

정렬 지원 현황:

| 브랜드 | 최신순 정렬 | 값 |
|---|---|---|
| Mercedes-Benz | ✅ | `sortingType: "registrationYear-desc"` |
| BMW · MINI | ✅ | URL `sorting=PRODUCTION_DATE_DESC` |
| Volvo | ✅ | URL `sort=modelYear:DESC` |
| Porsche | ⚠️ 미적용 | 기본 순서로 앞에서부터 자른다 (정렬 파라미터 미확인) |
| Lexus · Audi · Toyota | — | 전체가 300건 미만이라 상한 무관 |

벤츠는 상한 적용 전 최초등록 2017-01~, 적용 후 **2025-03~**로 바뀐다.

## 브랜드별 상태

| 브랜드 | 담당 | 수집 | 전체 재고 | 방식 |
|---|---|---|---|---|
| Mercedes-Benz | fetch | 300 | ~652 | GraphQL (`commerce/onesearch`) |
| BMW · MINI | **pw** | 300 | ~1,344 | SPA 응답 가로채기 (로컬 전용) |
| Porsche | **pw** | 101 (전부 CPO) | 101 | SSR HTML, `?condition=porsche_approved&page=N` |
| Volvo Selekt | **pw** | 218 | 218 | 클릭 페이지네이션 |
| Lexus Certified | fetch | 75 | 75 | PHP JSON, 무인증 |
| Audi Approved :plus | fetch | 67 | 67 | REST, `Token` 헤더 |
| Toyota Certified | fetch | 52 | 52 | PHP JSON, 무인증 |

합계 **1,117건이고 전부 인증중고차다.**

포르쉐는 `condition=porsche_approved` 필터를 걸어 받는다. 필터 없이 받으면 신차가 섞여
439건 중 CPO가 112건뿐이고, 상한에 걸려 끝까지 못 돌아 전체 재고 수도 알 수 없었다.
필터를 걸면 전량이 100건대라 끝까지 돌 수 있어 `sourceTotal`을 추정 없이 정확히 안다.
(`condition[]=…`, `filter=condition:…` 형식은 무효 — 필터가 안 걸린 결과가 온다)
`certified` 필드는 포르쉐 레코드에 남아 있지만 이제 전부 `true`다.

MINI는 별도 물량이 아니다. BMW와 같은 풀에 섞여 오고 레코드의 `brand`로 갈라진다.

## 필드 채움률 (실측)

소스가 주지 않는 필드가 브랜드마다 다르다. 통합 목록은 전 브랜드 100%인
`model · year · priceKrw · url`로만 만들고, 나머지는 상세에서 있는 것만 보여주는 편이 안전하다.

| 필드 | audi | benz | bmw | lexus | porsche* | toyota | volvo |
|---|---|---|---|---|---|---|---|
| model · year · priceKrw · url | 100 | 100 | 100 | 100 | 100 | 100 | 100 |
| image | **0** | 100 | 99 | 100 | 100 | 100 | 100 |
| mileageKm | 100 | 100 | 100 | 100 | 100 | 100 | 100 |
| fuel | 100 | 100 | 100 | **0** | 93 | **0** | 100 |
| transmission | 100 | 100 | 100 | **0** | 31 | **0** | 100 |
| bodyType | 90 | 100 | 100 | **0** | **0** | **0** | **0** |
| color | 90 | 100 | 100 | 100 | 100 | 100 | **0** |
| firstRegistration | 100 | 100 | **0** | **0** | 100 | **0** | **0** |
| accident | **0** | **0** | 100 | **0** | 100 | **0** | **0** |
| previousOwners | **0** | **0** | **0** | **0** | 100 | **0** | **0** |
| trim | 90 | **0** | 100 | 100 | **0** | 98 | **0** |
| newPriceKrw | **0** | **0** | **0** | 100 | **0** | 100 | **0** |
| dealer | 100 | 100 | **0** | 100 | **0** | 100 | 100 |

\* 포르쉐는 이제 CPO만 받으므로 전 건 기준이다. 주행거리·사고·최초등록·이미지 모두 100%다.
(필터 없이 신차가 섞였을 때는 주행거리 60%, 사고 26%로 떨어졌다 — 신차엔 그런 이력이 없다)

알아둘 것:

- **아우디는 실제 차량 사진이 없다.** 67건 전부 `tilesPictures`가 비어 있고
  `fallbackPictures`에는 아우디 로고 플레이스홀더만 있다. 채우면 사진이 있는 것처럼
  보이므로 `image: null`로 둔다.
- **사고 이력·이전 소유자는 포르쉐만 준다.** 벤츠 스키마에는
  `damagesRepairedFlag`·`numberPreviousOwners`가 있지만 한국 재고는 전 건 비어 있다.
- **벤츠는 마케팅 트림을 따로 주지 않는다.** `typeClass`는 차대코드(W177)라 `trim`에
  넣으면 오해를 부른다. 등급은 `model` 문자열에 포함되어 있다.
- 렉서스·토요타는 연료·변속기·차체를 아예 주지 않는다. 대신 **신차가(`newPriceKrw`)를
  주는 유일한 두 브랜드**라 감가율 계산이 된다.

## ⚠️ BMW: 직접 API 호출은 막혀 있다 — "더보기" 응답을 가로챈다

담당은 `fetch-import-cpo-pw.mjs`. **로컬(맥) 실행 전용**이고 워크플로는 bmw를 건너뛴다.

### 왜 API를 직접 못 부르나

요청 내용을 완벽히 복제해도 통과하지 못한다. SPA의 실제 요청은 이렇다:

```
POST /vehiclesearch/search/ko-kr/usedcarfinder
     ?maxResults=12&startIndex=0&brand=BMW&hash=<64자hex>&context=results-page
x-api-key: 7f665f5b…
body: {"searchContext":[{ … ,"buNos":[<126개 딜러코드>]}]}
```

이걸 그대로 복제해 여러 경로로 시도한 결과:

| 방법 | 결과 |
|---|---|
| SPA 자신의 요청 | **201 + 정상 데이터** |
| `ctx.request.post`로 재생 | 403 Forbidden |
| 페이지 내 `fetch`로 재생 | CORS 프리플라이트에서 죽음 |
| `page.route`로 SPA 요청 URL 바꿔치기 | 요청 자체가 죽음 |
| 번들 Chromium (헤드리스/헤드드) | search가 **200 빈 응답** + 화면에 에러 |
| **실제 Chrome + headed** | **201 + 정상 데이터** |

게이트웨이가 "SPA가 보낸 요청"만 통과시킨다. IP·URL·파라미터 문제가 아니다.
`maxResults` 상한을 찾는 것도 의미가 없다 — 우리 요청은 어떤 크기로도 통과하지 못한다.

### 그래서 요청을 만들지 않는다

페이지를 열고 **"더보기"를 눌러 SPA가 받는 201 응답을 가로채** 모은다.
DOM을 긁는 것보다 낫다 — API 원본 그대로라 필드가 훨씬 풍부하다(주행거리·사고이력·보증만료일 등).

UI가 12개씩 불러오므로 기본 300건이면 "더보기" 24회다(전량은 111회).

```bash
node scripts/fetch-import-cpo-pw.mjs bmw                      # 최신 300건
MAX_PER_BRAND=0 node scripts/fetch-import-cpo-pw.mjs bmw      # 전량 시도(취약함)
```

### 클릭 구현에서 두 번 넘어진 지점

- **"더보기"는 `<a>`도 `<button>`도 아니다.** 텍스트 노드라서 `getByRole('button')`으로는
  안 잡히고, `getByText`도 리렌더 사이에 간헐적으로 `count() === 0`을 돌려준다.
  → **페이지 안에서 텍스트로 직접 찾아 `.click()`** 하는 방식으로 해결했다.
- **진행 판정을 UI 카운터("N 중 M")로 하면 안 된다.** 렌더 타이밍에 따라 0을 돌려준다.
  → 실제로 가로챈 개수(`byId.size`)를 기준으로 바꿨다. 이제 클릭당 정확히 +12로 결정적이다.

- **실제 Chrome + headed가 필수다.** 헤드리스로 바꾸면 `search`가 200 빈 응답만 주고
  **조용히 0건**이 된다 — 실패로 안 보이니 특히 주의.
- BMW는 epaas 동의 배너를 쓴다. 클릭을 가로막으므로 오버레이를 걷어낸 뒤 누른다.
- 중간에 끊겨도 **부분 수집을 버리지 않는다.** 다시 실행하면 `id` 기준으로 이어붙는다.
  (전량을 받은 실행에서는 합치지 않는다 — 팔린 매물이 영구히 남으면 안 되기 때문이다.)
- MINI는 별도 수집이 아니다. 같은 풀에 섞여 오고 레코드의 `brand`로 갈라진다.

## 레코드 스키마

```jsonc
{
  "brand": "benz",              // bmw | mini | benz | volvo | porsche | lexus | audi | toyota
  "id": "MB4CW2WM6K",           // 브랜드 내 고유 ID
  "model": "C 200 d",
  "trim": null,
  "year": 2018,
  "mileageKm": 65478,           // 정수 km
  "priceKrw": 17500000,         // 원(KRW) 정수 — 아래 "단위" 참고
  "newPriceKrw": null,          // 신차가. lexus·toyota만 제공
  "fuel": null,
  "transmission": null,
  "bodyType": null,
  "color": null,
  "firstRegistration": "2018-03-22",
  "accident": null,             // 실제로 값이 오는 건 porsche뿐
  "warranty": null,
  "previousOwners": null,       // porsche만 (벤츠는 스키마엔 있으나 KR 재고가 빈값)
  "certified": true,            // porsche만 (신차가 섞여 있어서)
  "vehicleClass": "E",          // benz만
  "chassisCode": "W214",        // benz만 (차대코드. trim이 아니다)
  "dealer": "인증 중고차 원주 전시장",
  "region": "강변로 579, 26332 원주시",
  "url": "https://…",
  "image": null
}
```

전 브랜드가 채우는 필드는 `brand · id · model · year · mileageKm · priceKrw · url`이다.
통합 목록 화면은 이것만으로 만들고, 나머지는 상세에서 보여주는 편이 안전하다.

**수집하지 않는 것**: VIN, 차량번호판. BMW·벤츠 API가 그대로 주지만 개인정보라 버린다.

⚠️ 단 **BMW 사진 URL 경로에 VIN이 들어 있다**(`cdn.bmwdms.co.kr/Prd/<VIN>/…`).
사진을 띄우려면 이 URL이 필요해서 그대로 둔다 — VIN을 필드로 저장하지는 않지만
완전히 제거된 것은 아니라는 점을 알고 쓸 것. 사진을 포기하면 완전히 지울 수 있다.

## 최상위 메타: `brands`

앱이 "전체 N대 중 최신 M대 · 나머지는 공식 사이트에서"를 하드코딩 없이 그릴 수 있게
브랜드별 메타를 함께 싣는다.

```jsonc
{
  "maxPerBrand": 300,
  "brands": {
    "benz": {
      "name": "Mercedes-Benz 인증중고차",
      "collected": 300,        // 이 파일에 담긴 수
      "sourceTotal": 710,      // 소스가 알려준 전체 재고
      "searchUrl": "https://www.mercedes-benz.co.kr/passengercars/buy/used-car/search-results.html"
    }
  }
}
```

실측(2026-08-18):

| 브랜드 | 수집 / 전체 | 비율 |
|---|---|---|
| BMW · MINI | 300 / 1,341 | 22% |
| Mercedes-Benz | 300 / 716 | 42% |
| Porsche | 101 / 101 | 100% |
| Volvo · Lexus · Audi · Toyota | 전량 | 100% |

**`sourceTotal`은 `null`일 수 있다.** 상한에 걸려 끝까지 돌지 못한 실행에서는 기록하지 않는다 —
끊긴 수를 전체 재고로 쓰면 앱이 "전체 N대"를 틀리게 보여준다. 앱은 `null`이면 그 문구를 생략할 것.
이번 실행에서 다루지 않은 브랜드도 직전 값을 유지한다(모르는 걸 0으로 쓰지 않는다).

## 단위 함정 (제일 많이 틀리는 곳)

가격 단위가 소스마다 다르고, **아우디는 같은 응답 안에서 섞여 온다** —
67건 중 66건이 원(`23000000` / `'₩ 23,000,000'`)이고 1건만 만원(`9700` / `'₩ 9,700'`)이었다.
그래서 브랜드별로 단위를 고정하면 틀린다. `priceToKrw()`가 레코드 크기로 판정한다
(100만원 미만이면 만원 표기로 간주 — 그보다 싼 중고차는 없다).

주행거리 타입도 정수·float·콤마 포함 문자열이 섞여 있어 `toKm()`으로 정수화한다.

## 페이징 함정

소스마다 다르고, 셋 다 **에러 없이 조용히 틀리는** 종류다. 반드시 첫 레코드 ID가
바뀌는지로 검증할 것.

- **렉서스·토요타** — 파라미터가 `page`가 아니라 `cur_page`. `page`를 주면 200이 오는데
  내용은 계속 1페이지다.
- **벤츠** — `totalPages`·`totalResults`를 믿으면 안 된다. `limit=100`이면 page 7(601번째)이
  0건인데 `limit=50`이면 page 13(같은 601번째)이 정상으로 온다. `totalResults`도 700으로
  딱 떨어져 실제 재고가 아니라 상한값으로 보인다. 그래서 `limit=50`으로 빈 페이지까지 돈다.
- **볼보** — URL로는 페이지가 안 넘어간다. `page=2`를 줘도(쿠키를 물려도, 헤드리스로도)
  1페이지가 온다. 실제로는 "12개 더 로드하기"(`a.load-type`) 버튼을 눌러 이어붙이는 방식이다.

## 브라우저가 필요한 이유

- **BMW** — 직접 API 호출이 전부 막혀서 SPA의 응답을 가로채는 방식이다(위 참고).
  **실제 Chrome + headed 필수** → CI에서 못 돌린다.
- **포르쉐** — `finder.porsche.com`이 Vercel 봇 챌린지로 curl을 막는다(429).
  브라우저로는 그냥 열린다. `networkidle`은 쓰면 안 된다 — 애널리틱스가 계속 요청을
  날려 idle이 오지 않는다. `domcontentloaded` + 셀렉터 대기로 간다.
- **볼보** — 위 페이징 문제. 쿠키 동의 배너(OneTrust)가 클릭을 가로막아 오버레이를 먼저 걷어낸다.
