# 이세상 랭킹 — 카테고리 목록

> 마지막 업데이트: 2026-04-09
> 총 54개 카테고리, 8개 그룹

## 데이터 구조

### index.json
```jsonc
{
  "updatedAt": "2026-04-09",
  "groups": [{ "id": "...", "label": "...", "emoji": "..." }],
  "categories": [{
    "id": "tennis-rank",          // 고유 식별자
    "groupId": "male-sports",     // 소속 그룹
    "label": "테니스 (ATP)",       // 앱에 표시되는 이름
    "emoji": "🎾",               // 카드 아이콘
    "color": "#00C896",          // 테마 색상 (hex)
    "subtitle": "ATP 남자 단식 세계 랭킹",  // 상세 설명
    "updatedAt": "2026-04-01",   // 데이터 기준일
    "top": {                     // 1위 preview (홈 카드용)
      "name": "야닉 신네르",
      "value": "11,830점",
      "flag": "🇮🇹"
    }
  }]
}
```

### {groupId}.json
```jsonc
{
  "updatedAt": "2026-04-09",
  "rankings": {
    "tennis-rank": [
      {
        "rank": 1,               // 현재 순위
        "prev": 1,               // 이전 순위 (변동 표시용)
        "name": "야닉 신네르",     // 이름 (한국어)
        "value": "11,830점",     // 대표 수치
        "detail": "설명 텍스트",   // 펼침 시 보이는 설명
        "flag": "🇮🇹",          // 국기 이모지
        "highlight": true        // (선택) true면 KR 배지 표시
      }
    ]
  }
}
```

---

## 그룹별 카테고리

### 🏃‍♂️ 남자 스포츠 (`male-sports`) — 10개

| ID | label | subtitle | 데이터 소스 | 갱신 주기 |
|----|-------|----------|-----------|----------|
| `tennis-rank` | 테니스 (ATP) | ATP 남자 단식 세계 랭킹 | atptour.com | 주간 |
| `tennis-earn` | 테니스 수입 | 테니스 선수 연간 수입 | Forbes 추정 | 연간 |
| `golf-rank` | 골프 (OWGR) | 세계 골프 랭킹 (OWGR) | owgr.com | 주간 |
| `golf-earn` | 골프 수입 | 골프 선수 연간 수입 | Forbes 추정 | 연간 |
| `f1-driver` | F1 드라이버 | F1 드라이버 챔피언십 | formula1.com | 레이스 후 |
| `f1-team` | F1 팀 | F1 컨스트럭터 챔피언십 | formula1.com | 레이스 후 |
| `boxing-p4p` | 복싱 P4P | 복싱 파운드 포 파운드 랭킹 | BoxRec / ESPN | 월간 |
| `ufc-p4p` | UFC P4P | UFC 파운드 포 파운드 랭킹 | ufc.com | 월간 |
| `chess` | 체스 FIDE | FIDE 체스 세계 랭킹 | ratings.fide.com | 월간 |
| `marathon` | 마라톤 기록 | 마라톤 역대 최고 기록 | worldathletics.org | 드물게 |

### 🏃‍♀️ 여자 스포츠 (`female-sports`) — 3개

| ID | label | subtitle | 데이터 소스 | 갱신 주기 |
|----|-------|----------|-----------|----------|
| `tennis-women` | 테니스 (WTA) | WTA 여자 단식 세계 랭킹 | wtatennis.com | 주간 |
| `golf-women` | 골프 (LPGA) | LPGA 여자 골프 세계 랭킹 | lpga.com | 주간 |
| `football-women` | 축구 (FIFA 여자) | FIFA 여자 국가대표 랭킹 | fifa.com | 분기 |

### ⚽ 축구 (`football`) — 6개

| ID | label | subtitle | 데이터 소스 | 갱신 주기 |
|----|-------|----------|-----------|----------|
| `football-team` | FIFA 랭킹 | FIFA 남자 국가대표 랭킹 | fifa.com | 월간 |
| `football-salary` | 선수 연봉 | 축구 선수 연간 수입 | Forbes 추정 | 연간 |
| `uefa-club` | UEFA 클럽 | UEFA 클럽 계수 랭킹 | uefa.com | 주간 |
| `epl` | EPL | 잉글리시 프리미어 리그 | premierleague.com | 주간 |
| `laliga` | 라리가 | 스페인 라리가 | laliga.es | 주간 |
| `kleague` | K리그 | K리그 1 순위 | kleague.com | 주간 |

### 🏀 농구·야구 (`ball-league`) — 5개

| ID | label | subtitle | 데이터 소스 | 갱신 주기 |
|----|-------|----------|-----------|----------|
| `nba-team` | NBA 팀 | NBA 팀 전력 순위 | nba.com | 주간 |
| `nba-salary` | NBA 연봉 | NBA 선수 연봉 | spotrac.com | 연간 |
| `mlb-team` | MLB 팀 | MLB 팀 전력 순위 | mlb.com | 주간 |
| `mlb-salary` | MLB 연봉 | MLB 선수 연봉 | spotrac.com | 연간 |
| `kbo` | KBO | KBO 리그 순위 | koreabaseball.com | 주간 |

### 🎤 엔터테인먼트 (`ent`) — 10개

