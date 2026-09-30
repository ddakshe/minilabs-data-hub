#!/usr/bin/env python3
"""
법정동·리 중심점 표 → urban-plan/cache/bjd-centroids.json

    python3 scripts/build-bjd-centroids.py ~/Data/vworld-bjd ~/ClaudeProjects/realestate-tools/_data/raw/lawd-code-full.txt

**왜 필요한가.** 고속도로 공사현황(fetch-urban-highway.mjs)은 좌표 없이 공구별 시점·종점 **주소**만 준다.
카카오·브이월드·구글 지오코더는 결과 저장이 금지라 쓸 수 없다. 대신 **법정경계 폴리곤에서 직접 중심점을 계산**하면
그 결과는 우리 산출물이라 저장할 수 있다. 주소가 대부분 「○○면 ○○리」·「○○동」 수준이라 이 정밀도로 충분하다.

── 입력 ─────────────────────────────────────────────────────────────
1) 브이월드 「행정구역_읍면동(법정동)」 dsId 30603 · 「행정구역_리(법정동)」 dsId 30602 — 시도별 SHP zip.
   🚨 **다운로드에 브이월드 로그인이 필요하다** → Actions 에서 못 받는다. 그래서 이 스크립트는 **손으로** 돌리고
   결과만 커밋한다. 경계가 바뀌는 일은 드물다(행정구역 개편 때만) — 개편 소식이 있으면 다시 받는다.
   받는 법: 로그인 → `/dtmk/downloadResourceFile.do?ds_id={30602|30603}&fileNo={n}` (n 은 2~21, 없는 번호는 404).
   zip 을 `{dir}/x/{zip 이름}/` 에 풀어 둔다.
2) 행안부 법정동코드 전체자료(cp949 TSV: 코드·이름·폐지여부) — 주소 문자열과 맞출 **전체 이름**을 얻는다.

── 함정 ─────────────────────────────────────────────────────────────
1) 좌표계는 EPSG:5186(GRS80 TM 중부, 원점 38N 127E, FE 200000, FN 600000). pyproj 없이 역변환한다.
2) 2026 개편으로 **전남·광주가 통합특별시(코드 12)**, 강원 42→51, 전북 45→52, 화성은 일반구로 코드가 바뀌었다.
   브이월드에는 옛 코드 파일(29·46, 202606)과 새 파일이 같이 있다 → 둘 다 넣는다(코드가 달라 겹치지 않는다).
   도로공사 주소는 옛 이름(「전라남도」)을 쓰므로 옛 코드 쪽이 매칭에 쓰인다.
3) 면적 중심이 폴리곤 밖에 떨어지는 오목한 리가 있다 → 그 경우 중심을 지나는 가로선의 가장 긴 안쪽 구간 가운데를 쓴다.
4) 법정동코드 표에 없는 새 코드는 `full` 이 null 이다 — 매칭 쪽에서 시군구 검사를 건너뛰고 이름·시도로만 고른다.

약관: 브이월드 공개 공간정보(공공누리). 경계 자체는 싣지 않고 계산한 중심점만 낸다.
"""
import glob, json, math, os, sys

import shapefile  # pyshp

a = 6378137.0; f = 1 / 298.257222101; e2 = f * (2 - f); ep2 = e2 / (1 - e2)
LAT0, LON0, FE, FN = math.radians(38), math.radians(127), 200000, 600000


def _m(p):
    return a * ((1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256) * p
                - (3 * e2 / 8 + 3 * e2**2 / 32 + 45 * e2**3 / 1024) * math.sin(2 * p)
                + (15 * e2**2 / 256 + 45 * e2**3 / 1024) * math.sin(4 * p)
                - (35 * e2**3 / 3072) * math.sin(6 * p))


M0 = _m(LAT0)


