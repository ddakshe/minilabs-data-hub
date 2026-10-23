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
    'UCoxT1kQSLq564FwpK473w-g': '크랩 KLAB — KBS 시사·교양. 경제 전문 아님',
    'UCSzpHE8fNKapVLqEyJhCxSg': '인생노트 — 사연 라디오. 경제 아님',
    'UCnLAcTZroegnABTiqDBR5Fw': '해운대 풍경 — 풍경 채널. 질의 「국가부채 재정」 에 걸렸다',
}
# 사람이 봐야 하는 것 — id: 왜 애매한지
REVIEW = {
    'UCdwlSE2aW2VCCQIS5aJwTsA': '시동위키 — 경제·법·정치에 음악·예술·여행까지 섞인 잡학',
    'UCLF1hNfWMvgq4zvR5qzDWgg': '그리구라 — 예능 형식, 주식·부동산 사연을 다룸',
    'UCWstEH0k34aMAMPb5cJ9okw': '유나으리 — 의사 출신, 경제 전문인지 불분명',
    'UCHpGooMnVgnILywqrpqvZcQ': '힐링여행자 — 주식 정보 + 여행이 반반',
    'UCGbBsCwi2Ohh5Y61chv_N6w': '팩트빌더 — 설명에 「정치,경제,뉴스,이슈」. 정치 비중 불명',
    'UC1w3vCc-kgwKQNUvZju2V1w': '문명순 TV — 「정치ㆍ경제의 본질」. 정치 비중 불명',
    'UCsjvgV8YZ84pZmHDlurUy8Q': 'FutureEconLab — 「정치&경제&이슈 팩트폭행」',
    'UCfKBue1iAOfltXBGUcT8eqw': '한국해설소 — 「군사, 경제, 사회 이슈」. 시사 종합에 가깝다',
    'UCjcsgya3C8krj-uo24PgxAw': '마당N — 미주 한인 정보 공유. 경제 전문 아님',
    'UCUoYvgfHG1rvblfVCXY9c8g': 'minimal rich — 미니멀 라이프. 경제와 겹치는 정도 불명',
}
# 세부는 질의 파일(queries.tsv 2열)이 `subHint` 로 실어 준다. 여기 표를 둘 필요가 없다.

HANGUL = re.compile('[가-힣]')
# 한글도 라틴도 아닌 문자 체계 — 키릴·아랍·태국·히브리·데바나가리.
# 이게 보이면 country 가 비어 있어도 한국 채널이 아니다.
FOREIGN_SCRIPT = re.compile(r'[\u0400-\u04FF\u0590-\u06FF\u0900-\u097F\u0E00-\u0E7F]')

# 종합 뉴스 브랜드. **보수적으로 좁게** 잡는다 — 경제 전문 뉴스를 날리면 안 된다.
# 살아남아야 하는 것들: 한국경제TV · SBS Biz 뉴스 · 매일경제TV · 이데일리TV ·
#   연합뉴스경제TV · 서울경제TV · KBS 경제한방 · MTN 머니투데이방송 · 경제통마늘(YTN라디오)
# 그래서 ① 브랜드명이 「뉴스/News」 와 **붙어 있을 때만** 잡고
#        ② 제목에 경제 표지(경제·증권·머니·비즈·Biz…)가 있으면 **살린다**.
GENERAL_NEWS = re.compile(
    r'(JTBC|MBN|YTN|채널A|TV조선|연합뉴스TV)\s*(News|뉴스)?$'
    r'|^(KBS|SBS|MBC)\s*(News|뉴스)'
    r'|^뉴스\s*[A-Z]$', re.I)
ECON_MARK = re.compile(r'경제|증권|머니|비즈|Biz|금융|투자|부동산|재테크|주식|Money', re.I)


def auto_reject(c: dict) -> str | None:
    """손으로 보기 전에 규칙으로 떨어뜨린다. **노하우가 쌓이는 자리다 — 규칙을 늘린다.**

    지금까지 확인된 패턴은 하나다(2026-10-22, 1,131개 중):
      한국어가 한 글자도 없고 국가도 한국이 아닌 채널 — 질의 `환율 달러` 가
      전 세계 forex 채널을 끌어왔다(아랍어·터키어·러시아어·인도네시아어…).
      → 질의 자체도 `원달러 환율` 로 좁히는 게 맞다. queries.tsv 참고.
    country 가 비어 있는 채널은 **떨어뜨리지 않는다** — 한국 채널도 자주 비어 있다.
    """
    text = (c.get('title') or '') + (c.get('description') or '')
    if not HANGUL.search(text):
        if FOREIGN_SCRIPT.search(text):
            return '한국어 콘텐츠 아님 (키릴·아랍 등 다른 문자 체계)'
        if c.get('country') not in (None, 'KR'):
            return f"한국어 콘텐츠 아님 (country={c.get('country')})"
    title = (c.get('title') or '').strip()
    if GENERAL_NEWS.search(title) and not ECON_MARK.search(title):
        return f'종합 뉴스 채널 ({title}). 경제 전문이 아니다'
    return None


def auto_review(c: dict) -> str | None:
    """떨어뜨리기엔 근거가 약한 것 — 사람이 본다. **추측으로 지우지 않는다.**

    한글이 없는데 country 도 비어 있으면 한국 채널인지 알 수 없다. 실제로
    `LIFE DIPTA`·`DIPIE` 는 country=KR 인 한국 채널이었다(제목만 영어).
    같은 모양인데 country 가 비면 판단할 근거가 없으므로 보류한다.
    """
    text = (c.get('title') or '') + (c.get('description') or '')
    if not HANGUL.search(text) and c.get('country') is None:
        return '한글이 없고 country 도 비어 있다 — 한국 채널인지 확인 필요'
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
        rev = auto_review(c)
        if rev and cid not in NONE and cid not in REVIEW:
            c.update(category='review', reviewReason=rev,
                     classifiedBy='rule', classifiedAt=stamp)
            n['review'] += 1
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
