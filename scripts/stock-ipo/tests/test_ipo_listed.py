import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ipo_listed
from ipo_listed import attach_performance, lookup_stock_codes, retain_previous, summarize_prices

TODAY = date(2026, 9, 10)


def item(code, **over):
    return {'corpCode': code, 'corpName': code, 'subscriptionEnd': '2026-09-02',
            'offerPrice': 10000, **over}


def test_listed_item_survives_after_leaving_fresh():
    """상장하는 날 수집분에서 빠져도 어제 파일에서 되살린다 (2026-09-10 이전의 실제 결함)."""
    out, kept = retain_previous([item('A')], [item('A'), item('B', subscriptionEnd='2026-08-13')], TODAY)
    assert [i['corpCode'] for i in out] == ['A', 'B']
    assert kept == 1


def test_old_items_expire():
    out, kept = retain_previous([], [item('OLD', subscriptionEnd='2026-05-01')], TODAY)
    assert out == [] and kept == 0


def test_fresh_wins_but_inherits_stock_code_and_performance():
    perf = {'firstDate': '2026-08-24', 'lastDate': '2026-09-09'}
    fresh = [item('A', offerPrice=12000)]
    prev = [item('A', offerPrice=10000, stockCode='417030', performance=perf)]
    out, _ = retain_previous(fresh, prev, TODAY)
    assert out[0]['offerPrice'] == 12000
    assert out[0]['stockCode'] == '417030'
    assert out[0]['performance'] == perf


def test_anchor_falls_back_to_first_trading_day():
    p = item('A', subscriptionEnd=None, performance={'firstDate': '2026-08-24'})
    out, kept = retain_previous([], [p], TODAY)
    assert kept == 1


def test_stock_code_lookup_skips_upcoming_and_known(monkeypatch):
    monkeypatch.setattr(ipo_listed, 'DART_GAP', 0)
    calls = []

    def get(path, key, corp_code):
        calls.append(corp_code)
        return {'status': '000', 'stock_code': '0155E0' if corp_code == 'DONE' else ''}

    items = [item('UPCOMING', subscriptionEnd='2026-09-20'),
             item('KNOWN', stockCode='282620'),
             item('DONE'),
             item('WAITING')]
    n, found = lookup_stock_codes('k', items, TODAY, get)
    assert calls == ['DONE', 'WAITING']
    assert found == 1
    assert items[2]['stockCode'] == '0155E0'
    assert 'stockCode' not in items[3]


def row(d, code='417030', mkp='40500', clpr='28650', mrkt='KOSDAQ'):
    return {'basDt': d, 'srtnCd': code, 'mkp': mkp, 'clpr': clpr, 'mrktCtg': mrkt}


def test_summarize_prices_uses_exact_code_and_first_last():
    """2026-09-10 실측 니어스랩: 첫 거래일 8/24 시가 40,500 · 종가 28,650, 9/9 종가 30,850."""
    rows = [row('20260909', clpr='30850'), row('20260824'),
            row('20260825', code='4170300')]   # 포함 검색이 끌고 온 다른 코드
    p = summarize_prices(rows, '417030', '2026-08-13')
    assert p == {'market': 'KOSDAQ', 'firstDate': '2026-08-24', 'firstOpen': 40500,
                 'firstClose': 28650, 'lastDate': '2026-09-09', 'lastClose': 30850,
                 'tradingDays': 2}


def test_summarize_prices_drops_rows_before_subscription():
    """코넥스 이전상장은 같은 코드로 옛 시세가 있다 — 첫 거래일을 잘못 잡으면 안 된다."""
    rows = [row('20250102', mrkt='KONEX'), row('20260824')]
    p = summarize_prices(rows, '417030', '2026-08-13')
    assert p['firstDate'] == '2026-08-24' and p['market'] == 'KOSDAQ'


def test_summarize_prices_none_when_not_listed():
    assert summarize_prices([], '417030', '2026-09-11') is None


def test_attach_performance_keeps_yesterday_on_failure(monkeypatch):
    monkeypatch.setattr(ipo_listed, 'PRICE_GAP', 0)
    old = {'lastDate': '2026-09-08'}
    items = [item('A', stockCode='417030', performance=old)]

    def boom(*a):
        raise TimeoutError('portal down')

    ok, fail = attach_performance('k', items, fetch=boom)
    assert (ok, fail) == (0, 1)
    assert items[0]['performance'] is old


def test_attach_performance_skips_without_offer_price(monkeypatch):
    monkeypatch.setattr(ipo_listed, 'PRICE_GAP', 0)
    called = []
    items = [item('A', stockCode='417030', offerPrice=None)]
    attach_performance('k', items, fetch=lambda *a: called.append(a) or [])
    assert called == []


def test_legacy_items_keep_only_todays_fresh_and_strip_v2_fields():
    """옛 앱은 시세 붙은 건을 청약 목록 「청약 마감」 에 섞는다 — ipo.json 에 싣지 않는다."""
    from ipo_listed import legacy_items
    perf = {'firstDate': '2026-08-21', 'lastDate': '2026-09-09'}
    fresh = item('FRESH')
    listed = item('LISTED', stockCode='282620', performance=perf)
    out = legacy_items([fresh, listed], {'FRESH'})
    assert [i['corpCode'] for i in out] == ['FRESH']
    assert 'stockCode' not in out[0] and 'performance' not in out[0]


def test_legacy_items_does_not_mutate_v2_items():
    from ipo_listed import legacy_items
    it = item('FRESH', stockCode='X', performance={'lastDate': '2026-09-09'})
    legacy_items([it], {'FRESH'})
    assert it['stockCode'] == 'X' and it['performance'] == {'lastDate': '2026-09-09'}


def test_listed_item_counts_from_listing_day_not_subscription_end():
    """피스피스스튜디오: 5/27 청약 종료 → 6/8 상장. 9/11 에 청약 기준이면 107일, 상장 기준이면 95일."""
    p = item('PIECE', subscriptionEnd='2026-05-27', performance={'firstDate': '2026-06-08'})
    out, kept = retain_previous([], [p], date(2026, 9, 11))
    assert kept == 1
