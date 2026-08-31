#!/usr/bin/env bash
# GitHub 예약(schedule)을 대신해 워크플로를 밀어 넣는다.
#
# 왜 필요한가 — GitHub 의 schedule 은 이 저장소에서 **대량으로 유실된다.**
# 2026-08-31 실측: 예상 39회 중 13회만 실행(유실 67%). 특히 고빈도 cron 이 심하다.
# build-wanted 는 '*/30'(하루 48회)인데 하루 2~6회만 떴고, 간격도 3~6시간이었다.
# 취소 이력은 0 건이다 — 실행이 취소되는 게 아니라 **애초에 만들어지지 않는다.**
#
# 대상 워크플로는 모두 이 맥의 셀프호스티드 러너에서 돈다. 맥이 꺼져 있으면
# GitHub 예약이 떠도 어차피 실행되지 않으므로, 여기서 미는 것이 손해가 아니다.
#
#   ./scripts/dispatch-workflow.sh fetch-market-close.yml "정규 수집"
#
# launchd 등록은 LOCAL_JOBS.md 참고.
set -uo pipefail

WF="${1:?워크플로 파일명이 필요하다 (예: build-wanted.yml)}"
REASON="${2:-launchd dispatch}"
REPO="ddakshe/minilabs-data-hub"
GH="${GH_BIN:-/opt/homebrew/bin/gh}"
LOG="${DISPATCH_LOG:-$HOME/Library/Logs/minilabs-dispatch.log}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S%z')" "$*" >> "$LOG"; }

[ -x "$GH" ] || { log "[$WF] gh 없음: $GH"; exit 127; }

# 이미 도는 중이면 굳이 밀지 않는다. 워크플로의 concurrency 가 직렬화해 주지만
# 대기열을 늘려 봐야 얻는 것이 없다.
RUNNING=$("$GH" run list --repo "$REPO" --workflow "$WF" --status in_progress --limit 1 --json databaseId -q 'length' 2>/dev/null || echo 0)
if [ "${RUNNING:-0}" != "0" ]; then
  log "[$WF] 이미 실행 중 — 건너뛴다"
  exit 0
fi

if OUT=$("$GH" workflow run "$WF" --repo "$REPO" 2>&1); then
  log "[$WF] 디스패치 ($REASON)"
else
  # -f reason 을 받지 않는 워크플로도 있으므로 입력 없이 한 번 더 시도하지 않는다.
  log "[$WF] 실패: $OUT"
  exit 1
fi
