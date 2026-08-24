# minilabs-data-hub

MiniLabs 앱들이 사용하는 데이터를 GitHub Actions로 수집하고 저장하는 중앙 데이터 허브.

## 구조

```
korea-stats/               ← korea-stats-mini 앱용
  stats.json
subway-congestion/         ← subway-congestion-mini 앱용 (분기별 갱신, 매일 diff 감지)
  congestion.json
subway-arcade/             ← 지하상가 임대정보 (서울교통공사, 비정기 연 1~2회)
  arcade.json              # 점포 1500여건 (호선/역/면적/임대료/계약/사업진행단계)
  stats.json               # 노선·업종별 평균 임대료, 공실/입찰 카운트
  meta.json                # 원본 파일 식별(seq, modified) — 변경 감지용
holidays/                  ← holiday-pto-mini 앱용 (KASI, 월 1회 diff 감지)
  holidays.json            # 현재 연도부터 +2년치 공휴일·대체공휴일
convenience-events/        ← convenience-events-mini 앱용 (편의점 3사 행사, 매일)
  products.json            # CU·GS25·세븐일레븐 1+1/2+1/증정/할인 (5천여건, 가격·카테고리 포함)
chicken-events/            ← chicken-event-mini 앱용 (치킨 브랜드 진행중 이벤트, 매주 월)
  events.json              # 브랜드별 이벤트(제목·기간·플랫폼). 어댑터 레지스트리 방식, 어댑터 없는 브랜드는 링크전용
recall/                    ← recall-mini(리콜모아) 앱용 (소비자24, 매일 diff 감지)
  recalls.json             # 국내 리콜 1,700여건 (9개 카테고리 × 최근 300건, 최신순)
  meta.json                # 수집 시각·카테고리별 건수. 앱이 "기준일" 표시에 쓴다
fx/                        ← fx-lens-mini(환율 고시) 앱용 (한국은행 ECOS, 평일 diff 감지)
  rates.json               # 여행 통화 14종 · 원화/대미달러 기준 1년 일별 + 장기 월평균 + 정책금리
rate-lens/                 ← rate-lens-mini(금리 돋보기) 앱용 (금감원 공시, 매일 diff 감지)
  rates.json               # 예적금 765상품 / 금리행 4,335 (회사·상품·금리 3테이블 정규화)
benefit-gauge/             ← benefit-gauge-mini(내가 받을 수 있는 혜택) 앱용 (보조금24, 주 1회)
  benefits.json            # 개인·가구 대상 + 지원금액 명시 3,669건 (조건 비트마스크로 압축)
  meta.json                # 수집 시각·건수. 앱이 "기준일" 표시에 쓸 수 있다
realestate/                ← 부동산 미니앱 2종용 (국토부 실거래가, 주 2회 월·목 3개월 롤링)
  region-master.json       시군구 256개 (LAWD_CD 5자리). 광주+전남은 `12` 전남광주통합특별시다
  trade/{YYYY-MM}.json     앱 A(아파트 매매) 축약본 · trade/latest.json 을 앱이 읽는다
  rent/{YYYY-MM}.json      앱 B(아파트 전월세) 축약본 · 갱신 인상률이 핵심 지표
  meta.json                수집 시각·건수. 앱이 "기준일" 표시에 쓴다
stock-ipo/                 ← stock-ipo-mini(공모주 미리보기) 앱용 (DART, 매일 diff 감지)
  ipo.json                 # 국내 공모주 청약 일정 13건 (공모가·일정·인수단·자금사용처·환매청구권)
  doc_cache.json           # 증권신고서 원문 추출 캐시(receiptNo 기준) — 5MB 원문 재다운로드 방지
```

