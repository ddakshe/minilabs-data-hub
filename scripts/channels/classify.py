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
}
# 사람이 봐야 하는 것 — id: 왜 애매한지
REVIEW = {
    'UCdwlSE2aW2VCCQIS5aJwTsA': '시동위키 — 경제·법·정치에 음악·예술·여행까지 섞인 잡학',
    'UCLF1hNfWMvgq4zvR5qzDWgg': '그리구라 — 예능 형식, 주식·부동산 사연을 다룸',
    'UCWstEH0k34aMAMPb5cJ9okw': '유나으리 — 의사 출신, 경제 전문인지 불분명',
    'UCHpGooMnVgnILywqrpqvZcQ': '힐링여행자 — 주식 정보 + 여행이 반반',
}
# 세부는 질의 파일(queries.tsv 2열)이 `subHint` 로 실어 준다. 여기 표를 둘 필요가 없다.


def main() -> int:
    p = ytapi.DATA / 'registry.json'
    reg = json.loads(p.read_text())
    chans = reg['channels']
    stamp = datetime.now(KST).date().isoformat()
    n = {'none': 0, 'review': 0, 'econ': 0}

    for cid, c in chans.items():
        if c.get('category') is not None:
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
