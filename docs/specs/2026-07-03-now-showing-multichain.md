# now-showing 멀티체인 재설계 (spec)

- 작성일: 2026-07-03
- 대상 파이프라인: `minilabs-data-hub` → `scripts/fetch-now-showing.mjs` + `now-showing/movies.json`
- 소비자: `now-showing-mini` (앱인토스 WebView), GitHub raw로 `movies.json` 소비

## 1. 배경 / 문제

현재 `fetch-now-showing.mjs`는 **KOBIS 영화목록(`openStartDt=올해`) + `prdtStatNm==개봉` + 60일 창**으로 "지금 상영중"을 추정한다. 실측 결과 이 방식은 두 가지 오류가 있다:

1. **쓰레기 포함**: 성인 VOD물이 형식적 1관 개봉으로 KOBIS에 "개봉"으로 등록되어 목록에 대량 유입됨 (상영중 후보 50편 중 24편). 실제로는 극장에 걸려있지 않음.
2. **실제 상영작 누락**: 재개봉·구작(비긴 어게인, 유레카, 피아노 등)은 올해 개봉이 아니라 통째로 빠짐. 롯데 현재상영 37편 중 15편+가 우리 목록에 없었음.

근본 원인: **KOBIS `개봉` 상태 = "제작상태가 개봉됨"일 뿐, "지금 극장에 걸려있음"이 아니다.** KOBIS 무료 API에는 현재 상영관/스케줄 데이터가 없다(박스오피스는 Top 10만).

## 2. 목표 / 비목표

**목표**
- "지금 상영중" = **실제 극장 체인에 현재 걸려있는 영화**로 정의를 교정.
- 극장 체인(롯데·CGV·메가박스) 현재상영작을 스파인으로 사용 → 정확한 상영 여부 + 포스터 확보 + 재개봉 포착 + 성인 VOD 자연 제외.
- 기존 소비자(`now-showing-mini`) 계약을 깨지 않고 필드를 보강.

**비목표**
- "개봉예정"은 이번 재설계 범위 밖 — 현행 KOBIS `개봉예정` 로직 유지(체인엔 개봉 전 영화가 없음).
- 성인물 나이인증 게이트 기능(별도 프로젝트).
- 전체 영화 추천 앱(별도 프로젝트).

## 3. 데이터 소스와 역할

| 소스 | 접근 | 역할(권위) | 조인키 |
|---|---|---|---|
| **롯데시네마** | JSON API (`MovieData.aspx`, curl) | 상영여부, 포스터, **KOFMovieCd**, 예매율 | `KOFMovieCd`(=KOBIS movieCd) |
| **메가박스** | playwright AJAX 인터셉트 (`/movie`) | 상영여부, 포스터(`imgPathNm`), 예매율(`boxoBokdRt`), 시놉시스, 평점 | 없음 → 제목+개봉일 |
| **CGV** | playwright (봇차단 우회) | 상영여부, 포스터 | 없음 → 제목+개봉일 |
| **KOBIS** | REST API | 박스오피스 랭킹, 상세(러닝타임/장르/배우/등급/국가) | `movieCd` |
| **KMDb** | JSON API | 줄거리(우선), 키워드 | 제목+개봉연도 |

**역할 분담 원칙**
- **상영여부(스파인)** = 3개 체인 현재상영작의 **합집합**.
- **포스터** = 체인 포스터 우선(롯데 → 메가박스 → CGV), 없으면 KMDb.
- **줄거리** = KMDb 우선, 없으면 메가박스 `movieSynopCn`.
- **랭킹/인기** = KOBIS 일별 박스오피스(있으면) + 체인 예매율(보조).
- **상세 메타**(러닝타임/장르/배우/등급/국가) = KOBIS 상세(KOFMovieCd 조인) 우선, 없으면 체인 필드.

## 4. 병합(dedup) 전략

- **표준 dedup 키 = `정규화(제목) + 개봉연도`**. 정규화 = 공백/특수문자 제거, KMDb의 `!HS`/`!HE` 마크업 제거.
- **KOFMovieCd**는 KOBIS(박스오피스/상세) 연결용 보조키. 롯데 항목에서만 직접 획득. 메가박스/CGV-only 항목은 KOBIS를 제목+개봉연도로 fuzzy 조인(실패 시 체인 필드로 대체).
- 병합 순서: 롯데 → 메가박스 → CGV 순으로 union하되, 이미 있는 키면 **빈 필드만 보강**(포스터 등). `availableAt: ["lotte","megabox","cgv"]` 배열로 어느 체인에 걸렸는지 기록.

## 5. 출력 스키마 (`now-showing/movies.json`)

기존 필드 유지 + 추가. `nowShowing[]` 항목:

