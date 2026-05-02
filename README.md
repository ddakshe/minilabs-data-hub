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
```

## 사용 방법

각 앱에서 GitHub raw URL로 접근:

```
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/korea-stats/stats.json
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/subway-congestion/congestion.json
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/subway-arcade/arcade.json
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/subway-arcade/stats.json
https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/holidays/holidays.json
```

## 데이터 갱신

GitHub Actions가 매일 자동 실행 (cron). 수동 실행도 가능 (workflow_dispatch).
