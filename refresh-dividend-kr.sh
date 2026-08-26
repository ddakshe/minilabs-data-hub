#!/usr/bin/env bash
# 국내 배당 데이터 갱신 (DART) → GitHub push.
#
# ⚠ GitHub Actions 로 옮기지 않는다. 기술적으로는 가능하지만(키가 Secrets 에 있다)
#   **순차로 40분 넘게 도는 작업**이라 CI 에 두면 얻는 것 없이 비용과 위험만 는다.
#   - 국내 배당은 사업보고서 기준이라 **3~4월에만 값이 움직인다.**
#   - DART 는 이 프로젝트에 **IP 차단을 건 적이 있다** (2026-08-25, 하루 뒤 해제).
#     초당 3건 이하로 천천히 받는 것이 유일한 방어라 시간을 줄일 수단이 없다.
#   - CI 에는 `.cache/` 가 없어 매번 전량을 새로 받는다. 로컬은 캐시가 차 있어 싸다.
#
# 사용법:
#   ./refresh-dividend-kr.sh
#   ./run-local-jobs.sh dividend-kr      # 러너를 통해 (결과가 status 에 남는다)
set -euo pipefail

cd "$(dirname "$0")"

STOCK_TOOLS="${STOCK_TOOLS:-$(cd .. && pwd)/stock-tools}"
APP="$STOCK_TOOLS/stock-dividend-kr"
PY="${PY:-python3}"

# 받아야 할 사업연도. 12월 결산 법인의 사업보고서 마감이 3/31 이라, 4월부터 작년치가 선다
TARGET=$("$PY" - <<'PY'
from datetime import datetime, timezone, timedelta
n = datetime.now(timezone(timedelta(hours=9)))
print(n.year - 1 if n.month >= 4 else n.year - 2)
PY
)
echo "▶ 대상 사업연도 $TARGET"

echo "▶ 최신 pull"
git pull --rebase --autostash origin main

# 🔴 '데이터 없음'(status 013) 캐시를 대상 연도만 비운다.
#
#    dart.py 는 013 도 캐시한다 — "다시 물어봐도 같은 답" 이라는 전제인데 **공시 시즌에는
#    틀리다.** 아직 사업보고서를 안 낸 회사가 013 을 주고, 며칠 뒤 제출하면 000 이 된다.
#    비우지 않고 다시 돌리면 캐시가 013 을 돌려줘 **늦게 낸 회사를 영영 못 잡는다.**
#    시즌에 여러 번 도는 이유가 바로 지연·정정 제출을 줍는 것이라, 이 단계가 없으면
#    두 번째 실행부터 아무 일도 하지 않는다.
#
#    000 은 건드리지 않는다. 이미 받은 것을 다시 받을 이유가 없다.
echo "▶ '데이터 없음' 캐시 비우기 (대상 연도만)"
"$PY" - "$APP" "$TARGET" <<'PY'
import json, pathlib, sys
app, year = sys.argv[1], sys.argv[2]
d = pathlib.Path(app) / '.cache' / 'alotMatter'
n = 0
for f in d.glob(f'*bsns_year-{year}_*.json') if d.exists() else []:
    try:
        if json.loads(f.read_text()).get('status') == '013':
            f.unlink(); n += 1
    except Exception:
        f.unlink(); n += 1        # 깨진 캐시도 지운다 — 다음 실행이 다시 받는다
print(f'   {n:,}건 비움 (다음 실행에서 다시 물어본다)')
PY

echo "▶ 수집 (DART — 순차 · 초당 3건 이하)"
"$PY" "$APP/scripts/collect.py"

# 🔴 연도 가드. collect.py 의 LATEST/PAST 가 **하드코딩**이라 해가 바뀌면 손으로 올려야 한다.
#    안 올리면 캐시가 다 차 있어 몇 초 만에 끝나고 **작년과 같은 파일**이 나온다 —
#    성공한 것처럼 보이므로 여기서 잡지 않으면 아무도 눈치채지 못한다.
ASOF=$("$PY" -c "import json,sys;print(json.load(open(sys.argv[1]))['asOf'])" "$APP/data/dividend-kr.json")
if [ "$ASOF" != "$TARGET" ]; then
  echo
  echo "🔴 수집 결과가 $ASOF 사업연도다. $TARGET 을 기대했다."
  echo "   $APP/scripts/collect.py 의 연도를 올려야 한다:"
  echo "     LATEST = $TARGET"
  echo "     PAST   = ($((TARGET-3)), $((TARGET-6)), $((TARGET-9)))"
  echo "   허브에 올리지 않고 멈춘다."
  exit 1
fi

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
git commit -m "chore(dividend-kr): 국내 배당 데이터 갱신 ($TARGET 사업연도 · $DATE_KST KST)"
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
