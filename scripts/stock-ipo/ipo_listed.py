"""상장 후 성적 — 청약이 끝나고 상장한 공모주를 목록에 남기고 시세를 붙인다.

⚠️ 공모주 판정(`is_ipo`)이 "list.json 의 stock_code 가 빈값" 이라 **상장하는 날 목록에서
   빠진다.** 2026-09-10 까지는 청약 종료 후 약 1주(= 상장일)에 사라졌다. 빌드 스크립트
   주석은 "85일 남긴다" 였지만 실제로는 그렇게 돌지 않았다.
   → **어제 파일을 기억으로 쓴다.** 한 번 공모주로 잡힌 건은 KEEP_DAYS 동안 남긴다.

시세는 공공데이터포털 「금융위원회_주식시세정보」(getStockPriceInfo).
토스와 달리 허용 IP 가 없어 GitHub Actions 에서 그대로 부를 수 있다.
⚠️ **하루 늦다.** 아침에 받으면 전 거래일 종가까지다. 앱은 lastDate 를 기준일로 반드시 쓴다.
⚠️ 수익률은 여기서 계산하지 않는다. 원자료만 넣고 앱이 공모가로 나눈다 (BRAND.md 원문 우선).
"""
import json
import re
import time
import urllib.parse
import urllib.request
from datetime import timedelta

# 청약 종료 → 상장까지 약 1~2주 + 상장 후 3개월
KEEP_DAYS = 100

PRICE_BASE = ('https://apis.data.go.kr/1160100/service/'
              'GetStockSecuritiesInfoService/getStockPriceInfo')
PRICE_GAP = 1.0
# 🚨 DART 는 순차 + 간격. 동시 4개로 긁다가 IP 차단을 당했다 (2026-08-25, ../../CLAUDE.md)
DART_GAP = 0.3


def _anchor(item):
    """남길지 판단하는 날짜. **상장했으면 상장일(첫 거래일)**, 아니면 청약 종료일.

    화면 문구가 「최근 약 3개월 안에 상장한 종목」 이다. 청약 종료일로 세면 청약과 상장 사이가
    긴 종목이 문구보다 먼저 빠진다 — 피스피스스튜디오(5/27 청약 종료 → 6/8 상장)가 상장 95일째에
    빠졌다 (2026-09-11 실측).
    """
    perf = item.get('performance') or {}
    return perf.get('firstDate') or item.get('subscriptionEnd')


def retain_previous(fresh, previous, today, keep_days=KEEP_DAYS):
    """오늘 수집분에 어제 파일의 최근 항목을 되살려 붙인다.

    - 같은 corpCode 면 **오늘 값이 이긴다.** 다만 오늘 수집분에 없는 stockCode·performance 는
      어제 값을 이어 받는다 (수집 단계에서는 그 둘을 채우지 않으므로).
    - 오늘 수집분에 없는 어제 항목은 anchor 가 cutoff 이후일 때만 남긴다.

    반환: (항목 목록, 되살린 건수)
    """
    cutoff = (today - timedelta(days=keep_days)).isoformat()
    prev = {i['corpCode']: i for i in (previous or []) if i.get('corpCode')}
    out, seen = [], set()
    for it in fresh:
        p = prev.get(it['corpCode'])
        if p:
            for k in ('stockCode', 'performance'):
                if it.get(k) is None and p.get(k) is not None:
                    it[k] = p[k]
        out.append(it)
        seen.add(it['corpCode'])
    kept = 0
    for code, p in prev.items():
        if code in seen:
            continue
        a = _anchor(p)
        if a and a >= cutoff:
            out.append(p)
            kept += 1
    return out, kept


def lookup_stock_codes(dart_key, items, today, get):
    """청약이 끝났는데 종목코드가 없는 건만 DART company.json 으로 확인한다.

    상장 전이면 아직 빈값이라 다음 날 다시 묻는다. 청약 마감 ~ 상장 사이 건만 해당해
    하루 0~3건이다. `get` 은 ipo_dart._get (테스트에서 바꿔 끼운다).
    """
    t = today.isoformat()
    calls = found = 0
    for it in items:
        if it.get('stockCode'):
            continue
        end = it.get('subscriptionEnd')
        if not end or end >= t:
            continue
        r = get('company.json', dart_key, corp_code=it['corpCode'])
        calls += 1
        time.sleep(DART_GAP)
        code = (r.get('stock_code') or '').strip() if r.get('status') == '000' else ''
        if code:
            it['stockCode'] = code
            found += 1
    return calls, found


