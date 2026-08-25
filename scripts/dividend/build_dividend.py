#!/usr/bin/env python3
"""stock-dividend-mini 데이터 배치 — SEC EDGAR XBRL 단독.

키·허용 IP가 필요 없다. DART 를 쓰는 stock-ipo-mini 와 같은 등급이라
**GitHub Actions 로 완전 자동화된다** (LOCAL_JOBS.md 에 줄이 늘지 않는다).

  python3 scripts/dividend_batch.py              # 전체 수집
  python3 scripts/dividend_batch.py --from-cache # 수집 건너뛰고 계산만

SEC 요구사항은 둘뿐이다 — User-Agent 에 연락 이메일, 초당 10요청 이하.
이메일 없는 UA 는 403 으로 막힌다(이 저장소 다른 스크립트의 'Mozilla/5.0' 관례와 다르다).

정규화 규칙은 전부 실측으로 정해졌다. 근거는 stock-dividend-mini/PROJECT.md.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import statistics as st
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

# 허브 저장소 뿌리. scripts/dividend/build_dividend.py → 두 단계 위
ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / 'scripts' / '.cache' / 'dividend'
# 출력은 저장소 안 한 곳뿐이다. **앱의 public/data 를 여기서 쓰지 않는다** —
# CI 러너에는 앱 저장소가 없다. 로컬 개발본은 앱에서 `npm run data:sync` 로 받아간다.
OUTS = (ROOT / 'dividend' / 'dividend.json',)

UA = {'User-Agent': 'stock-tools batch ddakshe@gmail.com'}
SLEEP = 0.12                      # 초당 10요청 제한 아래로
EPS = 0.005                       # 증감 판정 허용오차 0.5%
TODAY = dt.date.today()

# 태그는 회사마다 다르다 — 폴백 체인 (PROJECT.md 함정 ①)
TAGS = [
    'CommonStockDividendsPerShareDeclared',   # AAPL · INTC · T
    'CommonStockDividendsPerShareCashPaid',   # KO · O
    'DividendsPayableAmountPerShare',         # 실측 기여 0건이지만 남겨둔다
]
SPLIT_TAG = 'StockholdersEquityNoteStockSplitConversionRatio1'
YEARS = range(2015, TODAY.year + 1)


def get(url: str, tries: int = 3):
    """gzip 해제까지. asset_batch.py 가 밟았던 함정 — 압축을 안 풀면 UnicodeDecodeError."""
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={**UA, 'Accept-Encoding': 'gzip'})
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
                if r.headers.get('Content-Encoding') == 'gzip':
                    body = gzip.decompress(body)
                return json.loads(body)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if i == tries - 1:
                raise
            time.sleep(1 + i)
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(1 + i)
    return None


def cached(name: str, fn):
    CACHE.mkdir(parents=True, exist_ok=True)
    p = CACHE / name
    if p.exists():
        return json.loads(p.read_text())
    v = fn()
    p.write_text(json.dumps(v))
    return v


# ---------------------------------------------------------------- 수집

def fetch_frames() -> dict:
    """CIK -> {'start|end': {val, tag}}. 분기 프레임을 태그별로 훑는다.

    companyfacts 를 종목마다 받으면 회사당 수 MB 라 2,600종목이면 수십 GB 다.
    frames 는 전 종목을 한 번에 준다 — 요청 141회로 끝난다.
    """
    out: dict[str, dict] = defaultdict(dict)
    req = 0
    for tag in TAGS:
        for y in YEARS:
            for q in (1, 2, 3, 4):
                d = get(f'https://data.sec.gov/api/xbrl/frames/us-gaap/{tag}/'
                        f'USD-per-shares/CY{y}Q{q}.json')
                req += 1
                time.sleep(SLEEP)
                if not d:
                    continue
                for r in d['data']:
                    key = f"{r['start']}|{r['end']}"
                    cur = out[str(r['cik'])]
                    if key in cur:                      # 폴백 체인 우선순위 유지
                        continue
                    cur[key] = {'val': r['val'], 'tag': tag, 'name': r['entityName']}
        print(f'  [{tag}] 누적 {sum(len(v) for v in out.values())}건 (요청 {req}회)', flush=True)
    return out


def fetch_annual_div() -> dict:
    """연간 배당 프레임 — {cik|year: 값}. 분기 합산보다 이쪽이 먼저다 (annual_series 참고).

    태그 폴백 체인의 우선순위를 setdefault 로 유지한다 — fetch_frames 와 같은 규칙.
    요청은 태그 3 × 연도 12 = 36회. 분기까지 훑는 fetch_frames 의 1/4 이다.
    """
    out = {}
    for tag in TAGS:
        for y in YEARS:
            d = get(f'https://data.sec.gov/api/xbrl/frames/us-gaap/{tag}/'
                    f'USD-per-shares/CY{y}.json')
            time.sleep(SLEEP)
            if not d:
                continue
            for r in d['data']:
                out.setdefault(f"{r['cik']}|{y}", r['val'])
    return out


def fetch_year_frames(tag: str, unit: str) -> dict:
    """연간 프레임 — {cik|year: 값}. EPS·순이익용."""
    out = {}
    for y in range(2018, TODAY.year + 1):
        d = get(f'https://data.sec.gov/api/xbrl/frames/us-gaap/{tag}/{unit}/CY{y}.json')
        time.sleep(SLEEP)
        if not d:
            continue
        for r in d['data']:
            out.setdefault(f"{r['cik']}|{y}", r['val'])
    return out


# ---------------------------------------------------------------- 정규화

def quarters(m: dict) -> list[tuple[str, float]]:
    """분기(75~100일)만 골라낸다. 혼자 0인 값은 오류로 보고 뺀다 (INTC 2018Q2).

    ⚠️ **아직 끝나지 않은 분기는 뺀다.** 다음 분기 배당을 미리 선언해 신고하는 회사가 있어
    (CHESAPEAKE UTILITIES 가 2026Q3 에 val=0), 그대로 두면 기준 시점이 미래가 되고
    다른 종목이 죄다 '오래된 데이터'로 밀린다.
    """
    o = []
    for k, v in m.items():
        s, e = k.split('|')
        if e > TODAY.isoformat():
            continue
        days = (dt.date.fromisoformat(e) - dt.date.fromisoformat(s)).days
        if 75 <= days <= 100:
            o.append((e, v['val']))
    o.sort()
    return [(e, v) for i, (e, v) in enumerate(o)
            if not (v == 0 and 0 < i < len(o) - 1 and o[i - 1][1] > 0 and o[i + 1][1] > 0)]


def qidx(e: str) -> int:
    d = dt.date.fromisoformat(e)
    return d.year * 4 + (d.month - 1) // 3


def annual(q: list[tuple[str, float]]) -> list[tuple[int, float]]:
    """연간 합계. **4분기가 다 있는 해만** 쓴다.

    3개면 평균으로 메우고, 2개 이상 빠지면 그 해를 버린다. 이걸 안 하면
    연 1회 일괄 선언형(WMT)이 가짜 삭감으로 잡힌다 (PROJECT.md 함정 ⑥).
    """
    grid = {qidx(e): v for e, v in q}
    if not grid:
        return []
    lo, hi = min(grid), max(grid)
    by = defaultdict(dict)
    for i in range(lo, hi + 1):
        by[i // 4][i % 4] = grid.get(i)
    out = []
    for y in sorted(by):
        qs = by[y]
        if len(qs) < 4:                      # 연초·연말이 잘린 해
            continue
        rep = [v for v in qs.values() if v is not None]
        if len(rep) < 3:
            continue
        out.append((y, round(sum(rep) * 4 / 3 if len(rep) == 3 else sum(rep), 6)))
    return out


def annual_series(q: list[tuple[str, float]], ann: dict[int, float]) -> list[tuple[int, float]]:
    """연간 배당 계열. **연간 프레임이 1순위**이고, 못 믿을 때만 분기 합산으로 돌아간다.

    분기 프레임의 값은 '그 기간에 **선언된** 배당의 합'이지 분기 배당액이 아니다.
    이사회 선언이 분기 경계에 걸치면 한 분기에 2회, 다른 분기에 0회가 된다.
    실측: CAT 2024Q2 = 2.71 = 1.30 + 1.41 · LLY 2018Q2 = 1.13 = 0.5625 × 2.
    기간이 90일이어도 값은 90일치가 아니다 — 그래서 분기 4개를 모아 더하는 방식은
    회사에 따라 과대(LLY 2018 +25%)·과소(CAT 2015 −35%) 가 둘 다 난다.
    CAT 은 2019년 이후 분기 프레임이 1년에 하나뿐이라 연도가 아예 안 만들어졌고,
    그 결과 9년치가 cut·streak 판정에서 빠졌다.

    연간 프레임(CY{y})에는 이 문제가 없다. 다만 0 이나 단위가 어긋난 값이 섞여 있어
    (PLD 2024 = 0.01, 실제 3.84) 불변식으로 거른다 —
    **연간 배당은 그 해 어느 분기 값보다 작을 수 없다.** 분기 값은 그 해에 선언된
    배당의 부분집합이기 때문이다. 전량 대조 8,289쌍 중 87쌍이 걸렸고 전부 0 계열이었다.

    ⚠️ 상한은 두지 않는다. 연간이 분기최대의 6배를 넘는 161쌍에 단위 오류(PKE 50 vs
    0.125)와 특별배당(DDS 26 vs 0.25 · PGR 13.9 vs 0.1)이 섞여 있어 구분할 수 없다.
    특별배당은 PROJECT.md 가 이미 아는 '연 1회 선언형' 문제라 여기서 다루지 않는다.
    """
    by_year: dict[int, list[float]] = defaultdict(list)
    for e, v in q:
        by_year[int(e[:4])].append(v)

    fallback = dict(annual(q))
    out = []
    for y in sorted(set(by_year) | set(ann)):
        a = ann.get(y)
        qs = by_year.get(y, [])
        recon = fallback.get(y)
        if a and a >= _floor(qs, recon) - 1e-9 and not _unit_error(a, _uniform(qs, recon)):
            out.append((y, round(a, 6)))
        elif y in fallback:
            out.append((y, fallback[y]))
    return out


def _uniform(qs: list[float], recon: float | None) -> float | None:
    """분기가 **균등**할 때의 재구성값. 그때만 재구성값을 믿을 수 있다.

    분기가 뭉쳐 있으면(LLY 2018 Q2 = 0.5625×2) 재구성값 자체가 틀렸다.
    """
    nz = [v for v in qs if v > 0]
    if recon is None or len(nz) < 3:
        return None
    return recon if max(nz) <= 1.5 * st.median(nz) else None


def _floor(qs: list[float], recon: float | None) -> float:
    """연간 프레임 값을 믿어도 되는 하한.

    분기가 균등하면 재구성값을 하한으로 쓴다. 이게 있어야 '연간 컨텍스트에 분기 금액을
    태깅한' 값이 걸린다 (SAIC 2018 연간 0.31 · 분기 0.31×3 → 재구성 1.24 로 기각).
    """
    u = _uniform(qs, recon)
    if u is not None:
        return u
    nz = [v for v in qs if v > 0]
    return max(nz) if nz else 0.0


def _unit_error(a: float, recon: float | None) -> bool:
    """연간 프레임 값이 재구성값의 **10·100·1000 배에 붙어 있으면 단위 오류**다.

    달러 대신 센트로 신고하는 회사가 있다. 기간도 1년이고 하한도 넘어서 다른 검사에
    전부 통과한다. 실측: FMBH 2023 연간 92 · 분기 0.23×4 = 0.92 → 정확히 100배.
    PKE 도 같다(50 vs 0.5). 그대로 두면 0.90 → 92 로 뛰어 배당 증가율이 연 +75.6%가
    되고 목록 첫 줄에 올라온다.

    특별배당은 배율이 제각각이라 갈린다 — DDS 23.6·26.0·29.2배 · PGR 12.2·34.7배 ·
    ITIC 9.5배. 전량에서 4배 초과 47쌍 중 이 규칙에 걸린 것은 5쌍(2종목)뿐이었고
    둘 다 진짜 단위 오류였다.
    """
    if not recon or recon <= 0 or a <= 0:
        return False
    f = a / recon
    return any(abs(f / k - 1) < 0.03 for k in (10, 100, 1000))


def _cuts(a: list[tuple[int, float]]) -> list[int]:
    """삭감이 일어난 연도. **특별배당이 있던 해 다음의 하락은 삭감이 아니다.**

    연간 프레임은 특별배당을 포함한다 (SMG FY2020 = 정규 2.36 + 특별 5.00 = 7.36).
    다음 해에 특별배당이 없으면 값이 뚝 떨어지는데 그걸 삭감으로 잡으면 안 된다.
    분기 합산 시절에는 특별배당이 잘 안 잡혀 드러나지 않던 문제라, 연간 프레임으로
    옮기면서 생긴 부작용이다.

    계열 중앙값의 1.8배를 넘는 해를 특별배당으로 본다. 앞 해가 평범하면 그대로
    삭감으로 잡힌다 — EQT 2020 (0.12 → 0.03).
    """
    vs = [v for _, v in a]
    med = st.median(vs) if vs else 0
    return [y1 for (_, v0), (y1, v1) in zip(a, a[1:])
            if v1 < v0 * (1 - EPS) and not (med > 0 and v0 >= med * 1.8)]


def robust_cagr(series: list[tuple[int, float]]):
    """앞 2년 평균 → 뒤 2년 평균. 한 해의 특이값에 흔들리지 않는다.

    CSCO 는 2018년 세금 손실 탓에 단순 계산으로 +90.9%, 이 방식으로 +9.7%.
    """
    if len(series) < 5:
        return None, None
    ys = [y for y, _ in series]
    vs = [v for _, v in series]
    if any(v <= 0 for v in vs[:2] + vs[-2:]):
        return None, None
    v0, v1 = (vs[0] + vs[1]) / 2, (vs[-1] + vs[-2]) / 2
    span = ((ys[-1] + ys[-2]) - (ys[0] + ys[1])) / 2
    if span < 3:
        return None, None
    return round(((v1 / v0) ** (1 / span) - 1) * 100, 1), [ys[0], ys[-1]]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--from-cache', action='store_true', help='수집을 건너뛰고 계산만')
    args = ap.parse_args()

    if args.from_cache and not (CACHE / 'frames.json').exists():
        print('캐시가 없다. --from-cache 없이 한 번 돌릴 것.', file=sys.stderr)
        return 1

    print('1) CIK → 티커')
    tickers = cached('tickers.json', lambda: get('https://www.sec.gov/files/company_tickers.json'))
    cik2tic = {}
    for r in tickers.values():
        cik2tic.setdefault(str(r['cik_str']), r['ticker'])
    print(f'   {len(cik2tic)}건')

    print('2) 배당 프레임 수집')
    raw = cached('frames.json', fetch_frames)
    print(f'   종목 {len(raw)}')

    print('3) 연간 배당 프레임 — 분기 합산보다 우선한다 (annual_series 참고)')
    adiv = cached('annual_div.json', fetch_annual_div)
    adiv_by_cik = defaultdict(dict)
    for k, v in adiv.items():
        c, y = k.split('|')
        adiv_by_cik[c][int(y)] = v
    print(f'   {len(adiv)}건 · 종목 {len(adiv_by_cik)}')

    print('4) EPS · 순이익 프레임')
    eps = cached('eps.json', lambda: fetch_year_frames('EarningsPerShareDiluted', 'USD-per-shares'))
    eps2 = cached('eps_basic.json', lambda: fetch_year_frames('EarningsPerShareBasic', 'USD-per-shares'))
    ni = cached('netincome.json', lambda: fetch_year_frames('NetIncomeLoss', 'USD'))

    print('5) 종목별 계산')
    rows = []
    for cik, m in raw.items():
        tic = cik2tic.get(cik)
        if not tic:                       # 티커가 없다 = 더 이상 상장돼 있지 않다
            continue
        q = quarters(m)
        if not q:
            continue
        last = dt.date.fromisoformat(q[-1][0])
        if (TODAY - last).days > 365:     # 1년 넘게 공시가 없으면 유니버스에서 뺀다
            continue
        a = annual_series(q, adiv_by_cik.get(cik, {}))
        if len(a) < 3:
            continue
        ys = [y for y, _ in a]
        av = [v for _, v in a]
        if any(v > 100 for v in av) or any(v > 50 for _, v in q):
            continue                      # 주당 배당으로 볼 수 없는 값 (UHT 분기 $750)

        cuts = _cuts(a)
        streak = 0
        for x, y2 in zip(av[::-1][1:], av[::-1][:-1]):
            if y2 > x * (1 + EPS):
                streak += 1
            else:
                break

        payout = None
        for y, dps in sorted(a, reverse=True):
            e = eps.get(f'{cik}|{y}', eps2.get(f'{cik}|{y}'))
            if e is None:
                continue
            payout = round(dps / e * 100, 1) if e > 0 else -1
            break
        if payout is not None and payout > 1000:
            payout = None

        dg, dgw = robust_cagr(a)
        nyears = sorted(int(k.split('|')[1]) for k in ni if k.startswith(f'{cik}|'))
        ng, ngw = robust_cagr([(y, ni[f'{cik}|{y}']) for y in nyears]) if len(nyears) >= 5 else (None, None)

        label = (f'{streak}년 연속 올랐어요' if streak >= 3 else
                 '최근에 줄었어요' if (cuts and cuts[-1] == ys[-1]) else
                 '줄인 적이 있어요' if cuts else
                 '올렸어요' if streak >= 1 else '그대로예요')
        rows.append({
            'cik': cik, 't': tic, 'n': m[next(iter(m))]['name'].title(),
            'l': label, 'c': 'down' if cuts else ('up' if streak else 'flat'),
            's': streak, 'cut': 1 if cuts else 0, 'cuty': cuts[-1] if cuts else None,
            'p': payout, 'g5': dg, 'gwin': dgw, 'ng': ng, 'ngy': ngw,
            'a': [[y, v] for y, v in a[-12:]],
            'q': [[f'{i // 4}.{i % 4 + 1}', ({qidx(e): v for e, v in q}).get(i)]
                  for i in range(max(qidx(q[0][0]), qidx(q[-1][0]) - 11), qidx(q[-1][0]) + 1)],
            'ld': q[-1][0], 'lv': q[-1][1], 'fd': q[0][0],
        })
    print(f'   {len(rows)}종목')

    # asOf 는 마지막 분기 프레임의 종료일 = 가장 최근 공시 시점이다.
    # 행에서 ld/lv/q 를 떼기 전에 여기서 뽑아 둔다.
    as_of = max(r['ld'] for r in rows)

    print('6) 주식분할 조회 — 급락 구간이 있는 종목만')
    # 분할하면 주당 배당이 하루아침에 1/4·1/10 로 준다. 보정을 세 번 시도했으나
    # 프레임에 분할 전 값과 수정본이 섞여 있어 구분이 불가능했다 → **제외**한다.
    susp = [r for r in rows if any(v1 < v0 * 0.7 for (_, v0), (_, v1) in zip(r['a'], r['a'][1:]))]
    splits = cached('splits.json', lambda: _fetch_splits(susp))
    for r in rows:
        r['sp'] = 1 if r['t'] in splits else 0
        if r['sp']:
            r['g5'] = None
    print(f'   분할 이력 {sum(r["sp"] for r in rows)}종목 (조회 {len(susp)})')

    print('7) 신규 배당 검증 — 첫 기록이 최근인 종목만')
    # 관측 창이 2015년부터라 그 이전은 안 보인다. 검증 없이 쓰면 24%가 틀린다
    # (UFPI 는 우리 첫 기록 2019년, 실제 최초 2008년).
    newc = [r for r in rows if r['fd'][:4] >= '2019' and not r['cut']]
    firsts = cached('firsts.json', lambda: _fetch_firsts(newc))
    for r in rows:
        f = firsts.get(r['t'])
        r['nw'] = 1 if (f and f[:4] >= '2019') else 0
        if r['nw']:
            r['fd'] = f
    print(f'   신규 배당 {sum(r["nw"] for r in rows)}종목 (후보 {len(newc)})')

    print('8) 성격 분류')
    for d in rows:
        k = None
        if not d['cut'] and not d['sp']:
            p, ng, g5 = d['p'], d['ng'], d['g5']
            if p is not None and 0 < p < 25 and ng is not None and ng >= 10:
                k = 'growth'
            elif ng is not None and ng >= 7 and (d['s'] >= 3 or (g5 or 0) >= 3):
                k = 'both'
            elif p is not None and 45 <= p <= 120:
                k = 'income'
        d['k'] = k
        d.pop('cik', None)
        # 분기 필드는 앱에서 쓰지 않는다. 상세 시트의 분기 탭을 없앴기 때문이다 —
        # 분기 프레임의 값은 '그 분기에 선언된 배당'이지 분기 배당액이 아니라
        # "분기 주당배당금"이라는 제목이 대부분의 종목에서 거짓말이었다.
        # 세 필드가 JSON 의 40%(713 → 425KB, gzip 111 → 70KB)를 차지한다.
        for dead in ('q', 'lv', 'ld'):
            d.pop(dead, None)

    counts = defaultdict(int)
    for d in rows:
        counts[d['k'] or '분류없음'] += 1
    counts['이제 시작'] = sum(d['nw'] for d in rows)

    payload = {
        'asOf': as_of,
        'builtAt': TODAY.isoformat(),
        'source': 'SEC EDGAR XBRL',
        'rows': rows,
    }
    blob = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
    for out in OUTS:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(blob)
    print(f'\n완료 · {len(rows)}종목 · {len(blob) // 1024}KB')
    for out in OUTS:
        print(f'   → {out}')
    print('   ⚠️ 커밋·푸시해야 프로덕션에 반영된다')
    print('   ' + ' · '.join(f'{k} {v}' for k, v in counts.items()))
    return 0


def _fetch_splits(susp) -> dict:
    out = {}
    for r in susp:
        d = get(f"https://data.sec.gov/api/xbrl/companyconcept/"
                f"CIK{int(r['cik']):010d}/us-gaap/{SPLIT_TAG}.json")
        time.sleep(0.08)
        if not d:
            continue
        ev = {v['end']: v['val'] for u in d['units'].values() for v in u
              if v.get('val') and v['val'] > 1.05}     # 액면분할만 (역분할 제외)
        if ev:
            out[r['t']] = sorted(ev.items())
    return out


def _fetch_firsts(cand) -> dict:
    out = {}
    for r in cand:
        earliest = None
        for tag in TAGS[:2]:
            d = get(f"https://data.sec.gov/api/xbrl/companyconcept/"
                    f"CIK{int(r['cik']):010d}/us-gaap/{tag}.json")
            time.sleep(0.08)
            if not d:
                continue
            for u in d['units'].values():
                for v in u:
                    if v.get('val', 0) <= 0:
                        continue
                    s = v.get('start') or v['end']
                    if earliest is None or s < earliest:
                        earliest = s
        if earliest:
            out[r['t']] = earliest
    return out


if __name__ == '__main__':
    sys.exit(main())
