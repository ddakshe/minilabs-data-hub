"""기상청 단기예보 + 에어코리아 실시간으로 시군구별 예보를 받아 data/forecast.json 으로 저장한다.

출시용 수집기. 화면(mockup.html)이 읽는 형식은 fetch_openmeteo.py 와 같다.
- 기상청 단기예보: 시군구 중심점 → 5km 격자(nx, ny), 격자마다 1회 호출(겹치는 격자는 한 번만)
- 에어코리아: sidoName=전국 한 번으로 측정소 전체 → 측정소 좌표 API 승인 전까지는 시도 평균을 그 시도 시군구에 똑같이
- 기상청에 없는 값(구름 층별·가시거리·자외선)은 비우거나 추정한다(아래 주석)

키: ~/.config/stock-tools/datagokr.env 의 DATA_GO_KR_KEY (이미 URL 인코딩된 형태) 또는 환경변수
"""
import json
import math
import os
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

from geo_centroids import centroids

ROOT = Path(__file__).parent
OUT = Path(os.environ.get("OUT") or ROOT / "public" / "data" / "forecast.json")  # 허브는 OUT 으로 출력 위치를 넘긴다. 앱이 읽는 파일(시안 mockup.html 용 data/forecast.json 에도 복사)
MOCK = ROOT / "data" / "forecast.json"
KST = timezone(timedelta(hours=9))
HOURS = 72  # 기본값 — main() 이 받은 예보의 마지막 시각까지로 다시 정한다
VILAGE = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst"
AIR = "https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty"
STNAPI = "https://apis.data.go.kr/B552584/MsrstnInfoInqireSvc/getMsrstnList"
STN_CACHE = Path(os.environ.get("STN_CACHE") or ROOT / "data" / "stations.json")  # 측정소 위치는 거의 안 바뀐다 → 7일에 한 번만 다시 받음
MIDLAND = "https://apis.data.go.kr/1360000/MidFcstInfoService/getMidLandFcst"
MIDTA = "https://apis.data.go.kr/1360000/MidFcstInfoService/getMidTa"
# 중기 육상예보 구역(시도 앞 두 자리 → 구역). 강원은 영서/영동으로 갈린다
LAND_BY_SIDO = {"11": "11B00000", "28": "11B00000", "41": "11B00000", "30": "11C20000", "36": "11C20000", "44": "11C20000",
                "43": "11C10000", "29": "11F20000", "46": "11F20000", "52": "11F10000", "27": "11H10000", "47": "11H10000",
                "26": "11H20000", "31": "11H20000", "48": "11H20000", "50": "11G00000"}
YEONGDONG = {"51150", "51170", "51190", "51210", "51230", "51820", "51830"}  # 강릉·동해·태백·속초·삼척·고성·양양
# 중기 기온 지점(주요 도시) — 시군구마다 가장 가까운 곳
TA_POINTS = {"11B10101": (37.57, 126.98), "11B20201": (37.46, 126.71), "11B20601": (37.26, 127.03), "11D10301": (37.88, 127.73),
             "11D10401": (37.34, 127.92), "11D20501": (37.75, 128.88), "11C20401": (36.35, 127.38), "11C10301": (36.64, 127.49),
             "11F10201": (35.82, 127.15), "11F20501": (35.16, 126.85), "21F20801": (34.81, 126.39), "11F20401": (34.76, 127.66),
             "11H10701": (35.87, 128.60), "11H10501": (36.57, 128.73), "11H10201": (36.02, 129.34), "11H20201": (35.18, 129.08),
             "11H20101": (35.54, 129.31), "11H20301": (35.23, 128.68), "11H20701": (35.18, 128.11), "11G00201": (33.50, 126.53),
             "11G00401": (33.25, 126.56)}
HOLIAPI = "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo"  # 천문연 특일정보(공휴일·대체공휴일)
UVAPI = "https://apis.data.go.kr/1360000/LivingWthrIdxServiceV5/getUVIdxV5"  # 포털 문서의 V4 주소는 폐기됨

