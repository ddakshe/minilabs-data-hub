"""EDGAR 문서에서 값을 뽑는 순수 함수들. 네트워크를 타지 않는다."""
import re

# 미국 IPO 는 통상 $4 이상이고 나스닥 최저 상장가 기준도 $4 다.
# 액면가($0.0001)나 단주 가격을 공모가로 오독하는 것을 막는다.
MIN_PRICE = 1.0

# 느슨한 패턴("$N per share")은 워런트 행사가·최근 체결가·액면가를 전부 잡는다.
# 2026-08-17 실측에서 20건 중 7건이 오탐이었다. 앞에 "initial public offering price"가
# 붙고 그 사이에 마침표나 다른 금액이 없는 경우만 인정한다.
# 표기가 네 가지다. 2026-08-17 실측에서 전부 확인했다:
#   ITG           "initial public offering price ... will be $16.00 per share"
#   Quantinuum    "initial public offering price per share ... is $60.00"
#   Londian Wason "initial public offering price per ADS is US$22.00"   ← ADS 상장
#   TCGX          "at an initial public offering price of $10.00"       ← per 단위 없음
#   East West     "Initial public offering price $ 10.000"              ← 표 형식
#
# [^.$] 로 문장 경계와 다른 금액을 넘지 못하게 막는 것이 오탐 방지의 핵심이다.
# 마지막 패턴은 느슨해 보이지만 $ 가 "price" 바로 뒤에 와야 하므로
# "price, less the underwriting..." (워런트) 나 "price could impact" (직상장) 은 걸리지 않는다.
_UNIT = r'(?:share|ADS|unit)s?'
_OFFER_PRICES = (
    re.compile(
        rf'initial public offering price[^.$]{{0,60}}?(?:US)?\$\s*([\d,]+\.?\d*)\s*per\s+{_UNIT}',
        re.I,
    ),
    re.compile(
        rf'initial public offering price\s+per\s+{_UNIT}[^.$]{{0,60}}?(?:US)?\$\s*([\d,]+\.?\d*)',
        re.I,
    ),
    re.compile(
        r'initial public offering price\s*(?:of|is|was)?\s*(?:US)?\$\s*([\d,]+\.?\d*)',
        re.I,
    ),
)

_SPAC_NAME = re.compile(r'\bAcquisition\b|\bCapital Corp\b|\bBlank Check\b', re.I)
_SPAC_TEXT = re.compile(r'blank check|special purpose acquisition', re.I)


def parse_number(s):
    """'8,580,000' -> 8580000. 숫자가 아니면 None."""
    if not s:
        return None
    cleaned = re.sub(r'[^\d.]', '', str(s))
    if not cleaned or cleaned == '.':
        return None
    try:
        return int(float(cleaned))
    except ValueError:
        return None


# 진짜 IPO 인지 가르는 게이트.
#
# 2026-08-17 실측에서 Janus Living 이 $20.00 로 목록에 들어왔다. 각주
# "NOTE 19 ... at the initial public offering price of $20.00" 을 잡은 것인데,
# Janus 는 이미 상장된 회사(최근가 $30.18)의 후속공모였다. 과거 IPO 가격이라
# 값 자체는 틀리지 않았지만 "방금 상장" 목록에 있어서는 안 된다.
#
# 가격 패턴을 조이는 것보다 이 게이트가 정확하다. 진짜 IPO 문서에는
# 예외 없이 아래 문장 중 하나가 있다 (ITG·Quantinuum·Apnimed 확인).
_IS_IPO = (
    re.compile(r'there\s+(?:has|have)\s+been\s+no\s+public\s+market', re.I),
    re.compile(r'no\s+established\s+public\s+(?:trading\s+)?market', re.I),
    re.compile(r'this\s+is\s+(?:our|the)\s+initial\s+public\s+offering', re.I),
    re.compile(r"this\s+is\s+[A-Z][\w.,&' ]{2,40}(?:’s|'s)\s+initial\s+public\s+offering", re.I),
)


def is_new_listing(text):
    """이 문서가 신규 상장(IPO)인지. 후속공모·직상장이면 False."""
    return any(p.search(text or '') for p in _IS_IPO)


def parse_offer_price(text):
    """확정 공모가. 못 뽑으면 None — 추측하지 않는다."""
    if not text:
        return None
    for pattern in _OFFER_PRICES:
        for m in pattern.finditer(text):
            raw = m.group(1).replace(',', '')
            try:
                value = float(raw)
            except ValueError:
                continue
            if value >= MIN_PRICE:
                return value
    return None


def sic_to_industry(sic):
    """SIC 코드를 한글 업종 12군으로 접는다.

    순서가 중요하다. 6770(SPAC)은 6000~6799(금융) 안에 있고,
    반도체 대역은 2000~3999(제조) 안에 있다. 좁은 것을 먼저 본다.
    """
    if sic is None:
        return '기타'
    try:
        n = int(str(sic).strip())
    except (TypeError, ValueError):
        return '기타'

    if n == 6770:
        return 'SPAC'
    if 2833 <= n <= 2836 or n == 8731:
        return '제약·바이오'
    if 3570 <= n <= 3579 or 3670 <= n <= 3679 or n == 3825:
        return '반도체·전자'
    if 7370 <= n <= 7379:
        return '소프트웨어·IT'
    if 6000 <= n <= 6799:
        return '금융·부동산'
    if 1000 <= n <= 1499:
        return '광업·자원'
    if 1500 <= n <= 1799:
        return '건설'
    if 4900 <= n <= 4999:
        return '에너지·유틸리티'
    if 4000 <= n <= 4899:
        return '운수·통신'
    if 5000 <= n <= 5999:
        return '유통·소매'
    if 2000 <= n <= 3999:
        return '제조'
    return '기타'


def is_spac(sic, name, text=None):
    """SIC 6770(Blank Checks)이 1순위. 이름 매칭은 정확도가 낮은 보조 수단이다."""
    if sic is not None and str(sic).strip():
        try:
            return int(str(sic).strip()) == 6770
        except (TypeError, ValueError):
            pass
    if text and _SPAC_TEXT.search(text):
        return True
    return bool(name and _SPAC_NAME.search(name))
