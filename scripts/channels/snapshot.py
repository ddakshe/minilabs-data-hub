#!/usr/bin/env python3
"""매일 1회: 레지스트리의 채널을 찍어 series 에 한 줄씩 쌓는다.

**이 스크립트가 쌓는 것이 자산이다.** 유튜브 API 는 *현재* 값만 준다 — 과거 추이는
어디서도 살 수 없고 소급해서 만들 수도 없다. 오늘 안 찍은 날은 영구히 빈다.
그래서 이 스크립트는 **부분 성공을 저장한다**(쿼터가 끊겨도 모은 것까지 기록).

## 지표 선택 — 🚨 구독자수로 성장을 재지 말 것
`subscriberCount` 는 1,000명 이상 채널에서 **유효숫자 3자리로 반올림**돼 온다
(123,456 → 123000). 큰 채널은 일간 증감이 반올림에 먹혀 **0으로 보인다.**
→ 성장의 주 지표는 **`viewCount` 일간 증가분**이다(정확한 값이다). 구독자는 규모 구간용.

## 활동성은 공짜다
`videoCount` 가 같은 응답에 딸려 오므로, 어제보다 늘었으면 그날 업로드한 것이다.
연속 업로드 일수·휴면(30일) 판정에 **추가 쿼터가 0원**이다. 한계는 알고 쓴다:
하루에 2개 올리면 1회로 뭉치고, 영상을 지우면 감소한다(감소는 업로드로 세지 않는다).

## 휴면은 덜 찍는다
휴면 채널을 매일 찍는 것은 쿼터 낭비다. `tier=dormant` 는 **주 1회(월요일)만** 찍어서
그만큼 활성 채널을 더 담는다. 이게 쿼터를 버는 유일한 정직한 방법이다.
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ytapi  # noqa: E402

KST = timezone(timedelta(hours=9))
DATA = ytapi.DATA
REGISTRY = DATA / 'registry.json'
SERIES = DATA / 'series'
DORMANT_DAYS = 30          # 이 기간 업로드가 없으면 휴면으로 내린다
BATCH = 50                 # channels.list 가 한 번에 받는 id 수 = 1 unit


def load_registry() -> dict:
    if REGISTRY.exists():
        return json.loads(REGISTRY.read_text())
    return {'updatedAt': None, 'channels': {}}


def save_registry(reg: dict) -> None:
    reg['updatedAt'] = datetime.now(KST).isoformat(timespec='seconds')
    REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY.write_text(json.dumps(reg, ensure_ascii=False, indent=2) + '\n')


def due(ch: dict, today: date) -> bool:
    """오늘 찍을 채널인가. 휴면은 월요일에만."""
    if ch.get('tier') == 'dormant':
        return today.weekday() == 0
    return True


def main() -> int:
    reg = load_registry()
    chans = reg['channels']
    if not chans:
        print('레지스트리가 비었다. 먼저 `python3 resolve.py` 로 씨앗을 꽂는다.')
        return 1

    today = datetime.now(KST).date()
    stamp = today.isoformat()
    targets = [cid for cid, c in chans.items() if due(c, today)]
    skipped = len(chans) - len(targets)
    print(f'대상 {len(targets)}개 (휴면 건너뜀 {skipped}) · 예상 쿼터 {-(-len(targets) // BATCH)} units')

    rows: list[dict] = []
    seen: set[str] = set()
    stopped = None
    for group in ytapi.chunks(targets, BATCH):
        try:
            body = ytapi.call(
                'channels', units=1,
                part='statistics,snippet', id=','.join(group), maxResults=BATCH,
            )
        except ytapi.QuotaGuard as e:
            stopped = str(e)
            break                       # 모은 것은 아래에서 저장한다
        for item in body.get('items', []):
            cid = item['id']
            st = item.get('statistics', {})
            sn = item.get('snippet', {})
            # hiddenSubscriberCount 인 채널은 subscriberCount 가 아예 없다
            subs = int(st['subscriberCount']) if st.get('subscriberCount') else None
            views = int(st.get('viewCount', 0))
            videos = int(st.get('videoCount', 0))
            rows.append({'d': stamp, 'id': cid, 's': subs, 'v': views, 'n': videos})
            seen.add(cid)

            c = chans[cid]
            prev_videos = c.get('videos')
            # 활동성 — videoCount 증가 = 그날 업로드. 공짜 지표다
            if prev_videos is not None and videos > prev_videos:
                c['uploadStreak'] = c.get('uploadStreak', 0) + 1
                c['lastUploadAt'] = stamp
            elif prev_videos is not None and videos <= prev_videos:
                c['uploadStreak'] = 0
            # 제목·설명은 30일 refresh 대상이다. 매일 덮어써서 자동 충족한다
            c['title'] = sn.get('title')
            c['description'] = (sn.get('description') or '')[:300]
            c['country'] = sn.get('country')
            c['subs'], c['views'], c['videos'] = subs, views, videos
            c['lastSeenAt'] = stamp
            last = c.get('lastUploadAt')
            if last:
                quiet = (today - date.fromisoformat(last)).days
                c['tier'] = 'dormant' if quiet >= DORMANT_DAYS else 'active'
            else:
                c.setdefault('tier', 'active')

    # 응답에 없던 id = 삭제·비공개된 채널. 조용히 흐르면 series 에 구멍이 난다
    missing = [c for c in targets if c not in seen]
    for cid in missing:
        chans[cid]['missingSince'] = chans[cid].get('missingSince') or stamp

    if rows:
        SERIES.mkdir(parents=True, exist_ok=True)
        out = SERIES / f'{stamp}.jsonl'
        # 같은 날 두 번 돌면 덮어쓴다 (append 면 중복 행이 생긴다)
        out.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows))
        save_registry(reg)
        print(f'✓ {out.relative_to(ytapi.ROOT)} — {len(rows)}행')
    else:
        print('✗ 아무것도 못 모았다 — series 를 쓰지 않는다')

    if missing:
        print(f'⚠ 응답에 없는 채널 {len(missing)}개 (삭제·비공개 의심): {missing[:5]}')
    led = ytapi.spent()
    print(f'쿼터 누적 {led["units"]} units · search {led["search"]}/{ytapi.SEARCH_BUDGET}')
    if stopped:
        print(f'⚠ 중단: {stopped}')
        return 1
    return 0 if rows else 1


if __name__ == '__main__':
    raise SystemExit(main())
