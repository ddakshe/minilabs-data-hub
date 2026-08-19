#!/usr/bin/env bash
# 인증중고차 로컬 갱신 → GitHub push.
# BMW·MINI·포르쉐는 GitHub Actions에서 데이터가 오지 않아 이 스크립트로 갱신한다:
#   BMW·MINI — 실제 Chrome + headed 필수(번들 Chromium은 조용히 0건).
#   포르쉐   — Vercel 봇 챌린지가 Actions 데이터센터 IP를 막는다(로컬 IP는 통과).
# 나머지 8개 브랜드(현대·제네시스·기아·벤츠·볼보·렉서스·아우디·토요타)는 CI가 매일 돌린다.
#
# ⚠ BMW는 headed라 실행 중 Chrome 창이 5분 남짓 뜬다. 로그인된 GUI 세션에서만 동작한다.
#   창을 닫거나 화면을 잠그면 수집이 멈춘다(부분 수집으로 기존 데이터와 병합된다).
#
# ⚠ BMW는 700건 상한이 걸려 있다(전체 1,339건). 렌더러 메모리 벽 때문이며
#   상한을 올리면 400~750장 사이에서 응답이 멈춘다 — cpo/README.md 참고.
#
# 사용법:
#   ./refresh-cpo.sh                 # bmw,porsche (기본)
#   ./refresh-cpo.sh bmw             # 특정 브랜드만
#   BMW_MAX_ITEMS=400 ./refresh-cpo.sh   # BMW 상한(기본 700)을 낮춰 더 안전하게
set -euo pipefail

# cd 가 중요하다 — playwright 가 이 저장소의 node_modules 에 있어서
# 다른 디렉터리에서 실행하면 ERR_MODULE_NOT_FOUND 로 죽는다.
cd "$(dirname "$0")"

BRANDS="${1:-bmw,porsche}"

echo "▶ 최신 pull (CI가 올린 커밋과 충돌 방지)"
git pull --rebase --autostash origin main

echo "▶ 스크래핑: $BRANDS"
node scripts/fetch-cpo-pw.mjs "$BRANDS"

echo "▶ cpo/ 변경 확인"
git add cpo/
if git diff --cached --quiet -- cpo/; then
  echo "· 변경 없음 — push 생략"
  exit 0
fi

git --no-pager diff --cached --stat -- cpo/
DATE_KST=$(TZ=Asia/Seoul date "+%Y-%m-%d %H:%M")
git commit -m "chore(cpo): local refresh ($BRANDS, $DATE_KST KST)"
git push origin main

echo "▶ jsDelivr 캐시 purge (즉시 반영)"
curl -s -o /dev/null "https://purge.jsdelivr.net/gh/ddakshe/minilabs-data-hub@main/cpo/listings.json" || true

echo "✅ 완료"
node -e "const d=require('./cpo/listings.json');console.log('   총',d.total,'건 —',Object.entries(d.byBrand).sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+' '+v).join(' · '))"
