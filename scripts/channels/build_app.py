#!/usr/bin/env python3
"""앱이 읽을 정적 JSON 을 만든다. **registry.json 을 그대로 내보내지 않는다.**

registry 는 설명문·검수 이력까지 들고 있어 230KB 가 넘는다. 앱은 그중 일부만 쓴다.
앱은 이 파일들을 **런타임에 raw.githubusercontent.com 에서 fetch** 한다
(이 시리즈 관례 — `stock-sector-mini/src/lib/data.ts` 참고).

  app/config.json    🔑 **원격 설정.** 앱 배포 없이 노출을 바꾼다 (아래)
  app/map.json       분야 지도 — 카테고리·세부별 채널 수와 대표 채널
  app/channels.json  채널 목록 — 지도에서 한 칸을 열 때 쓴다
  app/growth.json    규모 구간별 성장 순위

🚨 **「어제」 같은 기간 표현을 쓰지 않는다.** 유튜브의 채널 조회수 갱신이 불규칙해
   하루 창이 밀리면 수치가 몇 배로 튄다(2026-10-23 실측: 전 채널이 5~16배).
   그래서 절대 증가량 대신 **구독자 대비 퍼센트**만 내보내고, 갱신 시각을 같이 싣는다.
🚨 규모가 다른 채널을 한 줄에 세우면 조회수가 500배 차이 난다. **구간을 나눠** 담는다.

## 원격 설정 (config.json)
앱이 탭 목록·추천 검색어를 **코드가 아니라 이 파일에서** 읽는다. 분야를 하나 더
열려면 `LIVE` 에 키를 넣고 분류를 끝내면 끝이다 — **앱 배포가 필요 없다.**
⚠️ 바꿀 수 있는 것은 **무엇을 보여줄지**지 기능 자체가 아니다. 심사는 번들을 보므로,
   심사 때 없던 기능을 원격으로 켜는 식으로 쓰지 않는다. 콘텐츠·노출 범위만 다룬다.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ytapi  # noqa: E402

DATA = ytapi.DATA
OUT = DATA / 'app'
# 🔑 앱에 내보낼 카테고리. **여기에 한 줄 더하고 분류하면 앱에 탭이 생긴다** —
#    앱은 map.json 에서 탭 목록을 읽으므로 **배포가 필요 없다.**
#    `learn` 은 2026-10-23 에 수집을 시작했고, 분류가 끝나면 여기에 넣는다.
LIVE = ('econ', 'realty', 'urban')
MIN_SUBS = 1000            # 아래는 성장률 분모가 흔들려 순위가 튄다

CAT = {'econ': '경제', 'realty': '부동산', 'urban': '도시·교통', 'learn': '배움·커리어'}
SUB = {
    'macro': '거시경제', 'kr-stock': '국내주식', 'us-stock': '미국주식', 'etf': 'ETF',
    'dividend': '배당주', 'crypto': '코인', 'pension': '연금', 'personal': '재테크',
    'tax': '절세·세금', 'biz': '창업·사업',
    'home': '아파트·주택', 'auction': '경매·공매', 'land': '토지', 'comm': '상가·빌딩',
    'redev': '재개발', 'rent': '임대사업',
    'transit': '교통·철도', 'plan': '도시계획', 'region': '지역개발',
    'english': '영어', 'it': 'IT·개발', 'ai': 'AI', 'career': '직업·이직', 'cert': '자격증',
}
BANDS = (('big', '10만+', 100_000), ('mid', '1만~10만', 10_000), ('small', '1천~1만', 0))


def band_of(subs: int) -> str:
    for key, _, floor in BANDS:
        if subs >= floor:
            return key
    return 'small'


def main() -> int:
    reg = json.loads((DATA / 'registry.json').read_text())
    chans = reg['channels']
    days = sorted(p.stem for p in (DATA / 'series').glob('*.jsonl'))
    if len(days) < 2:
        print('series 가 2일 미만이다. 성장 순위를 만들 수 없다.')
        return 1

    def load(d):
        return {r['id']: r for r in
                (json.loads(l) for l in (DATA / 'series' / f'{d}.jsonl').read_text().splitlines() if l.strip())}

    prev, last = load(days[-2]), load(days[-1])
    asof = reg.get('updatedAt')

    live = {cid: c for cid, c in chans.items() if c.get('category') in LIVE}

    # ── 채널 목록
    channels = {}
    for cid, c in live.items():
        subs = c.get('subs') or 0
        pct = None
        if cid in prev and cid in last and subs >= MIN_SUBS:
            dv = last[cid]['v'] - prev[cid]['v']
            if dv > 0:
                pct = round(dv / subs * 100)
        # 빈 값은 담지 않는다 — 1,500채널이면 null 하나가 10KB 다
        row = {'t': c.get('title'), 's': subs, 'u': c.get('sub')}
        if c.get('thumb'):
            row['g'] = c['thumb']          # 썸네일 id (앱이 URL 을 조립한다)
        if c.get('handle'):
            row['h'] = c['handle']
        if pct is not None:
            row['p'] = pct
        channels[cid] = row

    # ── 분야 지도: 세부별 채널 수 + 대표 채널(구독자 상위 3)
    bins: dict[tuple[str, str], list[str]] = {}
    for cid, c in live.items():
        bins.setdefault((c['category'], c.get('sub') or '-'), []).append(cid)
    mapping = []
    for (cat, sub), ids in bins.items():
        ids.sort(key=lambda i: -(channels[i]['s'] or 0))
        movers = [i for i in ids if channels[i].get('p')]
        movers.sort(key=lambda i: -channels[i]['p'])
        # 🔑 얼굴 정보를 **map.json 에 박아 넣는다.** id 만 주면 홈이 썸네일을 그리려고
        #    169KB 짜리 채널 목록을 받아야 한다. 20칸 × 3얼굴이면 5KB 뿐이다.
        mv = movers[0] if movers else None
        mapping.append({
            'cat': cat, 'catName': CAT[cat], 'sub': sub, 'name': SUB.get(sub, sub),
            'count': len(ids),
            'faces': [{'g': channels[i].get('g')} for i in ids[:3] if channels[i].get('g')],
            'mover': ({'id': mv, 't': channels[mv]['t'], 'p': channels[mv]['p'],
                       'g': channels[mv].get('g')} if mv else None),
        })
    mapping.sort(key=lambda m: (-m['count'],))

    # ── 규모 구간별 성장 순위
    growth = {}
    for key, label, _ in BANDS:
        rows = [cid for cid, v in channels.items()
                if v.get('p') and band_of(v['s']) == key]
        rows.sort(key=lambda i: -channels[i]['p'])
        growth[key] = {'label': label, 'total': sum(
            1 for v in channels.values() if v.get('p') and band_of(v['s']) == key),
            'ids': rows[:50]}

    OUT.mkdir(parents=True, exist_ok=True)
    meta = {'asof': asof, 'days': len(days), 'channels': len(channels)}

    def dump(name: str, payload) -> None:
        f = OUT / f'{name}.json'
        f.write_text(json.dumps({'meta': meta, 'd': payload},
                                ensure_ascii=False, separators=(',', ':')) + '\n')
        print(f'✓ {f.relative_to(ytapi.ROOT)} — {f.stat().st_size // 1024}KB')

    # 🔑 채널 목록은 **카테고리별로 쪼갠다.** 한 덩어리면 220KB 라 첫 화면이 느려진다.
    #    홈(지도)은 map.json 3KB 만 받고, 한 칸을 열 때 그 카테고리만 받는다.
    for cat in LIVE:
        dump(f'channels-{cat}',
             {cid: v for cid, v in channels.items() if live[cid]['category'] == cat})
    # 🔑 원격 설정. 앱은 탭을 여기서 읽는다 — 분야 추가에 배포가 필요 없다
    tabs = []
    for cat in LIVE:
        n = sum(m['count'] for m in mapping if m['cat'] == cat)
        if n:
            tabs.append({'cat': cat, 'name': CAT.get(cat, cat), 'count': n})
    tabs.sort(key=lambda t: -t['count'])
    dump('config', {
        'tabs': tabs,
        # 찾기 화면의 추천 주제. 손으로 고른다 — 사람이 실제로 칠 법한 말이어야 한다
        'suggest': ['배당주', '경매', '연금', '청약', '절세', 'GTX', '미국주식', '재개발'],
        # 공지 한 줄. null 이면 안 그린다. 데이터 사고가 났을 때 여기로 알린다
        'notice': None,
        'minSubs': MIN_SUBS,
    })
    dump('map', mapping)
    dump('growth', {'bands': growth,
                    'ch': {cid: channels[cid]
                           for b in growth.values() for cid in b['ids']}})
    scored = sum(1 for v in channels.values() if v.get('p'))
    print(f'채널 {len(channels)} · 성장 수치 있는 것 {scored} · 칸 {len(mapping)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
