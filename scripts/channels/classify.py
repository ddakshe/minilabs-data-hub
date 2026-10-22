#!/usr/bin/env python3
"""분류를 레지스트리에 적는다. **이 라벨과 걸러낸 이력이 자산이다.**

유튜브 `videoCategory` 에는 경제·부동산·도시개발이 없다. 우리가 만든다.
걸러낸 것(`category: 'none'`)도 **지우지 않고 이유와 함께 남긴다** — 같은 채널이
다음 발굴에서 또 올라오는데, 이력이 없으면 매번 다시 판단해야 한다.

쓰는 법: 이 파일의 NONE·REVIEW 에 채널 id 를 적고 돌린다. 나머지는 질의 힌트를
그대로 승계한다(= 질의가 곧 카테고리다).
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ytapi  # noqa: E402

KST = timezone(timedelta(hours=9))

# 경제가 아닌 것 — id: 이유
NONE = {
    'UCoCvTlU0KpNYwnMIgs7MPrA': '교양·과학 콘텐츠 제작사(보다 BODA). 경제 전문 아님',
    'UCG9aFJTZ-lMCHAiO1KJsirg': '종합 뉴스(MBN). 경제는 일부',
    'UCMLJc_D3jgFcS_48G7i4V0A': '종합 라디오 스트리밍(KBS 1라디오)',
    'UCtx-S99FkDz93kqhg2Rcj7w': '아랍어 채널. 한국 대상 아님',
    # 🚨 이미 분류된 채널도 여기에 적으면 교정된다. 밀도 지표가 찾아낸 오분류다 —
    #    urban/transit 1위 점유율 79% 로 걸렸고, 원인이 구조가 아니라 오분류였다.
    'UCyNHdF4hMxHUFSsPbY24p6A': '미미미누 — 입시 유튜버. 질의 「지하철 연장」 에 걸렸다',
}
# 사람이 봐야 하는 것 — id: 왜 애매한지
REVIEW = {
    'UCdwlSE2aW2VCCQIS5aJwTsA': '시동위키 — 경제·법·정치에 음악·예술·여행까지 섞인 잡학',
    'UCLF1hNfWMvgq4zvR5qzDWgg': '그리구라 — 예능 형식, 주식·부동산 사연을 다룸',
    'UCWstEH0k34aMAMPb5cJ9okw': '유나으리 — 의사 출신, 경제 전문인지 불분명',
    'UCHpGooMnVgnILywqrpqvZcQ': '힐링여행자 — 주식 정보 + 여행이 반반',
}
# 세부는 질의 파일(queries.tsv 2열)이 `subHint` 로 실어 준다. 여기 표를 둘 필요가 없다.

HANGUL = re.compile('[가-힣]')


def auto_reject(c: dict) -> str | None:
    """손으로 보기 전에 규칙으로 떨어뜨린다. **노하우가 쌓이는 자리다 — 규칙을 늘린다.**

    지금까지 확인된 패턴은 하나다(2026-10-22, 1,131개 중):
      한국어가 한 글자도 없고 국가도 한국이 아닌 채널 — 질의 `환율 달러` 가
      전 세계 forex 채널을 끌어왔다(아랍어·터키어·러시아어·인도네시아어…).
      → 질의 자체도 `원달러 환율` 로 좁히는 게 맞다. queries.tsv 참고.
    country 가 비어 있는 채널은 **떨어뜨리지 않는다** — 한국 채널도 자주 비어 있다.
    """
    text = (c.get('title') or '') + (c.get('description') or '')
    if not HANGUL.search(text) and c.get('country') not in (None, 'KR'):
        return f"한국어 콘텐츠 아님 (country={c.get('country')})"
    return None


def main() -> int:
    p = ytapi.DATA / 'registry.json'
    reg = json.loads(p.read_text())
    chans = reg['channels']
    stamp = datetime.now(KST).date().isoformat()
    n = {'none': 0, 'review': 0, 'econ': 0}

    for cid, c in chans.items():
        # NONE·REVIEW 에 적힌 채널은 **이미 분류됐어도 교정한다.** 그게 이 파일의 용도다
        if c.get('category') is not None and cid not in NONE and cid not in REVIEW:
            continue
        auto = auto_reject(c)
        if auto and cid not in NONE:
            c.update(category='none', rejectReason=auto,
                     classifiedBy='rule', classifiedAt=stamp)
            n['none'] += 1
            continue
        if cid in NONE:
            c.update(category='none', rejectReason=NONE[cid],
                     classifiedBy='claude', classifiedAt=stamp)
            n['none'] += 1
        elif cid in REVIEW:
            c.update(category='review', reviewReason=REVIEW[cid],
                     classifiedBy='claude', classifiedAt=stamp)
            n['review'] += 1
        else:
            hint = c.get('queryHint')
            c.update(category=hint, sub=c.get('subHint'),
                     classifiedBy='claude', classifiedAt=stamp)
            n[hint] = n.get(hint, 0) + 1

    reg['updatedAt'] = datetime.now(KST).isoformat(timespec='seconds')
    p.write_text(json.dumps(reg, ensure_ascii=False, indent=2) + '\n')
    print('분류 반영:', ' · '.join(f'{k} {v}' for k, v in n.items() if v))
    left = sum(1 for c in chans.values() if c.get('category') is None)
    print(f'남은 분류 대기 {left}개')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
