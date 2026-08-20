# LOCAL_JOBS — 로컬에서 돌려야 하는 작업

> **이 저장소에는 GitHub Actions 로 옮길 수 없는 작업이 있다.**
> 기계를 바꾸거나 한동안 손을 놨다면 이 파일부터 확인할 것.
> CI 가 도는 나머지 작업은 `.github/workflows/` 에 있다.

**형식은 프로젝트 간에 동일하다.** 다른 저장소에도 같은 이름의 `LOCAL_JOBS.md` 를 두고,
작업마다 아래 `yaml` 블록을 하나씩 넣는다. 나중에 여러 저장소를 한 번에 훑을 수 있게 하려는 것이다.

| # | 작업 | 주기 | 실행 | 로컬인 이유 |
|---|---|---|---|---|
| 1 | 인증중고차(BMW·포르쉐) | **⏸ 중단** | `./refresh-cpo.sh` | GUI 브라우저 · 봇 차단 |
| 2 | OTT 순위(라프텔·티빙) | 수·목 10시 | `./refresh-ott.sh` | 한국 IP 필요 |
| 3 | 레버리지 데이터 | 평일 08:10 | `./refresh-lever.sh` | 토스 허용 IP 등록 |

---

## 1. 인증중고차 — BMW · 포르쉐

```yaml
id: cpo
repo: minilabs-data-hub
command: ./refresh-cpo.sh
schedule: on-demand        # ⏸ 2026-08-20 중단 — 아래 사유
prefer_time: "10:00 KST"
reason: gui-browser, bot-block
outputs: cpo/listings.json
consumers: [cpo-mini]
```

### ⏸ 2026-08-20 중단

앱인토스가 **"인증중고차 정보 제공 서비스" 자체의 출시를 한시적으로 제한**했다.
수수료 모델을 검토 중이며 단계적으로 오픈할 예정이라고 하지만, **재개 알림은 받을 수 없다.**
앱 내용 문제가 아니라 카테고리 정책이므로 앱을 고쳐도 달라지지 않는다.

소비 앱(cpo-mini)이 출시되지 못하는 동안:

- **CI(8개 브랜드)도 스케줄을 껐다** — `.github/workflows/fetch-cpo.yml`.
  매일 1.3MB diff 를 커밋할 이유가 없고, 되살리는 비용이 12초라 미리 신선하게 둘 값이 없다.
- **이 작업(BMW·포르쉐)은 `on-demand`** — 자동으로 잡히지 않는다.

**재개 절차** (카테고리가 열리면):

1. `schedule: on-demand` → `daily` 로 되돌린다
2. `.github/workflows/fetch-cpo.yml` 의 `schedule` 두 줄 주석을 푼다
3. `./run-local-jobs.sh cpo` 를 한 번 돌려 BMW·포르쉐를 채운다
4. 앱에서 `npm run build && npm run preview && npm run screenshot` 로 스크린샷을 다시 찍는다
   (데이터가 바뀌었을 테니 제출물도 새로 찍어야 한다)

- **10시에 부르는 이유**: CI 가 09:20 KST 에 8개 브랜드를 올린다. 그 뒤에 돌리면
  이 스크립트의 첫 단계(`git pull --rebase`)가 CI 커밋을 흡수한 뒤 작업하므로
  push 거부가 구조적으로 생기지 않는다. 반대 순서면 충돌을 사람이 풀어야 한다.
- **덤으로 감시가 된다**: CI 직후에 돌리므로 스크립트 마지막의 신선도 점검이
  8개 브랜드까지 함께 확인해 준다. CI 가 조용히 실패하면 그날 바로 경고가 뜬다.

- **왜 로컬인가**: BMW·MINI 는 실제 Chrome + headed 가 필수다(번들 Chromium 은 조용히 0건).
  포르쉐는 Vercel 봇 챌린지가 Actions 데이터센터 IP 를 막는다.
- **주의**: BMW 는 headed 라 실행 중 Chrome 창이 5분 남짓 뜬다. **로그인된 GUI 세션에서만** 동작한다.
  창을 닫거나 화면을 잠그면 멈춘다.
- **BMW 는 400건 상한**이 걸려 있다(전체 약 1,350건). 렌더러 메모리 벽 때문이며 상한을 올리면
  264~756장 사이에서 응답이 멈춘다(지점이 실행마다 다르다) — `cpo/README.md` 참고.
- ⚠ **한 번 54분이 걸린 적이 있다.** 벽에 부딪힌 뒤 클릭이 간헐적으로 성공하면 정체 카운터가
  0으로 리셋돼서 "5회 연속 실패" 조건에 영원히 닿지 못했다. 지금은 **8분 데드라인**으로 자른다
  (`BMW_DEADLINE_MS`). 정체 카운터만으로는 이 폭주를 막을 수 없다.
- **BMW 는 병합하지 않는다.** 매 실행에서 실제로 본 것만 남긴다 — 예전엔 부분 수집이면
  기존과 합쳤는데, BMW 는 전량에 도달할 수 없어 **항상** 병합 모드였고 팔린 매물이 영구히
  남았다. 더 많이 받고 싶으면 `BMW_MAX_ITEMS` 를 올린다(7.4초/클릭 → 600건 약 6분).
