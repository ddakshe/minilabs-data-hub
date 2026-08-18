"""424B4 투자설명서 본문에서 공모 개요를 뽑는다.

2026-08-17 실측 교훈: 느슨한 패턴은 목차와 상투구를 잡는다.
'Use of Proceeds 85 Dividend Policy 86' 같은 목차 줄이 사업 설명으로,
'We are an emerging growth company' 가 사업 요약으로 잡혔다.
값을 못 뽑으면 None 을 낸다 — 잘못된 값보다 빈칸이 낫다.
"""
import re

from us_parse import parse_number

# 표기가 세 가지다. 2026-08-17 실측:
#   Scribe       "Scribe Therapeutics Inc. is offering 8,580,000 shares"   ← 주어가 회사명
#   Jersey Mike's "We are selling 13,782,609 shares"                       ← offering 이 아니라 selling
#   표지          "PROSPECTUS 8,580,000 Shares Common Stock"
#
# "there will be N shares outstanding after this offering" 은 발행 후 총수이지
# 공모 규모가 아니다. 앞에 are/is + offering/selling 을 요구해 걸러낸다.
_SHARES = (
    re.compile(r'\b(?:are|is)\s+(?:offering|selling)\s+([\d,]{7,})\s+(?:shares|ADSs|units)', re.I),
    re.compile(r'PROSPECTUS\s+([\d,]{7,})\s+(?:Shares|ADSs|Units)', re.I),
)

_EXCHANGES = (
    (re.compile(r'NYSE American', re.I), 'NYSE American'),
    (re.compile(r'New York Stock Exchange|\bNYSE\b', re.I), '뉴욕증권거래소'),
    (re.compile(r'Nasdaq', re.I), '나스닥'),
)

_UNDERWRITER_BLOCK = re.compile(
    r'(?:Book-Running Managers?|Lead Underwriters?|Representatives? of the Underwriters?)'
    r'(.{0,400})',
    re.I | re.S,
)
# 인수단 이름은 대문자로 시작하고 & . 를 포함할 수 있다. 흔한 접미사로 끝을 잡는다.
_UNDERWRITER_NAME = re.compile(
    r'\b([A-Z][A-Za-z.&\'\- ]{2,40}?'
    r'(?:LLC|Inc\.|LP|L\.P\.|Securities|Partners|Group|Capital Markets|& Co\.))'
)

_SUMMARY = re.compile(
    r'\b(We are (?:a|an|the)\b[^.]{40,300}\.|Our mission is[^.]{20,300}\.)'
)

# 공모 '전' 발행주식수. 문서는 "outstanding as of March 31, 2026" 형태로 기준일을
# 밝히는데 이건 공모 전 수치다. 시가총액을 내려면 공모주식수를 더해야 한다.
# 국내 앱에서 같은 함정(sharesAfterListing)을 밟은 적이 있다.
_SHARES_BEFORE = re.compile(
    r'([\d,]{7,})\s+shares of (?:our )?(?:Class A )?common stock'
    r'(?:\s+will be|\s+to be)?\s+outstanding',
    re.I,
)

# 바이오텍이 다수라 매출보다 순손실이 훨씬 자주 나온다.
# XBRL 이 없는 IPO 기업의 재무 대체재다.
#
# ⚠️ 2026-08-17 실측 교훈: 첫 매치를 집으면 대부분 틀린다. 투자설명서는
# 유동성 논의에서 분기 실적을 먼저 언급하는 경우가 많아 첫 문장이 분기일
# 확률이 오히려 높다 (Scribe·Apnimed 가 분기, Latigo·Attovia 가 구년도였다).
# us_xbrl.py 에서 지킨 '연간만, 최신만' 규율을 여기에도 적용한다.
#
# 두 어순을 다 본다:
#   "for the year ended December 31, 2025, the Company had a net loss of $66.1 million"
#   "net loss of $61.2 million for the year ended December 31, 2024"
_YEAR = r'(?:fiscal\s+)?year\s+ended\s+\w+\s+\d{1,2},?\s*(20\d\d)'
_RESULT = r'net\s+(loss|income)\s+of\s+\$\s*([\d,.]+)\s*(million|billion)?'

_ANNUAL_FORWARD = re.compile(rf'{_YEAR}[^.]{{0,140}}?{_RESULT}', re.I)
_ANNUAL_BACKWARD = re.compile(rf'{_RESULT}[^.]{{0,100}}?for\s+the\s+{_YEAR}', re.I)

# 아래가 문장에 있으면 어느 해·어느 기간의 값인지 확정할 수 없다.
#   "net losses of $47.8 million and $21.8 million, respectively" — 두 해를 나열
#   "three/six/nine months ended" — 분기·반기
_AMBIGUOUS = re.compile(
    r'\band\s+\$|respectively|(?:three|six|nine)\s+months\s+ended', re.I,
)

