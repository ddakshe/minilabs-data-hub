import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from us_xbrl import annual_financials


def flow(start, end, val, form='10-K'):
    return {'start': start, 'end': end, 'val': val, 'form': form}


def instant(end, val):
    return {'end': end, 'val': val, 'form': '10-K'}


def facts(**tags):
    return {tag: {'units': {'USD': units}} for tag, units in tags.items()}


class TestAnnualFinancials:
    def test_연간값을_고른다(self):
        us = facts(
            Revenues=[flow('2025-01-01', '2025-12-31', 404_633_000)],
            NetIncomeLoss=[flow('2025-01-01', '2025-12-31', 1_788_000)],
            Assets=[instant('2025-12-31', 1_068_610_000)],
        )
        assert annual_financials(us) == {
            'fiscalEnd': '2025-12-31',
            'revenue': 404_633_000,
            'netIncome': 1_788_000,
            'assets': 1_068_610_000,
        }

    def test_분기값을_연간으로_오인하지_않는다(self):
        """Neutron 사고: end 만 보고 최신값을 집으면 분기 매출과 연간 순이익이 섞인다."""
        us = facts(
            Revenues=[
                flow('2025-01-01', '2025-12-31', 304_000_000),   # 연간
                flow('2026-01-01', '2026-03-31', 80_000_000),    # 분기 — 더 최신
            ],
            NetIncomeLoss=[flow('2025-01-01', '2025-12-31', 12_000_000)],
        )
        result = annual_financials(us)
        assert result['revenue'] == 304_000_000
        assert result['fiscalEnd'] == '2025-12-31'

    def test_회계연도를_하나로_맞춘다(self):
        """revenue 의 연도에 없는 항목은 생략한다. 서로 다른 해를 나란히 놓지 않는다."""
        us = facts(
            Revenues=[flow('2025-01-01', '2025-12-31', 100)],
            NetIncomeLoss=[flow('2024-01-01', '2024-12-31', 999)],   # 다른 해
        )
        result = annual_financials(us)
        assert result['revenue'] == 100
        assert result['netIncome'] is None

    def test_매출이_없으면_순이익으로_기준연도를_잡는다(self):
        us = facts(NetIncomeLoss=[flow('2025-01-01', '2025-12-31', -65_000_000)])
        result = annual_financials(us)
        assert result['fiscalEnd'] == '2025-12-31'
        assert result['revenue'] is None
        assert result['netIncome'] == -65_000_000

    def test_연간값이_하나도_없으면_None(self):
        """분기값만 있으면 재무 블록을 통째로 생략한다."""
        us = facts(Revenues=[flow('2026-01-01', '2026-03-31', 80_000_000)])
        assert annual_financials(us) is None

    def test_빈_입력(self):
        assert annual_financials({}) is None
        assert annual_financials(None) is None

    def test_매출_태그_우선순위(self):
        us = facts(
            RevenueFromContractWithCustomerExcludingAssessedTax=[
                flow('2025-01-01', '2025-12-31', 222)
            ],
            NetIncomeLoss=[flow('2025-01-01', '2025-12-31', 1)],
        )
        assert annual_financials(us)['revenue'] == 222

    def test_assets_는_기간이_없어도_잡는다(self):
        """Assets 는 시점(instant) 항목이라 start 가 없다. 기간 필터로 걸러지면 안 된다."""
        us = facts(
            Revenues=[flow('2025-01-01', '2025-12-31', 100)],
            Assets=[instant('2025-12-31', 5_000)],
        )
        assert annual_financials(us)['assets'] == 5_000
