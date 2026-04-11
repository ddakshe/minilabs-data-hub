# 이세상 랭킹 — 카테고리 후보 목록

> 새로 추가 예정인 카테고리들을 소스 검증 상태와 함께 관리.
> 마지막 업데이트: 2026-04-11

## 범례

- ✅ **검증됨**: Wikipedia/API 등 스크래핑 가능한 소스 확인 완료
- 🟡 **소스 필요**: 카테고리는 매력적이나 자동화 가능 소스 미확인
- ⚠️ **큐레이션**: 자동 랭킹 없음, 수동 큐레이션 필요
- 🟣 **중복**: 기존 `CATEGORIES.md`에 이미 있음 (추가 안 함)
- ⬜ **미검증**: 아직 소스 확인 안 함

## 작업 순서

1. 이 파일에서 후보를 선정
2. Wikipedia/API 소스 확인 (`WebFetch`로 표 존재 여부 확인)
3. `seed.json`에 카테고리 + 샘플 데이터 추가
4. `sources/*.mjs`에 스크래퍼 구현
5. `CATEGORIES.md` 업데이트 후 이 파일에서 제거 또는 완료 표시

---

## 그룹: 🏆 기네스 / 기록 (`records` — 신규 그룹 필요)

| 상태 | 제안 ID | label | subtitle | 소스 | 비고 |
|------|---------|-------|----------|------|------|
| ✅ | `oldest-person` | 최고령 인물 | 역대 최고령자 | [Wikipedia: List_of_the_verified_oldest_people](https://en.wikipedia.org/wiki/List_of_the_verified_oldest_people) | 잔 칼망 122세 1위, 여성/남성 각 100명 테이블 |
| ✅ | `tallest-person` | 역대 최장신 | 역사상 가장 키 큰 사람 | [Wikipedia: List_of_tallest_people](https://en.wikipedia.org/wiki/List_of_tallest_people) | Robert Wadlow 272cm 1위 |
| ✅ | `hottest-pepper` | 가장 매운 고추 | 스코빌 지수 랭킹 | [Wikipedia: Scoville_scale](https://en.wikipedia.org/wiki/Scoville_scale) | Pepper X 2,693,000 SHU 1위 |
| ✅ | `oldest-tree` | 가장 오래된 나무 | 역대 최장수 나무 | [Wikipedia: List_of_oldest_trees](https://en.wikipedia.org/wiki/List_of_oldest_trees) | Methuselah 4,668년 |
| ⬜ | `100m-record` | 100m 세계 기록 | 100m 달리기 역대 기록 | Wikipedia: Men's_100_metres_world_record_progression | 우사인 볼트 9.58초 |
| ⬜ | `most-children` | 자녀 최다 부모 | 가장 많은 자녀를 둔 사람 | Wikipedia/Guinness | - |
| ⬜ | `most-languages` | 다언어 구사자 | 가장 많은 언어 구사 | Wikipedia: Hyperpolyglot | - |

## 그룹: 🐾 동물 (`animals` — 신규 그룹 필요)

| 상태 | 제안 ID | label | subtitle | 소스 | 비고 |
|------|---------|-------|----------|------|------|
| ✅ | `fastest-animal` | 가장 빠른 동물 | 전체 동물 최고 속도 | [Wikipedia: Fastest_animals](https://en.wikipedia.org/wiki/Fastest_animals) | 매 389 km/h 1위 |
| ✅ | `largest-snake` | 가장 큰 뱀 | 역대 최대 뱀 종 | [Wikipedia: List_of_largest_snakes](https://en.wikipedia.org/wiki/List_of_largest_snakes) | 그린 아나콘다 1위 |
| ⬜ | `largest-land-animal` | 최대 육상동물 | 현존 최대 육상 동물 | Wikipedia: Largest_terrestrial_animals | 아프리카코끼리 |
| ⬜ | `longest-living-animal` | 장수 동물 | 가장 오래 사는 동물 | Wikipedia: List_of_longest-living_organisms | - |
| ⬜ | `smallest-animal` | 최소 동물 | 가장 작은 동물 종 | Wikipedia: Smallest_organisms | - |

## 그룹: 🌍 지리·기후 (`geography` — 기존 `world` 그룹 확장 가능)

| 상태 | 제안 ID | label | subtitle | 소스 | 비고 |
|------|---------|-------|----------|------|------|
| 🟣 | ~~`smallest-country`~~ | 가장 작은 나라 | - | - | `area` 역순으로 이미 커버 가능 |
| ⬜ | `coldest-place` | 가장 추운 곳 | 역대 최저 기온 기록지 | Wikipedia: List_of_weather_records | -89.2°C 보스토크 기지 |
| ⬜ | `hottest-place` | 가장 더운 곳 | 역대 최고 기온 기록지 | Wikipedia: List_of_weather_records | 56.7°C Death Valley |
| ⬜ | `deepest-lake` | 가장 깊은 호수 | 세계 최심 호수 | Wikipedia: List_of_lakes_by_depth | 바이칼 호 1,642m |
| ⬜ | `deepest-ocean` | 가장 깊은 바다 | 해저 최심부 | 정적 데이터 (마리아나 해구) | 챌린저 해연 11,034m |
| ⬜ | `tallest-waterfall` | 최장 폭포 | 세계 최고 폭포 | Wikipedia: List_of_waterfalls_by_height | 앙헬 폭포 979m |
| ⬜ | `largest-desert` | 최대 사막 | 세계 최대 사막 | Wikipedia: List_of_deserts_by_area | 남극 사막 |
| ⬜ | `largest-island` | 최대 섬 | 세계 최대 섬 | Wikipedia: List_of_islands_by_area | 그린란드 |

## 그룹: 🌑 다크 랭킹 (`dark` — 신규 그룹)

| 상태 | 제안 ID | label | subtitle | 소스 | 비고 |
|------|---------|-------|----------|------|------|
| ✅ | `incarceration-rate` | 수감률 높은 나라 | 인구 10만 명당 수감자 수 | [Wikipedia: List_of_countries_by_incarceration_rate](https://en.wikipedia.org/wiki/List_of_countries_by_incarceration_rate) | 엘살바도르 1,659/10만 1위 |
| ✅ | `homicide-rate` | 살인 범죄율 높은 나라 | 10만 명당 의도적 살인 | [Wikipedia: List_of_countries_by_intentional_homicide_rate](https://en.wikipedia.org/wiki/List_of_countries_by_intentional_homicide_rate) | 터크스 카이코스 76.34/10만 1위 |
| ⚠️ | `supermax-prisons` | 탈출 어려운 교도소 | 세계 최고 보안 교도소 | 큐레이션 | ADX Florence, Black Dolphin, Goulburn, Stammheim 등 |
| ⬜ | `suicide-rate` | 자살률 높은 나라 | WHO 통계 | WHO / Wikipedia | - |
| ⬜ | `corruption-index` | 부패 지수 | Transparency International CPI | transparency.org | 연간 |

## 그룹: 📊 사회 통계 (`society` — 신규 그룹)

| 상태 | 제안 ID | label | subtitle | 소스 | 비고 |
|------|---------|-------|----------|------|------|
| ⬜ | `happiness-index` | 행복 지수 | World Happiness Report | worldhappiness.report | 연간 |
| ⬜ | `life-expectancy` | 기대수명 | 국가별 평균 수명 | **World Bank API** | 연간 — API 기구현돼 있으니 추가 쉬움 |
| ⬜ | `birth-rate` | 출산율 | 국가별 합계출산율 | **World Bank API** | 연간 |
| ⬜ | `divorce-rate` | 이혼율 | 국가별 이혼율 | UN / OECD | - |
| ⬜ | `literacy-rate` | 문맹률 | 국가별 문해율 | **World Bank API** | 연간 |
| ⬜ | `internet-penetration` | 인터넷 보급률 | 국가별 인터넷 사용률 | **World Bank API** | 연간 |

---

## 기존과 중복 (추가하지 않음)

기존 `CATEGORIES.md`에 이미 있는 카테고리들:

- `mountain`, `river`, `lake`, `area`, `population`, `building`, `bridge`, `fastest-car`, `expensive-painting`, `gdp`, `gdp-per-capita`, `tourist-city`, `nobel`, `olympic` 등

## 우선 진행 추천

1. **즉시 가능한 것 (Wikipedia 표 검증 완료)** — 8개
   - `oldest-person`, `tallest-person`, `hottest-pepper`, `oldest-tree`, `fastest-animal`, `largest-snake`, `incarceration-rate`, `homicide-rate`

2. **World Bank API 기반** — 3개 (기존 스크래퍼 재활용)
   - `life-expectancy`, `birth-rate`, `literacy-rate`

3. **큐레이션 필요** — 1개
   - `supermax-prisons`

첫 배치로 위 12개 정도가 빠르게 추가 가능할 것으로 보임.
