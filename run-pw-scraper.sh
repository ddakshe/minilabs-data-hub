#!/bin/bash
# Playwright 스크래퍼 실행 → 커밋 → 푸시
# 사용법:
#   ./run-pw-scraper.sh           # 전체 11개
#   ./run-pw-scraper.sh kbo       # 특정 카테고리만

set -e
cd "$(dirname "$0")"

echo "▶ Playwright 스크래핑 시작..."
node scripts/fetch-rankings-pw.mjs "$@"

# 변경사항 확인
if git diff --quiet rankings/; then
  echo "✓ 변경사항 없음 — 푸시 스킵"
  exit 0
fi

echo ""
echo "▶ 변경사항 커밋 & 푸시..."
git add rankings/
git commit -m "data: Playwright 스크래핑 갱신 $(date +%Y-%m-%d)"
git push

echo ""
echo "✓ 완료! jsDelivr CDN에 수 분 내 반영됩니다."
