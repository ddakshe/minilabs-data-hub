#!/usr/bin/env bash
# OTT 순위 로컬 갱신 → GitHub push (한국 IP에서 실행: 라프텔·티빙 포함 5개 전부 성공).
# GitHub Actions(수·목)는 미국 IP라 넷플릭스·웨이브·디즈니만 되므로, 라프텔·티빙은 이걸로 갱신.
# 앱은 GitHub(jsDelivr)에서 읽으니 push만 되면 재배포 없이 반영됨.
set -euo pipefail

cd "$(dirname "$0")"

echo "▶ 최신 pull (CI가 올린 커밋과 충돌 방지)"
git pull --rebase --autostash origin main

echo "▶ 스크래핑"
node scripts/fetch-ott.mjs

echo "▶ ott/ 변경 확인"
git add ott/
if git diff --cached --quiet -- ott/; then
  echo "· 변경 없음 — push 생략"
  exit 0
fi

git --no-pager diff --cached --stat -- ott/
DATE_KST=$(TZ=Asia/Seoul date "+%Y-%m-%d %H:%M")
git commit -m "chore(ott): local refresh ($DATE_KST KST)"
git push origin main

echo "▶ jsDelivr 캐시 purge (즉시 반영)"
for s in netflix disney tving wavve laftel coupang; do
  curl -s -o /dev/null "https://purge.jsdelivr.net/gh/ddakshe/minilabs-data-hub@main/ott/$s.json" || true
done
echo "✓ push + purge 완료 → 앱 즉시 최신화 (재배포 불필요)"