# 지도(행안부 시군구 코드) 앞 두 자리 → 에어코리아 sidoName
SIDO = {"11": "서울", "26": "부산", "27": "대구", "28": "인천", "29": "광주", "30": "대전", "31": "울산", "36": "세종",
        "41": "경기", "51": "강원", "43": "충북", "44": "충남", "52": "전북", "46": "전남", "47": "경북", "48": "경남", "50": "제주"}


def service_key():
    k = os.environ.get("DATA_GO_KR_KEY")
    if not k:
        env = Path.home() / ".config/stock-tools/datagokr.env"
        for line in env.read_text().splitlines():
            if line.startswith("DATA_GO_KR_KEY="):
                k = line.split("=", 1)[1].strip().strip('"')
    # 허브 시크릿은 디코딩 형태, 로컬 파일은 인코딩 형태 — 주소에 그대로 붙이므로 인코딩 형태로 맞춘다
    return k if "%" in k else urllib.parse.quote(k, safe="")


def to_grid(lat, lon):
    """위경도 → 기상청 동네예보 격자 (기상청 공식 Lambert 변환식)."""
    re_, g, s1, s2, olon, olat, xo, yo = 6371.00877, 5.0, 30.0, 60.0, 126.0, 38.0, 43, 136
    d = math.pi / 180
    re_ /= g
    s1, s2, olon, olat = s1 * d, s2 * d, olon * d, olat * d
    sn = math.log(math.cos(s1) / math.cos(s2)) / math.log(math.tan(math.pi / 4 + s2 / 2) / math.tan(math.pi / 4 + s1 / 2))
    sf = math.tan(math.pi / 4 + s1 / 2) ** sn * math.cos(s1) / sn
    ro = re_ * sf / math.tan(math.pi / 4 + olat / 2) ** sn
    ra = re_ * sf / math.tan(math.pi / 4 + lat * d / 2) ** sn
    th = lon * d - olon
    th = (th + math.pi) % (2 * math.pi) - math.pi
    th *= sn
    return int(ra * math.sin(th) + xo + 0.5), int(ro - ra * math.cos(th) + yo + 0.5)


def sun_alt(lat, lon, dt_kst):
    """태양 고도(도), NOAA 근사식."""
    n = dt_kst.timetuple().tm_yday
    g = 2 * math.pi / 365 * (n - 1 + (dt_kst.hour - 12) / 24)
    eq = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g) - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    de = 0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g) - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g)
    tst = dt_kst.hour * 60 + dt_kst.minute + eq + 4 * lon - 540
    ha = math.radians(tst / 4 - 180)
    la = math.radians(lat)
    return math.degrees(math.asin(math.sin(la) * math.sin(de) + math.cos(la) * math.cos(de) * math.cos(ha)))


def latest_base(now):
    """발표 10분 뒤부터 조회 가능. 02·05·08·11·14·17·20·23시."""
    t = now - timedelta(minutes=10)
    for h in (23, 20, 17, 14, 11, 8, 5, 2):
        if t.hour >= h:
            return t.strftime("%Y%m%d"), f"{h:02d}00"
    y = t - timedelta(days=1)
    return y.strftime("%Y%m%d"), "2300"


def get_json(url, params, key, tries=3, timeout=30):
    q = "serviceKey=" + key + "&" + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            with urllib.request.urlopen(f"{url}?{q}", timeout=timeout) as r:
                body = r.read().decode("utf-8")
            return json.loads(body)
        except Exception as e:  # 일시 오류·XML 오류 응답은 재시도
            if i == tries - 1:
                raise RuntimeError(f"{url} 실패: {e}")
            time.sleep(2 + i * 2)


def amount(v, unit):
    """「강수없음」「1mm 미만」「1.0mm」「30.0~50.0mm」「50.0mm 이상」 → 숫자."""
    v = (v or "").strip()
    if not v or "없음" in v or v in ("0", "-"):
        return 0.0
    if "미만" in v:
        return 0.5
    v = v.replace(unit, "").replace("이상", "").strip()
    if "~" in v:
        a, b = v.split("~")
        return round((float(a) + float(b)) / 2, 1)
    try:
        return float(v)
    except ValueError:
        return 0.0


