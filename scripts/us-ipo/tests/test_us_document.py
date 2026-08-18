import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from us_document import parse_prospectus

FIX = pathlib.Path(__file__).parent / 'fixtures'


class TestSharesOffered:
    def test_공모주식수를_뽑는다(self):
        text = 'We are offering 8,580,000 shares of our common stock.'
        assert parse_prospectus(text)['sharesOffered'] == 8_580_000

    def test_class_a_도_잡는다(self):
        text = 'We are offering 12,000,000 shares of Class A common stock.'
        assert parse_prospectus(text)['sharesOffered'] == 12_000_000

    def test_발행후_주식수를_공모주식수로_잡지_않는다(self):
        """'outstanding after this offering' 은 공모 규모가 아니다."""
        text = (
            'There will be 8,497,386 shares of our common stock outstanding '
            'after this offering.'
        )
        assert parse_prospectus(text)['sharesOffered'] is None


class TestExchange:
    def test_거래소를_한글로_바꾼다(self):
        assert parse_prospectus(
            'approved for listing on the Nasdaq Global Select Market'
        )['exchange'] == '나스닥'
        assert parse_prospectus(
            'listed on the New York Stock Exchange'
        )['exchange'] == '뉴욕증권거래소'
        assert parse_prospectus(
            'listed on the NYSE American'
        )['exchange'] == 'NYSE American'

    def test_없으면_None(self):
        assert parse_prospectus('아무 말')['exchange'] is None


class TestUnderwriters:
    def test_대표주관사를_뽑는다(self):
        text = 'Book-Running Managers Goldman Sachs & Co. LLC Morgan Stanley J.P. Morgan'
        names = parse_prospectus(text)['underwriters']
        assert any('Goldman Sachs' in n for n in names)

    def test_없으면_빈_리스트(self):
        assert parse_prospectus('아무 말')['underwriters'] == []


class TestBusinessSummary:
    def test_사업_설명을_뽑는다(self):
        text = (
            'We are a leading provider of quantum computing hardware and software '
            'for enterprise customers worldwide, serving over 200 institutions.'
        )
        summary = parse_prospectus(text)['businessSummary']
        assert summary is not None
        assert 'quantum computing' in summary

    def test_emerging_growth_company_상투구를_거른다(self):
        """실측에서 'We are an emerging growth company'가 먼저 잡혔다 — 사업 설명이 아니다."""
        text = (
            'We are an "emerging growth company" as defined under the federal '
            'securities laws and are subject to reduced reporting requirements.'
        )
        assert parse_prospectus(text)['businessSummary'] is None

    def test_목차를_사업설명으로_잡지_않는다(self):
        """실측에서 'Use of Proceeds 85 Dividend Policy 86' 같은 목차가 잡혔다."""
        text = 'We are a Use of Proceeds 85 Dividend Policy 86 Capitalization 87 leading firm.'
        assert parse_prospectus(text)['businessSummary'] is None


class TestRealDocument:
    def test_itg_fixture_에서_거래소를_뽑는다(self):
        result = parse_prospectus((FIX / 'itg_424b4.txt').read_text())
        assert result['exchange'] == '나스닥'

    def test_빈_입력(self):
        result = parse_prospectus('')
        assert result == {
            'sharesOffered': None,
            'sharesBefore': None,
            'exchange': None,
            'underwriters': [],
            'businessSummary': None,
            'netResult': None,
            'netResultYear': None,
            'useOfProceeds': None,
            'lockupDays': None,
        }


class TestSharesBefore:
    def test_공모전_주식수를_뽑는다(self):
        text = ('There will be 8,497,386 shares of our common stock outstanding '
                'as of March 31, 2026.')
        assert parse_prospectus(text)['sharesBefore'] == 8_497_386

    def test_class_a_도_잡는다(self):
        text = '232,834,177 shares of our Class A common stock outstanding'
        assert parse_prospectus(text)['sharesBefore'] == 232_834_177


class TestNetResult:
    """연간 실적만, 최신 연도만. 2026-08-17 실측에서 분기값과 구년도를 집는 버그가 있었다."""

    def test_연간_순손실은_음수다(self):
        text = 'For the year ended December 31, 2025, the Company had a net loss of $66.1 million.'
        assert parse_prospectus(text)['netResult'] == -66_100_000

    def test_연간_순이익은_양수다(self):
        text = 'For the year ended December 31, 2025, we had net income of $1.8 million.'
        assert parse_prospectus(text)['netResult'] == 1_800_000

    def test_값이_먼저_오는_어순도_잡는다(self):
        text = 'a net loss of $61.2 million for the year ended December 31, 2024'
        assert parse_prospectus(text)['netResult'] == -61_200_000

    def test_분기값은_버린다(self):
        """Scribe·Apnimed 회귀: MD&A 가 분기를 먼저 언급해 첫 매치가 분기였다."""
        text = 'including a net loss of $17.4 million for the three months ended March 31, 2026'
        assert parse_prospectus(text)['netResult'] is None

    def test_두_해를_나열하면_버린다(self):
        """'$47.8 million and $21.8 million, respectively' 는 어느 해 값인지 확정 불가."""
        text = ('for the years ended December 31, 2024 and 2025, we incurred net losses '
                'of $47.8 million and $21.8 million, respectively')
        assert parse_prospectus(text)['netResult'] is None

    def test_최신_연도를_고른다(self):
        """Latigo·Attovia 회귀: 구년도를 집었다."""
        text = ('a net loss of $61.2 million for the year ended December 31, 2024. '
                'Separately, a net loss of $109.2 million for the year ended December 31, 2025.')
        result = parse_prospectus(text)
        assert result['netResult'] == -109_200_000
        assert result['netResultYear'] == '2025'

    def test_단위_없는_맨_숫자는_버린다(self):
        """'$475' 처럼 million/billion 이 없으면 천 달러 단위 표에서 잘려 나온 값일 수 있다."""
        text = 'For the year ended December 31, 2025, a net loss of $475'
        assert parse_prospectus(text)['netResult'] is None

    def test_billion_단위(self):
        text = 'For the year ended December 31, 2025, a net loss of $1.2 billion'
        assert parse_prospectus(text)['netResult'] == -1_200_000_000

    def test_없으면_None(self):
        assert parse_prospectus('아무 말')['netResult'] is None
        assert parse_prospectus('아무 말')['netResultYear'] is None


class TestUseOfProceeds:
    def test_자금_사용목적을_뽑는다(self):
        text = ('We intend to use the net proceeds from this offering to advance '
                'our clinical programs and for general corporate purposes.')
        out = parse_prospectus(text)['useOfProceeds']
        assert out is not None and 'clinical programs' in out

    def test_html_엔티티를_지운다(self):
        text = ('We intend to use the net proceeds from this offering, together with '
                'existing cash, as follows: &#149; research and development spending.')
        out = parse_prospectus(text)['useOfProceeds']
        assert '&#149;' not in out

    def test_없으면_None(self):
        assert parse_prospectus('아무 말')['useOfProceeds'] is None


class TestLockup:
    def test_잠금기간을_뽑는다(self):
        assert parse_prospectus('lock-up period of 180 days')['lockupDays'] == 180

    def test_없으면_None(self):
        assert parse_prospectus('lock-up agreements; changes in accounting')['lockupDays'] is None
