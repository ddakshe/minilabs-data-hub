#!/usr/bin/env python3
"""공모주 미리보기 배치 — DART + 토스를 합쳐 stock-ipo/ipo.json 을 만든다.

    export DART_API_KEY=...
    export TOSS_CLIENT_ID=tsck_live_...      # 없으면 상장일 없이 진행
    export TOSS_CLIENT_SECRET=tssk_live_...
    python3 scripts/stock-ipo/build_ipo_json.py

일 1회 실행한다. 공모가는 [기재정정] 공시로 청약 며칠 전에 확정되므로
주 단위로 돌리면 '확정 전'인 채로 청약이 시작되는 구간이 생긴다.

⚠️ 토스 호출은 허용 IP 사전 등록이 필요하다.
"""
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ipo_dart import fetch_ipos
from ipo_paths import OUT
from ipo_document import enrich
from ipo_toss import attach_list_dates, fetch_scheduled

KST = timezone(timedelta(hours=9))


def main():
    dart_key = os.environ.get('DART_API_KEY')
    if not dart_key:
        sys.exit('DART_API_KEY 환경변수가 필요합니다.')

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

    # 청약이 끝난 건도 남긴다 — "최근에 뭐가 있었나"가 앱의 절반이다.
    # DART 조회창(85일)이 곧 '최근'의 범위가 된다.
    keep = list(items)
    keep.sort(key=lambda i: (i['subscriptionStart'] or '9999-99-99', i['corpName']))

    payload = {
        'generatedAt': datetime.now(KST).isoformat(timespec='seconds'),
        'items': keep,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')

    confirmed = sum(1 for i in keep if i['offerPrice'] is not None)
    dated = sum(1 for i in keep if i['listDate'])
    closed = sum(1 for i in keep
                 if i['subscriptionEnd'] and i['subscriptionEnd'] < today.isoformat())
    print(f'\n저장: {OUT}')
    print(f'  총 {len(keep)}건')
    print(f'  공모가 확정 {confirmed} / 미확정 {len(keep) - confirmed}')
    print(f'  청약 마감 {closed} / 진행·예정 {confirmed - closed}')
    print(f'  상장일 확정 {dated}')


if __name__ == '__main__':
    main()