```jsonc
{
  "movieCd": "20261234",        // KOFMovieCd(롯데) 또는 KOBIS fuzzy 조인 결과, 없으면 null
  "title": "토이 스토리 5",
  "titleEn": "",
  "openDt": "2026-06-17",
  "genre": "애니메이션",          // KOBIS 상세 우선
  "runtime": 102,
  "grade": "전체관람가",          // 체인 등급명 or KOBIS
  "nation": "미국",
  "directors": [], "actors": [],
  "poster": "https://...",       // 체인 우선, https 강제
  "plot": "…",                    // KMDb 우선 → 메가박스 시놉시스
  "keywords": null,
  "boxOffice": { "rank": 2, "audiAcc": 123456 } | null,  // KOBIS
  "bookingRate": 22,             // 신규: 체인 예매율(최대값)
  "availableAt": ["lotte","megabox"],  // 신규: 상영 체인
  "kmdbId": null
}
```

- **하위호환**: 기존 소비자가 읽던 `poster/plot/title/openDt/genre/grade/boxOffice` 등은 그대로 존재. 신규 필드(`bookingRate`,`availableAt`)는 추가일 뿐이라 안전.
- `stills`는 이번 스코프에서 제외(불필요), 필요 시 후속.

## 6. 에러 처리 / 폴백

- **체인별 독립 try/catch**: 한 체인이 죽어도 나머지로 스파인 구성(nae-baeum식 우아한 degrade). 최소 1개 체인 성공하면 산출.
- **모든 체인 실패 시**: 산출물을 덮어쓰지 않음(빈 커밋 방지) — 워크플로우가 diff 없음으로 스킵. (KOBIS-only 폴백은 정확도 낮으므로 채택 안 함.)
- KMDb/KOBIS 보강 실패는 개별 항목에서 빈 필드로 degrade.

## 7. CI (GitHub Actions)

- `fetch-now-showing.yml`에 **playwright 설치 스텝 추가** (`fetch-rankings-pw` 패턴 참고: `npx playwright install --with-deps chromium`).
- 시크릿: `KOBIS_KEY`(필수), `KMDB_KEY`(선택). 체인은 키 불필요(공개 엔드포인트).
- 스케줄: 현행 유지(09:30 KST). 체인 현재상영은 상시 최신이라 시점 민감도 낮음.

## 8. 테스트

- **순수 함수 분리 후 유닛테스트**: 정규화/dedup 병합, 포스터 우선순위 선택, 스키마 빌드 — mock 입력으로 vitest 또는 node --test.
- **스크래퍼**는 통합 성격 → 로컬 실행으로 산출물 스냅샷 검증(포스터/상영작 수/성인물 제외 확인).

## 9. 증분 구현 계획

1. **롯데 스파인** (가장 깨끗): 롯데 현재상영 → 스파인, KOFMovieCd로 KOBIS 조인, KMDb 줄거리, 신규 스키마. 산출·검증. ✅ **완료** (37편, 포스터 100%)
2. **메가박스 추가**: playwright AJAX 인터셉트, 제목+개봉연도 dedup 병합, `imgPathNm` 포스터. ✅ **완료** (병합 46편, 포스터 100%, 제목중복 0). 단 기본 페이지 상위 ~20편만 로드(페이징 미구현).
3. **CGV 추가**: ✅ **완료**. cgv.co.kr 홈 로드 시 `api.cgv.co.kr`의 무비차트 응답(`data.dspScrdispMovctTab.dspScrdispMovctDtlList[].movctSearchResDtoList`, 가장 큰 탭) 인터셉트. 포스터=`https://cdn.cgv.co.kr{imgPath}{img320Fnm}`, 예매율=`atktRate`. 직접 curl은 403/401(WAF·세션) → playwright 세션 인터셉트만 동작. 라이브뷰잉/콘서트/팬미팅/스포츠중계는 이벤트 정규식(`EVENT_RE`)으로 제외. **최종 3체인 76편, 포스터 100%, 중복 0.**
   - 병합키를 `정규화(제목)+연도`→`정규화(제목)`으로 변경(재개봉작이 체인마다 원작/재개봉 연도가 달라 중복 발생하던 것 해결).
4. **워크플로우 playwright 대응**: `npm ci` + `npx playwright install chromium --with-deps` 스텝 추가(fetch-outlets 패턴). ✅ **완료**.

각 단계는 독립적으로 동작·검증 가능(현재 1+2+4 완료, 3은 후속).

## 10. 미해결/구현 중 확정할 것

- 메가박스 포스터 base URL·확장자(`https://img.megabox.co.kr{imgPathNm}` + suffix) — 2단계에서 확정.
- CGV 현재상영 정확한 셀렉터/AJAX 엔드포인트 — 3단계에서 확정.
- 체인 등급명 ↔ KOBIS 등급 표기 정규화(예: "전체관람가" 통일).
