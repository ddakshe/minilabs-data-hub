"""DART 응답 문자열을 정규화한다. 네트워크를 타지 않는 순수 함수만 둔다."""
import re

_DATE = re.compile(r'(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일')


def parse_date(s):
    """'2026년 09월 15일' -> '2026-09-15'. 못 읽으면 None."""
    if not s:
        return None
    m = _DATE.search(s)
    if not m:
        return None
    y, mo, d = m.groups()
    return f'{y}-{int(mo):02d}-{int(d):02d}'


def parse_date_range(s):
    """'2026년 09월 10일 ~ 2026년 09월 11일' -> ('2026-09-10', '2026-09-11').

    날짜가 하나면 시작=종료로 둔다. 못 읽으면 (None, None).
    """
    if not s:
        return (None, None)
    found = _DATE.findall(s)
    if not found:
        return (None, None)
    dates = [f'{y}-{int(mo):02d}-{int(d):02d}' for y, mo, d in found]
    return (dates[0], dates[-1])


def parse_number(s):
    """'16,500' -> 16500. 숫자가 없으면 None."""
    if not s:
        return None
    digits = re.sub(r'[^\d]', '', s)
    return int(digits) if digits else None


def normalize_corp_name(s):
    """조인 키. '(주)', '주식회사', 공백을 걷어낸다.

    DART corp_name 과 토스 stocks.name 을 잇는 유일한 수단이다
    (corp_code 와 symbol 은 체계가 다르다).
    """
    if not s:
        return ''
    out = s.strip()
    for marker in ('주식회사', '(주)', '（주）'):
        out = out.replace(marker, '')
    return re.sub(r'\s+', '', out)


def is_ipo(filing):
    """list.json 한 건이 IPO인지 판별한다.

    증권신고서(지분증권)에는 IPO와 유상증자가 섞여 있다.
    stock_code 가 빈값이면 비상장 = IPO 다. slmthn(모집방법)으로는 구분되지 않는다
    — 유상증자도 '일반공모'로 나오는 사례가 있다 (판타지오).
    """
    return not (filing.get('stock_code') or '').strip()


def is_spac(corp_name):
    """SPAC(기업인수목적회사) 판별. IPO 건수의 절반가량을 차지한다."""
    return '기업인수목적' in (corp_name or '')
