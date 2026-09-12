# minilabs-data-hub

MiniLabs 앱들이 사용하는 데이터를 GitHub Actions로 수집하고 저장하는 중앙 데이터 허브.

> 🚨 **새 배치를 붙이기 전에 [`docs/api-budget.md`](docs/api-budget.md) 에서 남은 한도를 본다.**
> `DART_API_KEY` 를 6개 워크플로가, `DATA_GO_KR_KEY` 를 7개가 **나눠 쓴다.**
> 한도를 넘기면 그 키를 쓰는 형제 앱이 **같이 멈춘다.**
>
> ```bash
> node scripts/api-registry.mjs     # 표 갱신 + 미신고·유령·한도 초과 검사
> ```
>
> 표는 `.github/workflows/` 를 스캔해 자동 생성한다 — 손으로 고치지 않는다.
> 한도와 호출량만 `docs/api-limits.json` 에 선언한다. **새 워크플로에 키를 붙이면
> 다음 실행에서 「미신고」로 뜬다.**

## 구조

```
stadium/                   ← store-apps 경기장 좌석 앱용 (주 1회 변경 감지)
  sources.json             # 감시할 구단 좌석·티켓 페이지 20곳 (referer·ignore 규칙 포함)
  watch-state.json         # 정규화 해시 + 이미지 파일명 집합
                           # 🚨 데이터를 만들지 않는다. 바뀐 사실만 이슈로 알린다 —
                           #    좌석 정보는 대부분 이미지 안이라 자동 파싱이 안 된다.
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
protest/                   ← hansanhae-mini(한산해) 집회 섹션용 (서울경찰청 게시판, 매일 3회)
  assemblies.json          # 서울 집회 신고 현황 (오늘~+7일). 일시/장소/인원/관할서 + 자치구·규모등급 파생
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
vaccine/app/               ← flu-shot-mini(우리동네 독감주사) 앱용 (보조금24 + 심평원 비급여, 주 2회 월·목)
  local-support.json       지자체·중앙 예방접종 지원 서비스 (서비스명 LIKE 인플루엔자·독감·예방접종).
                           항목마다 scope(national/sido/sigungu)·code(시군구 5자리, report-reward/regions 기준)·
                           vaccines 태그(flu·zoster·pneumo…)·지원대상/내용 원문. 🚨 전국을 다 담지 않는다 —
                           보조금24 에 안 올린 지자체는 "등록된 정보 없음"으로 보여야 한다
  prices.json              백신 종류별 시도 가격 통계 {n, min, p10, med, p90, max} + reported.mainMonth(신고 시점).
                           독감은 flu / flu-senior(고령자용)로 나눈다. 앱은 p10~p90 을 쓴다(min/max 엔 입력 실수가 섞임)
                           🚨 **병원급 이상만**(의원 없음) · 제품명은 일부러 뺐다(전문의약품 광고 소지) → meta 에만
                           🚨 2026-09 실측 독감 가격의 91%가 2025-09 신고분(지난 절기) — 앱은 신고 시점을 붙인다
  meta.json                기준일·건수·지역 못 맞춘 기관·제품별 행 수(검증용)
aptcost/                   ← 관리비 미니앱용 (K-apt 자료실 엑셀, 월 1회)
                           🚨 OpenAPI 가 아니라 **엑셀**이 원본이다. 단지 22,298 곳을
                              단지코드 하나씩 부르는 API 로는 한 달치도 못 채운다
                              (상세기능당 5,000/일). 자료실에 연도별 전체가 엑셀
                              한 장으로 올라온다 — 2018~2026, 주 1회 재추출
  complexes.json           단지 21,301 (이름·시군구·동·세대수). 앱의 "우리 단지 찾기"용
  stats/{시군구코드}.json    그 시군구 단지들의 지표 + 백분위 경계. **앱은 이 파일 하나만 읽는다**
                           253개 · 평균 48KB · 최대 186KB
                           지표는 전부 **원/㎡·월**(분모 = 관리비부과면적) 12개월 평균.
                           세대당 총액으로 비교하면 평수 큰 집이 무조건 "많이 낸다"가 된다
                           공용관리비와 개별사용료를 나눠 둔 게 핵심 — 공용은 관리사무소
                           몫이고 개별은 우리 집 사용량이다. 합치면 두 얘기가 섞인다
                           단지마다 `trend` 로 2018~2026 추이 `[공용, 개별, 개월수]`
                           🚨 연도 비교는 **같은 단지끼리만**. 공개 의무가 2024-10-25 부터
                              100세대 이상으로 넓어져 모집단이 계속 커졌다
                              (2018년 16,020 → 2023년 18,506 → 2024년 20,834 단지).
                              전국 평균을 연도로 늘어놓으면 값이 아니라 구성 변화를 본다
  meta.json                기준일·연도·월별 행 수·전국 분포·연도별 단지 수
                           🚨 시차: 관리비 공개 기한이 **부과한 달의 다음 달 말일**이다.
                              2026-09-07 추출 실측 — M-1 1.4% · M-2 83% · M-3 99%.
                              앱이 "최신"으로 쓸 수 있는 달은 **M-3**
stock-ipo/                 ← stock-ipo-mini(공모주 미리보기) 앱용 (DART, 매일 diff 감지)
  ipo.json                 # 국내 공모주 청약 일정 13건 (공모가·일정·인수단·자금사용처·환매청구권)
  doc_cache.json           # 증권신고서 원문 추출 캐시(receiptNo 기준) — 5MB 원문 재다운로드 방지
cancer-cover/              ← cancer-cover-mini(암보험 충분할까) 앱용 (KOSIS, 매월 1일 diff 감지)
  cancers.json             # 암종 23종 id·라벨
  incidence.json           # 성별 × 10년 연령대(20~70대) × 암종별 조발생률
  costs.json               # 암종별 1인당 진료비(입원+외래)·평균 입원일수, 상급종합병원
  meta.json                # 수집 시각 + 통계 연도 2종 + **진료비를 비운 암종과 그 이유**
nps/                       ← nps-region-mini(우리동네 연금) 앱용 (국민연금 공표통계, 매월 1·11·21일)
  regions.json             # 시도 17개 × 노령·장애·유족연금 수급자수·수급금액·1인당 월평균 + 노령 기준 순위
  meta.json                # 기준월·수집시각. 앱이 "2026년 4월 기준" 표시에 쓴다 (공표 지연 3.5개월)
auto-option/               ← auto-option-mini(옵션 계산기) 앱용 (기아·현대 공식 가격표 PDF, 수동 갱신)
  models.json              # 28종. 옵션마다 트림별 상태(불가/기본/유료)
  meta.json                # 수집 시각·건수 + **빠진 차종과 그 이유**
  sources.json             # 차종별 현행 PDF 주소·ETag·수정일. **변경 감지의 기준선**
report-reward/             ← report-reward-mini(신고하고 포상금받자) 앱용 (국가법령정보 자치법규, 사람이 검수해 점진 추가)
  COLLECT.md               # 🚨 수집 안내서 — 채우기 전에 반드시 읽는다. 틀린 값이 재배포 없이 바로 앱에 간다
  regions/{code}.json      # 기초자치단체별 쓰레기 무단투기 신고포상금 (지급률·상한·기한·자격·출처 조례 mst)
                           # code = region-master 5자리, 일반구는 모시(앞 4자리+0), 세종 36110·제주 50000
                           # 파일이 없는 곳은 「미수집」이지 「제도 없음」이 아니다 (없음은 status none)
  regions/index.json       # 전 기초자치단체 × status — build-report-reward.mjs 가 만든다. 앱 동네 시트가 읽는다
  meta.json                # 건수(verified·stale·none·미수집)·caveats
  _work/                   # (gitignore) collect-report-reward.mjs 가 받은 조례 원문 재료
```

