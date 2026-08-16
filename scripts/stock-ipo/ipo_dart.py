"""DART 오픈API에서 국내 IPO 공모정보를 수집한다.

핵심 판별: list.json 응답의 stock_code 가 빈값이면 비상장 = IPO.
slmthn(모집방법)으로는 구분되지 않는다 (유상증자도 '일반공모'로 나온다).
자세한 배경은 ../../docs/dart-ipo.md 참고.
"""
import json
import time
import urllib.parse
import urllib.request

from ipo_parse import is_ipo, is_spac, parse_date, parse_date_range, parse_number

BASE = 'https://opendart.fss.or.kr/api'


def _get(path, key, **params):
    params['crtfc_key'] = key
    url = f'{BASE}/{path}?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode('utf-8'))


def _fetch_filings(key, bgn, end):
    """발행공시(pblntf_ty=C) 중 증권신고서(지분증권)만 모은다.

    corp_code 없이 조회하면 검색기간 3개월 제한이 걸린다 (status 100).
    """
    out = []
    for page in range(1, 21):
        d = _get('list.json', key, bgn_de=bgn, end_de=end, pblntf_ty='C',
                 page_count='100', page_no=str(page))
        if d.get('status') != '000':
            if page == 1:
                print(f'  [list.json] {d.get("status")} {d.get("message")}')
            break
        out += d['list']
        if page >= int(d.get('total_page', 1)):
            break
        time.sleep(0.1)
    return [i for i in out if '증권신고서(지분증권)' in i['report_nm']]


def _clean(v):
    """DART는 빈 값을 '-' 로 준다."""
    v = (v or '').strip()
    return None if v in ('', '-') else v


def _fetch_offering(key, corp_code, bgn, end):
    """estkRs.json 에서 공모 상세를 뽑는다.

    status 013(데이터 없음)은 대부분 기재정정 진행 중 = 공모가 미확정 상태다.
    누락이 아니라 상태이므로 None 을 '확정 전'으로 다룬다.
    """
    r = _get('estkRs.json', key, corp_code=corp_code, bgn_de=bgn, end_de=end)
    if r.get('status') != '000':
        return None
    g = {x['title']: x['list'] for x in r['group']}
    gen = (g.get('일반사항') or [{}])[0]
    sec = (g.get('증권의종류') or [{}])[0]
    unders = g.get('인수인정보') or []
    lead = next((u for u in unders if u.get('actsen') == '대표'), (unders or [{}])[0])
    start, end_ = parse_date_range(gen.get('sbd'))
    return {
        'receiptNo': gen.get('rcept_no'),
        'subscriptionStart': start,
        'subscriptionEnd': end_,
        'paymentDate': parse_date(gen.get('pymd')),
        'noticeDate': parse_date(gen.get('sband')),
        'allotmentDate': parse_date(gen.get('asand')),
        'offerPrice': parse_number(sec.get('slprc')),
        'shareCount': parse_number(sec.get('stkcnt')),
        'totalAmount': parse_number(sec.get('slta')),
        'faceValue': parse_number(sec.get('fv')),
        'offerMethod': _clean(sec.get('slmthn')),
        'shareType': _clean(sec.get('stksen')),
        'underwriter': lead.get('actnmn'),
        # 청약은 인수단 계좌로만 넣을 수 있다. 어느 증권사인지가 실질 정보다.
        'underwriters': [{
            'name': _clean(u.get('actnmn')),
            'role': _clean(u.get('actsen')),
            'shareCount': parse_number(u.get('udtcnt')),
            'amount': parse_number(u.get('udtamt')),
            'method': _clean(u.get('udtmth')),
        } for u in unders if _clean(u.get('actnmn'))],
        # 공모로 걷은 돈을 어디에 쓰는지 — 다른 공모주 앱에 없는 정보다.
        'fundUse': [{
            'purpose': _clean(f.get('se')),
            'amount': parse_number(f.get('amt')),
        } for f in (g.get('자금의사용목적') or []) if _clean(f.get('se'))],
        # 구주매출 — 기존 주주가 파는 물량. 신주는 회사로, 구주는 주주에게 간다.
        'oldShareSales': [{
            'holder': _clean(s.get('hdr')),
            'relation': _clean(s.get('rl_cmp')),
            'before': parse_number(s.get('bfsl_hdstk')),
            'sold': parse_number(s.get('slstk')),
            'after': parse_number(s.get('atsl_hdstk')),
        } for s in (g.get('매출인에관한사항') or []) if _clean(s.get('hdr'))],
        # 환매청구권(풋백옵션) — 상장 후 정해진 값에 되팔 수 있는 권리. 손실 하한선이다.
        'putBack': _put_back((g.get('일반청약자환매청구권') or [{}])[0]),
    }


def _put_back(row):
    price = parse_number(row.get('exprc'))
    if not price:
        return None
    return {
        'price': price,
        # '상장일로부터\n3개월까지' 처럼 줄바꿈이 섞여 온다
        'period': ' '.join((_clean(row.get('expd')) or '').split()) or None,
        'shareCount': parse_number(row.get('grtcnt')),
        'target': _clean(row.get('exavivr')),
        'reason': _clean(row.get('grtrs')),
    }


