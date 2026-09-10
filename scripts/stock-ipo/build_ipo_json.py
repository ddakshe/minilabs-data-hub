#!/usr/bin/env python3
"""공모주 미리보기 배치 — DART + 토스를 합쳐 stock-ipo/ipo.json 을 만든다.

    export DART_API_KEY=...
    export TOSS_CLIENT_ID=tsck_live_...      # 없으면 상장일 없이 진행
    export TOSS_CLIENT_SECRET=tssk_live_...
    export DATA_GO_KR_KEY=...                # 없으면 상장 후 성적 없이 진행
    python3 scripts/stock-ipo/build_ipo_json.py
    python3 scripts/stock-ipo/build_ipo_json.py --backfill-days 100   # 처음 한 번

일 1회 실행한다. 공모가는 [기재정정] 공시로 청약 며칠 전에 확정되므로
주 단위로 돌리면 '확정 전'인 채로 청약이 시작되는 구간이 생긴다.

⚠️ 토스 호출은 허용 IP 사전 등록이 필요하다.
"""
import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ipo_backfill import find_recent_listed
from ipo_dart import _get, fetch_ipos
from ipo_listed import attach_performance, legacy_items, lookup_stock_codes, retain_previous
from ipo_parse import is_spac
from ipo_paths import OUT, OUT_V2
from ipo_document import enrich
from ipo_toss import attach_list_dates, fetch_scheduled

KST = timezone(timedelta(hours=9))


