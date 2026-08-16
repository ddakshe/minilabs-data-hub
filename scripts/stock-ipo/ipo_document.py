"""증권신고서 원문(document.xml)에서 사업 내용과 총 발행주식수를 뽑는다.

estkRs·company.json 에 없는 것들이 여기 있다:
  - 사업의 개요      "웨어러블 의료기기 및 데이터 플랫폼을 개발·제조·판매하는..."
  - 주요 제품        "CART BP pro", "CART BP"
  - 총 발행주식수     16,681,977주 -> 예상 시가총액 계산의 근거

원문은 5MB 남짓이라 매번 받으면 배치가 무거워진다. 정정공시가 나야 내용이 바뀌므로
receiptNo 를 키로 추출 결과만 캐시한다 (원문은 버린다). 캐시는 커밋한다 —
CI 에서도 같은 문서를 다시 받지 않게 하려는 것이다.
"""
import io
import json
import re
import urllib.parse
import urllib.request
import zipfile

from ipo_parse import parse_number
from ipo_paths import DOC_CACHE as CACHE

BASE = 'https://opendart.fss.or.kr/api'

# 추출 로직이 바뀌면 올린다. 캐시에는 원문이 아니라 추출 결과만 담기므로
# 로직 변경 시 다시 받아야 한다.
EXTRACT_VERSION = 3


def _load_cache():
    if CACHE.exists():
        try:
            return json.loads(CACHE.read_text(encoding='utf-8'))
        except json.JSONDecodeError:
            pass
    return {}


def _save_cache(cache):
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding='utf-8')


