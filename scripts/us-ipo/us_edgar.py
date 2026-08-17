"""SEC EDGAR 접근. 키도 IP 등록도 필요 없다 — User-Agent 에 연락처만 넣으면 된다.

이것이 이 앱이 성립하는 이유다. 토스증권 API 는 허용 IP 사전 등록이 필수라
GitHub Actions 에서 부를 수 없다.
"""
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = os.environ.get('SEC_USER_AGENT', 'stock-tools kyungtaekim@odkmedia.net')

# SEC 권고는 초당 10회 이하. 여유를 두고 0.15초.
_THROTTLE = 0.15
_TIMEOUT = 60
_PAGE = 100          # full-text search 한 페이지 상한 (실측 98건이 한 번에 왔다)
_MAX_PAGES = 20      # 폭주 방지. 2000건이면 어떤 기간이든 충분하다


def _request(url, raw=False):
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    body = urllib.request.urlopen(req, timeout=_TIMEOUT).read()
    time.sleep(_THROTTLE)
    return body if raw else json.loads(body.decode())


def search_filings(form, start, end):
    """지정 기간의 공시를 전부 가져온다. 100건을 넘으면 이어서 받는다."""
    collected = []
    for page in range(_MAX_PAGES):
        params = urllib.parse.urlencode({
            'q': '"initial public offering"',
            'forms': form,
            'dateRange': 'custom',
            'startdt': start,
            'enddt': end,
            'from': page * _PAGE,
        })
        try:
            data = _request(f'https://efts.sec.gov/LATEST/search-index?{params}')
        except urllib.error.HTTPError:
            break
        hits = (data.get('hits') or {}).get('hits') or []
        collected.extend(hits)
        if len(hits) < _PAGE:
            break
    return collected


def hit_cik(hit):
    ciks = (hit.get('_source') or {}).get('ciks') or ['']
    return ciks[0]


def hit_name(hit):
    names = (hit.get('_source') or {}).get('display_names') or []
    return ', '.join(names)


def hit_filed_at(hit):
    return (hit.get('_source') or {}).get('file_date') or ''


def dedupe_by_cik(hits):
    """CIK 당 가장 최근 제출건만 남기고, 원래 등장 순서를 유지한다."""
    best = {}
    order = []
    for h in hits:
        cik = hit_cik(h)
        if not cik:
            continue
        if cik not in best:
            order.append(cik)
            best[cik] = h
        elif hit_filed_at(h) > hit_filed_at(best[cik]):
            best[cik] = h
    return [best[c] for c in order]


def document_url(hit):
    accession, filename = hit['_id'].split(':', 1)
    cik = hit_cik(hit).lstrip('0')
    return (
        f'https://www.sec.gov/Archives/edgar/data/{cik}/'
        f"{accession.replace('-', '')}/{filename}"
    )


def strip_html(html):
    text = re.sub(r'(?is)<(script|style).*?</\1>', ' ', html)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = text.replace('&nbsp;', ' ').replace('&#160;', ' ').replace('&amp;', '&')
    return re.sub(r'\s+', ' ', text).strip()


def fetch_document_text(hit):
    return strip_html(_request(document_url(hit), raw=True).decode('utf-8', 'replace'))


def fetch_submissions(cik):
    """회사 메타 (티커·SIC·소재지). 없으면 None."""
    try:
        return _request(f'https://data.sec.gov/submissions/CIK{cik.zfill(10)}.json')
    except (urllib.error.HTTPError, urllib.error.URLError, ValueError):
        return None


# 희망 공모밴드가 실려 있는 등록신고서. 수정본(/A)이 확정에 가장 가깝다.
# 외국 발행인은 S-1 이 아니라 F-1 을 낸다 — Londian Wason·Ticketplus 가 그 경우였다.
REGISTRATION_FORMS = ('S-1/A', 'F-1/A', 'S-1', 'F-1')


def latest_registration_url(cik, sub):
    """직전 등록신고서의 본문 URL. 없으면 None.

    이미 받아둔 submissions 응답을 재사용한다 — 별도 요청을 하지 않는다.
    """
    recent = ((sub or {}).get('filings') or {}).get('recent') or {}
    forms = recent.get('form') or []
    accessions = recent.get('accessionNumber') or []
    documents = recent.get('primaryDocument') or []

    for wanted in REGISTRATION_FORMS:
        for i, form in enumerate(forms):
            if form != wanted or i >= len(accessions) or i >= len(documents):
                continue
            if not documents[i]:
                continue
            return (
                f'https://www.sec.gov/Archives/edgar/data/{cik.lstrip("0")}/'
                f'{accessions[i].replace("-", "")}/{documents[i]}'
            )
    return None


def fetch_text(url):
    """임의 공시 본문을 평문으로. 실패하면 None."""
    try:
        return strip_html(_request(url, raw=True).decode('utf-8', 'replace'))
    except (urllib.error.HTTPError, urllib.error.URLError, ValueError):
        return None


def fetch_company_facts(cik):
    """XBRL us-gaap 사실들. 상장 전 회사는 비어 있을 수 있다 — 정상이다."""
    try:
        data = _request(
            f'https://data.sec.gov/api/xbrl/companyfacts/CIK{cik.zfill(10)}.json'
        )
    except (urllib.error.HTTPError, urllib.error.URLError, ValueError):
        return {}
    return (data.get('facts') or {}).get('us-gaap') or {}