def to_wgs84(x, y):
    mu = (M0 + (y - FN)) / (a * (1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    p1 = (mu + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu) + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
          + (151 * e1**3 / 96) * math.sin(6 * mu) + (1097 * e1**4 / 512) * math.sin(8 * mu))
    c1 = ep2 * math.cos(p1)**2; t1 = math.tan(p1)**2
    n1 = a / math.sqrt(1 - e2 * math.sin(p1)**2); r1 = a * (1 - e2) / (1 - e2 * math.sin(p1)**2)**1.5
    d = (x - FE) / n1
    lat = p1 - (n1 * math.tan(p1) / r1) * (d**2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * ep2) * d**4 / 24
                                          + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * ep2 - 3 * c1**2) * d**6 / 720)
    lon = LON0 + (d - (1 + 2 * t1 + c1) * d**3 / 6
                  + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * ep2 + 24 * t1**2) * d**5 / 120) / math.cos(p1)
    return [round(math.degrees(lat), 5), round(math.degrees(lon), 5)]


def _rings(sh):
    parts = list(sh.parts) + [len(sh.points)]
    return [sh.points[parts[i]:parts[i + 1]] for i in range(len(parts) - 1)]


def _area_centroid(r):
    A = cx = cy = 0.0
    for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1]):
        c = x1 * y2 - x2 * y1; A += c; cx += (x1 + x2) * c; cy += (y1 + y2) * c
    return A / 2, (cx / (3 * A) if A else r[0][0]), (cy / (3 * A) if A else r[0][1])


def _inside(x, y, r):
    hit = False
    for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def representative(sh):
    outer = max(_rings(sh), key=lambda r: abs(_area_centroid(r)[0]))
    _, cx, cy = _area_centroid(outer)
    if _inside(cx, cy, outer):
        return cx, cy
    # 함정 3) 오목한 리 — 가로 주사선의 가장 긴 안쪽 구간 가운데
    xs = sorted((x2 - x1) * (cy - y1) / (y2 - y1) + x1
                for (x1, y1), (x2, y2) in zip(outer, outer[1:] + outer[:1]) if (y1 > cy) != (y2 > cy))
    lo, hi = max(zip(xs[::2], xs[1::2]), key=lambda p: p[1] - p[0])
    return (lo + hi) / 2, cy


def main(src, lawd_path):
    law = {}
    with open(lawd_path, encoding='cp949') as fh:
        for ln in fh:
            p = ln.rstrip('\r\n').split('\t')
            if len(p) == 3 and p[0].isdigit():
                law[p[0]] = p[1]

    items, srcs = {}, {}
    files = sorted(glob.glob(os.path.join(src, 'x', '*', '*.shp')))
    if not files:
        sys.exit(f'✗ {src}/x/*/*.shp 가 없다 — zip 을 먼저 풀어라')
    for shp in files:
        is_ri = '_RI_' in shp
        name = os.path.basename(shp)
        for sr in shapefile.Reader(shp, encoding='cp949').iterShapeRecords():
            d = sr.record.as_dict()
            code = d['RI_CD'] if is_ri else d['EMD_CD'] + '00'
            if not sr.shape.points or (code in srcs and srcs[code] > name):
                continue  # 같은 코드면 최신 기준월 파일을 쓴다
            x, y = representative(sr.shape)
            srcs[code] = name
            items[code] = to_wgs84(x, y) + [d['RI_NM'] if is_ri else d['EMD_NM']]

    sgg = {c[:5]: law[c] for c in law if c.endswith('00000') and not c.endswith('00000000')}
    out = {
        'source': '브이월드 행정구역_읍면동(법정동)·행정구역_리(법정동) 경계에서 계산한 대표점',
        'basis': sorted({n.rsplit('_', 1)[1][:6] for n in srcs.values()}),
        # code(10자리) → [lat, lng, 이름]. 법정동코드 표에 있으면 전체 이름은 names 에
        'points': items,
        'names': {c: law[c] for c in items if c in law},
        'sgg': sgg,
    }
    bad = [c for c, v in items.items() if not (32 < v[0] < 39.5 and 124 < v[1] < 132)]
    if bad or len(items) < 20000:
        sys.exit(f'✗ 검증 실패 — {len(items)}개, 범위 밖 {bad[:5]}')
    dst = os.path.join(os.path.dirname(__file__), '..', 'urban-plan', 'cache', 'bjd-centroids.json')
    with open(dst, 'w') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
    print(f'✓ bjd-centroids.json — {len(items)}개 · 이름 있음 {len(out["names"])} · 기준월 {out["basis"]}')


if __name__ == '__main__':
    main(os.path.expanduser(sys.argv[1]), os.path.expanduser(sys.argv[2]))
