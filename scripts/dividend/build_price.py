#!/usr/bin/env python3
"""stock-dividend-mini 주가 스냅샷 — dividend/price.json.

    python3 scripts/dividend/build_price.py

**토스에서 떼어낸 값이다.** 토스증권 API 는 허용 IP 사전 등록이 필수라 GitHub Actions
러너에서 부를 수 없다 (LOCAL_JOBS.md). 그런데 주가는 이 앱에서 **매일 갱신이 필요한
유일한 값**이라, 로컬 배치에 묶어 두면 사람이 매일 손으로 돌려야 한다.

  · 주가(px)      매일  → 여기 (Yahoo, 키·IP 불필요) ← CI 자동
  · 한글명·시가총액  분기  → dividend_toss.py (토스, 허용 IP) ← 로컬 수동

⚠️ **Yahoo 는 공식 API 가 아니다.** `v7/finance/quote` 는 이미 Unauthorized 로 막혔고
   (2026-08-25 실측) `v8/finance/chart` 도 언제든 막힐 수 있다. 그래서:
   - 성공률이 MIN_OK 아래면 **아무것도 쓰지 않고 실패한다.** 반쯤 갱신된 파일을
     내보내면 일부 종목만 옛 가격이라 목록 안에서 비교가 깨진다.
   - 워크플로가 실패하면 기존 price.json 이 그대로 남는다. 앱은 마지막 성공분을 쓰고
     화면에 그 날짜를 찍는다 — 고장이 아니라 "조금 오래된 값" 이 된다.
   - 예비 출처: api.nasdaq.com/api/quote/{t}/info 도 키 없이 응답하는 것을 확인해 뒀다.
"""
from __future__ import annotations

import datetime as dt
import json
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'dividend' / 'dividend.json'
OUT = ROOT / 'dividend' / 'price.json'

# 실측: 동시 8개에서 32/32 성공, 1,313개 1.2분 (2026-08-25).
# 더 올리지 않는다 — 공식 API 가 아니라 차단 임계를 알 수 없고, 1분대면 이미 충분하다.
WORKERS = 8
TIMEOUT = 12
UA = {'User-Agent': 'minilabs-data-hub batch kyungtaekim@odkmedia.net'}

# 이 아래면 실패로 본다. 상장폐지·티커 변경으로 몇 개는 늘 빠지지만,
# 90% 를 밑돈다면 그건 개별 종목 문제가 아니라 출처가 막힌 것이다.
MIN_OK = 0.90


def fetch(sym: str) -> tuple[str, float | None, int | None]:
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=1d&interval=1d'
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as f:
            meta = json.load(f)['chart']['result'][0]['meta']
        px = meta.get('regularMarketPrice')
        # 0 이나 음수는 값이 아니다. 그대로 내보내면 앱에서 0 으로 나누게 된다
        if not isinstance(px, (int, float)) or px <= 0:
            return sym, None, None
        return sym, round(float(px), 4), meta.get('regularMarketTime')
    except (urllib.error.URLError, KeyError, IndexError, TypeError, ValueError, TimeoutError):
        return sym, None, None


def main() -> int:
    if not SRC.exists():
        print(f'✗ {SRC} 가 없다. build_dividend.py 를 먼저 돌린다.', file=sys.stderr)
        return 1
    tickers = [r['t'] for r in json.loads(SRC.read_text())['rows']]
    print(f'{len(tickers):,}종목 조회 (동시 {WORKERS})')

    with ThreadPoolExecutor(WORKERS) as ex:
        rows = list(ex.map(fetch, tickers))

    px = {s: p for s, p, _ in rows if p is not None}
    times = [t for _, p, t in rows if p is not None and t]
    rate = len(px) / len(tickers) if tickers else 0
    print(f'  성공 {len(px):,}/{len(tickers):,} ({rate:.1%})')

    if rate < MIN_OK:
        print(f'✗ 성공률이 {MIN_OK:.0%} 미만이다. 출처가 막혔을 가능성이 높아 쓰지 않는다.',
              file=sys.stderr)
        print('  기존 price.json 을 그대로 둔다 — 반쯤 갱신된 파일이 더 나쁘다.', file=sys.stderr)
        return 1

    # 기준 시각은 **거래소 시각의 최댓값**이다. 화면에 이 날짜를 찍는다 (BRAND.md 화면 원칙 3)
    as_of = (
        dt.datetime.fromtimestamp(max(times), dt.timezone.utc).date().isoformat()
        if times else dt.date.today().isoformat()
    )
    payload = {
        'asOf': as_of,
        'builtAt': dt.datetime.now(dt.timezone.utc).date().isoformat(),
        'source': 'Yahoo Finance chart v8',
        'px': px,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')))
    print(f'✓ {OUT.name} · asOf {as_of} · {len(json.dumps(px)) // 1024}KB')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
