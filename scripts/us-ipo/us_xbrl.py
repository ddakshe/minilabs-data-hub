"""companyfacts 응답에서 연간 재무 3종을 뽑는다.

기간 정합성이 이 모듈의 존재 이유다. 2026-08-17 실측에서 Neutron 이
매출 304M / 순이익 295M 로 나왔는데, end 날짜만으로 최신값을 집어
분기값과 연간값을 섞었기 때문이다.
"""
from datetime import date

REVENUE_TAGS = (
    'Revenues',
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
)

# 회계연도는 52~53주라 정확히 365일이 아니다. 분기(약 90일)와는 확실히 갈린다.
_MIN_DAYS = 350
_MAX_DAYS = 380


def _units(fact):
    """companyfacts 의 units 는 통화별 dict 다. USD 를 우선한다."""
    if not fact:
        return []
    units = fact.get('units') or {}
    return units.get('USD') or next(iter(units.values()), [])


def _is_annual(unit):
    start, end = unit.get('start'), unit.get('end')
    if not start or not end:
        return False
    try:
        days = (date.fromisoformat(end) - date.fromisoformat(start)).days
    except ValueError:
        return False
    return _MIN_DAYS <= days <= _MAX_DAYS


def _latest_annual(us, tags):
    """태그 우선순위대로 훑어 가장 늦게 끝나는 연간 항목을 찾는다."""
    for tag in tags:
        annual = [u for u in _units(us.get(tag)) if _is_annual(u)]
        if annual:
            return max(annual, key=lambda u: u['end'])
    return None


def _value_at(us, tags, fiscal_end, instant=False):
    """지정한 회계연도 종료일의 값만 가져온다. 없으면 None."""
    for tag in tags:
        for unit in _units(us.get(tag)):
            if unit.get('end') != fiscal_end:
                continue
            if instant:
                if unit.get('start'):
                    continue           # 기간 항목은 시점 값이 아니다
            elif not _is_annual(unit):
                continue
            return unit.get('val')
    return None


def annual_financials(us_gaap):
    """{'fiscalEnd', 'revenue', 'netIncome', 'assets'} 또는 None.

    기준 회계연도는 매출에서 정하고, 매출이 없으면 순이익에서 정한다.
    그 해에 값이 없는 항목은 None 으로 둔다 — 다른 해의 값을 끌어오지 않는다.
    """
    if not us_gaap:
        return None

    anchor = _latest_annual(us_gaap, REVENUE_TAGS)
    if anchor is None:
        anchor = _latest_annual(us_gaap, ('NetIncomeLoss',))
    if anchor is None:
        return None

    fiscal_end = anchor['end']
    return {
        'fiscalEnd': fiscal_end,
        'revenue': _value_at(us_gaap, REVENUE_TAGS, fiscal_end),
        'netIncome': _value_at(us_gaap, ('NetIncomeLoss',), fiscal_end),
        'assets': _value_at(us_gaap, ('Assets',), fiscal_end, instant=True),
    }
