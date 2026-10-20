#!/usr/bin/env python3
"""YouTube Data API v3 호출 + 쿼터 장부. **쿼터를 지키는 것이 이 모듈의 존재 이유다.**

이 시리즈에서 DART 로 IP 차단을 당한 적이 있다(2026-08-25). 유튜브는 차단 대신 쿼터로
막는데, 넘기면 그날 남은 호출이 전부 `quotaExceeded` 로 죽는다 — **스냅샷까지 같이 죽는 게
문제다.** 발굴(search)이 비싸고 스냅샷(channels)이 싸므로, 장부를 두고 **발굴에만 상한을
걸어 스냅샷 예산을 반드시 남긴다.**

쿼터 단가 (developers.google.com/youtube/v3/determine_quota_cost):
    search.list    비싸다. 하루 약 100회가 한계이고 별도로 묶여 있다
    channels.list  1 — id 를 50개씩 묶을 수 있다. 200채널 = 4
    videos.list    1
기본 할당량은 10,000/day.

🚨 **쿼터는 태평양시 자정에 리셋된다.** 장부를 KST 날짜로 끊으면 하루가 어긋나 상한이
풀려 버린다. `_quota_date()` 가 태평양 날짜를 쓰는 이유다.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent      # minilabs-data-hub/
DATA = ROOT / 'channels'
LEDGER = DATA / '.quota'
BASE = 'https://www.googleapis.com/youtube/v3'

# 발굴 상한. search 는 **1회 100 units** 로 잡는다(문서가 '하루 100회' 로도 읽혀 모호한데,
# 비싼 쪽으로 가정하는 것이 안전하다). 하루 예산 배분:
#     발굴  60회 × 100 = 6,000
#     업로드(쇼츠/롱폼)      ~2,500   (uploads.py UPLOADS_BUDGET)
#     스냅샷 5,000채널까지      ~100
#     여유                   ~1,400
# 🚨 **이 값을 올리기 전에 위 배분을 다시 계산할 것.** 넘기면 그날 스냅샷이 같이 죽고,
#    못 찍은 날은 영구히 빈다 — 그게 이 프로젝트에서 가장 비싼 사고다.
SEARCH_BUDGET = 60
SLEEP = 0.1               # 유튜브는 초당 제한을 명시하지 않지만 몰아치지 않는다
RETRY = 2                 # 계속 실패하면 서버가 그만하라는 뜻이다 (dart.py 의 규율)
BACKOFF = 2.0


def _read_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    got = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        got[k.strip().upper()] = v.strip()
    return got


def api_key() -> str:
    """환경변수 → `~/.config/stock-tools/youtube.env` → 저장소 `.env` 순으로 찾는다.

    이 시리즈의 관례다 (toss.env · dart.env 가 이미 그렇다). 소스에 박으면 git 이력에서
    지우기 어렵고, 저장소 .env 만 쓰면 기계를 옮길 때마다 다시 만들어야 한다.
    CI 에서는 환경변수(Secrets)로 들어온다.
    """
    for src in (
        os.environ,
        _read_env_file(Path.home() / '.config' / 'stock-tools' / 'youtube.env'),
        _read_env_file(ROOT / '.env'),
    ):
        for name in ('YOUTUBE_API_KEY', 'YT_API_KEY'):
            if src.get(name):
                return src[name]
    raise SystemExit(
        '키가 없다. 아래 중 하나로 넣는다:\n'
        '  1) ~/.config/stock-tools/youtube.env 에 YOUTUBE_API_KEY=... 한 줄 + chmod 600\n'
        '  2) 환경변수 YOUTUBE_API_KEY (CI 는 이 경로)\n'
        '키 발급: console.cloud.google.com → API 및 서비스 → YouTube Data API v3 사용 설정\n'
        '        → 사용자 인증 정보 → API 키. OAuth 가 아니라 **API 키**다(공개 데이터만 읽는다).'
    )


# ── 쿼터 장부 ──────────────────────────────────────────────────────────────
def _quota_date() -> str:
    """태평양 날짜. PST/PDT 를 가르지 않고 UTC-8 로 잡는다 — 여름에 한 시간 보수적으로
    끊히는 쪽이라 상한이 느슨해지는 사고가 없다."""
    return (datetime.now(timezone.utc) - timedelta(hours=8)).strftime('%Y-%m-%d')


def _ledger_path() -> Path:
    return LEDGER / f'{_quota_date()}.json'


def spent() -> dict:
    p = _ledger_path()
    if p.exists():
        return json.loads(p.read_text())
    return {'date': _quota_date(), 'units': 0, 'search': 0, 'calls': {}}


def _charge(endpoint: str, units: int) -> None:
    led = spent()
    led['units'] += units
    if endpoint == 'search':
        led['search'] += 1
    led['calls'][endpoint] = led['calls'].get(endpoint, 0) + 1
    LEDGER.mkdir(parents=True, exist_ok=True)
    _ledger_path().write_text(json.dumps(led, ensure_ascii=False, indent=2) + '\n')


def search_left() -> int:
    """오늘 발굴에 더 쓸 수 있는 search 호출 수."""
    return max(0, SEARCH_BUDGET - spent()['search'])


# ── 호출 ──────────────────────────────────────────────────────────────────
def call(endpoint: str, *, units: int = 1, **params) -> dict:
    """GET /{endpoint}. 실패를 삼키지 않는다 — 조용히 빈 결과가 흐르면 series 에
    구멍이 나고 그 구멍은 소급해서 메울 수 없다."""
    if endpoint == 'search' and search_left() <= 0:
        raise QuotaGuard(f'오늘 발굴 상한({SEARCH_BUDGET}) 소진. 스냅샷 예산을 지킨다')

    params['key'] = api_key()
    url = f'{BASE}/{endpoint}?' + urllib.parse.urlencode(params)
    last = None
    for attempt in range(RETRY + 1):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                body = json.loads(r.read().decode())
            _charge(endpoint, units)
            time.sleep(SLEEP)
            return body
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors='replace')[:400]
            # 403 quotaExceeded 는 재시도해도 똑같이 실패한다. 즉시 멈춘다
            if e.code == 403 and 'quota' in detail.lower():
                _charge(endpoint, units)
                raise QuotaGuard(f'쿼터 소진: {detail}') from None
            last = f'HTTP {e.code} {detail}'
            if e.code < 500:
                break                     # 400·404 는 요청이 틀린 것이다
        except (urllib.error.URLError, TimeoutError) as e:
            last = f'{type(e).__name__}: {e}'
        if attempt < RETRY:
            time.sleep(BACKOFF * (attempt + 1))
    raise RuntimeError(f'{endpoint} 실패 — {last}')


class QuotaGuard(Exception):
    """쿼터 때문에 멈췄다. 호출부는 이걸 잡아 **이미 모은 것은 저장하고** 끝내야 한다."""


def chunks(seq, n):
    seq = list(seq)
    for i in range(0, len(seq), n):
        yield seq[i:i + n]
