"""한 번 쓰는 백필 — 이미 상장해서 목록에서 빠진 최근 공모주를 되찾는다.

    python3 scripts/stock-ipo/build_ipo_json.py --backfill-days 100

평소 배치는 어제 파일을 기억으로 쓰므로(ipo_listed.retain_previous) 이건 **처음 한 번**만
필요하다. 기억을 쓰기 전에 이미 빠진 건을 채우는 용도다.

🚨 **DART 목록(list.json)을 기간으로 훑지 않는다.** corp_code 없이 발행공시(C)를 부르면
   85일에 6,598건(66페이지)인데 수집기는 20페이지에서 멈춘다 — 최신순이라 약 2개월치만
   보이고 나머지는 **조용히 빠진다** (2026-09-10 실측). 첫 백필이 기도산업·니어스랩·해치텍을
   놓치고 스트라드비젼 등 8곳의 확정 공모가를 못 붙인 원인이다.

대신 이렇게 찾는다 — 셋 다 목록 페이지에 기대지 않는다:
  1. 시세 API 전종목 목록을 N일 전과 최근 거래일에 한 번씩 받아 **새로 생긴 코드**를 뽑는다
  2. DART corpCode.xml 로 종목코드 → corp_code
  3. 회사별 list.json 에 **증권신고서(지분증권)** 이 있으면 공모 IPO.
     합병(세미티에스)·증권예탁증권(인제니아)·분할 재상장(한화머시너리)은 여기서 빠진다.

🚨 DART 는 순차로만 (ipo_listed.DART_GAP).
"""
import io
import re
import time
import urllib.parse
import urllib.request
import zipfile
from datetime import timedelta

from ipo_dart import BASE, _get
from ipo_listed import DART_GAP, price_query

# 신고서 → 상장이 길면 수개월 걸린다 (스트라드비젼: 4/9 신고 → 6월 상장)
LOOKBACK_DAYS = 300


def listed_codes_on(service_key, day, tries=7):
    """day(또는 그 직전 거래일)에 시세가 있던 종목. {종목코드: 종목명}"""
    for back in range(tries):
        d = (day - timedelta(days=back)).strftime('%Y%m%d')
        rows = price_query(service_key, numOfRows=5000, basDt=d)
        codes = {r['srtnCd']: r.get('itmsNm') for r in rows if r.get('srtnCd')}
        if codes:
            return codes, d
    raise RuntimeError(f'{day} 부근 {tries}일 동안 시세가 없다 — 포털 장애로 본다')


def new_codes(old, new):
    return {c: n for c, n in new.items() if c not in old}


def parse_corp_codes(xml_text):
    """corpCode.xml → {종목코드: corp_code}. 비상장 법인은 stock_code 가 공백이라 빠진다."""
    rows = re.findall(r'<corp_code>(\d+)</corp_code>.*?<stock_code>([^<]*)</stock_code>',
                      xml_text, flags=re.S)
    return {s.strip(): c for c, s in rows if s.strip()}


def fetch_corp_codes(key):
    url = f'{BASE}/corpCode.xml?' + urllib.parse.urlencode({'crtfc_key': key})
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    raw = urllib.request.urlopen(req, timeout=120).read()
    time.sleep(DART_GAP)
    z = zipfile.ZipFile(io.BytesIO(raw))
    return parse_corp_codes(z.read(z.namelist()[0]).decode('utf-8'))


def ipo_filings(filings):
    """공모 IPO 로 볼 공시만 — 증권신고서(지분증권) 계열 ([기재정정]·[발행조건확정] 포함)."""
    return [f for f in filings if '증권신고서(지분증권)' in (f.get('report_nm') or '')]


def company_filings(key, corp_code, bgn, end):
    r = _get('list.json', key, corp_code=corp_code, bgn_de=bgn, end_de=end,
             pblntf_ty='C', page_count='100')
    time.sleep(DART_GAP)
    return r.get('list', []) if r.get('status') == '000' else []


def find_recent_listed(dart_key, service_key, today, days):
    """(백필 대상 filings, corp_code → 종목코드, 조회 시작일) 을 돌려준다."""
    old, old_day = listed_codes_on(service_key, today - timedelta(days=days))
    new, new_day = listed_codes_on(service_key, today)
    added = new_codes(old, new)
    print(f'  [백필] {old_day} {len(old)}종목 → {new_day} {len(new)}종목 · 새 코드 {len(added)}')

    corp = fetch_corp_codes(dart_key)
    start = today - timedelta(days=days + LOOKBACK_DAYS)
    bgn, end = start.strftime('%Y%m%d'), today.strftime('%Y%m%d')

    picked, codes, skipped = [], {}, []
    for code, name in sorted(added.items()):
        cc = corp.get(code)
        if not cc:
            skipped.append(f'{name}(corp_code 없음)')
            continue
        fl = ipo_filings(company_filings(dart_key, cc, bgn, end))
        if not fl:
            skipped.append(name)
            continue
        picked += fl
        codes[cc] = code
    print(f'  [백필] 공모 IPO {len(codes)}곳 · 제외 {len(skipped)}: {", ".join(skipped)}')
    return picked, codes, start
