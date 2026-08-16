"""토스증권 Open API에서 상장 예정 종목의 확정 상장일을 가져와 DART 결과에 붙인다.

DART는 납입일(pymd)까지만 주고 상장일을 주지 않는다.
토스 /stocks/all?status=SCHEDULED 가 그걸 채워준다 (2026-08-15 실측).

⚠️ 허용 IP 사전 등록이 필수다. 미등록 IP는 /oauth2/token 단계에서 403이다.
⚠️ /stocks/all 은 1 TPS 다. 간격을 둔다.
⚠️ 응답이 에러까지 gzip으로 온다. urllib은 자동 해제를 안 해준다.
"""
import gzip
import json
import time
import urllib.error
import urllib.parse
import urllib.request

from ipo_parse import normalize_corp_name

BASE = 'https://openapi.tossinvest.com'
MARKETS = ('KOSPI', 'KOSDAQ')
GAP = 1.2  # /stocks/all 이 1 TPS


def _body(resp):
    raw = resp.read()
    if resp.headers.get('Content-Encoding') == 'gzip':
        raw = gzip.decompress(raw)
    return raw.decode('utf-8', 'replace')


def _token(client_id, client_secret):
    body = urllib.parse.urlencode({
        'grant_type': 'client_credentials',
        'client_id': client_id,
        'client_secret': client_secret,
    }).encode()
    req = urllib.request.Request(
        f'{BASE}/oauth2/token', data=body,
        headers={'Content-Type': 'application/x-www-form-urlencoded'})
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.loads(_body(r))
    return d.get('access_token') or d.get('result', {}).get('access_token')


def _api(token, path, **q):
    url = f'{BASE}{path}' + ('?' + urllib.parse.urlencode(q) if q else '')
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.loads(_body(r))
        return d.get('result', d) if isinstance(d, dict) else d
    except urllib.error.HTTPError as e:
        print(f'  [토스] {path} {e.code} {_body(e)[:120]}')
        return None


def fetch_scheduled(client_id, client_secret):
    """상장 예정 종목의 symbol/name/listDate 를 반환한다.

    실패하면 빈 리스트를 반환한다 — 상장일은 부가 정보이므로
    토스가 죽어도 배치 전체를 실패시키지 않는다.
    """
    try:
        token = _token(client_id, client_secret)
    except Exception as e:
        print(f'  [토스] 토큰 발급 실패: {e} — 상장일 없이 진행한다')
        return []
    if not token:
        return []

    symbols = []
    for market in MARKETS:
        rows = _api(token, '/api/v1/stocks/all', market=market, status='SCHEDULED')
        for r in rows or []:
            symbols.append(r['symbol'])
        time.sleep(GAP)

    if not symbols:
        print('  [토스] 상장 예정 종목 0건')
        return []

    detail = _api(token, '/api/v1/stocks', symbols=','.join(symbols[:200]))
    out = [{'symbol': s['symbol'], 'name': s['name'], 'listDate': s.get('listDate')}
           for s in (detail or [])]
    print(f'  [토스] 상장 예정 {len(out)}건')
    return out


def attach_list_dates(ipos, scheduled):
    """회사명으로 조인해 listDate/symbol 을 붙인다.

    corp_code(DART)와 symbol(토스)은 체계가 달라 직접 연결되지 않는다.
    회사명이 유일한 조인 키다 (2026-08-15 실측에서 3건 전부 일치).

    매칭 실패는 정상이다 — 토스 SCHEDULED 는 상장일이 확정된 건만 잡힌다.
    이때 상장일을 추정하지 않고 None 으로 둔다.
    """
    index = {normalize_corp_name(s['name']): s for s in scheduled}
    out = []
    for ipo in ipos:
        match = index.get(normalize_corp_name(ipo.get('corpName', '')))
        out.append({
            **ipo,
            'listDate': match['listDate'] if match else None,
            'symbol': match['symbol'] if match else None,
        })
    return out
