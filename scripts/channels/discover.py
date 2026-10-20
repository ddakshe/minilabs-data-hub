#!/usr/bin/env python3
"""발굴: 카테고리 질의로 새 채널을 찾아 레지스트리에 **분류 대기** 상태로 넣는다.

search 가 비싸서 하루 상한이 80이다(`ytapi.SEARCH_BUDGET`). 그래서 질의 목록을
**커서로 조금씩** 돈다 — 오늘 몇 줄, 내일 그 다음 줄. 한 바퀴 돌면 처음으로 돌아간다
(같은 질의를 다시 돌려도 새 채널이 생기므로 낭비가 아니다).

🔑 **분류는 우리가 한다.** 발굴된 채널은 `category=None` · `classifiedBy=None` 으로
들어가고 `pending-classify.tsv` 에 쌓인다. 질의 카테고리는 **힌트일 뿐**이다 —
"부동산" 검색에 부동산 아닌 채널이 섞여 들어오고, 그걸 걸러낸 이력이 자산이 된다.
"""
from __future__ import annotations

import csv
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ytapi  # noqa: E402
from snapshot import load_registry, save_registry  # noqa: E402

HERE = Path(__file__).resolve().parent
KST = timezone(timedelta(hours=9))
STATE = ytapi.DATA / 'discover-state.json'
# 하루에 돌 질의 수. 영상 수집(uploads.py)을 CI 에서 뺀 만큼 발굴에 몰아준다
# (2026-10-20). 50 × 100 = 5,000 units + channels.list 몇십 → 상한 60 안쪽이다.
PER_RUN = 50
PER_QUERY = 50              # search 한 번이 받는 최대 채널 수
MIN_SUBS = 1000             # 이 아래는 담지 않는다 — 랭킹이 동전주로 도배되는 것과 같은 함정


def read_queries() -> list[tuple[str, str, str]]:
    """카테고리 · 세부 · 검색어. **질의 파일이 카테고리 정의다.**"""
    out = []
    for line in (HERE / 'queries.tsv').read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        parts = [p.strip() for p in line.split('\t')]
        if len(parts) >= 3 and all(parts[:3]):
            out.append((parts[0], parts[1], parts[2]))
    return out


def main() -> int:
    queries = read_queries()
    cursor = json.loads(STATE.read_text())['cursor'] if STATE.exists() else 0
    reg = load_registry()
    chans = reg['channels']
    stamp = datetime.now(KST).date().isoformat()

    found, stopped, ran = [], None, 0
    for i in range(PER_RUN):
        if ytapi.search_left() <= 1:
            stopped = '발굴 상한 소진'
            break
        cat, sub, q = queries[(cursor + i) % len(queries)]
        try:
            body = ytapi.call('search', units=100, part='snippet', q=q,
                              type='channel', maxResults=PER_QUERY,
                              regionCode='KR', relevanceLanguage='ko')
        except ytapi.QuotaGuard as e:
            stopped = str(e)
            break
        ran += 1
        ids = [it['id'].get('channelId') for it in body.get('items', [])]
        ids = [c for c in ids if c and c not in chans]
        if not ids:
            print(f'  [{cat}] {q!r} → 새 채널 0')
            continue
        # 구독자 하한을 보려면 통계를 받아야 한다 (50개 묶어 1 unit)
        kept = 0
        for group in ytapi.chunks(ids, 50):
            full = ytapi.call('channels', units=1, part='statistics,snippet',
                              id=','.join(group), maxResults=50)
            for item in full.get('items', []):
                st, sn = item.get('statistics', {}), item.get('snippet', {})
                subs = int(st['subscriberCount']) if st.get('subscriberCount') else None
                if subs is not None and subs < MIN_SUBS:
                    continue
                cid = item['id']
                chans[cid] = {
                    'seedName': None,
                    'handle': sn.get('customUrl'),
                    'title': sn.get('title'),
                    'description': (sn.get('description') or '')[:300],
                    'country': sn.get('country'),
                    'category': None,            # 🔑 우리가 분류해야 한다
                    'classifiedBy': None,
                    'queryHint': cat,            # 어느 질의에서 나왔는지 (힌트일 뿐)
                    'subHint': sub,              # 세부도 질의가 준다
                    'foundBy': q,
                    'source': 'discover',
                    'addedAt': stamp,
                    'tier': 'active',
                    'subs': subs,
                    'views': int(st.get('viewCount', 0)),
                    'videos': int(st.get('videoCount', 0)),
                }
                found.append((cat, sn.get('title'), subs, cid))
                kept += 1
        print(f'  [{cat}] {q!r} → 새 채널 {kept}')

    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(
        {'cursor': (cursor + ran) % len(queries), 'ranAt': stamp,
         'queries': len(queries)}, ensure_ascii=False, indent=2) + '\n')

    if found:
        save_registry(reg)
        p = ytapi.DATA / 'pending-classify.tsv'
        with p.open('a') as f:
            w = csv.writer(f, delimiter='\t')
            for row in found:
                w.writerow(row)
        print(f'\n✓ 새 채널 {len(found)}개 → 분류 대기 {p.relative_to(ytapi.ROOT)}')
    else:
        print('\n새 채널 없음')

    pend = sum(1 for c in chans.values() if c.get('category') is None)
    led = ytapi.spent()
    print(f'레지스트리 {len(chans)}개 (분류 대기 {pend}) · 질의 커서 '
          f'{(cursor + ran) % len(queries)}/{len(queries)}')
    print(f'쿼터 누적 {led["units"]} units · search {led["search"]}/{ytapi.SEARCH_BUDGET}')
    if stopped:
        print(f'⚠ 중단: {stopped}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
