#!/usr/bin/env python3
"""2주 뒤 판정용. **판정 축이 둘이다** (2026-10-22 에 제품 틀을 「지도형」으로 정했다).

  ① 지도가 서는가 — 카테고리마다 채널이 충분히 모이고 서로 구별되는가  ← `density()`
     앱의 **얼굴**이다. "배당주 채널 52개, 한눈에" 가 설치하는 이유다.
     유튜브는 "다음에 볼 영상" 을 주지 플레이보드조차 유튜브의 거친 분류(게임·엔터·교육)를
     쓴다. 「배당주 채널 랭킹」 은 세상에 없다 — 우리가 손으로 만든 분류가 유일한 자산이다.
  ② 목록이 바뀌는가 — 성장 순위가 요동치는가  ← 아래 본문
     앱의 **심장**이지 얼굴이 아니다. 성장성 자체는 플레이보드·녹스가 이미 준다.
     지도에 시간 축을 붙여 다시 올 이유를 만드는 장치로만 쓴다.

🚨 **지도형에서는 ②가 단독 기각 조건이 아니다.** 지도는 원래 자주 안 바뀐다.
   ①이 서지 않으면 그게 기각이다.

---

**성장 순위가 실제로 요동치는가.**

안 요동치면 첫 화면이 고정되고 재방문이 0이 된다. 그게 이 검증의 전부다.
(섹터 앱이 허브 CI 없이는 데이터가 고정되는 것과 같은 함정이다.)

주 지표는 **조회수 일간 증가분**이다 — 구독자수는 유효숫자 3자리로 반올림돼 와서
큰 채널의 일간 증감이 0으로 보인다(snapshot.py 머리말).

판정 기준:
  ① 상위 10 교체율 — 어제 상위 10 중 오늘도 상위 10 인 비율. **낮아야 좋다**
  ② 순위 상관(스피어만) — 1.0 에 붙으면 고정된 화면이다
  ③ 커버리지 — 증가분이 0 인 채널 비율. 높으면 지표가 둔하다는 뜻

🚨 **채널 `viewCount` 는 하루 단위로 갱신된다.** 13시간 간격으로 두 번 찍었더니
   229채널 중 220개가 **완전히 같은 값**이었다(2026-10-20 → 10-21 실측).
   → 스냅샷은 하루 한 번, 같은 시각에 찍는다(예약 배치가 05:10 KST).
     주기 밖에서 손으로 돌린 날은 짝이 갱신 없음으로 잡히므로 **판정에서 뺀다.**
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ytapi  # noqa: E402

SERIES = ytapi.DATA / 'series'


def load_days() -> list[tuple[str, dict[str, dict]]]:
    days = []
    for p in sorted(SERIES.glob('*.jsonl')):
        rows = {}
        for line in p.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                rows[r['id']] = r
        days.append((p.stem, rows))
    return days


def spearman(a: list[str], b: list[str]) -> float | None:
    """두 순위 목록의 상관. 공통 채널만 본다.

    🚨 **공통 집합 안에서 다시 순위를 매겨야 한다.** 전체 목록의 순위를 그대로 쓰면서
    n 만 공통 개수로 잡으면 d² 가 정규화 범위를 넘어 **-1.95 같은 불가능한 값**이 나온다
    (2026-10-22 실측). 스피어만은 -1~1 이다.
    """
    common = [c for c in a if c in b]
    if len(common) < 3:
        return None
    ra = {c: i for i, c in enumerate([x for x in a if x in common])}
    rb = {c: i for i, c in enumerate([x for x in b if x in common])}
    n = len(common)
    d2 = sum((ra[c] - rb[c]) ** 2 for c in common)
    return 1 - (6 * d2) / (n * (n * n - 1))


def density(reg: dict, delta: dict[str, int]) -> None:
    """① 카테고리 밀도 — **이 카테고리가 한 화면으로 설 수 있는가.**

    네 가지를 본다. 채널 수만 보면 안 된다 — 거대 채널 하나에 잔챙이가 붙은 칸은
    목록이 아니라 '한 채널 소개' 가 된다.
      채널수   20 미만이면 한 화면이 안 찬다 → 옆 칸과 합친다
      활성     24시간에 조회수가 는 비율. 휴면 투성이면 지도가 죽은 지도다
      중앙값   규모가 고르게 섞였나 (거대 채널만 있으면 「발견」이 안 된다)
      독점     1위 채널의 구독자 점유율. 40% 넘으면 목록이 성립하지 않는다
    """
    groups: dict[tuple, list] = {}
    for cid, c in reg.items():
        if c.get('category') not in ('econ', 'realty', 'urban'):
            continue
        groups.setdefault((c['category'], c.get('sub') or '-'), []).append((cid, c))

    print(f'\n{"카테고리":<18}{"채널":>5}{"비교가능":>7}{"활성":>6}{"구독중앙":>9}'
          f'{"1위점유":>7}  판정')
    thin = []
    for key in sorted(groups):
        g = groups[key]
        subs = sorted((c.get('subs') or 0) for _, c in g)
        total = sum(subs) or 1
        med = subs[len(subs) // 2]
        top_share = max(subs) / total
        cmp_ = [cid for cid, _ in g if cid in delta]
        live = sum(1 for cid in cmp_ if delta[cid] > 0)
        act = live / len(cmp_) if cmp_ else None

        if len(g) < 20:
            verdict, flag = '얇다 — 합칠 것', True
        elif top_share >= 0.40:
            verdict, flag = '1위 독점 — 목록 안 됨', True
        elif act is not None and act < 0.5:
            verdict, flag = '휴면 많음', True
        else:
            verdict, flag = '충분', False
        if flag:
            thin.append((key, verdict))
        label = f'{key[0]}/{key[1]}'
        actx = f'{act:.0%}' if act is not None else '-'
        print(f'{label:<18}{len(g):>5}{len(cmp_):>7}{actx:>6}{med:>9,}'
              f'{top_share:>7.0%}  {verdict}')

    print(f'\n한 화면으로 서는 칸 {len(groups) - len(thin)}/{len(groups)}')
    if thin:
        print('손봐야 하는 칸:')
        for key, why in thin:
            print(f'  {key[0]}/{key[1]:<10} {why}')


def main() -> int:
    days = load_days()
    if len(days) < 2:
        print(f'series 가 {len(days)}일치뿐이다. 최소 2일, 판정은 14일 뒤.')
        return 1

    reg = json.loads((ytapi.DATA / 'registry.json').read_text())['channels']
    print(f'기간 {days[0][0]} ~ {days[-1][0]} ({len(days)}일) · 채널 {len(reg)}개\n')

    prev_top: list[str] | None = None
    print(f'{"날짜":<12}{"관측":>6}{"움직인채널":>11}{"상위10 유지":>12}{"순위상관":>10}')
    for i in range(1, len(days)):
        (d0, r0), (d1, r1) = days[i - 1], days[i]
        delta = {}
        for cid, row in r1.items():
            if cid in r0 and row['v'] is not None and r0[cid]['v'] is not None:
                delta[cid] = row['v'] - r0[cid]['v']
        if not delta:
            print(f'{d1:<12}{len(r1):>6}{"-":>11}{"-":>12}{"-":>10}')
            continue
        moved = sum(1 for v in delta.values() if v > 0)
        # 갱신이 안 된 짝은 순위가 무의미하다. 계산하지 않고 표시만 한다
        if moved < len(delta) * 0.5:
            print(f'{d1:<12}{len(r1):>6}{moved:>11}{"갱신없음":>12}{"-":>10}'
                  f'   ← {d0} 와 같은 갱신 주기. 판정에서 제외')
            continue
        order = sorted(delta, key=lambda c: delta[c], reverse=True)
        top = order[:10]
        keep = f'{len(set(top) & set(prev_top)) / 10:.0%}' if prev_top else '-'
        rho = spearman(order, prev_order) if prev_top else None
        print(f'{d1:<12}{len(r1):>6}{moved:>11}{keep:>12}'
              f'{(f"{rho:+.2f}" if rho is not None else "-"):>10}')
        prev_top, prev_order = top, order

    # 마지막 날 상위 10 을 사람이 읽을 수 있게
    (d0, r0), (d1, r1) = days[-2], days[-1]
    delta = {c: r1[c]['v'] - r0[c]['v'] for c in r1
             if c in r0 and r1[c]['v'] is not None and r0[c]['v'] is not None}
    print(f'\n{d1} 조회수 증가 상위 10')
    for cid in sorted(delta, key=lambda c: delta[c], reverse=True)[:10]:
        c = reg.get(cid, {})
        cat = c.get('category') or f'?{c.get("queryHint", "")}'
        print(f'  [{cat:<6}] {str(c.get("title"))[:24]:<26}'
              f'+{delta[cid]:>10,}회  구독 {c.get("subs") or 0:>10,}'
              f'  연속업로드 {c.get("uploadStreak", 0)}일')

    density(reg, delta)

    dormant = sum(1 for c in reg.values() if c.get('tier') == 'dormant')
    pend = sum(1 for c in reg.values() if c.get('category') is None)
    print(f'\n휴면 {dormant}개 · 분류 대기 {pend}개')
    print('\n판정 ① 지도(얼굴) — 한 화면으로 서는 칸이 충분한가. 얇은 칸은 합친다.')
    print('     ② 목록(심장) — 상위10 유지율. 80~100% 로 붙어 있으면 시간 축이 죽은 것이다.')
    print('        🚨 지도형에서 ②는 단독 기각 조건이 아니다 — 지도는 원래 자주 안 바뀐다.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
