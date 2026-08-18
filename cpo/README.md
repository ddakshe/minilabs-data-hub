# cpo — 인증중고차(CPO) 매물 (국산 + 수입)

브랜드 공식 소스만 사용한다. 애그리게이터(엔카·KB차차차·케이카)는 쓰지 않는다 —
robots에서 상세를 막고 있고 DB권 침해 판례 리스크가 있다.

- 산출: `cpo/listings.json`
- 앱 설계 전제: **최신 N건만 보여주고 나머지는 브랜드 공식 사이트로 링크**한다.
  완전한 매물 검색을 흉내내지 않는다 — `brands[].searchUrl`이 그 링크다.
- 소비: `https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/cpo/listings.json`
- 스크래퍼: `scripts/fetch-cpo.mjs`(API 기반) + `scripts/fetch-cpo-pw.mjs`(브라우저 필요)
- 워크플로: `.github/workflows/fetch-cpo.yml` (매일 09:20 KST)

## CI에서 도는 것과 로컬에서만 도는 것

2026-08-18 실측(run 32106585398, 2분 24초, 전 단계 success):

| 브랜드 | CI | 비고 |
|---|---|---|
| 현대 · 기아 · Mercedes-Benz · Lexus · Audi · Toyota | ✅ | 해외 IP에서도 정상 |
| Volvo | ✅ | Playwright 클릭 페이지네이션이 러너에서도 동작 |
| **Porsche** | ❌ | Vercel 봇 챌린지가 Actions 데이터센터 IP를 통과시키지 않는다.<br>실측: 셀렉터 대기 25초 × 2 = **51초 타임아웃 후 0건**. 로컬 맥에서는 같은 코드가 300건을 받는다 |
| **BMW · MINI** | ❌ | 실제 Chrome + headed 필수. 헤드리스는 조용히 0건 |

그래서 워크플로의 Playwright 단계 기본값은 **`volvo`만**이다.
BMW·포르쉐는 로컬에서 돌린다:

```bash
# 저장소 루트에서 (pull → 수집 → 변경 있으면 commit·push → jsDelivr purge)
./refresh-cpo.sh                  # bmw,porsche 기본
./refresh-cpo.sh bmw              # 특정 브랜드만
MAX_PER_BRAND=600 ./refresh-cpo.sh

# 스크래퍼만 직접
node scripts/fetch-cpo-pw.mjs bmw,porsche
```

⚠️ **반드시 이 저장소 디렉터리에서 실행할 것.** `playwright`가 여기 `node_modules`에 있어서
다른 곳에서 돌리면 `ERR_MODULE_NOT_FOUND: playwright`로 죽는다.
`refresh-cpo.sh`는 `cd "$(dirname "$0")"`로 이 문제를 스스로 막는다.

**주기: 매일이면 충분하다.** 상한 300 기준 실측 소요는 bmw+porsche+volvo 전부 돌려 **3분 51초**,
볼보는 CI가 커버하니 로컬에서 필요한 bmw+porsche만 돌리면 **약 3분**이다.
(상한이 없던 시절엔 BMW만 클릭 111회여서 주 1회를 고민할 만했지만, 지금은 24회다.)

최신순 슬라이스는 전체 재고보다 회전이 빠르다 — 신규 유입이 전부 상위 300에 들어오기 때문에
주기를 길게 잡으면 놓치는 매물이 생긴다. 창을 넓히는(`MAX_PER_BRAND`↑) 것보다 자주 돌리는 게 낫다.

CI가 실패해도 데이터는 파괴되지 않는다. 담당하지 않는 브랜드와 실패한 브랜드는
기존 데이터를 그대로 유지하도록 만들어서, 포르쉐가 0건으로 끝난 실행에서도
기존 300건과 BMW 300건이 온전히 남았다.

## 수집 정책: 전량 (2026-08-19 변경)

**기본이 전량이다** (`MAX_PER_BRAND` 기본값 `0` = 무제한). 예전엔 브랜드당 300건 상한이었다.

