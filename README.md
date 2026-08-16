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
rate-lens/                 ← rate-lens-mini(금리 돋보기) 앱용 (금감원 공시, 매일 diff 감지)
  rates.json               # 예적금 765상품 / 금리행 4,335 (회사·상품·금리 3테이블 정규화)
stock-ipo/                 ← stock-ipo-mini(공모주 미리보기) 앱용 (DART, 매일 diff 감지)
  ipo.json                 # 국내 공모주 청약 일정 13건 (공모가·일정·인수단·자금사용처·환매청구권)
  doc_cache.json           # 증권신고서 원문 추출 캐시(receiptNo 기준) — 5MB 원문 재다운로드 방지
```

`stock-ipo/ipo.json` 은 청약이 **끝난 건도 남긴다** — "내가 놓쳤나" 확인이 앱의 절반이다.
`offerPrice: null` 은 누락이 아니라 **공모가 미확정**(기재정정 진행 중) 상태다.
상장일(`listDate`)은 토스증권 API 로만 확정되는데 허용 IP 제한 때문에 Actions 에서 못 받는다.
**추정하지 않고 `null` 로 둔다.**

`rate-lens/rates.json` 은 기본금리(`intr_rate`, 우대조건 미충족 시 실제 금리)와
최고금리(`intr_rate2`)를 **둘 다** 담는다. 앱의 존재 이유가 그 격차라서 어느 쪽도 버리면 안 된다.
결측은 `null` 이며 0 이 아니다 — 0 으로 치환하면 순위가 조용히 오염된다.

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
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/rate-lens/rates.json
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/recall/recalls.json
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/recall/meta.json
```

## 데이터 갱신

GitHub Actions가 매일 자동 실행 (cron). 수동 실행도 가능 (workflow_dispatch).
