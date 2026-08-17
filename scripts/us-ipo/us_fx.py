"""USD/KRW. 키가 필요 없는 두 소스를 순서대로 시도한다.

2026-08-17 실측: frankfurter 1,411.27 / open.er-api 1,415.10 (0.3% 차이).
실패하면 None 을 낸다 — 앱은 원화 병기만 생략하고 달러는 정상 표시한다.
"""
import json
import urllib.request

_TIMEOUT = 20
_SOURCES = (
    ('https://api.frankfurter.app/latest?from=USD&to=KRW', lambda d: d['rates']['KRW']),
    ('https://open.er-api.com/v6/latest/USD', lambda d: d['rates']['KRW']),
)


def usd_krw():
    for url, pick in _SOURCES:
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'stock-tools'})
            rate = pick(json.loads(urllib.request.urlopen(req, timeout=_TIMEOUT).read()))
            if isinstance(rate, (int, float)) and rate > 0:
                return round(float(rate), 2)
        except Exception:
            continue
    return None