상한을 없앤 이유가 "더 많이 받고 싶어서"가 아니다 — **전량이 더 빠르다**는 게 실측으로 나왔다:

```
상한 300 · 순차 (sleep 500~600ms)   1,716건   약 35초
상한 없음 · 병렬                    3,511건   12.0초
```

페이지가 독립적인 현대·벤츠를 동시 요청으로 바꾸고 기아 페이지 크기를 100으로 올린 결과다.

상한을 없애면 얻는 게 하나 더 있다. **"무엇을 기준으로 300을 잘랐는지"가 브랜드마다 달랐다**:

| 브랜드 | 상한이 자르던 기준 |
|---|---|
| BMW | UI 최신순(`sorting=PRODUCTION_DATE_DESC`) 상위 300 |
| 벤츠 | `registrationYear-desc` 상위 300 |
| 기아 | `DISPLAYED_AT_DESC`(매물 등록일) 상위 300 |
| 현대 | ⚠️ **인기순**(`sortType=popularity`) 상위 300 — 최신순 값을 못 찾았다 |
| 볼보 | `sort=modelYear:DESC` (상한 미달) |
| 포르쉐 | 정렬 파라미터 미확인 — 기본 순서 앞에서부터 |

즉 현대의 300건은 "최신 300대"가 아니라 "인기 300대"였다. 전량을 받으면 이 표본 편향이
아예 질문거리가 안 된다.

```bash
node scripts/fetch-cpo.mjs                   # 전량 (기본)
MAX_PER_BRAND=300 node scripts/fetch-cpo.mjs # 상한을 다시 걸고 싶을 때
CONCURRENCY=8     node scripts/fetch-cpo.mjs # 동시 요청 수(기본 5)
```

`CONCURRENCY` 기본값이 5인 이유: 실측으로 현대 5동시·벤츠 8동시가 전부 200이었지만, CI가
GitHub Actions 데이터센터 IP에서 돈다. 차단당하면 매일 도는 수집이 통째로 멈춘다. 속도는
이미 충분하니 여유를 남긴다.

### 병렬화 가능 여부 (실측)

| 브랜드 | 병렬 | 근거 | 전량 요청 수 |
|---|:-:|---|---|
| 현대 | ✅ | `startNo` 오프셋이 독립적. 동시 5요청 104ms 전부 200 | 1,088 → 73회 |
| 벤츠 | ✅ | `page`가 독립 정수. 동시 8요청 전부 200 | 674 → 14회 |
| 기아 | ❌ | **커서 방식** — 이전 응답 마지막 레코드의 `cursors[]`를 다음 요청에 넘긴다. 원리적으로 순차 | 1,009 → 11회 |
| BMW | ❌ | SPA "더보기" 클릭. 서버가 세션 상태를 들고 있다 | 1,339 → **112클릭** |
| 볼보·포르쉐·렉서스·아우디·토요타 | — | 이미 전량 | 변화 없음 |

**BMW만 부담이 남는다.** 더보기 12건씩 112클릭, headed Chrome, 약 5분.
게다가 "5회 연속 증가 없으면 중단" 조건이 있어 클릭이 늘수록 중도 중단 확률이 올라간다.
중단되면 부분 수집으로 기존 데이터와 병합되므로 데이터가 깨지지는 않는다.

## 브랜드별 상태

국산 3 + 수입 6, **9개 브랜드**. 전국 인증중고차 재고 약 4,600대 중 최신 1,717대를 수집한다.

