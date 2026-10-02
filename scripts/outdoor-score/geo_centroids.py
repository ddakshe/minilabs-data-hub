"""시군구 중심점(가장 큰 폴리곤 바깥 고리 평균). fetch_kma.py·fetch_openmeteo.py 가 함께 쓴다."""
import json
import os
from pathlib import Path

# 2025-04 행정동 경계를 시군구로 합친 것(행안부 시군구 코드). 허브에서는 TOPO 환경변수로 위치를 넘긴다
TOPO = Path(os.environ.get("TOPO") or Path(__file__).parent / "munis_2025_topo.json")


def centroids():
    topo = json.loads(TOPO.read_text())
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)

    def ring(idx):
        pts = []
        for i in idx:
            a = arcs[i] if i >= 0 else arcs[~i][::-1]
            pts.extend(a)
        return pts

    out = []
    for g in next(iter(topo["objects"].values()))["geometries"]:
        polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
        # 가장 큰 폴리곤(꼭짓점 많은 것)의 바깥 고리 평균 — 섬이 많은 군에서 중심이 바다로 빠지지 않게
        outer = max((ring(p[0]) for p in polys), key=len)
        lon = sum(p[0] for p in outer) / len(outer)
        lat = sum(p[1] for p in outer) / len(outer)
        pr = g["properties"]
        out.append({"code": pr.get("sgg") or pr.get("code"), "name": pr.get("sggnm") or pr.get("name"), "lat": round(lat, 4), "lon": round(lon, 4)})
    return out
