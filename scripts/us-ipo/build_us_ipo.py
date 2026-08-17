"""EDGAR 를 긁어 us-ipo/ipo.json 을 만든다.

설계 규칙:
  - 확정 공모가를 못 뽑은 항목은 listed 에서 뺀다. 추측값을 넣지 않는다.
  - 결과가 비면 기존 파일을 덮지 않고 exit 1 한다. API 장애로 좋은 데이터를 날리지 않는다.
  - upcoming 은 본문을 받지 않는다. 296건 × 1MB 를 CI 에서 받을 이유가 없다.
"""
import json
import sys
from datetime import date, timedelta

from us_document import parse_prospectus
from us_edgar import (
    dedupe_by_cik,
    fetch_text,
    fetch_company_facts,
    fetch_document_text,
    fetch_submissions,
    hit_cik,
    hit_filed_at,
    hit_name,
    latest_registration_url,
    search_filings,
)
from us_fx import usd_krw
from us_parse import (
    band_position,
    is_new_listing,
    is_spac,
    parse_offer_price,
    parse_price_band,
    sic_to_industry,
)
from us_paths import DATA_DIR, OUTPUT
from us_xbrl import annual_financials

LISTED_DAYS = 30
UPCOMING_DAYS = 90


def _window(days, today):
    return (today - timedelta(days=days)).isoformat(), today.isoformat()


def _clean_name(raw):
    """'ITG, Inc./DE/  (ITG)  (CIK 0002110117)' -> 'ITG, Inc.'"""
    name = raw.split('(CIK')[0]
    name = name.split('  (')[0]
    return name.replace('/DE/', '').replace('/', ' ').strip().rstrip(',').strip()


def _ticker_of(sub):
    tickers = (sub or {}).get('tickers') or []
    return tickers[0] if tickers else None


def _location_of(sub):
    addr = ((sub or {}).get('addresses') or {}).get('business') or {}
    city, state = addr.get('city'), addr.get('stateOrCountry')
    return ', '.join(p for p in (city, state) if p) or None


def _company_meta(cik):
    sub = fetch_submissions(cik)
    sic = (sub or {}).get('sic') or None
    return {
        'ticker': _ticker_of(sub),
        'sic': sic,
        'industry': sic_to_industry(sic),
        'location': _location_of(sub),
        'financials': annual_financials(fetch_company_facts(cik)),
        'sub': sub,
    }


def _price_band(cik, sub, price):
    """직전 등록신고서에서 희망밴드를 찾아 확정가의 위치를 판정한다.

    미국에서 'priced above the range' 는 수요가 강했다는 표준 신호로,
    국내의 기관 수요예측 경쟁률에 대응한다. 사실만 싣고 해석은 앱이 하지 않는다.
    없으면 전부 None — 배지를 붙이지 않는다.
    """
    url = latest_registration_url(cik, sub)
    if not url:
        return None, None, None
    band = parse_price_band(fetch_text(url), price)
    if not band:
        return None, None, None
    return band[0], band[1], band_position(price, band)


def _sec_url(cik, form):
    return (
        'https://www.sec.gov/cgi-bin/browse-edgar'
        f'?action=getcompany&CIK={cik}&type={form}'
    )


def build_listed(today):
    start, end = _window(LISTED_DAYS, today)
    items = []
    skipped = 0
    for hit in dedupe_by_cik(search_filings('424B4', start, end)):
        cik, raw_name = hit_cik(hit), hit_name(hit)
        try:
            text = fetch_document_text(hit)
        except Exception as exc:                 # 개별 실패는 건너뛴다
            print(f'  본문 실패 {raw_name[:40]}: {exc}', file=sys.stderr)
            skipped += 1
            continue

        # 후속공모·직상장을 먼저 걸러낸다. Janus Living 은 각주의 과거 IPO 가격이
        # 잡혀 목록에 들어왔는데, 값은 맞지만 신규 상장이 아니었다.
        if not is_new_listing(text):
            skipped += 1
            continue

        price = parse_offer_price(text)
        if price is None:
            skipped += 1
            continue

        doc = parse_prospectus(text)
        meta = _company_meta(cik)
        shares = doc['sharesOffered']

        # 시가총액 = 공모가 × 상장 후 총주식수.
        # 문서의 "outstanding as of <날짜>" 는 공모 '전' 수치라 공모주식수를 더한다.
        # 국내 앱에서 같은 함정을 밟아 시총이 절반으로 나온 적이 있다.
        before = doc['sharesBefore']
        shares_after = (before + shares) if (before and shares) else None

        band_low, band_high, position = _price_band(cik, meta['sub'], price)

        items.append({
            'cik': cik,
            'name': _clean_name(raw_name),
            'ticker': meta['ticker'],
            'exchange': doc['exchange'],
            'offerPrice': price,
            'priceBandLow': band_low,
            'priceBandHigh': band_high,
            'bandPosition': position,
            'sharesOffered': shares,
            'sharesAfterListing': shares_after,
            'grossProceeds': int(price * shares) if shares else None,
            'marketCap': int(price * shares_after) if shares_after else None,
            'filedAt': hit_filed_at(hit),
            'isSpac': is_spac(meta['sic'], raw_name, text),
            'sic': meta['sic'],
            'industry': meta['industry'],
            'underwriters': doc['underwriters'],
            'businessSummary': doc['businessSummary'],
            'useOfProceeds': doc['useOfProceeds'],
            'netResult': doc['netResult'],
            'lockupDays': doc['lockupDays'],
            'location': meta['location'],
            'financials': meta['financials'],
            'secUrl': _sec_url(cik, '424B4'),
        })
    print(f'  (공모가 추출 실패로 제외 {skipped}건)', file=sys.stderr)
    items.sort(key=lambda x: x['filedAt'], reverse=True)
    return items


def build_upcoming(today, listed_ciks):
    start, end = _window(UPCOMING_DAYS, today)
    hits = search_filings('S-1', start, end) + search_filings('S-1/A', start, end)
    items = []
    for hit in dedupe_by_cik(hits):
        cik = hit_cik(hit)
        if cik in listed_ciks:
            continue                              # 이미 상장 확정된 곳은 뺀다
        raw_name = hit_name(hit)
        meta = _company_meta(cik)
        items.append({
            'cik': cik,
            'name': _clean_name(raw_name),
            'ticker': meta['ticker'],
            'filedAt': hit_filed_at(hit),
            'isSpac': is_spac(meta['sic'], raw_name),   # 본문 없음 — 이름으로 보조 판정
            'sic': meta['sic'],
            'industry': meta['industry'],
            'financials': meta['financials'],
            'secUrl': _sec_url(cik, 'S-1'),
        })
    items.sort(key=lambda x: x['filedAt'], reverse=True)
    return items


def main():
    today = date.today()
    print(f'[us-ipo] {today} 수집 시작')

    listed = build_listed(today)
    print(f'[us-ipo] 상장 확정 {len(listed)}건')

    upcoming = build_upcoming(today, {i['cik'] for i in listed})
    print(f'[us-ipo] 준비 중 {len(upcoming)}건')

    if not listed and not upcoming:
        print('[us-ipo] 결과가 비었다. 기존 파일을 덮지 않는다.', file=sys.stderr)
        return 1

    payload = {
        'generatedAt': f'{today.isoformat()}T00:00:00Z',
        'source': 'SEC EDGAR',
        'sourceUrl': 'https://www.sec.gov/edgar',
        'usdKrw': usd_krw(),
        'listed': listed,
        'upcoming': upcoming,
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f'[us-ipo] 저장 {OUTPUT}  환율 {payload["usdKrw"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
