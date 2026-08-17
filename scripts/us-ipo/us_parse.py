"""EDGAR 문서에서 값을 뽑는 순수 함수들. 네트워크를 타지 않는다."""
import re

# 미국 IPO 는 통상 $4 이상이고 나스닥 최저 상장가 기준도 $4 다.
# 액면가($0.0001)나 단주 가격을 공모가로 오독하는 것을 막는다.
MIN_PRICE = 1.0

# 느슨한 패턴("$N per share")은 워런트 행사가·최근 체결가·액면가를 전부 잡는다.
# 2026-08-17 실측에서 20건 중 7건이 오탐이었다. 앞에 "initial public offering price"가
# 붙고 그 사이에 마침표나 다른 금액이 없는 경우만 인정한다.
# 어순이 두 가지다. 실측:
#   ITG        "initial public offering price ... will be $16.00 per share"
#   Quantinuum "initial public offering price per share ... is $60.00"
# 둘 다 [^.$] 로 문장 경계와 다른 금액을 넘지 못하게 막는다.
_OFFER_PRICES = (
    re.compile(
        r'initial public offering price[^.$]{0,60}?\$\s*([\d,]+\.?\d*)\s*per\s+share',
        re.I,
    ),
    re.compile(
        r'initial public offering price\s+per\s+share[^.$]{0,60}?\$\s*([\d,]+\.?\d*)',
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
