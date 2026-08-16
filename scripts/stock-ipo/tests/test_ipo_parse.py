import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ipo_parse import (
    is_ipo, is_spac, normalize_corp_name, parse_date, parse_date_range, parse_number,
)


def test_parse_date_range_splits_two_dates():
    s = '2026년 09월 10일 ~ 2026년 09월 11일'
    assert parse_date_range(s) == ('2026-09-10', '2026-09-11')


def test_parse_date_range_handles_single_date():
    assert parse_date_range('2026년 09월 10일') == ('2026-09-10', '2026-09-10')


def test_parse_date_range_handles_none():
    assert parse_date_range(None) == (None, None)


def test_parse_date_range_handles_garbage():
    assert parse_date_range('미정') == (None, None)


def test_parse_date():
    assert parse_date('2026년 09월 15일') == '2026-09-15'
    assert parse_date(None) is None


def test_parse_number_strips_commas():
    assert parse_number('16,500') == 16500
    assert parse_number('14,000,000,000') == 14000000000


def test_parse_number_handles_none_and_garbage():
    assert parse_number(None) is None
    assert parse_number('-') is None
    assert parse_number('') is None


def test_normalize_corp_name_strips_company_markers():
    assert normalize_corp_name('(주)브릴스') == '브릴스'
    assert normalize_corp_name('브릴스(주)') == '브릴스'
    assert normalize_corp_name('주식회사 해치텍') == '해치텍'
    assert normalize_corp_name('  기도산업  ') == '기도산업'


def test_normalize_corp_name_matches_toss_names():
    """2026-08-15 실측: DART와 토스 SCHEDULED 3건이 정확히 일치했다."""
    for name in ('기도산업', '니어스랩', '해치텍'):
        assert normalize_corp_name(name) == name


def test_is_ipo_when_stock_code_is_blank():
    """증권신고서(지분증권)에는 IPO와 유상증자가 섞여 있다.
    stock_code 빈값 = 비상장 = IPO 가 유일하게 신뢰할 수 있는 판별자다."""
    assert is_ipo({'corp_name': '브릴스', 'stock_code': ''}) is True
    assert is_ipo({'corp_name': '브릴스', 'stock_code': '   '}) is True
    assert is_ipo({'corp_name': '브릴스'}) is True


def test_is_not_ipo_when_listed():
    """상장사의 증권신고서는 유상증자다. slmthn(모집방법)으로는 구분되지 않는다."""
    assert is_ipo({'corp_name': '판타지오', 'stock_code': '032800'}) is False


def test_is_spac_detects_by_name():
    assert is_spac('케이비제34호기업인수목적') is True
    assert is_spac('엔에이치기업인수목적34호') is True


def test_is_spac_false_for_normal_company():
    assert is_spac('브릴스') is False
    assert is_spac('') is False
