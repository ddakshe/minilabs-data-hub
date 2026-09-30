#!/usr/bin/env python3
"""ITS 국가교통정보센터 CCTV 전국 목록 → cctv-mini(내 CCTV) 앱이 읽는 파일.

    python3 scripts/fetch-cctv.py OUT_DIR

API 4건(고속도로 ex·국도 its × 정지 3·실시간 HTTPS 4). 전국 범위 한 번이면 다 온다.

🚨 ITS 주소는 **24시간만 유효**하다. 하루라도 빠지면 앱의 사진·영상이 전부 안 나온다.
🚨 ITS API 는 클라우드 IP(GitHub 호스티드·GCP 등)에서 연결 타임아웃이다 → 맥 셀프호스티드 러너에서만 돈다.
🚨 ITS 는 인증키당 월 호출 한도가 있다(개발 100 · 운영 보통 30,000). 하루 2회 × 4건 = 월 240건.

출력 (OUT_DIR/cctv/):
- index.json   [id, 이름, 노선, 경도, 위도] 배열. 앱의 지도·검색용.
- urls/NN.json {id: [정지 주소, 실시간 주소]}, id % 64 조각. 첫 화면은 내 CCTV 조각만 받는다.
- meta.json    받은 시각·개수.

id 는 ITS 주소 경로의 번호(ktict.co.kr/<번호>/...). 날이 바뀌어도 그대로이고(9/30 비교 4734/4741)
정지·실시간이 같은 번호를 쓴다. 좌표는 겹치는 카메라가 있어(고속도로 178개) 식별자로 못 쓴다.

용량이 크고(약 4MB) 주소가 매일 전부 바뀌어서 main 에 커밋하지 않는다.
워크플로가 히스토리 없는 `cctv-data` 브랜치에 강제 푸시한다 — 저장소가 불어나지 않는다.
"""
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

BUCKETS = 64
MIN_COUNT = {"ex": 4000, "its": 5000}  # 이보다 적으면 응답이 잘린 것으로 보고 멈춘다(어제 파일을 덮지 않는다)
ENDPOINT = "https://openapi.its.go.kr:9443/cctvInfo"
BBOX = "minX=124&maxX=132&minY=33&maxY=39"


def api_key():
    k = os.environ.get("ITS_API_KEY", "").strip()
    if not k:
        p = Path.home() / ".config" / "its-key"
        k = p.read_text().strip() if p.exists() else ""
    if not k:
        sys.exit("ITS_API_KEY 도 ~/.config/its-key 도 없다")
    return k


def fetch(key, road, kind):
    url = f"{ENDPOINT}?apiKey={key}&type={road}&cctvType={kind}&{BBOX}&getType=json"
    with urllib.request.urlopen(url, timeout=90) as r:
        body = json.load(r)
    data = body.get("response", {}).get("data")
    if not isinstance(data, list):
        sys.exit(f"{road}-{kind}: 예상과 다른 응답 {str(body)[:200]}")
    if len(data) < MIN_COUNT[road]:
        sys.exit(f"{road}-{kind}: {len(data)}건뿐 — 잘린 응답으로 보고 멈춘다")
    return data


num = lambda u: int(re.search(r"ktict\.co\.kr(?::\d+)?/(\d+)/", u).group(1))


def split_name(raw):
    m = re.match(r"\s*\[(.*?)\]\s*(.*)", raw)
    road, name = (m.group(1), m.group(2)) if m else ("", raw)
    road = road.strip()
    # 국도 표기가 제각각이다: 「국도 1호선」「국도1호선」「국도5」「위임국도59」 → 「국도 N호선」
    g = re.fullmatch(r"(?:위임)?국도\s*(\d+)(?:호선)?", road)
    if g:
        road = f"국도 {int(g.group(1))}호선"
    return road, name.strip() or raw.strip()


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = Path(sys.argv[1]) / "cctv"
    key = api_key()

    index, urls = [], {}
    for road in ("ex", "its"):
        still = fetch(key, road, 3)
        live = {num(c["cctvurl"]): c["cctvurl"] for c in fetch(key, road, 4)}
        for c in still:
            i = num(c["cctvurl2"])
            if i in urls:
                continue
            r, n = split_name(c["cctvname"])
            index.append([i, n, r, round(c["coordx"], 5), round(c["coordy"], 5)])
            urls[i] = [c["cctvurl2"], live.get(i, "")]

    index.sort(key=lambda row: (row[2], row[1]))
    (out / "urls").mkdir(parents=True, exist_ok=True)
    (out / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")))
    for b in range(BUCKETS):
        part = {str(i): u for i, u in urls.items() if i % BUCKETS == b}
        (out / "urls" / f"{b:02d}.json").write_text(json.dumps(part, separators=(",", ":")))
    fetched = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    (out / "meta.json").write_text(json.dumps({"fetchedAt": fetched, "count": len(index), "buckets": BUCKETS}))
    print(f"{len(index)} cctv · fetched {fetched} → {out}")


if __name__ == "__main__":
    main()