`auto-option/` 은 **월 1회 Actions 가 갱신한다**(`fetch-auto-option.yml`, 1일 09:00 KST).
PDF 75MB 를 git 에 넣지 않을 뿐, 매 실행마다 poppler 를 깔고 원본을 새로 받아 파싱한다.
파서는 `scripts/auto-option/` 에 있다 — 기아 내연·기아 전기·현대 세 서식이 근본적으로
달라 파일이 셋이다.

**주소를 코드에 박지 않는다.** 제조사가 연식마다 파일명을 바꾼다 —
`avante-price.pdf`(2023) / `avante-2026-price.pdf` / `venue-2027-price.pdf`, 슬러그까지
바뀐다(sonata → sonata-the-edge, ioniq5 → ioniq-5). 고정 주소를 쓰다가 **현대 13종이
2~4년 된 가격표**로 등록된 적이 있다(그랜저는 2022년 10월 파일, 실제보다 11% 낮았다).
`resolve-sources.mjs` 가 후보를 전부 HEAD 로 조회해 **Last-Modified 가 가장 최근인 것**을
고른다. 규칙을 추측하지 않으므로 내년에도 그대로 돈다.

**바뀐 차종만 다시 굽는다.** 1단계에서 HEAD 로 달라진 차종을 가려내고, 2단계에서
`bake.mjs --only` 로 그것만 받아 파싱한다(나머지는 이전 결과를 옮긴다).
한 차종이면 0.4초, 전체는 40초다. 시간보다 중요한 건 **가드 판정이 선명해진다**는 것 —
원본이 하나만 바뀌었는데 결과가 열 종에서 달라졌다면 갱신이 아니라 파서 고장이다.

