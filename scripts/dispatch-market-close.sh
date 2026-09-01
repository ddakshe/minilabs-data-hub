#!/usr/bin/env bash
# 장마감 리포트를 **필요할 때만** 돌린다. launchd 가 평일 09:30~14:00 에 30분마다 부른다.
#
# 정해진 시각에 세 번 찍는 대신 이 구조를 쓰는 이유:
#   공개 시각이 날마다 흔들린다 (실측: 08-28 은 09:39~10:53, 09-01 은 10:35~10:40).
#   고정 시각은 이른 날엔 한 시간을 놀리고 늦은 날엔 놓친다.
#   30분마다 **싼 판정**(호출 1~3회)만 하고, 새 기준일이 있을 때만 무거운 파이프라인을 부른다.
#   한 번 성공하면 그날 나머지 호출은 판정에서 바로 멈춘다.
set -uo pipefail
cd "$(dirname "$0")/.."

LOG="${DISPATCH_LOG:-$HOME/Library/Logs/minilabs-dispatch.log}"
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S%z')" "$*" >> "$LOG"; }

# 허브 데이터가 낡아 있으면 '이미 만든 기준일'을 잘못 읽는다. 먼저 맞춘다.
git fetch --quiet origin main 2>/dev/null && git merge --ff-only --quiet origin/main 2>/dev/null

VERDICT=$(node scripts/market-close-due.mjs 2>&1); RC=$?
case $RC in
  0) log "[market-close] $VERDICT"; exec ./scripts/dispatch-workflow.sh fetch-market-close.yml "launchd 게이트 통과" ;;
  1) log "[market-close] $VERDICT"; exit 0 ;;
  *) log "[market-close] 판정 실패: $VERDICT"; exit 1 ;;
esac
