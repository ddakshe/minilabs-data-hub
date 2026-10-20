#!/usr/bin/env python3
"""씨앗(`seeds.tsv`) → 레지스트리. 매일 조금씩 꽂는다.

핸들이 있으면 `channels.list?forHandle` 로 **1 unit**, 없으면 `search` 로 찾아야 해서
비싸다(하루 상한 80). 그래서 **한 번에 다 못 꽂는다** — 상한에 닿으면 꽂은 것까지
저장하고 끝낸다. 다음 날 다시 돌리면 남은 것부터 이어서 한다.

🚨 **이름으로 찾은 것은 사람이 검수해야 한다.** 동명·유사명 채널이 꽂히면 2주 뒤 판정이
오염된다. 끝에 `needs-review.tsv` 를 뽑으니 구독자수·제목을 눈으로 본다.
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


def read_seeds() -> list[tuple[str, str, str]]:
    out = []
    for line in (HERE / 'seeds.tsv').read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        parts = (line.split('\t') + ['', ''])[:3]
        cat, name, handle = (p.strip() for p in parts)
        if cat and name:
            out.append((cat, name, handle))
    return out


def by_handle(handle: str) -> dict | None:
    h = handle if handle.startswith('@') else '@' + handle
    body = ytapi.call('channels', units=1, part='statistics,snippet', forHandle=h)
    items = body.get('items', [])
    return items[0] if items else None


def by_search(name: str) -> dict | None:
    """search 는 비싸고 **틀릴 수 있다**. 1건만 받아 뒤에서 검수한다."""
    body = ytapi.call('search', units=100, part='snippet', q=name,
                      type='channel', maxResults=1, regionCode='KR')
    items = body.get('items', [])
    if not items:
        return None
    cid = items[0]['snippet'].get('channelId') or items[0]['id'].get('channelId')
    if not cid:
        return None
    full = ytapi.call('channels', units=1, part='statistics,snippet', id=cid)
    got = full.get('items', [])
    return got[0] if got else None


def main() -> int:
    reg = load_registry()
    chans = reg['channels']
    known_names = {c.get('seedName') for c in chans.values()}
    stamp = datetime.now(KST).date().isoformat()

    added, review, failed, stopped = [], [], [], None
    for cat, name, handle in read_seeds():
        if name in known_names:
            continue
        try:
            item = by_handle(handle) if handle else by_search(name)
        except ytapi.QuotaGuard as e:
            stopped = str(e)
            break
        except RuntimeError as e:
            failed.append((name, str(e)[:80]))
            continue
        if not item:
            failed.append((name, '검색 결과 없음'))
            continue

        cid = item['id']
        sn, st = item.get('snippet', {}), item.get('statistics', {})
        if cid in chans:                       # 다른 이름으로 이미 들어온 채널
            continue
        chans[cid] = {
            'seedName': name,
            'handle': sn.get('customUrl') or handle or None,
            'title': sn.get('title'),
            'description': (sn.get('description') or '')[:300],
            'country': sn.get('country'),
            'category': cat,                   # 🔑 우리가 정한 분류다
            'classifiedBy': 'hand',
            'source': 'seed',
            'addedAt': stamp,
            'tier': 'active',
            'subs': int(st['subscriberCount']) if st.get('subscriberCount') else None,
            'views': int(st.get('viewCount', 0)),
            'videos': int(st.get('videoCount', 0)),
        }
        known_names.add(name)
        added.append((cat, name, sn.get('title'), chans[cid]['subs']))
        if not handle:                          # 검색으로 찾은 것 = 검수 대상
            review.append((cat, name, sn.get('title'), sn.get('customUrl'),
                           chans[cid]['subs'], cid))

    if added:
        save_registry(reg)
    print(f'✓ 새로 꽂은 채널 {len(added)}개 · 레지스트리 총 {len(chans)}개')
    for cat, name, title, subs in added:
        print(f'  [{cat}] {name!r} → {title!r} ({subs:,}명)' if subs
              else f'  [{cat}] {name!r} → {title!r} (구독자 비공개)')
    if failed:
        print(f'\n✗ 못 찾은 것 {len(failed)}개 — 이름을 고치거나 핸들을 적어 준다')
        for name, why in failed:
            print(f'  {name}: {why}')
    if review:
        p = ytapi.DATA / 'needs-review.tsv'
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open('a') as f:
            w = csv.writer(f, delimiter='\t')
            for row in review:
                w.writerow(row)
        print(f'\n🚨 검수 필요 {len(review)}개 → {p.relative_to(ytapi.ROOT)}')
        print('   찾은 제목이 의도한 채널인지 본다. 틀린 것은 레지스트리에서 지우고'
              ' seeds.tsv 에 핸들을 적는다.')
    led = ytapi.spent()
    print(f'\n쿼터 누적 {led["units"]} units · search {led["search"]}/{ytapi.SEARCH_BUDGET}')
    if stopped:
        print(f'⚠ 중단: {stopped} — 내일 다시 돌리면 남은 씨앗부터 이어서 한다')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
