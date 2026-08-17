import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from us_parse import is_spac, parse_number, parse_offer_price, sic_to_industry

FIX = pathlib.Path(__file__).parent / 'fixtures'


def read(name):
    return (FIX / f'{name}_424b4.txt').read_text()


class TestOfferPrice:
    """실측(2026-08-17)에서 실제로 틀렸던 케이스를 고정한다."""

    def test_확정_공모가를_뽑는다(self):
        assert parse_offer_price(read('itg')) == 16.0
        assert parse_offer_price(read('quantinuum')) == 60.0

    def test_워런트_행사가를_공모가로_잡지_않는다(self):
        # $11.50 은 SPAC 워런트의 행사가지 공모가가 아니다
        assert parse_offer_price(read('churchill')) is None
        assert parse_offer_price(read('columbus')) is None

    def test_액면가를_공모가로_잡지_않는다(self):
        # par value $0.0001 — MIN_PRICE 로 걸러진다
        assert parse_offer_price(read('advasa')) is None

    def test_이미_거래중인_주식의_시세를_잡지_않는다(self):
        # 최근 체결가 $30.18 이 본문에 있으나 공모가가 아니다
        assert parse_offer_price(read('janus')) is None

    def test_문장이_없으면_None(self):
        assert parse_offer_price('아무 관계 없는 텍스트') is None


class TestParseNumber:
    def test_콤마를_제거한다(self):
        assert parse_number('8,580,000') == 8580000

    def test_숫자가_아니면_None(self):
        assert parse_number('') is None
        assert parse_number(None) is None
        assert parse_number('약간') is None


class TestSicToIndustry:
    def test_spac_이_금융보다_먼저_잡힌다(self):
        # 6770 은 6000~6799 범위 안이므로 순서가 뒤집히면 '금융·부동산'이 된다
        assert sic_to_industry('6770') == 'SPAC'

    def test_반도체가_제조보다_먼저_잡힌다(self):
        # 3674 는 2000~3999 범위 안이다
        assert sic_to_industry('3674') == '반도체·전자'

    def test_주요_업종(self):
        assert sic_to_industry('2836') == '제약·바이오'
        assert sic_to_industry('7372') == '소프트웨어·IT'
        assert sic_to_industry('6199') == '금융·부동산'
        assert sic_to_industry('4911') == '에너지·유틸리티'
        assert sic_to_industry('4512') == '운수·통신'
        assert sic_to_industry('5651') == '유통·소매'
        assert sic_to_industry('3510') == '제조'

    def test_모르면_기타(self):
        assert sic_to_industry(None) == '기타'
        assert sic_to_industry('') == '기타'
        assert sic_to_industry('9999') == '기타'


class TestIsSpac:
    def test_sic_6770_이면_spac(self):
        assert is_spac('6770', 'Anything Inc.') is True

    def test_sic_가_있으면_이름을_무시한다(self):
        # 이름에 Acquisition 이 있어도 SIC 가 사업회사면 사업회사다
        assert is_spac('3674', 'Foo Acquisition Corp.') is False

    def test_sic_가_없으면_이름으로_추정한다(self):
        assert is_spac(None, 'Karman Line Acquisition Corp.') is True
        assert is_spac(None, 'Churchill Capital Corp XIII') is True
        assert is_spac(None, 'Quantinuum Inc.') is False

    def test_본문이_있으면_본문을_우선한다(self):
        assert is_spac(None, 'Foo Inc.', 'we are a blank check company') is True