| 브랜드 | 담당 | 수집 / 전체 | CI | 방식 |
|---|---|---|---|---|
| **현대** (제네시스 포함) | fetch | 300 / 1,063 | ✅ | form POST → **HTML 조각**, cheerio |
| **기아** | fetch | 300 / 998 | ✅ | 순수 JSON API, 커서 페이지네이션 |
| BMW · MINI | pw | 300 / 1,341 | ❌ | SPA 응답 가로채기 (로컬 전용) |
| Mercedes-Benz | fetch | 300 / 716 | ✅ | GraphQL (`commerce/onesearch`) |
| Volvo Selekt | pw | 218 / 218 | ✅ | 클릭 페이지네이션 |
| Porsche Approved | pw | 101 / 101 | ❌ | SSR HTML (로컬 전용) |
| Lexus Certified | fetch | 78 / 78 | ✅ | PHP JSON, 무인증 |
| Audi Approved :plus | fetch | 68 / 68 | ✅ | REST, `Token` 헤더 |
| Toyota Certified | fetch | 52 / 52 | ✅ | PHP JSON, 무인증 |

전부 인증중고차다(신차 섞임 없음). MINI는 BMW와 같은 풀에 섞여 오고 레코드의 `brand`로 갈라진다.
현대 사이트는 제목이 "현대/제네시스 인증중고차"로, 제네시스 매물이 같은 목록에 포함된다.

### 현대 (`certified.hyundai.com`)

```
POST /p/search/vehicle/list   (application/x-www-form-urlencoded)
  ntcSeq= &type=PLP &pageIdx=N &rowsPerPage=15 &startNo=… &listCnt=15
  &sortType=popularity &srchType=srchWord &searchWord= &lowPrice=0 &highPrice=0 …
→ JSON이 아니라 HTML 조각. ul#productList > li 를 cheerio로 파싱한다.
```

- `robots.txt`는 **`Allow: /`** 전면 허용. 브라우저 없이 curl로 열린다 → CI 가능.
- 카드 구조: `.unit_info .name`(앞 4자리가 연식) · `.drive span`[최초등록, 주행거리, **번호판**, 지역] ·
  `.price .pay em`(만원). `del.txt.del`은 **할인 전 가격**이라 쓰지 않는다.
- **번호판은 담지 않는다**(`269로8643` 형태로 그대로 온다). 지역만 취한다.
- 총 재고는 `<em id="totalVehicleCnt">`에 있다.
- ⚠️ **`sortType` 최신순 값을 못 찾았다.** `popularity`만 유효하고 `recent`·`regDate`·`newest`는 500이다.
  9개 브랜드 중 **최신순 정렬이 안 되는 유일한 브랜드**다(현재 인기순으로 받는다).
- 개별 상세 URL이 없다. `goodsDetail.do?contsNo=`는 브라우저에서도 400이고 JS가 만드는 경로를
  재현하지 못했다. 대신 **ID로 검색하면 정확히 그 한 대만 나와서** 그 링크를 쓴다(실측 확인).

### 기아 (`cpo.kia.com`)

```
GET /api/search/?size=50&sort=DISPLAYED_AT_DESC&displayChannel=GENERAL
    &cursors[]=<timestamp>&cursors[]=<id>        ← 다음 페이지
→ { content: [...], totalElements: 998 }
```

- 키·쿠키·브라우저 전부 불필요. curl로 그냥 열린다.
- **`sort=DISPLAYED_AT_DESC`는 매물 등록일 최신순이다.** 다른 브랜드는 연식·생산일로 대신했는데
  기아만 "최근 올라온 매물"로 정렬할 수 있다. 그래서 레코드에 `listedAt`을 담는다(기아 전용 필드).
  실측: 300건이 최근 5일치(2026-08-13 ~ 08-18)로 들어온다.
- 페이지네이션은 오프셋이 아니라 **커서**다. 응답 마지막 레코드의 `cursors` 배열을 그대로 넘긴다.
- 필드명 주의: 트림 `modelTrim`, 연료 `modelEngine`, 색상 `exteriorColorCodeName`.
  목록 응답에 판매점 정보는 없다. **`plateNumber`(번호판)가 오지만 담지 않는다.**

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