def _load_previous():
    """어제 파일. 상장해서 수집분에서 빠진 공모주의 '기억' 이다 (ipo_listed.py 머리말).

    🚨 **v2 를 읽는다.** ipo.json 에는 상장 건을 싣지 않으므로 거기서 읽으면 기억이 하루 만에
       사라진다. v2 가 아직 없을 때(처음 한 번)만 ipo.json 으로 떨어진다.
    """
    src = OUT_V2 if OUT_V2.exists() else OUT
    if not src.exists():
        return []
    try:
        return json.loads(src.read_text(encoding='utf-8')).get('items', [])
    except (OSError, ValueError) as e:
        print(f'  [어제 파일] {src.name} 읽기 실패 — 되살림 없이 진행한다: {e}')
        return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--backfill-days', type=int, default=0,
                    help='이미 상장해 빠진 최근 공모주를 N일치 되찾는다 (처음 한 번)')
    args = ap.parse_args()

    dart_key = os.environ.get('DART_API_KEY')
    if not dart_key:
        sys.exit('DART_API_KEY 환경변수가 필요합니다.')
    price_key = os.environ.get('DATA_GO_KR_KEY')
    previous = _load_previous()

    today = date.today()
    # corp_code 없이 조회하면 3개월 제한이 걸린다 (status 100)
    bgn = (today - timedelta(days=85)).strftime('%Y%m%d')
    end = today.strftime('%Y%m%d')
    print(f'DART 조회기간 {bgn} ~ {end}')

    ipos = fetch_ipos(dart_key, bgn, end)

    # 3개월간 증권신고서(지분증권)가 0건인 것은 실무적으로 불가능하다 = API 실패 신호.
    # 멀쩡한 기존 파일을 빈 값으로 덮어쓰지 않고 종료한다.
    # (반면 '청약 유효 0건'은 정상 상태다 — 실측상 6주 중 1주는 청약이 없다.)
    if not ipos:
        sys.exit('DART에서 IPO를 한 건도 받지 못했습니다. 기존 ipo.json 을 보존하고 종료합니다.')

    cid = os.environ.get('TOSS_CLIENT_ID')
    csec = os.environ.get('TOSS_CLIENT_SECRET')
    if cid and csec:
        scheduled = fetch_scheduled(cid, csec)
    else:
        print('  [토스] 키 없음 — 상장일 없이 진행한다')
        scheduled = []

    # 증권신고서 원문에서 사업 내용·총 발행주식수. receiptNo 로 캐시하므로
    # 새 공시가 없으면 네트워크를 타지 않는다
    ipos = enrich(dart_key, ipos)

    items = attach_list_dates(ipos, scheduled)
    # 오늘 DART 에서 공모주로 잡힌 것 — 옛 판(ipo.json)은 이것만 싣는다
    fresh_codes = {i['corpCode'] for i in items}

    if args.backfill_days:
        if not price_key:
            sys.exit('--backfill-days 는 DATA_GO_KR_KEY 가 필요합니다.')
        picked, codes, start = find_recent_listed(dart_key, price_key, today, args.backfill_days)
        extra = fetch_ipos(dart_key, start.strftime('%Y%m%d'), end,
                           predicate=lambda c: True, filings=picked)
        extra = attach_list_dates(enrich(dart_key, extra), scheduled)
        have = {i['corpCode'] for i in items}
        for e in extra:
            e['stockCode'] = codes.get(e['corpCode'])
            if e['corpCode'] not in have:
                items.append(e)

    # 🚨 청약이 끝난 건을 남기는 건 DART 조회창이 아니라 **어제 파일**이다.
    #    is_ipo 가 '종목코드 없음' 이라 상장하는 날 수집분에서 빠지기 때문이다
    #    (2026-09-10 확인 — 그 전까지는 청약 종료 후 약 1주에 사라졌다).
    items, kept = retain_previous(items, previous, today)
    print(f'  [상장 후] 어제 파일에서 되살림 {kept}건')
    calls, found = lookup_stock_codes(dart_key, items, today, _get)
    print(f'  [상장 후] 종목코드 확인 {calls}건 → 새로 찾음 {found}건')
    if price_key:
        ok, fail = attach_performance(price_key, items)
        print(f'  [시세] 성공 {ok} / 실패 {fail}')
    else:
        print('  [시세] DATA_GO_KR_KEY 없음 — 성적 없이 진행한다')

    keep = list(items)
    # 어제 파일·백필에서 온 항목은 is_spac 을 다시 거치지 않는다. 판정 규칙이 바뀌면
    # 옛 값이 남으므로 저장 직전에 이름으로 다시 맞춘다 (네트워크 없음)
    for it in keep:
        it['isSpac'] = is_spac(it.get('corpName'))
    keep.sort(key=lambda i: (i['subscriptionStart'] or '9999-99-99', i['corpName']))

    generated = datetime.now(KST).isoformat(timespec='seconds')
    OUT.parent.mkdir(parents=True, exist_ok=True)
    # v2 — 「최근 성적」 탭이 있는 앱 버전이 읽는다. 되살린 상장 건 · 시세 포함
    OUT_V2.write_text(json.dumps({'generatedAt': generated, 'items': keep},
                                 ensure_ascii=False, indent=2), encoding='utf-8')
    # 옛 판 — 라이브 중인 옛 앱 버전이 읽는다. 오늘 수집분만 (legacy_items 주석)
    legacy = legacy_items(keep, fresh_codes)
    OUT.write_text(json.dumps({'generatedAt': generated, 'items': legacy},
                              ensure_ascii=False, indent=2), encoding='utf-8')

    confirmed = sum(1 for i in keep if i['offerPrice'] is not None)
    dated = sum(1 for i in keep if i['listDate'])
    closed = sum(1 for i in keep
                 if i['subscriptionEnd'] and i['subscriptionEnd'] < today.isoformat())
    print(f'\n저장: {OUT_V2}  (v2 — 최근 성적 포함)')
    print(f'      {OUT}  (옛 판 — 오늘 수집분 {len(legacy)}건만)')
    print(f'  총 {len(keep)}건')
    print(f'  공모가 확정 {confirmed} / 미확정 {len(keep) - confirmed}')
    upcoming = sum(1 for i in keep
                   if i['subscriptionEnd'] and i['subscriptionEnd'] >= today.isoformat())
    # 예전에는 '확정 − 마감' 으로 셌다. 공모가 없는 마감 건이 섞이면 음수가 된다 (-5 를 봤다)
    print(f'  청약 마감 {closed} / 진행·예정 {upcoming}')
    print(f'  상장일 확정 {dated}')
    print(f"  상장 후 성적 {sum(1 for i in keep if i.get('performance'))}건")


if __name__ == '__main__':
    main()
