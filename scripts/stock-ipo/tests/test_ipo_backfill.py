import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ipo_backfill import ipo_filings, new_codes, parse_corp_codes


def test_parse_corp_codes_keeps_only_listed():
    xml = '''<result>
      <list><corp_code>00229085</corp_code><corp_name>기도산업</corp_name>
        <corp_eng_name>KIDO</corp_eng_name><stock_code>282620</stock_code><modify_date>20260821</modify_date></list>
      <list><corp_code>01999999</corp_code><corp_name>비상장</corp_name>
        <corp_eng_name></corp_eng_name><stock_code> </stock_code><modify_date>20260101</modify_date></list>
      <list><corp_code>01947443</corp_code><corp_name>해치텍</corp_name>
        <corp_eng_name></corp_eng_name><stock_code>0155E0</stock_code><modify_date>20260825</modify_date></list>
    </result>'''
    assert parse_corp_codes(xml) == {'282620': '00229085', '0155E0': '01947443'}


def test_ipo_filings_excludes_merger_and_depositary_receipts():
    """2026-09-10 실측: 신규 코드 23개 중 세미티에스는 합병, 인제니아는 증권예탁증권이었다."""
    fl = [
        {'report_nm': '증권신고서(지분증권)'},
        {'report_nm': '[기재정정]증권신고서(지분증권)'},
        {'report_nm': '[발행조건확정]증권신고서(지분증권)'},
        {'report_nm': '[기재정정]증권신고서(합병)'},
        {'report_nm': '증권신고서(증권예탁증권)'},
        {'report_nm': '투자설명서'},
        {'report_nm': '증권발행실적보고서'},
    ]
    assert len(ipo_filings(fl)) == 3


def test_new_codes():
    assert new_codes({'005930': '삼성전자'}, {'005930': '삼성전자', '282620': '기도산업'}) == {'282620': '기도산업'}