담당은 `fetch-cpo-pw.mjs`. **로컬(맥) 실행 전용**이고 워크플로는 bmw를 건너뛴다.

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
node scripts/fetch-cpo-pw.mjs bmw                      # 최신 300건
MAX_PER_BRAND=0 node scripts/fetch-cpo-pw.mjs bmw      # 전량 시도(취약함)
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

## 차량 URL — 실측 검증 결과

매물은 팔리면 사라진다. 그래서 개별 차량 URL이 실제로 열리는지 브랜드별로 확인했다(2026-08-18).

| 브랜드 | URL 출처 | 상태 |
|---|---|---|
| Mercedes-Benz | API `pdpLink` | ✅ 200 |
| Audi | API `weblink` | ✅ 200 |
| Volvo | 카드 `data-link` | ✅ 200 |
| Porsche | 카드 `href` | ✅ (curl은 429 봇챌린지, 브라우저에서 정상) |
| **BMW · MINI** | **조립** `…/details/{documentId}` | ✅ 200 |
| **기아** | **조립** `/products/detail/?id={id}` | ✅ 200 |
| **렉서스 · 토요타** | **조립** `/car-detail/?idx={idx}` | ✅ 200 (SPA 셸) |
| **현대** | **조립** 검색어=ID | ✅ 200 |

**조립한 URL은 반드시 검증할 것.** 기아를 처음 `/products/{id}`로 만들었는데 **404였다**
(정답은 `/products/detail/?id={id}`). 소스가 주는 링크와 달리 조립한 링크는 조용히 깨진다.

### 팔린 차량은 어떻게 되나

기아로 확인: 없는 id(`?id=1`, `?id=99999`)도 **404가 아니라 200에 "판매완료" 안내**를 보여준다.
링크가 깨지는 게 아니라 사용자에게 상황을 알려주는 형태다.

신선도를 낮추는 장치는 세 가지다:

- **매일 갱신** — 최신순 N건이라 새로 들어온 매물이 상위에 쌓인다.
- **`updatedAt`** — 파일 최상위에 수집 날짜가 있다. 앱이 "○월 ○일 기준"으로 표시할 것.
- **기아 `reserved`** — 예약중 플래그. 실측 300건 중 **42건(14%)** 이 예약중이었다.
  다른 브랜드는 이 신호를 주지 않는다.

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
- **기아** — 페이지 크기 서버 상한이 **100**이다. `size=200`·`size=500`을 주면 HTTP 200이
  오지만 100건만 온다(조용히 잘림). 커서 방식이라 병렬화가 불가능해서, 페이지를 키우는 것이
  유일한 단축 수단이다 — 50→100으로 요청 수가 절반이 됐다.
- **현대** — `rowsPerPage` 상한이 **15**다. 50·100·200을 주면 전부 **HTTP 400**.
  요청 수를 줄일 방법이 없어서 병렬로 던진다(오프셋이 독립적이라 가능).
- **벤츠** `totalResults`는 **부풀려져 있다.** 724를 알려주는데 실제로는 page 14에서 24건으로
  끝나 674건이다. `totalPages`(15)도 한 페이지 많다 — page 15는 0건.
  그래서 `totalPages`는 "여기까지만 던져보자"는 상한으로만 쓰고 종료 판정은 빈 페이지로 한다.

## 표본이 작으면 "100%"가 거짓말이 된다

`year`(모델연식)는 **전 브랜드 100%**로 문서화돼 있었다. 상한 300 시절 실측이 그랬다.
BMW 상한을 700으로 올리자 **4건이 null 로 나왔다**:

```
WBA21EU03R9V12371  X5 xDrive40i  year=null  price=94,000,000
WBA51FJ01RCR22130  530i xDrive   year=null
WBA51FJ09RCR20657  530i xDrive   year=null
WBA61FS03RFS28282  320i          year=null
```

BMW 응답의 `vehicleSpecification.modelAndOption.modelYear` 가 비어 있는 매물이다.
0.1% 라 대충 넘길 수 있어 보이지만, 앱에서 **조용히** 깨진다 — 최신순 정렬 비교자가
`b.year - a.year` 로 NaN 을 만들어 예외 없이 순서만 틀리고, 연식 게이지에 `null년형 이상`
칸이 생긴다.