**가드레일이 이 워크플로의 핵심이다.** 파서는 PDF 레이아웃에 의존해서, 제조사가 서식을
조금만 바꿔도 **에러 없이 쓰레기를 뽑는다** — 차종이 통째로 빠지거나 칼럼이 밀려 엉뚱한
금액이 들어온다. `guard.mjs` 가 이전 결과와 비교해 차종 소실·규모 급감·기본가 30% 이상
변동을 잡아내고, 걸리면 **커밋하지 않고 이슈를 연다**.
하루 늦게 갱신되는 게 틀린 값이 나가는 것보다 낫다 — 옛 데이터는 최소한 한때 사실이었다.

가드에 걸리면 `repair-auto-option.yml` 이 이어서 돌아 에이전트가 원인을 찾고 **PR 을 연다**.
main 에 직접 밀지 않는다 — 에이전트가 고친 가격을 검토 없이 합치면 가드레일을 둔 의미가
없다. 사람이 PR 에서 숫자를 보고 합친다.
동작하려면 저장소 시크릿에 `GEMINI_API_KEY` 가 필요하다(Google AI Studio, 무료 할당량).
없으면 조용히 건너뛰고 수집 워크플로가 연 이슈만 남는다.

차종별 예외는 파서가 아니라 `scripts/auto-option/models.config.mjs` 에 둔다.
한때 카니발의 잘못된 트림을 파서 정규식으로 걸렀는데, 그건 기아 전 차종이 지나는 길목을
한 차종 때문에 건드린 것이었다.

`meta.json` 의 `skipped` 는 지우지 말 것. **왜 그 차가 없는지**를 남기지 않으면
다음 사람이 같은 조사를 처음부터 다시 한다. 카니발은 트림 × 승차인원 조합의 기본가가
PDF 본문에 없어서, 봉고3 는 축거·적재함별 표가 얽혀서 뺐다.
가격 계산기에서 틀린 금액을 넣는 건 그 차종을 빼는 것보다 나쁘다.

`stock-ipo/ipo.json` 은 청약이 **끝난 건도 남긴다** — "내가 놓쳤나" 확인이 앱의 절반이다.
`offerPrice: null` 은 누락이 아니라 **공모가 미확정**(기재정정 진행 중) 상태다.
상장일(`listDate`)은 토스증권 API 로만 확정되는데 허용 IP 제한 때문에 Actions 에서 못 받는다.
**추정하지 않고 `null` 로 둔다.**

`cancer-cover/` 는 **두 통계의 축이 달라서** 스크립트 안 `CANCERS` 에 매핑을 손으로 적는다 —
발생률은 24개 암종(위·대장·폐), 진료비는 112개 ICD-10 C코드(C16·C18·C34)다. 자동 추론이 안 된다.
대장(C18-C20)처럼 여러 코드에 걸친 암종은 원본에 환자수가 없어 가중평균을 만들 수 없어서
**대표 코드 하나를 고르고 `basis` 로 앱 화면에 밝힌다.** 입술·구강·인두(C00-C14 14개 코드)는
대표를 고를 수 없어 `costs` 를 `null` 로 비운다 — `meta.json` 의 `costsSkipped` 가 그 이유다.
**지우지 말 것.** 없으면 다음 사람이 같은 조사를 처음부터 다시 한다.

이 도메인의 실패는 전부 **예외 없이 조용히 빈 값**으로 끝난다. KOSIS 암종명에 ICD 범위가
붙어 오고(`'위(C16)'`), ITM_ID 대소문자가 섞여 온다(`…AC000107` / `…ac000101`). 안 맞으면
빈 데이터가 담긴 파일이 정상 생성된다. 그래서 이 도메인만 쓰기 전에 `validate()` 로 구조를
검사하고(밴드 12칸·암종 수·진료비 범위·연도) 실패하면 커밋 전에 죽는다.

10년 연령대는 5세 통계의 **단순 평균이 아니다.** 발생자수/조발생률로 인구를 역산해 가중한다
(60대는 두 그룹 인구가 1.30배 차이라 단순 평균이면 4.8% 과대 계상된다).

앱이 이 JSON 을 **런타임에 읽지 않는다.** 번들 내장이라 앱에서 `npm run data` 로 내려받아
굽고 재배포해야 사용자에게 닿는다. CDN 이 갱신돼도 배포 전까지는 옛 숫자가 보인다.

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
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/protest/assemblies.json
```

## 데이터 갱신

GitHub Actions가 매일 자동 실행 (cron). 수동 실행도 가능 (workflow_dispatch).

`realestate/` 는 신고 기한(계약일 +30일) 때문에 **3개월을 매번 다시 받는다** — 지난달·전전달 숫자가
계속 늘어나서, 한 번 받고 끝내면 과거가 영원히 과소집계로 남는다.
주 2회만 도는 이유는 그 지연 때문에 하루 단위 신선도가 의미를 못 만들기 때문이고,
`DATA_GO_KR_KEY` 가 **계정 공통**이라 다른 프로젝트와 하루 10,000회 한도를 나눠 쓰기 때문이다.

집계 규칙의 근거는 `realestate-tools/_design/schema-v2.md` 에 있다.
**여기 집계를 바꾸면 두 앱의 화면이 같이 깨진다.**
