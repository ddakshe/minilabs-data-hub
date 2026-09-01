# API 예산 — 어느 워크플로가 어느 한도를 먹는가

> 🤖 **자동 생성이다. 손으로 고치지 말 것** — `node scripts/api-registry.mjs` 가 다시 쓴다.
> 한도·호출량은 `docs/api-limits.json` 에서 고친다. 워크플로 목록과 주기는 스캔 결과다.

**새 배치를 붙이기 전에 여기서 남은 한도를 확인한다.** 한도를 넘기면 그 키를 쓰는
형제 앱이 **같이 멈춘다.**

## DART_API_KEY

- **금융감독원 DART 오픈API** · 한도 **20,000건/일**
- 범위: 키 단위 — 이 키를 쓰는 모든 워크플로가 **나눠 쓴다**
- 🚨 동시 요청 금지. 2026-08-25 동시 4개로 긁다가 IP 차단(하루). 순차 + SLEEP 0.3 을 지킨다.

| 워크플로 | 주기(회/일) | 콜/회 | 평균/일 | 비고 |
|---|---:|---:|---:|---|
| `build-wanted.yml` | 수동 | 5 | 5 | 신청 종목만 — 대개 0~5 |
| `fetch-dividend-kr.yml` | 0 | 4,000 | 22 | 🖥 러너 파일 · 🖥 러너의 ~/.config/stock-tools/dart.env 를 읽는다. 연 2회(4·5월)만 돈다 |
| `fetch-market-close.yml` | 0.4 | 60 | 26 | 종목당 공시 1콜 · ABS_MAX_CALLS 로 상한 |
| `fetch-stock-ipo.yml` | 1 | 40 | 40 | list.json 페이지 순회 |
| `probe-dividend-kr.yml` | 수동 | 250 | 250 | 수동 실행 프로브 |
| `fetch-company-info.yml` | 예정 | 3,800 | — | 📋 **예정** · 🖥 러너 파일 · 전 종목 6콜 = 15,192 을 **4일에 나눠** 돈다(633종목/일). 한 번에 돌리면 한도의 76% 를 먹어 형제 앱이 막힌다 |
| **합계** | | | **342** | 🟢 평균은 한도의 **2%** |

> **최대 1회 소모 4,000건 (한도의 20%).** 한도를 깨는 것은
> 평균이 아니라 **버스트**다 — 무거운 배치가 도는 날은 같은 키를 쓰는 다른
> 워크플로와 부딪힌다. 큰 배치는 날짜를 겹치지 않게 두거나 나눠 돌린다.

## DATA_GO_KR_KEY

- **공공데이터포털 (data.go.kr)** · 한도 **10,000건/일**
- 범위: **활용신청(데이터셋) 단위**로 각 10,000. 서로 다른 데이터셋이면 한도가 별개다 — 이 표의 합계는 최악을 가정한 것이고, 실제로는 데이터셋별로 나뉜다.
- 🚨 일반 인증키는 이미 URL 인코딩돼 있다. 다시 인코딩하면 403 SERVICE_KEY_IS_NOT_REGISTERED.

| 워크플로 | 주기(회/일) | 콜/회 | 평균/일 | 비고 |
|---|---:|---:|---:|---|
| `build-wanted.yml` | 수동 | 5 | 5 | 주식시세정보 |
| `fetch-benefit-gauge.yml` | 0.1 | 60 | 8.6 | 보조금24 |
| `fetch-local-currency.yml` | 1 | 400 | 400 | 지역화폐 가맹점 |
| `fetch-market-close.yml` | 0.4 | 24 | 10 | 주식시세정보 · 프리셋 20 + 지수 2 |
| `fetch-realestate.yml` | 0.3 | 300 | 86 | 국토부 실거래가 |
| `probe-realestate.yml` | 수동 | 20 | 20 | 국토부 실거래가 |
| `fetch-company-info.yml` | 예정 | 2,532 | — | 📋 **예정** · 전 종목 시세 1콜 — market-close 와 **같은 데이터를 공유**한다 |
| **합계** | | | **530** | 🟢 평균은 한도의 **5%** |

> **최대 1회 소모 2,532건 (한도의 25%).** 한도를 깨는 것은
> 평균이 아니라 **버스트**다 — 무거운 배치가 도는 날은 같은 키를 쓰는 다른
> 워크플로와 부딪힌다. 큰 배치는 날짜를 겹치지 않게 두거나 나눠 돌린다.

## ECOS_API_KEY

- **한국은행 ECOS** · 한도 **100,000건/일**
- 범위: 키 단위. 여유가 크다

| 워크플로 | 주기(회/일) | 콜/회 | 평균/일 | 비고 |
|---|---:|---:|---:|---|
| `fetch-fx.yml` | 0.3 | 6 | 1.7 |  |
| **합계** | | | **1.7** | 🟢 평균은 한도의 **0%** |

> **최대 1회 소모 6건 (한도의 0%).** 한도를 깨는 것은
> 평균이 아니라 **버스트**다 — 무거운 배치가 도는 날은 같은 키를 쓰는 다른
> 워크플로와 부딪힌다. 큰 배치는 날짜를 겹치지 않게 두거나 나눠 돌린다.

## KOSIS_API_KEY

- **통계청 KOSIS** · 한도 **30,000건/일**
- 범위: 키 단위

| 워크플로 | 주기(회/일) | 콜/회 | 평균/일 | 비고 |
|---|---:|---:|---:|---|
| `fetch-cancer-cover.yml` | 0 | 20 | 0.6 |  |
| `fetch-kosis.yml` | 1 | 40 | 40 |  |
| **합계** | | | **41** | 🟢 평균은 한도의 **0%** |

> **최대 1회 소모 40건 (한도의 0%).** 한도를 깨는 것은
> 평균이 아니라 **버스트**다 — 무거운 배치가 도는 날은 같은 키를 쓰는 다른
> 워크플로와 부딪힌다. 큰 배치는 날짜를 겹치지 않게 두거나 나눠 돌린다.

## ⬜ 한도를 모르는 키

아래 키는 워크플로가 쓰고 있는데 `api-limits.json` 에 한도가 없다.
**한도를 모르면 남은 여유도 모른다.** 발급처에서 확인해 채운다.

- `EX_API_KEY` — `fetch-highway-rest.yml`
- `FESTIVAL_API_KEY` — `fetch-festivals.yml`
- `FINLIFE_API_KEY` — `fetch-rates.yml`
- `GEMINI_API_KEY` — `repair-auto-option.yml`
- `GOV24_KEY` — `fetch-benefit-gauge.yml`
- `KAMIS_CERT_ID` — `fetch-kamis.yml`
- `KAMIS_CERT_KEY` — `fetch-kamis.yml`
- `KASI_SERVICE_KEY` — `fetch-holidays.yml`
- `KMDB_KEY` — `fetch-now-showing.yml`
- `KOBIS_KEY` — `fetch-now-showing.yml`
- `KTO_API_KEY` — `fetch-travel-courses.yml`
- `LIFELONG_LEARNING_API_KEY` — `fetch-lifelong-learning.yml`
- `RECALL_API_KEYS` — `fetch-recall.yml`
- `SEOUL_API_KEY` — `fetch-subway-congestion.yml`
- `TOSS_API_KEY` — `fetch-dividend-labels.yml`, `fetch-lever.yml`

---

스캔: 워크플로 41개 · 관리 대상 키 19개 · 2026-09-01