def fetch_grid(nx, ny, base_date, base_time, key):
    d = get_json(VILAGE, {"pageNo": 1, "numOfRows": 1500, "dataType": "JSON", "base_date": base_date,
                          "base_time": base_time, "nx": nx, "ny": ny}, key)
    head = d.get("response", {}).get("header", {})
    if head.get("resultCode") != "00":
        raise RuntimeError(f"격자 {nx},{ny}: {head}")
    return d["response"]["body"]["items"]["item"]


def stations(key):
    """측정소 이름 → (위도, 경도, 주소). dmX=위도, dmY=경도."""
    if STN_CACHE.exists() and time.time() - STN_CACHE.stat().st_mtime < 7 * 86400:
        return json.loads(STN_CACHE.read_text())
    d = get_json(STNAPI, {"returnType": "json", "numOfRows": 1000, "pageNo": 1}, key, tries=4, timeout=90)
    out = {}
    for it in d["response"]["body"]["items"]:
        try:
            out.setdefault(it["stationName"], []).append([float(it["dmX"]), float(it["dmY"]), it.get("addr", "")])
        except (TypeError, ValueError):
            continue
    STN_CACHE.parent.mkdir(exist_ok=True)
    STN_CACHE.write_text(json.dumps(out, ensure_ascii=False))
    return out


def km(a, b):
    la = math.radians((a[0] + b[0]) / 2)
    return math.hypot((a[0] - b[0]) * 111.0, (a[1] - b[1]) * 111.0 * math.cos(la))


def uv_release(now):
    """생활기상지수는 06시·18시 발표."""
    t = now - timedelta(minutes=30)
    if t.hour >= 18:
        return t.replace(hour=18, minute=0, second=0, microsecond=0)
    if t.hour >= 6:
        return t.replace(hour=6, minute=0, second=0, microsecond=0)
    return (t - timedelta(days=1)).replace(hour=18, minute=0, second=0, microsecond=0)


def fetch_uv(code, rel, key):
    d = get_json(UVAPI, {"pageNo": 1, "numOfRows": 10, "dataType": "JSON", "areaNo": code + "00000",
                         "time": rel.strftime("%Y%m%d%H")}, key)
    try:
        it = d["response"]["body"]["items"]["item"][0]
    except (KeyError, IndexError, TypeError):
        return None
    return {int(k[1:]): float(v) for k, v in it.items() if k.startswith("h") and k[1:].isdigit() and v not in ("", None)}


def mid_release(now):
    """중기예보는 06시·18시 발표(조금 늦게 올라온다 → 1시간 여유)."""
    t = now - timedelta(hours=1)
    if t.hour >= 18:
        return t.replace(hour=18, minute=0, second=0, microsecond=0)
    if t.hour >= 6:
        return t.replace(hour=6, minute=0, second=0, microsecond=0)
    return (t - timedelta(days=1)).replace(hour=18, minute=0, second=0, microsecond=0)