_USE_OF_PROCEEDS = re.compile(
    r'(?:we (?:currently )?intend to use|we expect to use|intend to use)'
    r'\s+(?:the\s+)?net proceeds[^.]{30,260}\.',
    re.I,
)

_LOCKUP = re.compile(
    r'lock-up (?:agreements?|period)[^.]{0,40}?(\d{2,3})\s*days', re.I,
)
# 상투구·목차 배제.
#   - emerging growth company: 법적 지위 고지이지 사업 설명이 아니다
#   - "Dividend Policy 86 Capitalization" 처럼 단어 사이에 쪽번호가 끼면 목차다
_SUMMARY_REJECT = re.compile(
    r'emerging growth company|smaller reporting company|shell company'
    r'|[A-Z][a-z]+\s+\d{1,3}\s+[A-Z][a-z]+'
    r'|Use of Proceeds\s+\d',
)


def _shares_offered(text):
    for pattern in _SHARES:
        m = pattern.search(text)
        if m:
            return parse_number(m.group(1))
    return None


def _exchange(text):
    for pattern, label in _EXCHANGES:
        if pattern.search(text):
            return label
    return None


def _underwriters(text):
    m = _UNDERWRITER_BLOCK.search(text)
    if not m:
        return []
    names, seen = [], set()
    for cand in _UNDERWRITER_NAME.finditer(m.group(1)):
        name = cand.group(1).strip()
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        names.append(name)
        if len(names) >= 6:
            break
    return names


def _business_summary(text):
    for m in _SUMMARY.finditer(text):
        sentence = m.group(1).strip()
        if _SUMMARY_REJECT.search(sentence):
            continue
        return sentence
    return None


_SCALE = {'million': 1_000_000, 'billion': 1_000_000_000}


def _shares_before(text):
    m = _SHARES_BEFORE.search(text)
    return parse_number(m.group(1)) if m else None


def _net_result(text):
    """(순손익 달러, 회계연도) 또는 (None, None). 손실은 음수.

    연간 실적만, 그중 가장 최근 연도만 쓴다. 기간이나 연도가 모호한 문장은
    통째로 버린다 — 분기값을 연간처럼 보여주는 것이 값을 비워두는 것보다 나쁘다.

    매출은 뽑지 않는다 — 'Internal Revenue Code' 를 매출로 잡는 오탐이 나서
    본문 정규식으로는 신뢰할 수 없다. 표 파싱이 필요하다.
    """
    found = {}     # 연도 -> 금액
    for pattern, order in ((_ANNUAL_FORWARD, 'year_first'), (_ANNUAL_BACKWARD, 'value_first')):
        for m in pattern.finditer(text):
            if _AMBIGUOUS.search(m.group(0)):
                continue
            if order == 'year_first':
                year, kind, raw, scale = m.group(1), m.group(2), m.group(3), m.group(4)
            else:
                kind, raw, scale, year = m.group(1), m.group(2), m.group(3), m.group(4)
            try:
                value = float(raw.replace(',', ''))
            except ValueError:
                continue
            # 단위가 없는 맨 숫자는 신뢰하지 않는다. 재무제표가 '천 달러 단위'로
            # 표기된 표에서 잘려 나온 값일 수 있다 ($475 같은 값이 그래서 나왔다).
            unit = _SCALE.get((scale or '').lower())
            if unit is None:
                continue
            sign = -1 if kind.lower() == 'loss' else 1
            # int() 는 버림이다. 66.1 * 1e6 = 66099999.99… 라 66,099,999 가 된다.
            found.setdefault(year, round(sign * value * unit))

    if not found:
        return None, None
    year = max(found)
    return found[year], year


def _use_of_proceeds(text):
    m = _USE_OF_PROCEEDS.search(text)
    if not m:
        return None
    # HTML 엔티티가 남은 목록(&#149; 등)은 문장으로 읽히지 않는다
    sentence = re.sub(r'&#?\w+;', ' ', m.group(0))
    return re.sub(r'\s+', ' ', sentence).strip()


def _lockup_days(text):
    m = _LOCKUP.search(text)
    return parse_number(m.group(1)) if m else None


def parse_prospectus(text):
    """못 뽑은 항목은 None / 빈 리스트다. 추측하지 않는다."""
    text = text or ''
    net_result, fiscal_year = _net_result(text)
    return {
        'sharesOffered': _shares_offered(text),
        'sharesBefore': _shares_before(text),
        'exchange': _exchange(text),
        'underwriters': _underwriters(text),
        'businessSummary': _business_summary(text),
        'netResult': net_result,
        # 어느 해 실적인지 함께 낸다. 화면에 "2025년 순손실" 로 적어야 사실이 된다.
        'netResultYear': fiscal_year,
        'useOfProceeds': _use_of_proceeds(text),
        'lockupDays': _lockup_days(text),
    }