- 나머지 8개 브랜드(현대·제네시스·기아·벤츠·볼보·렉서스·아우디·토요타)는 CI 가 매일 돌린다.
- **실패 신호** — ⚠ 건수로 판단하면 안 된다. 스크래퍼는 실패 시 **직전 데이터를 유지**하고
  부분 수집이면 병합하므로 `byBrand` 가 0이 되지 않는다. 실측 로그가
  `bmw: 실패 → 기존 데이터 유지`, `부분 수집 → 300 + 144 → 300건` 이었다.
  즉 **건수가 그대로인 것**이 실패 신호다. 볼 곳은 두 군데다:
  - `cpo/listings.json` 의 `brands.<브랜드>.updatedAt` 이 오늘 날짜로 바뀌었는지
  - 최상위 `failed` 배열에 브랜드가 들어갔는지

## 2. OTT 순위 — 라프텔 · 티빙

```yaml
id: ott
repo: minilabs-data-hub
command: ./refresh-ott.sh
schedule: "0 10 * * 3,4"
reason: region-ip
outputs: ott/
consumers: [ott-mini]
```

- **왜 로컬인가**: Actions 는 미국 IP 라 넷플릭스·웨이브·디즈니만 된다.
  라프텔·티빙은 **한국 IP** 에서만 응답한다.
- CI(`0 0 * * 3,4` = 수·목 09:00 KST)가 3개를 갱신하고, 나머지 2개를 이걸로 채운다.
  넷플릭스 주간 갱신이 화요일(US)이라 수·목 KST 사이에 반영된다.
- **주기를 `weekly-2` 에서 명시적 cron 으로 바꿨다.** 러너의 `weekly` 분기는 접미사(`-2`)를
  파싱하지 않고 수·목을 하드코딩한다 — 값이 맞아 보이지만 `weekly-5` 라 써도 똑같이 동작한다.
  cron 식은 러너가 실제로 요일을 읽는다.
- **10시인 이유**: cpo 와 같다. CI(09:00) 뒤에 돌려야 `git pull --rebase` 가 CI 커밋을
  흡수한 뒤 작업한다.
- **실패 신호**: 라프텔·티빙 섹션이 비거나 갱신일이 밀림.
- ⚠ **예전에 LaunchAgent 로도 돌고 있었다** (`com.minilabs.refresh-ott`, 매일 06:00).
  러너와 이중 실행이 되고 문서의 "주 2회" 와도 맞지 않아 내렸다
  (`~/Library/LaunchAgents/com.minilabs.refresh-ott.plist.disabled`).
  **로컬 작업은 이제 전부 이 러너 한 곳을 지난다.**

## 3. 레버리지 데이터

```yaml
id: lever
repo: minilabs-data-hub
command: ./refresh-lever.sh
schedule: "10 8 * * 1-5"
reason: ip-allowlist
outputs: lever/lever.json
consumers: [stock-lever-mini]
batch: ../stock-tools/scripts/lever_batch.py
credentials: ~/.config/stock-tools/toss.env
```

- **왜 로컬인가**: 토스증권 Open API 는 **허용 IP 사전 등록**이 필수다.
  미등록 IP 는 `/oauth2/token` 단계에서 403 `IP address not allowed` — 토큰조차 못 받는다.
  Actions·Vercel 등은 아웃바운드 IP 가 유동이라 등록 자체가 불가능하다.
- **08:10 KST 인 이유**: 미국 정규장이 KST 05:00(서머타임 06:00) 마감이라
  그 시각이면 한국·미국 양쪽 전일 종가가 모두 확정된다.
- **필요한 것**
  - 키: `~/.config/stock-tools/toss.env` (`chmod 600`, 저장소 밖)
  - 이 기계의 **공인 IP** 가 WTS > 설정 > Open API > 허용 IP 에 등록돼 있을 것
  - VPN·iCloud 비공개 릴레이가 켜져 있으면 출구 IP 가 바뀌어 403 이 난다
- **실패 신호**: 로그에 `403 IP address not allowed` 또는 `환율 조회 실패`.
  후자는 대개 토큰 만료인데 클라이언트가 자동 재발급하므로, 계속 나면 키를 의심할 것.
- **안 돌리면**: 앱의 기준일이 멈춘다. 화면이 깨지지는 않지만
  `BRAND.md` 원칙 3 대로 "갱신 준비 중" 으로 물러서야 하는 상태가 된다.

---

## 실행 방법

**cron 을 쓰지 않는다.** Claude 스킬 `daily-jobs` 로 부른다.

```bash
./run-local-jobs.sh            # 오늘 주기에 해당하고, 아직 안 돌린 것
./run-local-jobs.sh cpo        # 특정 작업만
./run-local-jobs.sh --force    # 오늘 이미 성공한 것도 다시
./run-local-jobs.sh --list     # 목록만
```

### 왜 cron 이 아닌가

**macOS cron 은 백그라운드 세션에서 돌아 headed Chrome 이 화면에 붙지 못한다.**
1번(BMW)이 여기서 죽는다. LaunchAgent(Aqua 세션)면 되지만, 그러면 다른 문제가 생긴다 —
cron·launchd 는 **조용히 죽고** 실패를 알려주지 않는다. 특히 3번은 공인 IP 가 바뀌면
(공유기 재부팅·ISP 갱신·VPN) 먼저 죽는데, 며칠 뒤에나 알게 된다.

스킬로 부르면 사람이 그 자리에서 결과를 보고, 실패 원인을 바로 판단할 수 있다.
대신 **부르는 걸 잊으면 안 돈다** — 1번은 3일 넘기면 앱에서 BMW·포르쉐가 사라진다.

### 같은 날 두 번 불러도 안전하다

러너가 `local-jobs-status.json` 의 `ranAt` 을 보고 **오늘 이미 성공한 작업은 건너뛴다.**
(사람이 부르는 방식이라 필요하다. cron 은 하루 한 번이라 이 문제가 없었다.)
다시 돌리려면 `--force` 또는 id 를 직접 지목한다.