| ID | label | subtitle | 데이터 소스 | 갱신 주기 |
|----|-------|----------|-----------|----------|
| `billboard` | 빌보드 1위 | 빌보드 Hot 100 역대 1위 최다 | billboard.com | 드물게 |
| `spotify` | 스포티파이 | 스포티파이 월간 청취자 | Spotify API | 월간 |
| `youtube-subs` | 유튜브 구독자 | 유튜브 채널 구독자 수 | YouTube Data API | 월간 |
| `instagram` | 인스타 팔로워 | 인스타그램 팔로워 수 | 공개 프로필 | 월간 |
| `tiktok` | 틱톡 팔로워 | 틱톡 팔로워 수 | 공개 프로필 | 월간 |
| `netflix` | 넷플릭스 역대 | 넷플릭스 역대 시청 시간 | netflix.com/tudum | 분기 |
| `box-office-global` | 글로벌 흥행 | 역대 글로벌 흥행 영화 | boxofficemojo.com | 드물게 |
| `box-office-kr` | 한국 흥행 | 역대 한국 흥행 영화 (관객수) | kobis.or.kr | 드물게 |
| `kdrama` | K-드라마 | K-드라마 역대 시청률 | nielsen.co.kr | 드물게 |
| `oscar` | 아카데미상 | 아카데미상 최다 수상 영화 | oscar.go.com | 연간 |

### 💰 경제 (`economy`) — 8개

| ID | label | subtitle | 데이터 소스 | 갱신 주기 | 스크래퍼 |
|----|-------|----------|-----------|----------|---------|
| `rich` | 세계 부자 | 세계 부자 순위 (자산 기준) | Forbes | 연간 | ❌ seed |
| `rich-kr` | 한국 부자 | 한국 부자 순위 | Forbes Korea | 연간 | ❌ seed |
| `market-cap-global` | 글로벌 시총 | 글로벌 시가총액 순위 | Yahoo Finance | 월간 | ❌ seed |
| `market-cap-kospi` | KOSPI 시총 | KOSPI 시가총액 순위 | krx.co.kr | 월간 | ❌ seed |
| `gdp` | GDP | 국가 GDP 순위 | **World Bank API** | 연간 | ✅ 구현됨 |
| `gdp-per-capita` | 1인당 GDP | 1인당 GDP 순위 | **World Bank API** | 연간 | ✅ 구현됨 |
| `ceo-salary` | CEO 연봉 | 글로벌 CEO 연봉 | Forbes / WSJ | 연간 | ❌ seed |
| `unicorn` | 유니콘 기업 | 유니콘 기업 가치 | CB Insights | 분기 | ❌ seed |

### 🏙️ 세상·지리 (`world`) — 8개

| ID | label | subtitle | 데이터 소스 | 갱신 주기 | 스크래퍼 |
|----|-------|----------|-----------|----------|---------|
| `building` | 초고층 빌딩 | 세계 최고층 빌딩 | Wikipedia | 드물게 | ❌ seed |
| `mountain` | 최고 산 | 세계 최고봉 | 정적 데이터 | 안 바뀜 | 불필요 |
| `river` | 최장 강 | 세계에서 가장 긴 강 | 정적 데이터 | 안 바뀜 | 불필요 |
| `lake` | 최대 호수 | 세계에서 가장 큰 호수 | 정적 데이터 | 안 바뀜 | 불필요 |
| `bridge` | 최장 다리 | 세계에서 가장 긴 다리 | Wikipedia | 드물게 | ❌ seed |
| `population` | 인구 순 | 인구가 가장 많은 나라 | **World Bank API** | 연간 | ✅ 구현됨 |
| `area` | 면적 순 | 면적이 가장 넓은 나라 | 정적 데이터 | 안 바뀜 | 불필요 |
| `tourist-city` | 관광 도시 | 방문객이 가장 많은 도시 | Euromonitor | 연간 | ❌ seed |

### 🏆 기타 (`misc`) — 4개

| ID | label | subtitle | 데이터 소스 | 갱신 주기 |
|----|-------|----------|-----------|----------|
| `olympic` | 올림픽 금메달 | 역대 올림픽 금메달 국가별 | Wikipedia | 올림픽 후 |
| `nobel` | 노벨상 | 노벨상 수상 국가별 | nobelprize.org | 연간 |
| `fastest-car` | 최고속 자동차 | 세계에서 가장 빠른 양산차 | Wikipedia | 드물게 |
| `expensive-painting` | 비싼 그림 | 역대 가장 비싸게 팔린 그림 | Wikipedia | 드물게 |

---

## 카테고리 추가하기

1. `rankings/seed.json`에 category 추가 + rankings 데이터 추가
2. 해당 그룹에 맞는 `groupId` 지정
3. `node scripts/fetch-rankings.mjs` 실행 → 분리 파일 자동 생성
4. (선택) `scripts/fetch-rankings.mjs`의 `scrapers`에 실시간 fetch 함수 추가
5. 이 문서 업데이트

### 새 그룹 추가 시
1. `seed.json`의 `groups` 배열에 새 그룹 추가
2. 스크립트가 자동으로 `{groupId}.json` 파일 생성

### 색상 가이드
- 같은 그룹 내 색상은 동일 색조 계열 유지
- 예: 남자 스포츠 = 초록/시안, 축구 = 파랑/보라, 경제 = 노랑/주황

---

## 스크래퍼 구현 현황

| 상태 | 카테고리 수 | 설명 |
|------|-----------|------|
| ✅ 구현됨 | 3개 | GDP, 1인당 GDP, 인구 (World Bank API) |
| ❌ seed | 43개 | 정적 샘플 데이터 사용 중 |
| 🔒 불필요 | 8개 | 정적 데이터 (산, 강, 호수 등 안 바뀌는 것) |