def _plain(fragment, keep_tables=False):
    """XML 조각을 읽을 수 있는 텍스트로. 표는 통째로 버린다 (숫자 나열이라 문장이 깨진다)."""
    if not keep_tables:
        fragment = re.sub(r'<TABLE.*?</TABLE>', ' ', fragment, flags=re.S | re.I)
    text = re.sub(r'<[^>]+>', ' ', fragment)
    text = re.sub(r'&[a-zA-Z]+;|&#\d+;', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


def _section(doc, title):
    """<TITLE>제목</TITLE> 부터 다음 <TITLE> 전까지."""
    m = re.search(r'<TITLE[^>]*>\s*' + re.escape(title) + r'\s*</TITLE>(.*?)(?=<TITLE)',
                  doc, re.S)
    return m.group(1) if m else None


def _sentences(text, max_chars):
    """문장 경계에서 자른다. 중간에 끊기면 읽다 만 느낌이 난다."""
    if not text:
        return None
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    end = max(cut.rfind('. '), cut.rfind('다. '), cut.rfind('니다.'))
    return (cut[:end + 1] if end > max_chars * 0.4 else cut).strip() + '…'


def _lead(text, max_chars):
    """본문 시작점을 찾아 자른다.

    표를 걷어내도 '[주요 용어 설명]', '가. 개요' 같은 소제목 조각이 앞에 남는다.
    국내 공시는 거의 예외 없이 '당사는/당사의' 로 본문을 시작하므로 그 지점부터 취한다.
    """
    if not text:
        return None
    m = re.search(r'(당사|동사|회사)(는|의|가|와|에서)', text)
    if m and m.start() < 300:
        text = text[m.start():]
    return _sentences(text.strip(), max_chars)


# 확정가는 [발행조건확정] 원문에만 있다.
# "1주당 확정공모가액을 41,200원으로 결정하였습니다" 형태.
_CONFIRMED = [
    re.compile(r'확정공모가액을\s*([\d,]+)\s*원으로\s*결정'),
    re.compile(r'1주당\s*확정공모가액[은는이가]\s*([\d,]+)\s*원'),
]

# 희망밴드. 최초·[기재정정] 신고서에 있다.
# "희망공모가액인 30,000원~41,200원", "공모희망가 13,000원 ~ 16,000원"
_BAND = [
    re.compile(r'희망공모가액[인은는이]?\s*([\d,]+)\s*원\s*~\s*([\d,]+)\s*원'),
    re.compile(r'공모희망가[액]?\s*([\d,]+)\s*원\s*~\s*([\d,]+)\s*원'),
]


def _flat(doc):
    t = re.sub(r'<[^>]+>|&[a-zA-Z]+;|&#\d+;', ' ', doc)
    return re.sub(r'\s+', ' ', t)


def _confirmed_price(doc):
    t = _flat(doc)
    for pat in _CONFIRMED:
        m = pat.search(t)
        if m:
            return parse_number(m.group(1))
    return None


def _price_band(doc):
    t = _flat(doc)
    for pat in _BAND:
        m = pat.search(t)
        if m:
            lo, hi = parse_number(m.group(1)), parse_number(m.group(2))
            if lo and hi and lo <= hi:
                return lo, hi
    return None, None


def _total_shares(doc):
    """'4. 주식의 총수 등' 표에서 현재까지 발행한 주식의 총수."""
    body = _section(doc, '4. 주식의 총수 등')
    if not body:
        return None
    cells = [_plain(c, keep_tables=True) for c in re.findall(r'<TD[^>]*>(.*?)</TD>', body, re.S)]
    for i, c in enumerate(cells):
        if '현재까지 발행한 주식의 총수' in c:
            # 보통주 / 우선주 / 합계 / 비고 순. 합계를 쓰되 우선주가 '-' 면 보통주와 같다
            nums = [n for n in (parse_number(x) for x in cells[i + 1:i + 5]) if n]
            return max(nums) if nums else None
    return None


def _products(doc):
    """'2. 주요 제품 및 서비스' — 매출 비중 표 뒤의 '주요 제품 등의 내용' 서술."""
    body = _section(doc, '2. 주요 제품 및 서비스')
    if not body:
        return None
    text = _plain(body)
    # '나. 주요 제품 등의 내용' 같은 소제목 뒤가 본문이다
    m = re.search(r'주요\s*제품\s*등의\s*내용\s*(.+)', text)
    return _lead(m.group(1) if m else text, 420)


def fetch_document(key, rcept_no, cache=None):
    """추출 결과를 반환한다. 캐시에 있으면 원문을 받지 않는다."""
    if not rcept_no:
        return None
    cache = _load_cache() if cache is None else cache
    hit = cache.get(rcept_no)
    if hit and hit.get('v') == EXTRACT_VERSION:
        return hit

    url = f'{BASE}/document.xml?' + urllib.parse.urlencode(
        {'crtfc_key': key, 'rcept_no': rcept_no})
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        raw = urllib.request.urlopen(req, timeout=120).read()
    except Exception as e:
        print(f'    [원문] {rcept_no} 실패: {e}')
        return None
    if not raw.startswith(b'PK'):
        print(f'    [원문] {rcept_no} ZIP 아님')
        return None

    z = zipfile.ZipFile(io.BytesIO(raw))
    blob = z.read(z.namelist()[0])
    for enc in ('utf-8', 'euc-kr', 'cp949'):
        try:
            doc = blob.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        doc = blob.decode('utf-8', 'replace')

    overview = _section(doc, '1. 사업의 개요')
    lo, hi = _price_band(doc)
    result = {
        'v': EXTRACT_VERSION,
        'businessSummary': _lead(_plain(overview) if overview else None, 300),
        'products': _products(doc),
        'totalShares': _total_shares(doc),
        'bandLow': lo,
        'bandHigh': hi,
        'confirmedPrice': _confirmed_price(doc),
    }
    cache[rcept_no] = result
    _save_cache(cache)
    return result


def enrich(key, items):
    """각 종목에 원문 정보와 파생 지표를 붙인다."""
    cache = _load_cache()
    hit = miss = 0
    for it in items:
        rn = it.get('receiptNo')
        cached = cache.get(rn) if rn else None
        if cached and cached.get('v') == EXTRACT_VERSION:
            hit += 1
        elif rn:
            miss += 1
        doc = fetch_document(key, rn, cache) or {}

        # 확정가는 [발행조건확정] 원문에만 있다. 없으면 아직 수요예측 전이다.
        crn = it.get('confirmedRceptNo')
        cdoc = fetch_document(key, crn, cache) if crn else None
        price = (cdoc or {}).get('confirmedPrice')

        it['offerPrice'] = price
        # 원문에서 밴드를 못 읽으면 estkRs 의 slprc(=밴드 하한)로 대신한다
        it['priceBandLow'] = doc.get('bandLow') or it.pop('bandLow', None)
        it['priceBandHigh'] = doc.get('bandHigh')
        it.pop('bandLow', None)
        it.pop('confirmedRceptNo', None)

        total = doc.get('totalShares')
        sold = sum(s['sold'] or 0 for s in it.get('oldShareSales') or [])
        offered = it.get('shareCount') or 0
        # 상장 후 주식수 = 현재 발행분 + 신주(공모 물량에서 구주매출을 뺀 것)
        after = total + max(offered - sold, 0) if total else None

        # estkRs 의 slta 는 밴드 하한 기준이라 확정가와 어긋난다. 다시 계산한다
        it['totalAmount'] = price * offered if price and offered else None

        it['businessSummary'] = doc.get('businessSummary')
        it['products'] = doc.get('products')
        it['totalShares'] = total
        it['sharesAfterListing'] = after
        it['estimatedMarketCap'] = after * price if after and price else None
        it['floatRatio'] = round(offered / after, 4) if after and offered else None
    print(f'  [원문] 캐시 {hit}건 / 신규 {miss}건')
    return items