def _iso(d):
    return f'{d[:4]}-{d[4:6]}-{d[6:]}'


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def summarize_prices(rows, code, since=None):
    """시세 행 → 성적 원자료.

    🚨 likeSrtnCd 는 **포함 검색**이다. 코드가 정확히 같은 행만 쓴다.
    since(청약 종료일) 이전 행은 버린다 — 코넥스에서 옮겨 온 이전상장은 같은 코드로
    옛 시세가 남아 있어 첫 거래일을 잘못 잡는다.
    """
    rows = [r for r in rows or [] if r.get('srtnCd') == code and r.get('basDt')]
    if since:
        s = since.replace('-', '')
        rows = [r for r in rows if r['basDt'] >= s]
    if not rows:
        return None
    rows.sort(key=lambda r: r['basDt'])
    first, last = rows[0], rows[-1]
    return {
        'market': first.get('mrktCtg'),
        'firstDate': _iso(first['basDt']),
        'firstOpen': _int(first.get('mkp')),
        'firstClose': _int(first.get('clpr')),
        'lastDate': _iso(last['basDt']),
        'lastClose': _int(last.get('clpr')),
        'tradingDays': len(rows),
    }


def _service_key(raw):
    # 포털이 인코딩된 키와 원문 키를 둘 다 준다. 이미 인코딩됐으면 다시 인코딩하지 않는다
    return raw if re.search(r'%[0-9A-Fa-f]{2}', raw) else urllib.parse.quote(raw, safe='')


def price_query(service_key, **params):
    q = urllib.parse.urlencode({'resultType': 'json', 'pageNo': 1, **params})
    url = f'{PRICE_BASE}?serviceKey={_service_key(service_key)}&{q}'
    with urllib.request.urlopen(url, timeout=40) as r:
        d = json.load(r)
    body = d['response']['body']
    items = (body.get('items') or {}).get('item') or []
    return [items] if isinstance(items, dict) else items


def fetch_prices(service_key, code, since):
    # 청약 종료 후 100일 ≈ 70거래일. 200행이면 한 번에 끝난다
    return price_query(service_key, numOfRows=200, likeSrtnCd=code,
                       beginBasDt=since.replace('-', ''))


def attach_performance(service_key, items, fetch=fetch_prices):
    """종목코드·공모가·청약종료일이 모두 있는 건만. 실패하면 어제 값을 그대로 둔다."""
    ok = fail = 0
    for it in items:
        code, since = it.get('stockCode'), it.get('subscriptionEnd')
        if not (code and since and it.get('offerPrice')):
            continue
        try:
            perf = summarize_prices(fetch(service_key, code, since), code, since)
            ok += 1
        except Exception as e:  # 네트워크·포털 장애 — 어제 성적을 지우지 않는다
            print(f'    [시세] {it.get("corpName")} 실패: {e}')
            perf = None
            fail += 1
        if perf:
            it['performance'] = perf
        time.sleep(PRICE_GAP)
    return ok, fail


# 옛 판(ipo.json)에는 없던 필드. 옛 앱이 모르는 값을 굳이 싣지 않는다
V2_ONLY_FIELDS = ('stockCode', 'performance')


def legacy_items(items, fresh_codes):
    """옛 앱 버전이 읽는 ipo.json 의 항목 — **오늘 DART 수집분만**, v2 전용 필드는 뺀다.

    되살린 상장 건·백필 건은 넣지 않는다. 옛 앱의 groupItems 는 시세 붙은 건을 따로 가르지
    못해 청약 목록의 「청약 마감」 에 섞는다. v2 쪽 항목은 건드리지 않도록 복사해서 뺀다.
    """
    out = []
    for it in items:
        if it.get('corpCode') not in fresh_codes:
            continue
        copy = {k: v for k, v in it.items() if k not in V2_ONLY_FIELDS}
        out.append(copy)
    return out
