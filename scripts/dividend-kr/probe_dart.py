#!/usr/bin/env python3
"""국내 배당 데이터 프로브 — DART alotMatter 가 쓸 만한지 확인만 한다.

    DART_API_KEY=... python3 scripts/dividend-kr/probe_dart.py

**아무 파일도 쓰지 않는다.** `stock-dividend-kr` 착수 전에 확인할 것만 찍어 본다
(stock-tools/README.md: "DART alotMatter 는 문서로만 확인했고 실측하지 않았다").

🔴 **키를 절대 출력하지 않는다.** CI 로그는 저장소를 볼 수 있는 사람이 다 읽는다.
   Actions 가 secrets 를 마스킹해 주지만 그것에 기대지 않는다.

확인할 것
  1) alotMatter 응답에 **시가배당률**이 실제로 들어 있나 (핵심 — 이 앱의 축이 될 값)
  2) 몇 년치를 받을 수 있나 (연속 증액 대신 쓸 축을 정하려면 시계열 길이가 필요)
  3) corpCode 로 상장 종목이 몇 개나 잡히나 (호출 예산 계산의 분모)
  4) 종목당 호출 지연 — 일 20,000건 한도 안에서 몇 사 × 몇 년이 가능한가
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from xml.etree import ElementTree

KEY = os.environ.get('DART_API_KEY', '').strip()
if not KEY:
    sys.exit('DART_API_KEY 환경변수가 필요합니다.')

BASE = 'https://opendart.fss.or.kr/api'
UA = {'User-Agent': 'minilabs-data-hub probe kyungtaekim@odkmedia.net'}
# 11011 사업보고서 · 11012 반기 · 11013 1분기 · 11014 3분기
ANNUAL = '11011'


def get(path: str, **params):
    params['crtfc_key'] = KEY
    url = f'{BASE}/{path}?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=25) as f:
        return f.read()


def get_json(path: str, **params):
    return json.loads(get(path, **params))


def corp_map() -> dict[str, tuple[str, str]]:
    """상장 종목만: 종목코드 -> (corp_code, 회사명). corpCode.zip 은 호출 1회다."""
    raw = get('corpCode.xml')
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        xml = z.read(z.namelist()[0])
    out = {}
    for e in ElementTree.fromstring(xml).iter('list'):
        stock = (e.findtext('stock_code') or '').strip()
        # 빈 stock_code = 비상장 (ipo_dart.py 의 판별과 같다)
        if stock and stock != ' ':
            out[stock] = (e.findtext('corp_code').strip(), (e.findtext('corp_name') or '').strip())
    return out


def main() -> int:
    print('══ 1. corpCode — 상장 종목 수 ══')
    t0 = time.time()
    cm = corp_map()
    print(f'  상장 종목 {len(cm):,}개 · {time.time() - t0:.1f}초 (호출 1회)\n')

    # 배당을 오래 준 대표 종목들. 이름이 아니라 종목코드로 찾는다
    SAMPLE = {
        '005930': '삼성전자', '033780': 'KT&G', '017670': 'SK텔레콤',
        '005380': '현대차', '055550': '신한지주', '000810': '삼성화재',
        '316140': '우리금융지주', '105560': 'KB금융',
    }

    print('══ 2. alotMatter 응답 구조 (삼성전자 2024) ══')
    cc = cm.get('005930', (None, ''))[0]
    if not cc:
        print('  🔴 005930 을 corpCode 에서 못 찾았다')
        return 1
    r = get_json('alotMatter.json', corp_code=cc, bsns_year='2024', reprt_code=ANNUAL)
    print(f"  status={r.get('status')} message={r.get('message')}")
    rows = r.get('list') or []
    print(f'  항목 {len(rows)}개')
    labels = []
    for x in rows:
        se = (x.get('se') or '').strip()
        labels.append(se)
        print(f"    {se[:36]:38} 당기 {(x.get('thstrm') or ''):>12}  전기 {(x.get('frmtrm') or ''):>12}")

    print('\n══ 3. 배당수익률이 있나 (이 앱의 축) ══')
    # ⚠️ DART 표기는 '시가배당률' 이 아니라 **'현금배당수익률(%)'** 이다.
    #    '시가배당' 으로 찾으면 값이 있는데도 없다고 나온다 (2026-08-25 실측).
    hit = [l for l in labels if '배당수익률' in l]
    print(f"  {'✅ 있다: ' + ' / '.join(hit) if hit else '🔴 없다'}")

    print('\n══ 3-b. 값이 2줄씩 나오는 이유 — 주식 종류 구분 ══')
    # 삼성전자는 보통주(005930)·우선주(005935) 가 있어 항목마다 2줄이다.
    # 무엇으로 가르는지 모르면 우선주 수익률을 보통주 것으로 쓰게 된다.
    raw = r.get('list') or []
    keys = sorted({k for x in raw for k in x})
    print(f'  응답 필드: {keys}')
    for x in raw:
        if '배당수익률' in (x.get('se') or '') or '주당 현금배당금' in (x.get('se') or ''):
            extra = {k: v for k, v in x.items() if k not in ('se', 'thstrm', 'frmtrm', 'lwfr',
                                                             'rcept_no', 'corp_code', 'corp_cls',
                                                             'stlm_dt', 'status', 'message')}
            print(f"    {(x.get('se') or '')[:22]:24} 당기={x.get('thstrm'):>8}  {extra}")

    print('\n══ 4. 몇 년치를 받을 수 있나 (삼성전자) ══')
    ok_years = []
    for y in range(2015, 2026):
        try:
            rr = get_json('alotMatter.json', corp_code=cc, bsns_year=str(y), reprt_code=ANNUAL)
            n = len(rr.get('list') or [])
            ok_years.append((y, rr.get('status'), n))
        except Exception as e:
            ok_years.append((y, type(e).__name__, 0))
        time.sleep(0.05)
    good = [y for y, s, n in ok_years if s == '000' and n]
    print('  ' + ' '.join(f"{y}:{'✅' if s == '000' and n else '—'}" for y, s, n in ok_years))
    print(f'  받아지는 연도 {len(good)}개 ({min(good)}~{max(good)})' if good else '  🔴 없음')

    print('\n══ 5. 종목당 호출 지연 · 예산 ══')
    t0 = time.time()
    got = 0
    for code, name in SAMPLE.items():
        cc2 = cm.get(code, (None, ''))[0]
        if not cc2:
            print(f'  {code} {name}: corpCode 없음')
            continue
        rr = get_json('alotMatter.json', corp_code=cc2, bsns_year='2024', reprt_code=ANNUAL)
        lst = rr.get('list') or []
        y = next((x.get('thstrm') for x in lst if '시가배당' in (x.get('se') or '')), None)
        print(f"  {code} {name:8} status={rr.get('status')} 항목{len(lst):>3}  시가배당률={y}")
        got += 1
        time.sleep(0.05)
    el = time.time() - t0
    per = el / max(got, 1)
    print(f'\n  {got}종목 {el:.1f}초 → {per:.2f}s/건')
    print(f'  일 20,000건 한도 기준: 1년치면 {20000:,}사, 5년치면 {20000 // 5:,}사까지')
    print(f'  상장 {len(cm):,}개 × 5년 = {len(cm) * 5:,}건 → '
          f"{'한도 초과, 나눠 돌려야 한다' if len(cm) * 5 > 20000 else '한도 안에 들어간다'}")
    print(f'  소요 추정: {len(cm) * 5 * per / 60:.0f}분 (동시 실행 없이)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