EMPTY_DETAIL = {
    'receiptNo': None, 'subscriptionStart': None, 'subscriptionEnd': None,
    'paymentDate': None, 'noticeDate': None, 'allotmentDate': None,
    'offerPrice': None, 'shareCount': None, 'totalAmount': None,
    'faceValue': None, 'offerMethod': None, 'shareType': None,
    'underwriter': None, 'underwriters': [], 'fundUse': [],
    'oldShareSales': [], 'putBack': None,
}


# KSIC 대분류 2자리 -> 사람이 읽는 이름.
# 58(출판)에 게임·소프트웨어 개발이 들어간다 — '출판'만 쓰면 오해를 부른다.
INDUTY = {
    '10': '식료품', '11': '음료', '13': '섬유', '14': '의복',
    '15': '가죽·신발', '16': '목재', '17': '펄프·종이', '18': '인쇄',
    '19': '석유정제', '20': '화학', '21': '의약품', '22': '고무·플라스틱',
    '23': '비금속광물', '24': '1차 금속', '25': '금속가공',
    '26': '전자부품·통신장비', '27': '의료·정밀·광학기기', '28': '전기장비',
    '29': '기계·장비', '30': '자동차', '31': '기타 운송장비',
    '32': '가구', '33': '기타 제조', '34': '산업설비 수리',
    '35': '전기·가스', '36': '수도', '37': '폐기물',
    '41': '건설', '42': '전문공사', '45': '자동차 판매',
    '46': '도매', '47': '소매', '49': '육상운송', '50': '수상운송',
    '51': '항공운송', '52': '창고·운송지원', '55': '숙박', '56': '음식점',
    '58': '출판·소프트웨어', '59': '영상·음향', '60': '방송', '61': '통신',
    '62': '컴퓨터 프로그래밍', '63': '정보서비스',
    '64': '금융', '65': '보험', '66': '금융지원', '68': '부동산',
    '70': '연구개발', '71': '전문서비스', '72': '건축·엔지니어링',
    '73': '기타 과학기술', '74': '사업시설관리', '75': '사업지원',
    '85': '교육', '86': '보건업', '87': '사회복지',
    '90': '창작·예술', '91': '스포츠·오락',
}


def _url(v):
    """DART는 스킴 없이 주기도 한다 ('www.kido.co.kr', 'typecast.ai')."""
    v = _clean(v)
    if not v:
        return None
    v = v.rstrip('/')
    if not v.startswith(('http://', 'https://')):
        v = 'https://' + v
    return v


def fetch_company(key, corp_code):
    """회사 개요. 대표자·설립일·업종·주소·홈페이지를 준다.

    ⚠️ '대표 제품' 이나 사업 설명에 해당하는 필드는 없다.
       company.json 은 법인 등록 정보이지 기업 소개가 아니다.
       사업의 내용은 증권신고서 본문(document.xml)에만 있다.
    """
    r = _get('company.json', key, corp_code=corp_code)
    if r.get('status') != '000':
        return None
    code = _clean(r.get('induty_code')) or ''
    est = _clean(r.get('est_dt'))
    return {
        'ceo': _clean(r.get('ceo_nm')),
        'establishedAt': f'{est[:4]}-{est[4:6]}-{est[6:8]}' if est and len(est) == 8 else None,
        'indutyCode': code or None,
        'indutyName': INDUTY.get(code[:2]),
        'address': _clean(r.get('adres')),
        'englishName': _clean(r.get('corp_name_eng')),
        # SPAC은 페이퍼컴퍼니라 대부분 없다. 실질 기업은 약 80%가 있다
        'homepage': _url(r.get('hm_url')),
    }


def fetch_ipos(key, bgn, end):
    """기간 내 IPO 목록을 반환한다. 공모가 미확정 건도 포함한다."""
    filings = _fetch_filings(key, bgn, end)
    print(f'  증권신고서(지분증권) {len(filings)}건')

    companies = {}
    for f in filings:
        companies.setdefault(f['corp_code'], f)

    ipos = [c for c in companies.values() if is_ipo(c)]
    print(f'  비상장(IPO) {len(ipos)} / 상장(유상증자) {len(companies) - len(ipos)}')

    rows = []
    for c in ipos:
        detail = _fetch_offering(key, c['corp_code'], bgn, end)
        time.sleep(0.1)
        company = fetch_company(key, c['corp_code'])
        rows.append({
            'corpCode': c['corp_code'],
            'corpName': c['corp_name'],
            'isSpac': is_spac(c['corp_name']),
            **(detail or dict(EMPTY_DETAIL)),
            'company': company,
            # BRAND.md: 외부 링크는 종목당 1개까지. 공시 원문이 그 하나다.
            'dartUrl': (f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={detail['receiptNo']}"
                        if detail and detail.get('receiptNo') else None),
        })
        time.sleep(0.1)
    return rows