`stock-ipo/ipo.json` 은 청약이 **끝난 건도 남긴다** — "내가 놓쳤나" 확인이 앱의 절반이다.
`offerPrice: null` 은 누락이 아니라 **공모가 미확정**(기재정정 진행 중) 상태다.
상장일(`listDate`)은 토스증권 API 로만 확정되는데 허용 IP 제한 때문에 Actions 에서 못 받는다.
**추정하지 않고 `null` 로 둔다.**

`fx/rates.json` 은 원화 기준(`krw`)과 대미달러 기준(`usd`)을 **둘 다** 담는다.
원화가 강해지면 모든 통화가 동시에 싸 보이므로, 두 percentile 을 나란히 놔야
"그 통화가 약해진 것"과 구분된다 — 앱의 존재 이유가 그 구분이라 어느 쪽도 버리면 안 된다.
대미달러 값은 계산이 아니라 한국은행 고시(`731Y002`)이며, 고시가 없는 위안만 역산하고
`derived: true` 로 표시한다. ECOS 결측은 빈 문자열로 오는데 **0 으로 치환하면 percentile 이
조용히 오염된다** — 반드시 버린다.

`rate-lens/rates.json` 은 기본금리(`intr_rate`, 우대조건 미충족 시 실제 금리)와
최고금리(`intr_rate2`)를 **둘 다** 담는다. 앱의 존재 이유가 그 격차라서 어느 쪽도 버리면 안 된다.
결측은 `null` 이며 0 이 아니다 — 0 으로 치환하면 순위가 조용히 오염된다.

`benefit-gauge/benefits.json` 은 **행을 객체가 아니라 배열로** 담는다. 3,669건 × 13필드를
객체로 두면 키 이름이 반복되어 두 배 이상 커진다(앱 번들에 실리는 크기다).
그래서 **배열 순서와 조건 비트 순서가 계약**이다 — `scripts/fetch-benefit-gauge.mjs` 의
`SIT`·`HH`·`INC` 배열과 앱의 `src/data/types.ts`(`ROW`)·`src/lib/match.ts`(`SIT_CODES`·`HH_CODES`)가
반드시 일치해야 한다. **어긋나면 에러 없이 조용히 틀린 개수를 센다.**
그래서 이 도메인만 수집 스크립트 안에서 구조 검증(행 길이·비트 폭·정렬·시군구 인덱스 범위)을
하고 실패하면 커밋 전에 죽는다.

`지원유형` 필드는 쓰지 않는다. 부정확하다 — 국민내일배움카드(조회수 1위, 훈련비 500만원)가
`서비스(일자리)` 로 분류돼 있어서 현금 필터로 걸러내면 최상위가 빠진다. 대신 `지원내용` 의
금액 표현으로 판단한다.

## 사용 방법

각 앱에서 GitHub raw URL로 접근:

```
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/korea-stats/stats.json
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/subway-congestion/congestion.json
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/subway-arcade/arcade.json
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/subway-arcade/stats.json
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/holidays/holidays.json
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/convenience-events/products.json
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/stock-ipo/ipo.json
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/chicken-events/events.json
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/fx/rates.json
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/rate-lens/rates.json
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/benefit-gauge/benefits.json
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/recall/recalls.json
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/recall/meta.json
```

## 데이터 갱신

GitHub Actions가 매일 자동 실행 (cron). 수동 실행도 가능 (workflow_dispatch).

`realestate/` 는 신고 기한(계약일 +30일) 때문에 **3개월을 매번 다시 받는다** — 지난달·전전달 숫자가
계속 늘어나서, 한 번 받고 끝내면 과거가 영원히 과소집계로 남는다.
주 2회만 도는 이유는 그 지연 때문에 하루 단위 신선도가 의미를 못 만들기 때문이고,
`DATA_GO_KR_KEY` 가 **계정 공통**이라 다른 프로젝트와 하루 10,000회 한도를 나눠 쓰기 때문이다.

집계 규칙의 근거는 `realestate-tools/_design/schema-v2.md` 에 있다.
**여기 집계를 바꾸면 두 앱의 화면이 같이 깨진다.**
