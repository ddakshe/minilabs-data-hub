import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ipo_toss import attach_list_dates


def test_attaches_list_date_on_name_match():
    """2026-08-15 실측: DART 3건과 토스 SCHEDULED 3건이 이름으로 정확히 일치했다."""
    ipos = [
        {'corpName': '해치텍'},
        {'corpName': '기도산업'},
        {'corpName': '니어스랩'},
    ]
    scheduled = [
        {'symbol': '0155E0', 'name': '해치텍', 'listDate': '2026-08-25'},
        {'symbol': '282620', 'name': '기도산업', 'listDate': '2026-08-21'},
        {'symbol': '417030', 'name': '니어스랩', 'listDate': '2026-08-24'},
    ]
    out = attach_list_dates(ipos, scheduled)
    assert out[0]['listDate'] == '2026-08-25'
    assert out[0]['symbol'] == '0155E0'
    assert out[1]['listDate'] == '2026-08-21'
    assert out[2]['symbol'] == '417030'


def test_normalizes_company_markers_before_matching():
    ipos = [{'corpName': '(주)브릴스'}]
    scheduled = [{'symbol': '123456', 'name': '브릴스', 'listDate': '2026-09-17'}]
    out = attach_list_dates(ipos, scheduled)
    assert out[0]['listDate'] == '2026-09-17'


def test_no_match_leaves_null_and_does_not_estimate():
    """상장일을 추정하지 않는다. 매칭 실패는 정상 상황이다."""
    ipos = [{'corpName': '와이즈플래닛컴퍼니', 'paymentDate': '2026-09-18'}]
    out = attach_list_dates(ipos, [])
    assert out[0]['listDate'] is None
    assert out[0]['symbol'] is None


def test_does_not_mutate_input():
    ipos = [{'corpName': '해치텍'}]
    attach_list_dates(ipos, [{'symbol': 'X', 'name': '해치텍', 'listDate': '2026-08-25'}])
    assert 'listDate' not in ipos[0]
