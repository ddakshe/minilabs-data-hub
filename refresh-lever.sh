#!/usr/bin/env bash
# 레버리지 성적표 데이터 갱신 → GitHub push.
#
# ⚠ GitHub Actions 로 옮길 수 없다. 토스증권 Open API 는 **허용 IP 사전 등록**이 필수라
#   Actions 의 유동 IP 에서는 /oauth2/token 단계에서 403 이 난다.
#   그래서 허용 IP 로 등록된 이 기계에서만 돈다 (README '토스 API' 항목 참고).
#
# ⚠ 공인 IP 가 바뀌면(공유기 재부팅·ISP 갱신·VPN) 조용히 403 으로 죽는다.
#   cron 에 걸 때는 로그를 남기고 실패를 확인할 것.
#
# 사용법:
#   ./refresh-lever.sh
#   cron 예시 (평일 08:10 KST — 미국 전일 종가가 확정된 뒤):
#     10 8 * * 1-5 /Users/kyungtaekim/ClaudeProjects/minilabs-data-hub/refresh-lever.sh >> /tmp/lever.log 2>&1
set -euo pipefail

cd "$(dirname "$0")"

STOCK_TOOLS="${STOCK_TOOLS:-$(cd .. && pwd)/stock-tools}"
PY="${PY:-python3}"

echo "▶ 최신 pull"
git pull --rebase --autostash origin main

echo "▶ 배치 실행 (토스 API — 허용 IP 필요)"
"$PY" "$STOCK_TOOLS/scripts/lever_batch.py"

echo "▶ lever/ 변경 확인"
git add lever/
if git diff --cached --quiet -- lever/; then
  echo "· 변경 없음 — push 생략"
  exit 0
fi

git --no-pager diff --cached --stat -- lever/
DATE_KST=$(TZ=Asia/Seoul date "+%Y-%m-%d %H:%M")
git commit -m "chore(lever): 레버리지 데이터 갱신 ($DATE_KST KST)"
git push origin main

echo "▶ jsDelivr 캐시 purge (즉시 반영)"
curl -s -o /dev/null "https://purge.jsdelivr.net/gh/ddakshe/minilabs-data-hub@main/lever/lever.json" || true

echo "✅ 완료"
"$PY" - <<'PY'
import json
d = json.load(open('lever/lever.json'))
print(f"   {len(d['pairs'])}짝 · 기준일 {d['baseDate']} · 환율 {d['usdKrw']}")
PY
