#!/usr/bin/env python3
"""최근 영상별 조회수 — **쇼츠와 롱폼을 가른다.**

채널 단위 `viewCount` 는 합계 하나라 쪼갤 수 없다. 영상별로 봐야 하는데 전체 영상을
매일 보는 것은 쿼터 낭비다 → **최근 7일 영상만** 본다. 일간 조회수는 거의 다 거기서 나온다.

🚨 **"최근 N개" 로 자르면 안 된다 — 채널마다 덮는 기간이 달라져 비교가 깨진다.**
처음에 최신 50개만 받았더니 주 1회 올리는 채널은 1년치, 한국경제TV·SBS Biz 같은
뉴스형은 **하루치**였다(2026-10-20 실측: 36채널 중 11개가 잘렸다).
→ **기간으로 자르고 그 기간을 덮을 때까지 페이지를 넘긴다.** 페이지는 cutoff 를 지나면
  멈추므로, 적게 올리는 채널은 1페이지로 끝나고 비용이 늘지 않는다.

쿼터: 채널당 약 2 units
  playlistItems 1 — 업로드 목록 50개. 🔑 업로드 플레이리스트 id 는 `UC…` → `UU…` 치환이라
                    `channels.list?part=contentDetails` 호출이 **필요 없다** (1 unit 절약)
  videos        1 — 영상 50개의 통계 + 길이

🚨 **API 에 `isShort` 필드가 없다.** 그래서 "쇼츠" 라고 단정하지 않는다 — 길이 구간으로
적는다. 2분짜리 일반 영상을 쇼츠라고 표시하면 틀린 것이지만, "3분 미만" 은 틀릴 수 없다.
화면에도 그대로 "3분 미만 / 1분 미만" 으로 쓴다 (BRAND.md 3번).
    lt1m   60초 미만   — 사실상 쇼츠
    lt3m   1~3분       — 쇼츠와 짧은 롱폼이 섞인다
    ge3m   3분 이상    — 롱폼
확정하려면 youtube.com/shorts/{id} 가 리다이렉트 없이 열리는지 봐야 하는데 API 밖이다.

## 🔑 예산은 **공짜 신호로 줄을 세워** 쓴다
채널 하나당 스냅샷이 0.02 units 인데 영상 단위는 2 units — **100배**다. 그래서 기계적으로
한 바퀴 도는 것은 낭비다. 어제 아무것도 안 올렸고 조회수도 안 움직인 채널에 2 units 를
쓸 이유가 없다.
→ 스냅샷에 이미 들어 있는(= 추가 비용 0) `videoCount` 증가와 조회수 증가분으로 **우선순위**를
  매긴다. 예산이 모자라면 아래쪽이 잘리는데, 잘리는 것은 **오늘 안 움직인 채널**이다.
  조회수는 누적값이라 며칠 뒤에 봐도 증가분을 잃지 않는다.
순위: ① 기준값이 없는 새 채널 ② 오늘 업로드한 채널 ③ 조회수 증가분 큰 순
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ytapi  # noqa: E402
from snapshot import load_registry  # noqa: E402

KST = timezone(timedelta(hours=9))
OUT = ytapi.DATA / 'videos'
STATE = ytapi.DATA / 'uploads-state.json'
RECENT_DAYS = 7
MAX_PAGES = 10             # 50 × 10 = 500개. 하루 500개를 넘겨 올리는 채널은 포기한다
# 길이 구간. 쇼츠 상한이 3분(2024-10 부터)이라 경계를 거기 둔다
BUCKET_1M = 60
BUCKET_3M = 181            # 3분 + 1초 여유
UPLOADS_BUDGET = 2500      # 10,000 중 이만큼만. 발굴 80 + 스냅샷 100 을 반드시 남긴다

_DUR = re.compile(r'P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?')


def duration_sec(iso: str | None) -> int | None:
    if not iso:
        return None
    m = _DUR.fullmatch(iso)
    if not m:
        return None
    d, h, mi, s = (int(x) if x else 0 for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + s


def prioritize(active: list[str], chans: dict) -> list[str]:
    """오늘 볼 채널의 순서. **추가 호출 없이** 스냅샷이 이미 적어 둔 값만 쓴다."""
    seen = sorted(p.stem for p in (ytapi.DATA / 'series').glob('*.jsonl'))
    prev: dict[str, dict] = {}
    if len(seen) >= 2:
        for line in (ytapi.DATA / 'series' / f'{seen[-2]}.jsonl').read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                prev[r['id']] = r

    def score(cid: str) -> tuple:
        c = chans[cid]
        p = prev.get(cid)
        if p is None:                       # 기준값이 없다 — 오늘 찍어야 내일 증가분이 나온다
            return (2, 0)
        uploaded = (c.get('videos') or 0) > (p.get('n') or 0)
        growth = (c.get('views') or 0) - (p.get('v') or 0)
        return (1 if uploaded else 0, growth)

    return sorted(active, key=score, reverse=True)


def bucket(sec: int | None) -> str:
    if sec is None:
        return 'unknown'
    if sec < BUCKET_1M:
        return 'lt1m'
    return 'lt3m' if sec <= BUCKET_3M else 'ge3m'


def main() -> int:
    reg = load_registry()
    chans = reg['channels']
    active = [cid for cid, c in chans.items()
              if c.get('tier') != 'dormant' and not c.get('missingSince')]
    if not active:
        print('활성 채널이 없다. resolve.py 를 먼저 돌린다.')
        return 1

    today = datetime.now(KST).date()
    stamp = today.isoformat()
    cutoff = (today - timedelta(days=RECENT_DAYS)).isoformat()
    start_units = ytapi.spent()['units']
    order = prioritize(active, chans)

    rows, done, stopped = [], 0, None
    for cid in order:
        if ytapi.spent()['units'] - start_units >= UPLOADS_BUDGET:
            stopped = f'업로드 예산({UPLOADS_BUDGET}) 소진 — 남은 {len(order) - done}개는 안 움직인 채널이다'
            break
        uploads = 'UU' + cid[2:]        # UC… → UU… 는 안정된 관례다
        recent, token, truncated = [], None, False
        try:
            for page in range(MAX_PAGES):
                kw = {'pageToken': token} if token else {}
                pl = ytapi.call('playlistItems', units=1, part='contentDetails',
                                playlistId=uploads, maxResults=50, **kw)
                items = pl.get('items', [])
                # 업로드 목록은 최신순이다. cutoff 보다 오래된 것이 나오면 멈춘다
                hit_old = False
                for it in items:
                    cd = it.get('contentDetails', {})
                    pub = (cd.get('videoPublishedAt') or '')[:10]
                    if not pub:
                        continue
                    if pub >= cutoff:
                        recent.append((cd['videoId'], pub))
                    else:
                        hit_old = True
                token = pl.get('nextPageToken')
                if hit_old or not token:
                    break
            else:
                truncated = True            # MAX_PAGES 를 다 썼는데도 안 끝났다
        except ytapi.QuotaGuard as e:
            stopped = str(e)
            break
        except RuntimeError:
            # 업로드가 0인 채널은 플레이리스트가 없어 404 가 난다. 넘긴다
            done += 1
            continue
        done += 1
        if truncated:
            print(f'  ⚠ {reg["channels"][cid].get("title")} — {RECENT_DAYS}일을 '
                  f'{MAX_PAGES}페이지로 못 덮었다 (영상 {len(recent)}개까지)')
        if not recent:
            continue

        try:
            for group in ytapi.chunks([v for v, _ in recent], 50):
                vd = ytapi.call('videos', units=1, part='statistics,contentDetails',
                                id=','.join(group), maxResults=50)
                pubmap = dict(recent)
                for item in vd.get('items', []):
                    sec = duration_sec(item.get('contentDetails', {}).get('duration'))
                    st = item.get('statistics', {})
                    rows.append({
                        'd': stamp,
                        'ch': cid,
                        'vid': item['id'],
                        'pub': pubmap.get(item['id']),
                        'sec': sec,
                        # 🚨 길이 구간이다. "쇼츠" 라고 단정하지 않는다
                        'form': bucket(sec),
                        'v': int(st['viewCount']) if st.get('viewCount') else None,
                        'l': int(st['likeCount']) if st.get('likeCount') else None,
                    })
        except ytapi.QuotaGuard as e:
            stopped = str(e)
            break

    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps({'ranAt': stamp, 'active': len(active), 'covered': done},
                                ensure_ascii=False, indent=2) + '\n')
    if rows:
        OUT.mkdir(parents=True, exist_ok=True)
        p = OUT / f'{stamp}.jsonl'
        # 같은 날 두 번 돌면 이어 붙인다 — 커서가 다른 채널을 보기 때문이다.
        # 같은 (ch, vid) 가 두 번 들어가도 분석에서 마지막 것만 쓴다
        with p.open('a') as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')
        tally = {}
        for r in rows:
            tally[r['form']] = tally.get(r['form'], 0) + 1
        shape = ' · '.join(f'{k} {tally[k]}' for k in ('lt1m', 'lt3m', 'ge3m', 'unknown')
                           if tally.get(k))
        print(f'✓ {p.relative_to(ytapi.ROOT)} — 영상 {len(rows)}개 ({shape}) · 채널 {done}개')
    else:
        print(f'최근 {RECENT_DAYS}일 영상이 없다 (채널 {done}개 확인)')
    used = ytapi.spent()['units'] - start_units
    print(f'이번 실행 {used} units · 채널 {done}/{len(active)} 커버')
    if stopped:
        print(f'⚠ 중단: {stopped} — 남은 채널은 내일 커서가 이어서 본다')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
