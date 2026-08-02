#!/bin/bash
# 로컬(한국 IP) 주간 스크랩 — launchd에서 호출.
# 3사 전부(CU·GS25·세븐일레븐) 긁어 convenience-events/products.json만 commit/push.
# 세븐일레븐은 해외 IP 차단 때문에 GitHub Actions로는 못 긁으므로 이 로컬 잡이 담당한다.
set -u

REPO="/Users/kyungtaekim/ClaudeProjects/minilabs-data-hub"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# nvm 환경에서 node 로드 (버전 바뀌어도 default 사용)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

cd "$REPO" || { echo "repo 없음: $REPO"; exit 1; }
echo "===== $(TZ=Asia/Seoul date '+%Y-%m-%d %H:%M:%S KST') 로컬 주간 스크랩 ====="

# 최신 동기화 (WIP는 autostash로 보존, 충돌나면 중단)
git pull --rebase --autostash origin main || { echo "pull 실패 — 중단"; exit 1; }

# 3사 전부 스크랩
node scripts/fetch-convenience-events.mjs || { echo "스크랩 실패 — 중단"; exit 1; }

# 변경 시에만 convenience-events/products.json만 커밋 (다른 WIP는 건드리지 않음)
if git diff --quiet -- convenience-events/products.json; then
  echo "변경 없음 — 커밋 생략"
  exit 0
fi
git add convenience-events/products.json
git commit -m "chore(convenience-events): local weekly refresh ($(TZ=Asia/Seoul date '+%Y-%m-%d'))"
# 스크랩에 수 분이 걸려 그 사이 다른 잡이 push했을 수 있다 → rebase 후 재시도.
for attempt in 1 2 3; do
  if git push origin main; then
    echo "✓ push 완료 (시도 $attempt)"
    exit 0
  fi
  echo "push 거부됨 (시도 $attempt) — rebase 후 재시도"
  git pull --rebase --autostash origin main || { echo "rebase 실패 — 중단"; exit 1; }
  sleep 5
done
echo "push 실패 — 3회 시도 모두 거부"
exit 1