def fetch_mid(key, now):
    """구역·지점별 날짜 목록 [{date, pAm, pPm, wAm, wPm}] / [{date, tmin, tmax}]."""
    rel = mid_release(now)
    tm = rel.strftime("%Y%m%d%H%M")
    land, ta = {}, {}
    for reg in sorted(set(LAND_BY_SIDO.values()) | {"11D10000", "11D20000"}):
        d = get_json(MIDLAND, {"pageNo": 1, "numOfRows": 10, "dataType": "JSON", "regId": reg, "tmFc": tm}, key)
        try:
            it = d["response"]["body"]["items"]["item"][0]
        except (KeyError, IndexError, TypeError):
            continue
        days = []
        for n in range(3, 11):
            date = (rel + timedelta(days=n)).strftime("%Y-%m-%d")
            pa, pp = it.get(f"rnSt{n}Am", it.get(f"rnSt{n}")), it.get(f"rnSt{n}Pm", it.get(f"rnSt{n}"))
            wa, wp = it.get(f"wf{n}Am", it.get(f"wf{n}")), it.get(f"wf{n}Pm", it.get(f"wf{n}"))
            if pa is None and wa is None:
                continue
            days.append({"date": date, "pAm": pa, "pPm": pp, "wAm": wa, "wPm": wp})
        land[reg] = days
    for reg in TA_POINTS:
        d = get_json(MIDTA, {"pageNo": 1, "numOfRows": 10, "dataType": "JSON", "regId": reg, "tmFc": tm}, key)
        try:
            it = d["response"]["body"]["items"]["item"][0]
        except (KeyError, IndexError, TypeError):
            print("기온 지점 없음", reg)
            continue
        ta[reg] = [{"date": (rel + timedelta(days=n)).strftime("%Y-%m-%d"), "tmin": it.get(f"taMin{n}"), "tmax": it.get(f"taMax{n}")}
                   for n in range(3, 11) if it.get(f"taMax{n}") is not None]
    print(f"중기예보 {rel:%m-%d %H}시 발표 · 구역 {len(land)} · 기온 지점 {len(ta)}")
    return land, ta, rel


def fetch_holidays(key, now):
    """이번 달·다음 달 공휴일 {날짜: 이름}. 실패해도 앱은 주말만 빨갛게 보인다."""
    out = {}
    for add in (0, 1):
        y, m = now.year + (now.month + add - 1) // 12, (now.month + add - 1) % 12 + 1
        try:
            d = get_json(HOLIAPI, {"solYear": y, "solMonth": f"{m:02d}", "_type": "json", "numOfRows": 30}, key)
            items = d["response"]["body"]["items"]
            items = items.get("item", []) if isinstance(items, dict) else []
            for it in items if isinstance(items, list) else [items]:
                if it.get("isHoliday") == "Y":
                    s = str(it["locdate"])
                    out[f"{s[:4]}-{s[4:6]}-{s[6:]}"] = it["dateName"]
        except Exception as e:
            print("공휴일 조회 실패", y, m, e)
    print("공휴일", out)
    return out


