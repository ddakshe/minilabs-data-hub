#!/usr/bin/env bash
# 국내 배당 데이터 갱신 (DART) → GitHub push.
#
# ⚠ GitHub Actions 로 옮기지 않는다. 기술적으로는 가능하지만(키가 Secrets 에 있다)
#   **순차로 40분 넘게 도는 작업**이라 CI 에 두면 얻는 것 없이 비용과 위험만 는다.
#   - 국내 배당은 사업보고서 기준이라 **3~4월에만 값이 움직인다.** 매일 도는 크론은
#     같은 값을 8,400건씩 다시 받는다.
#   - DART 는 이 프로젝트에 **IP 차단을 건 적이 있다** (2026-08-25, 하루 뒤 해제).
#     초당 3건 이하로 천천히 받는 것이 유일한 방어라 시간을 줄일 수단이 없다.
#   그래서 사람이 필요할 때만 부른다 — LOCAL_JOBS.md 의 schedule 은 `on-demand` 다.
#
# 🔴 collect.py 의 `LATEST` 를 먼저 확인할 것. 지금 2025 로 **하드코딩**돼 있다.
#    새 사업연도를 받으려면 LATEST 와 PAST 를 함께 올려야 한다:
#      LATEST = 2026 · PAST = (2023, 2020, 2017)
#    안 올리면 40분을 돌고도 작년과 같은 파일이 나온다 (캐시가 다 차 있어 2초 만에 끝난다).
#
# 사용법:
#   ./refresh-dividend-kr.sh
#   ./run-local-jobs.sh dividend-kr      # 러너를 통해 (결과가 status 에 남는다)
set -euo pipefail

cd "$(dirname "$0")"

STOCK_TOOLS="${STOCK_TOOLS:-$(cd .. && pwd)/stock-tools}"
APP="$STOCK_TOOLS/stock-dividend-kr"
PY="${PY:-python3}"

echo "▶ 최신 pull"
git pull --rebase --autostash origin main

echo "▶ 수집 (DART — 순차 · 40분 안팎 · 캐시가 차 있으면 몇 초)"
"$PY" "$APP/scripts/collect.py"

echo "▶ 허브로 복사"
mkdir -p dividend-kr
cp "$APP/data/dividend-kr.json" dividend-kr/dividend-kr.json

echo "▶ dividend-kr/ 변경 확인"
git add dividend-kr/
if git diff --cached --quiet -- dividend-kr/; then
  echo "· 변경 없음 — push 생략"
  exit 0
fi

git --no-pager diff --cached --stat -- dividend-kr/
DATE_KST=$(TZ=Asia/Seoul date "+%Y-%m-%d %H:%M")
git commit -m "chore(dividend-kr): 국내 배당 데이터 갱신 ($DATE_KST KST)"
git push origin main

# jsDelivr purge 를 하지 않는다 — 이 데이터를 쓰는 앱(stock-dividend-kr)은
# raw.githubusercontent.com 을 직접 부르고, URL 에 KST 날짜를 붙여 하루 단위로
# 캐시를 턴다 (src/lib/data.ts 의 dailyBucket). raw 는 max-age=300 이다.

echo "▶ 발행 확인"
"$PY" - <<'PY'
import json, urllib.request
from datetime import datetime, timezone, timedelta
kst = datetime.now(timezone(timedelta(hours=9))).strftime('%Y-%m-%d')
url = ('https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main'
       f'/dividend-kr/dividend-kr.json?_={kst}')
with urllib.request.urlopen(url, timeout=30) as r:
    d = json.load(r)
print(f"   HTTP {r.status} · {len(d['rows']):,}종목 · {d['asOf']} 사업연도 · 수집 {d['builtAt']}")
PY

echo "✅ 완료"
