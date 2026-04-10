# 스크래퍼 미구현 목록 (TODO)

> 마지막 업데이트: 2026-04-10
> 현재 31/54 자동 스크래핑 완료. 아래는 아직 seed 정적 데이터를 사용하는 카테고리.

---

## Wikipedia 테이블 없음 — 별도 소스 필요 (5개)

| 카테고리 ID | 이름 | 실패 원인 | 해결 방안 |
|------------|------|----------|----------|
| `kdrama` | K-드라마 시청률 | Wikipedia에 정리 테이블 없음 | 닐슨코리아 스크래핑 또는 수동 |
| `fastest-car` | 최고속 자동차 | Wikipedia 페이지가 산문 형식 (테이블 없음) | "Production car speed record" 등 다른 페이지 탐색, 또는 수동 |
| `golf-rank` | 골프 OWGR | Wikipedia에 현재 랭킹 테이블 없음 | `owgr.com` 직접 스크래핑 (cheerio) |
| `chess` | 체스 FIDE | Wikipedia에 현재 랭킹 테이블 없음 | `ratings.fide.com` 스크래핑 또는 FIDE API |
| `boxing-p4p` | 복싱 P4P | Ring Magazine 현재 랭킹 테이블 없음 | `ringtv.com` 또는 ESPN Boxing 스크래핑 |

## 한국 전용 소스 필요 (3개)

| 카테고리 ID | 이름 | 현 상태 | 해결 방안 |
|------------|------|--------|----------|
| `kleague` | K리그 | seed 정적 | `kleague.com` 또는 ESPN 확인 (현재 ESPN에 kor.1 없음) |
| `kbo` | KBO | seed 정적 | `koreabaseball.com` 스크래핑 또는 `statiz.co.kr` |
| `market-cap-kospi` | KOSPI 시총 | seed 정적 | `krx.co.kr` API 또는 네이버 금융 |

## Forbes / 유료 소스 의존 (8개)

| 카테고리 ID | 이름 | 현 상태 | 해결 방안 |
|------------|------|--------|----------|
| `rich` | 세계 부자 | seed 정적 | Wikipedia "World's billionaires" 페이지 (연 1회 갱신) |
| `rich-kr` | 한국 부자 | seed 정적 | Wikipedia 또는 Forbes Korea 스냅샷 |
| `market-cap-global` | 글로벌 시총 | seed 정적 | Yahoo Finance 또는 Wikipedia "Largest companies by market cap" |
| `ceo-salary` | CEO 연봉 | seed 정적 | Wikipedia 또는 수동 |
| `unicorn` | 유니콘 기업 | seed 정적 | CB Insights 또는 Wikipedia |
| `tennis-earn` | 테니스 수입 | seed 정적 | Forbes 연간 스냅샷 → 수동 |
| `golf-earn` | 골프 수입 | seed 정적 | Forbes 연간 스냅샷 → 수동 |
| `football-salary` | 축구 연봉 | seed 정적 | spotrac.com 또는 capology.com |

## 기타 (4개)

| 카테고리 ID | 이름 | 현 상태 | 해결 방안 |
|------------|------|--------|----------|
| `nba-salary` | NBA 연봉 | seed 정적 | spotrac.com 스크래핑 |
| `mlb-salary` | MLB 연봉 | seed 정적 | spotrac.com 스크래핑 |
| `spotify` | 스포티파이 | ✅ 동작하나 검증 필요 | 현재 Wikipedia 기반. 데이터 정확도 확인 필요 |
| `netflix` | 넷플릭스 | ✅ 동작하나 1위가 의심 | "KPop Demon Hunters"가 1위로 나옴. 섹션/테이블 매칭 재확인 필요 |

---

## 구현 팁

### 새 스크래퍼 추가 순서
1. `scripts/sources/` 에 해당 모듈 파일 수정 (또는 새 파일 생성)
2. export된 함수를 `scripts/fetch-rankings.mjs`의 `scrapers` 객체에 등록
3. `node scripts/fetch-rankings.mjs` 로컬 실행 → 성공 확인
4. 이 문서 해당 항목 삭제 또는 ✅ 표기

### cheerio가 필요한 사이트 스크래핑
`cheerio`는 이미 설치됨. `scripts/sources/` 내 기존 파일 패턴 참고:
```js
import * as cheerio from 'cheerio'
const $ = cheerio.load(htmlString)
```

### ESPN API (무료, 인증 불필요)
현재 사용 중인 엔드포인트:
- EPL: `https://site.api.espn.com/apis/v2/sports/soccer/eng.1/standings`
- La Liga: `https://site.api.espn.com/apis/v2/sports/soccer/esp.1/standings`
- NBA: `https://site.api.espn.com/apis/v2/sports/basketball/nba/standings`
- MLB: `https://site.api.espn.com/apis/v2/sports/baseball/mlb/standings`

K리그/KBO는 ESPN에 없음.