현재는 앱(`useListings`)이 로딩 시점에 가격 더미와 함께 걸러낸다.
**채움률 표의 "100%"는 그 시점 표본에 대한 관찰일 뿐이다.** 수집 범위를 늘릴 때마다
필수 필드 누락을 다시 확인할 것.

## 파생 브랜드 함정 — 제네시스 중복 105건

**제네시스는 자기 소스가 없다.** `certified.hyundai.com`에 현대와 같이 올라오고,
현대 어댑터가 차종(`G70`·`G80`·`G90`·`GV60`·`GV70`·`GV80`)을 보고 `brand`를 갈라낸다.

그런데 `BRANDS` 배열에는 `genesis` 항목이 있고 어댑터는 없다. 그래서 메인 루프가
"어댑터 없음 → 기존 데이터 유지"로 판단해 **직전 파일의 제네시스를 다시 밀어넣었다.**
현대 어댑터가 이미 만들어 준 것과 겹쳐서 105건이 중복됐다.

`genesis` 분리를 도입한 커밋 직후에는 기존 파일에 제네시스가 **없어서**(`prev` = 0건)
안 터졌다. **분리 후 두 번째 실행에서 처음 터지는** 잠복 버그였다.

방어를 두 겹으로 넣었다:

1. `meta.derivedFrom`으로 표시하고, `refreshed`에 이미 그 브랜드가 있으면 `prev`를 얹지 않는다.
   원본 어댑터가 실패했을 때만 직전 데이터를 살린다.
2. 쓰기 직전 `(brand, id)` 중복 제거. 앱이 이 키로 즐겨찾기·조회 기록을 저장하므로
   중복은 조용히 망가진다.

## 믿을 수 없는 가격 (더미 값)

일부 딜러가 "가격 문의 / 판매 불가" 표시로 **9만 늘어놓은 값**을 넣는다. 실측 3건, 전부 BMW,
전부 판매완료·계약완료 상태였다:

```
999,999,999원   X5 xDrive40d · X6 xDrive30d   → "9억 9,999만원" 으로 눈에 띈다
 99,999,999원   M135 xDrive                   → 만원 단위 반올림으로 "1억원" 이 된다 ← 위험
```

후자가 위험하다. 그리고 이 값들이 "높은 가격순" 상위를 차지하고 가격 필터 임계값 분포까지 뒤튼다.

**판정 기준은 "자리수 전체가 9"**여야 한다. "9로 시작하는 큰 값"으로 훑으면 실제 가격이 걸린다:

```
99,000,000원  볼보 XC90    (9,900만원)   ← 실제 가격
90,000,000원  토요타 알파드 (9,000만원)   ← 실제 가격
99,900,000원  제네시스 G90 (9,990만원)   ← 실제 가격
```

현재는 앱(`useListings`)이 로딩 시점에 걸러낸다. 수집 단계에서 거르는 쪽이 더 맞지만,
`priceKrw`는 필수 필드라 레코드를 버려야 해서 아직 옮기지 않았다.

## 브라우저가 필요한 이유

- **BMW** — 직접 API 호출이 전부 막혀서 SPA의 응답을 가로채는 방식이다(위 참고).
  **실제 Chrome + headed 필수** → CI에서 못 돌린다.
- **포르쉐** — `finder.porsche.com`이 Vercel 봇 챌린지로 curl을 막는다(429).
  브라우저로는 그냥 열린다. `networkidle`은 쓰면 안 된다 — 애널리틱스가 계속 요청을
  날려 idle이 오지 않는다. `domcontentloaded` + 셀렉터 대기로 간다.
- **볼보** — 위 페이징 문제. 쿠키 동의 배너(OneTrust)가 클릭을 가로막아 오버레이를 먼저 걷어낸다.
