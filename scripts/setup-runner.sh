#!/usr/bin/env bash
# 셀프호스티드 러너 등록 — 새 맥에서 한 번 돌린다.
#
#   curl -fsSL https://raw.githubusercontent.com/ddakshe/minilabs-data-hub/main/scripts/setup-runner.sh | bash -s -- <저장소> [러너이름]
#   ./setup-runner.sh ddakshe/minilabs-data-hub mac-거실
#
# ── 왜 이 스크립트가 필요한가 ────────────────────────────────────────────────
# 국내 기관 API(토스·한국은행·소비자원·라프텔·티빙)가 **해외 IP 를 막는다.**
# GitHub 호스티드 러너는 아웃바운드 IP 가 유동이라 허용 목록에 등록할 수도 없다.
# 그래서 한국에 있는 이 맥에서 도는 러너가 필요하다. (docs 의 IP 차단 실측 참고)
#
# ⚠ 러너는 **저장소마다 따로** 등록한다. 개인 계정(Organization 이 아님)은
#   계정 레벨 러너를 둘 수 없다. 여러 저장소에 붙이려면 각각 이 스크립트를 돌린다.
set -euo pipefail

REPO="${1:-}"
NAME="${2:-mac-$(hostname -s | tr '[:upper:]' '[:lower:]')}"
DIR="${RUNNER_DIR:-$HOME/actions-runner}"

if [ -z "$REPO" ]; then
  echo "사용법: $0 <owner/repo> [러너이름]" >&2
  echo "예:    $0 ddakshe/minilabs-data-hub mac-거실" >&2
  exit 1
fi

say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m🔴 %s\033[0m\n' "$*" >&2; exit 1; }

# ── 0. 선행 조건 ────────────────────────────────────────────────────────────
say "선행 조건 확인"
[ "$(uname -s)" = "Darwin" ] || die "macOS 전용이다 (현재: $(uname -s))"
command -v gh >/dev/null || die "gh CLI 가 필요하다: brew install gh"
gh auth status >/dev/null 2>&1 || die "gh 로그인이 필요하다: gh auth login"
gh repo view "$REPO" >/dev/null 2>&1 || die "저장소에 접근할 수 없다: $REPO"
echo "  gh 로그인: $(gh api user --jq .login)"
echo "  대상 저장소: $REPO"
echo "  러너 이름: $NAME"

ARCH=$([ "$(uname -m)" = "arm64" ] && echo arm64 || echo x64)
echo "  아키텍처: osx-$ARCH"

# 같은 이름이 이미 있으면 멈춘다 — 덮어쓰면 기존 러너가 조용히 죽는다
if gh api "repos/$REPO/actions/runners" --jq '.runners[].name' 2>/dev/null | grep -qx "$NAME"; then
  die "'$NAME' 이 이미 $REPO 에 등록돼 있다. 다른 이름을 쓰거나 먼저 제거할 것."
fi

# ── 1. 러너 내려받기 ────────────────────────────────────────────────────────
if [ -f "$DIR/config.sh" ]; then
  say "러너가 이미 있다 — 내려받기 건너뜀 ($DIR)"
  # ⚠ 한 디렉터리는 한 저장소에만 붙는다. 다른 저장소용이면 RUNNER_DIR 를 달리 준다.
  if [ -f "$DIR/.runner" ]; then
    # ⚠ .runner 는 **UTF-8 BOM** 으로 쓰인다(러너가 그렇게 만든다). 그냥 json.load 하면
    #   `Unexpected UTF-8 BOM` 으로 죽고, 그러면 여기가 '?' 가 되어 엉뚱한 이유로 멈춘다.
    CUR=$(/usr/bin/python3 -c "import json;print(json.load(open('$DIR/.runner',encoding='utf-8-sig'))['gitHubUrl'])" 2>/dev/null || echo '?')
    echo "  현재 붙어 있는 곳: $CUR"
    case "$CUR" in *"$REPO") ;; *)
      die "이 디렉터리는 다른 저장소($CUR)에 붙어 있다. RUNNER_DIR=~/actions-runner-2 처럼 따로 줄 것." ;;
    esac
  fi