def main():
    key = service_key()
    now = datetime.now(KST)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    base_date, base_time = latest_base(now)

    pts = centroids()
    for p in pts:
        p["nx"], p["ny"] = to_grid(p["lat"], p["lon"])
    grids = sorted({(p["nx"], p["ny"]) for p in pts})
    print(f"단기예보 {base_date} {base_time} · 시군구 {len(pts)}곳 → 격자 {len(grids)}개")

    results = {}

    def job(g):
        results[g] = fetch_grid(g[0], g[1], base_date, base_time, key)

    with ThreadPoolExecutor(max_workers=6) as ex:
        list(ex.map(job, grids))

    # 시간 축 = 오늘 0시 ~ 받은 예보의 마지막 시각. 단기예보는 발표에 따라 글피(4일째, 3시간 간격)까지 온다.
    # 예전엔 72시간에서 잘라 4일째를 버렸고, 중기예보는 5일 뒤부터라 그 사이 하루(2026-10-06)가 비었다.
    global HOURS
    last = max(datetime.strptime(it["fcstDate"] + it["fcstTime"], "%Y%m%d%H%M").replace(tzinfo=KST)
               for items in results.values() for it in items)
    HOURS = max(72, int((last - start).total_seconds() // 3600) + 1)
    hours = [(start + timedelta(hours=i)).strftime("%Y-%m-%dT%H:00") for i in range(HOURS)]
    idx = {h: i for i, h in enumerate(hours)}

    # 지난 파일의 값으로 오늘 이른 시간(발표 이전)을 채운다
    prev = {}
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text())
            if old.get("source", "").startswith("기상청"):
                prev = {"hours": old["hours"], "munis": old["munis"]}
        except Exception:
            pass

    # 에어코리아: 전국 측정소 → 시도 평균(측정소 좌표 API 승인 전 임시)
    air = get_json(AIR, {"sidoName": "전국", "returnType": "json", "numOfRows": 1000, "pageNo": 1, "ver": "1.0"}, key, tries=4, timeout=90)  # 전국 한 번이라 응답이 느릴 때가 있다
    sido_vals, stn_pm = {}, []
    stn = stations(key)
    for it in air["response"]["body"]["items"]:
        try:
            v = float(it.get("pm25Value") or "x")
        except ValueError:
            continue
        if v <= 0:  # 점검 중인 측정소가 0 을 보내는 경우
            continue
        sido_vals.setdefault(it["sidoName"], []).append(v)
        locs = stn.get(it["stationName"]) or []
        if len(locs) > 1:  # 같은 이름이 여러 곳이면 시도 이름이 주소에 든 쪽
            locs = [l for l in locs if it["sidoName"][:2] in l[2]] or locs[:1]
        if locs:
            stn_pm.append((locs[0][0], locs[0][1], v))
    sido_pm = {k: round(sum(v) / len(v), 1) for k, v in sido_vals.items()}
    print(f"측정소 {len(stn_pm)}곳 위치 연결")
    print("초미세먼지 시도 평균", sido_pm)

    rel = uv_release(now)
    uvs = {}

    def uv_job(p):
        # 구가 있는 시(수원시장안구 41111 등)는 생활기상지수에 구 코드가 없다 → 상위 시 코드(41110)로 다시
        for code in (p["code"], p["code"][:4] + "0"):
            try:
                v = fetch_uv(code, rel, key)
            except Exception:
                v = None
            if v:
                uvs[p["code"]] = v
                return
        uvs[p["code"]] = None

    with ThreadPoolExecutor(max_workers=6) as ex:
        list(ex.map(uv_job, pts))
    print(f"자외선 {rel:%m-%d %H}시 발표 · 받은 곳 {sum(1 for v in uvs.values() if v)}/{len(pts)}")

    mid_land, mid_ta, mid_rel = fetch_mid(key, now)
    holidays = fetch_holidays(key, now)

    data = {}
    for p in pts:
        items = results[(p["nx"], p["ny"])]
        row = {k: [None] * HOURS for k in ("t", "rh", "pop", "pcp", "ws", "wd", "sn", "cc")}
        for it in items:
            ts = f"{it['fcstDate'][:4]}-{it['fcstDate'][4:6]}-{it['fcstDate'][6:]}T{it['fcstTime'][:2]}:00"
            i = idx.get(ts)
            if i is None:
                continue
            c, v = it["category"], it["fcstValue"]
            if c == "TMP": row["t"][i] = float(v)
            elif c == "REH": row["rh"][i] = int(v)
            elif c == "POP": row["pop"][i] = int(v)
            elif c == "PCP": row["pcp"][i] = amount(v, "mm")
            elif c == "SNO": row["sn"][i] = amount(v, "cm")
            elif c == "WSD": row["ws"][i] = float(v)
            elif c == "VEC": row["wd"][i] = int(float(v))
            elif c == "SKY": row["cc"][i] = {"1": 10, "3": 60, "4": 95}.get(v, 50)  # 하늘상태 3단계 → 구름양 근사
        # 발표 전 시간: 지난 파일 → 없으면 첫 값으로
        old = prev.get("munis", {}).get(p["code"])
        for k, arr in row.items():
            if old and k in old:
                oi = {h: j for j, h in enumerate(prev["hours"])}
                for i, h in enumerate(hours):
                    if arr[i] is None and h in oi and oi[h] < len(old[k]):
                        arr[i] = old[k][oi[h]]
            # 4일째는 3시간 간격 — 기온·습도·바람은 사이를 직선으로 잇는다(나머지는 아래에서 앞 값으로 채움)
            if k in ("t", "rh", "ws"):
                known = [i for i, x in enumerate(arr) if x is not None]
                for a0, b0 in zip(known, known[1:]):
                    for i in range(a0 + 1, b0):
                        v = arr[a0] + (arr[b0] - arr[a0]) * (i - a0) / (b0 - a0)
                        arr[i] = round(v, 1) if k != "rh" else int(round(v))
            first = next((x for x in arr if x is not None), None)
            for i in range(HOURS):
                if arr[i] is None:
                    arr[i] = first if i < HOURS // 2 else (arr[i - 1] if i else first)
        # 초미세먼지: 시군구 중심에서 가까운 측정소 최대 3곳(15km 안) 거리 가중 평균, 없으면 가장 가까운 1곳, 그것도 없으면 시도 평균
        near = sorted(((km((p["lat"], p["lon"]), (a, b)), v) for a, b, v in stn_pm))[:3]
        within = [(d, v) for d, v in near if d <= 15] or near[:1]
        if within:
            wsum = sum(1 / max(d, 1) for d, _ in within)
            pm = round(sum(v / max(d, 1) for d, v in within) / wsum, 1)
        else:
            nm = SIDO.get(p["code"][:2], "")
            pm = sido_pm.get(nm) or next((v for k, v in sido_pm.items() if nm and nm in k), None) or 15.0
        # 가시거리 예보는 기상청에 없음 → 습도·바람으로 안개 위험만 추정(가시거리 근사값)
        vis = [800 if (row["rh"][i] or 0) >= 97 and (row["ws"][i] or 9) < 1.5 else
               2500 if (row["rh"][i] or 0) >= 93 and (row["ws"][i] or 9) < 2 else 20000 for i in range(HOURS)]
        # 자외선: 생활기상지수(3시간 간격) → 시간별 보간, 해가 진 시간은 0. 못 받은 곳·범위 밖은 해 높이·구름양 추정
        uv, got = [], uvs.get(p["code"]) or {}
        for i in range(HOURS):
            t = start + timedelta(hours=i)
            a = sun_alt(p["lat"], p["lon"], t)
            off = (t - rel).total_seconds() / 3600
            lo, hi = int(off // 3 * 3), int(off // 3 * 3) + 3
            if a <= 0:
                uv.append(0.0)
            elif got and lo in got and hi in got:
                uv.append(round(got[lo] + (got[hi] - got[lo]) * (off - lo) / 3, 1))
            elif got and lo in got:
                uv.append(got[lo])
            else:
                clear = 11.5 * math.sin(math.radians(a)) ** 2.4
                uv.append(round(clear * (1 - 0.6 * ((row["cc"][i] or 0) / 100) ** 2), 1))
        # 기상청에 없는 구름 층별(cl·cm·ch)·pm10 은 아예 넣지 않는다(화면은 없으면 0으로 본다, 노을 칩은 자동으로 숨음)
        ml = "11D20000" if p["code"] in YEONGDONG else ("11D10000" if p["code"][:2] == "51" else LAND_BY_SIDO.get(p["code"][:2]))
        mt = min((r for r in TA_POINTS if r in mid_ta), key=lambda r: km((p["lat"], p["lon"]), TA_POINTS[r]), default=None)
        data[p["code"]] = {**row, "pm25": [pm] * HOURS, "vis": vis, "uv": uv, "ml": ml, "mt": mt}

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "generated": now.isoformat(timespec="minutes"),
        "source": f"기상청 단기예보({base_date} {base_time} 발표) + 중기예보 + 생활기상지수 자외선({rel:%d일 %H시}) + 에어코리아 실시간(가까운 측정소)",
        "hours": hours, "munis": data,
        "mid": {"rel": mid_rel.isoformat(timespec="minutes"), "land": mid_land, "ta": mid_ta},
        "holidays": holidays,
    }, ensure_ascii=False, separators=(",", ":")))
    if not os.environ.get("OUT"):  # 로컬에서만 시안용 사본
        MOCK.parent.mkdir(exist_ok=True)
        MOCK.write_text(OUT.read_text())
    print("saved", OUT, OUT.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
