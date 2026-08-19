#!/usr/bin/env bash
# 로컬 전용 작업들의 단일 진입점.
#
# CI 로 옮길 수 없는 작업(허용 IP·한국 IP·GUI 브라우저)이 저장소마다 흩어져 있어서
# cron 줄이 작업 수만큼 늘어나고, 어느 게 언제 실패했는지 알 방법이 없었다.
# 이 스크립트가 LOCAL_JOBS.md 들을 읽어 한 번에 돌리고 **결과를 파일로 남긴다.**
#
#   ./run-local-jobs.sh              # 오늘 돌려야 하는 것 전부
#   ./run-local-jobs.sh lever        # 특정 작업만
#   ./run-local-jobs.sh --list       # 목록만 보기
#   ./run-local-jobs.sh --force      # 오늘 이미 성공한 것도 다시
#   ./run-local-jobs.sh --all        # 주기 무시하고 전부
#
# cron 은 한 줄이면 된다:
#   10 8 * * * /Users/kyungtaekim/ClaudeProjects/minilabs-data-hub/run-local-jobs.sh >> /tmp/local-jobs.log 2>&1
set -uo pipefail
cd "$(dirname "$0")"
exec python3 scripts/run_local_jobs.py "$@"