else
  say "러너 내려받기"
  VER=$(gh api repos/actions/runner/releases/latest --jq .tag_name | sed 's/^v//')
  echo "  버전 $VER"
  mkdir -p "$DIR" && cd "$DIR"
  TAR="actions-runner-osx-$ARCH-$VER.tar.gz"
  curl -fsSL -o "$TAR" "https://github.com/actions/runner/releases/download/v$VER/$TAR"
  tar xzf "$TAR" && rm -f "$TAR"
fi
cd "$DIR"

# ── 2. 등록 ─────────────────────────────────────────────────────────────────
say "등록 토큰 발급 (1시간짜리 · 로그에 찍지 않는다)"
TOKEN=$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)
[ -n "$TOKEN" ] || die "등록 토큰을 받지 못했다"

say "러너 설정"
# 라벨은 기본(self-hosted, macOS, ARM64)에 더하지 않는다 — 워크플로가 그 셋으로 고른다.
./config.sh --unattended --replace \
  --url "https://github.com/$REPO" \
  --token "$TOKEN" \
  --name "$NAME" \
  --work _work
unset TOKEN

# ── 3. 서비스 등록 ──────────────────────────────────────────────────────────
say "LaunchAgent 로 서비스 등록"
# 🔴 **cron 이나 launchd 데몬이 아니라 LaunchAgent 여야 한다.**
#    svc.sh 가 UserName + SessionCreate 를 넣어 **Aqua(로그인) 세션**에 붙인다.
#    그래야 headed Chrome 이 화면에 뜬다 — 백그라운드 세션에서는 조용히 0건이 된다.
./svc.sh install
./svc.sh start

# ── 4. 확인 ─────────────────────────────────────────────────────────────────
say "확인"
sleep 3
gh api "repos/$REPO/actions/runners" \
  --jq '.runners[] | "  \(.name)  \(.status)  labels=\([.labels[].name]|join(","))"'

cat <<'NOTE'

✅ 등록 완료.

── 이 러너에서만 나타나는 실패 방식 (알아두면 원인 찾기가 빠르다) ─────────────

1. 🔴 **osxkeychain 에 닿지 못한다.**
   LaunchAgent 라 워크플로 안에서 `git clone` 으로 비공개 저장소를 받으면
   `could not read Username for 'https://github.com': Device not configured` 로 죽는다.
   → 우회: 이 기계의 기존 클론에서 `git archive origin/master` 로 스냅샷을 꺼낸다.
     (fetch-lever.yml · fetch-dividend-labels.yml 에 그 방식이 들어 있다)

2. **PATH 가 launchd 기본값이다.** anaconda·pyenv·nvm 이 없다.
   → 파이썬은 `/usr/bin/python3` 을 명시할 것 (3.9.x). Node 는 setup-node 액션을 쓴다.

3. ⚠ **맥이 꺼져 있으면 스케줄이 큐에 걸린 채 안 돈다.**
   깨어나면 돌지만 시각은 보장되지 않는다. 이건 "실패" 로 잡히지 않고 **"지연"으로만
   보인다** — 대시보드에서 실패 0인데 지연이 늘면 이걸 의심할 것.
   상시 가동하려면: sudo pmset -c sleep 0 disablesleep 1

4. **자격증명은 저장소 밖에 둔다.** `~/.config/stock-tools/*.env` (chmod 600).
   러너가 같은 사용자로 돌기 때문에 그대로 읽힌다. Secrets 로 올리지 않는다.
   새 맥이라면 이 파일들을 옮겨야 한다: toss.env · dart.env · ecos.env

5. ⚠ **공개 저장소에 셀프호스티드 러너는 GitHub 권장 사항이 아니다.**
   포크에서 온 PR 워크플로가 이 기계에서 돌 수 있다. 포크·협업자를 확인할 것.

── 다루기 ──────────────────────────────────────────────────────────────
  ~/actions-runner/svc.sh status | stop | start
  gh api repos/<owner>/<repo>/actions/runners --jq '.runners[].name'
  제거: ./svc.sh uninstall && ./config.sh remove --token $(gh api -X POST repos/<owner>/<repo>/actions/runners/remove-token --jq .token)
NOTE
