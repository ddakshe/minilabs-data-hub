import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ipo_dart
from ipo_dart import ListingTruncated, _fetch_filings, date_slices


def test_date_slices_cover_range_without_gaps():
    s = date_slices('20260617', '20260910', 21)
    assert s[0] == ('20260617', '20260707')
    assert s[-1][1] == '20260910'
    for (a, b), (c, _) in zip(s, s[1:]):
        from datetime import datetime, timedelta
        assert datetime.strptime(c, '%Y%m%d') - datetime.strptime(b, '%Y%m%d') == timedelta(days=1)


def _page(n, total, names):
    return {'status': '000', 'total_page': total,
            'list': [{'report_nm': r, 'corp_code': str(i)} for i, r in enumerate(names)]}


def test_asks_only_unlisted_and_keeps_equity_filings(monkeypatch):
    seen = []

    def get(path, key, **p):
        seen.append(p)
        return _page(1, 1, ['증권신고서(지분증권)', '일괄신고서', '[발행조건확정]증권신고서(지분증권)'])

    monkeypatch.setattr(ipo_dart, '_get', get)
    out = _fetch_filings('k', '20260901', '20260910')
    assert all(p['corp_cls'] == 'E' for p in seen)
    assert len(out) == 2


def test_raises_instead_of_silently_truncating(monkeypatch):
    """2026-09-10 실측: 66페이지를 20에서 끊어 오래된 공시가 조용히 빠졌다."""
    monkeypatch.setattr(ipo_dart, 'time', type('T', (), {'sleep': staticmethod(lambda s: None)}))
    monkeypatch.setattr(ipo_dart, '_get', lambda path, key, **p: _page(int(p['page_no']), 66, ['증권신고서(지분증권)']))
    with pytest.raises(ListingTruncated):
        _fetch_filings('k', '20260901', '20260910')


def test_raises_on_mid_page_failure(monkeypatch):
    monkeypatch.setattr(ipo_dart, 'time', type('T', (), {'sleep': staticmethod(lambda s: None)}))

    def get(path, key, **p):
        if p['page_no'] == '2':
            return {'status': '020', 'message': '요청 제한'}
        return _page(1, 3, ['증권신고서(지분증권)'])

    monkeypatch.setattr(ipo_dart, '_get', get)
    with pytest.raises(ListingTruncated):
        _fetch_filings('k', '20260901', '20260910')


def test_empty_slice_is_normal(monkeypatch):
    monkeypatch.setattr(ipo_dart, '_get', lambda path, key, **p: {'status': '013', 'message': '조회된 데이타가 없습니다.'})
    assert _fetch_filings('k', '20260901', '20260910') == []
