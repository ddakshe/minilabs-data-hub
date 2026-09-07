"""K-apt 엑셀 3종 → aptcost/ 산출물.

앱이 답하는 질문은 하나다: **"우리 집 관리비, 많이 내는 편인가?"**
그 답은 백분위인데, 백분위를 내려면 비교군 전체가 있어야 한다. 그래서 앱에서
API 를 부르는 구조가 성립하지 않는다 — 사용자 한 명이 수백 콜을 쓴다.
여기서 미리 계산해 시군구 단위로 쪼개 넣고, 앱은 자기 시군구 파일 하나만 읽는다.

비교를 공정하게 만드는 규칙 세 가지:

  1. **원/㎡ 로 환산한다.** 세대당 총액은 평수 차이로 왜곡된다.
     분모는 `관리비부과면적`(면적정보 엑셀). 이게 없으면 그 단지는 버린다.
  2. **12개월 평균을 쓴다.** 관리비는 계절이 지배한다(난방비는 6월 37만 → 7월 9천).
     특정 달을 고정하면 그 달 미제출 단지가 통째로 빠지는 문제도 같이 해결된다.
  3. **공용관리비와 개별사용료를 나눈다.** 공용은 관리사무소 몫이고 개별은 우리 집
     사용량이다. 합쳐서 한 줄로 주면 "난방 많이 썼다"와 "관리비가 비싸다"가 섞인다.

산출물:
    aptcost/meta.json              기준일·연도·단지 수·월별 커버리지
    aptcost/complexes.json         단지 마스터 (앱의 검색용)
    aptcost/stats/{code}.json      시군구별 지표 + 백분위 경계
"""

from __future__ import annotations

import argparse
import collections
import json
import statistics
import warnings
from datetime import datetime, timezone, timedelta
from pathlib import Path

import openpyxl

warnings.filterwarnings("ignore", category=UserWarning, module="openpyxl")

KST = timezone(timedelta(hours=9))

# 관리비 엑셀에서 쓸 컬럼. 51개 전부 넣으면 파일이 커지고, 앱이 실제로 보여주는 건
# 이 넷이다. 세부 항목(인건비·피복비…)은 "왜 비싼가"를 파고들 때 추가한다.
COST_FIELDS = {
    "common": "공용관리비계",
    "guard": "경비비",
    "clean": "청소비",
    "elev": "승강기유지비",
    "repair": "수선비",
    "indiv": "개별사용료계",
    "heat": "난방비(전용)",
    "elec": "전기료(전용)",
    "ltrf": "장충금 월부과액",
}


def _num(v) -> float:
    """엑셀이 '2.9551852E7' 같은 문자열로 준다."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _rows(path: Path):
    """(헤더, 데이터 이터레이터). 0행은 안내문이라 건너뛴다.

    read_only 모드에서 dimension 이 1x1 로 잘못 온다 → reset_dimensions 필수.
    """
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[wb.sheetnames[0]]
    ws.reset_dimensions()
    it = ws.iter_rows(values_only=True)
    next(it)  # 안내문
    header = next(it)
    return list(header), it


def load_area(path: Path) -> dict[str, dict]:
    """단지코드 → 관리비부과면적·세대수. 단지당 여러 행이라 첫 행만 쓴다."""
    header, it = _rows(path)
    H = {h: i for i, h in enumerate(header)}
    out: dict[str, dict] = {}
    for r in it:
        code = r[H["단지코드"]]
        if not code or code in out:
            continue
        area = _num(r[H["관리비부과면적"]])
        if area <= 0:
            continue
        out[code] = {"area": round(area, 1), "hh": int(_num(r[H["세대수"]]))}
    return out


def load_basis(path: Path) -> dict[str, dict]:
    """단지코드 → 비교군을 나누는 속성들.

    난방방식이 특히 중요하다. 개별난방 단지는 난방비가 관리비에 안 잡혀 0 으로
    보이는데, 그건 싼 게 아니라 다른 데로 나가는 것이다. 같은 난방방식끼리
    비교하지 않으면 앱이 틀린 답을 자신 있게 준다.
    """
    header, it = _rows(path)
    H = {h: i for i, h in enumerate(header)}

    def g(r, name):
        i = H.get(name)
        return r[i] if i is not None else None

    out: dict[str, dict] = {}
    for r in it:
        code = g(r, "단지코드")
        if not code or code in out:
            continue
        used = str(g(r, "사용승인일") or "")
        out[code] = {
            "heatType": g(r, "난방방식"),
            "mgmtType": g(r, "관리방식"),
            "builtYear": int(used[:4]) if used[:4].isdigit() else None,
            "guardCnt": int(_num(g(r, "경비관리-인원"))),
            "cleanCnt": int(_num(g(r, "청소관리-인원"))),
            "kind": g(r, "단지분류"),
        }
    return out


def load_cost(path: Path) -> tuple[dict[str, dict], collections.Counter, dict[str, dict]]:
    """단지코드 → 항목별 12개월 합계. 월별 커버리지도 같이 센다."""
    header, it = _rows(path)
    H = {h: i for i, h in enumerate(header)}
    missing = [c for c in COST_FIELDS.values() if c not in H]
    if missing:
        raise RuntimeError(f"관리비 엑셀에 없는 컬럼: {missing}")

    agg: dict[str, dict] = {}
    months = collections.Counter()
    where: dict[str, dict] = {}
    for r in it:
        code = r[H["단지코드"]]
        if not code:
            continue
        months[str(r[H["발생년월(YYYYMM)"]])] += 1
        a = agg.get(code)
        if a is None:
            a = agg[code] = {"n": 0, **{k: 0.0 for k in COST_FIELDS}}
            where[code] = {
                "name": r[H["단지명"]],
                "sido": r[H["시도"]],
                "sgg": r[H["시군구"]],
                "dong": r[H["동리"]] or r[H["읍면"]] or "",
            }
        a["n"] += 1
        for key, col in COST_FIELDS.items():
            a[key] += _num(r[H[col]])
    return agg, months, where


def load_region_index(path: Path) -> dict[tuple[str, str], str]:
    """(시도, 시군구) → 시군구 5자리 코드.

    `realestate/region-master.json` 을 그대로 쓰되 표기 차이를 흡수한다.
    두 시스템이 일반구를 다르게 적는다 —
        region-master : "성남시 분당구"  (법정동코드 표기)
        K-apt 엑셀    : "성남분당구"
    이걸 안 맞추면 분당·동탄·기흥 같은 아파트 밀집지가 통째로 빠진다(실측 4,700 단지).
    세종은 시군구가 없어 엑셀에서 빈 값으로 온다.
    """
    regions = json.loads(path.read_text(encoding="utf-8"))["regions"]
    idx: dict[tuple[str, str], str] = {}
    for r in regions:
        sido, sgg, code = r["sido"], r["sigungu"], r["code"]
        idx.setdefault((sido, sgg), code)
        idx.setdefault((sido, sgg.replace("시 ", "")), code)  # 성남시 분당구 → 성남분당구
        if sgg == sido:  # 세종특별자치시
            idx.setdefault((sido, ""), code)
            idx.setdefault((sido, None), code)
    return idx


def percentiles(values: list[float]) -> dict:
    """앱이 '상위 몇 %'를 그리는 데 필요한 경계값."""
    s = sorted(values)
    if not s:
        return {}

    def at(p: float) -> float:
        return round(s[min(len(s) - 1, int(len(s) * p))], 1)

    return {
        "n": len(s),
        "p10": at(0.10), "p25": at(0.25), "p50": at(0.50),
        "p75": at(0.75), "p90": at(0.90),
        "mean": round(statistics.fmean(s), 1),
    }


# 지역 마스터는 저장소 루트 기준으로 찾는다. --out 의 부모에서 유추하면
# --out 을 저장소 밖으로 주는 순간 조용히 깨진다(리허설에서 실측).
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REGIONS = REPO_ROOT / "realestate" / "region-master.json"


def recover_trend(out: Path) -> tuple[dict[str, dict[int, list]], int | None]:
    """직전 산출물에서 추이를 되살린다.

    🚨 이게 없으면 **정기 실행이 과거를 지운다.** 월 1회 실행은 올해와 작년 엑셀만
       받는데(과거 연도를 매달 500MB 씩 받을 이유가 없다) 빌더는 raw 폴더에 있는
       연도로만 추이를 만든다. 병합하지 않으면 2018~2023 이 매달 날아간다.
       (리허설에서 산출물이 14MB → 11MB 로 줄어드는 것으로 실측)

    직전 기준 연도의 대표 지표도 추이로 접어 넣는다. 기준 연도가 2025→2026 으로
    넘어가면 2025 는 더 이상 raw 에 없지만 추이에는 남아야 한다.
    """
    stats_dir = out / "stats"
    if not stats_dir.is_dir():
        return {}, None
    recovered: dict[str, dict[int, list]] = collections.defaultdict(dict)
    prev_base: int | None = None
    for f in stats_dir.glob("*.json"):
        try:
            doc = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        prev_base = doc.get("year") or prev_base
        for code, rec in doc.get("complexes", {}).items():
            for y, v in (rec.get("trend") or {}).items():
                recovered[code][int(y)] = v
            if prev_base is not None and "common" in rec:
                recovered[code].setdefault(
                    int(doc["year"]), [rec["common"], rec["indiv"], rec.get("months", 0)]
                )
    return recovered, prev_base


def build(
    raw: Path,
    out: Path,
    year: int,
    trend_years: list[int] | None = None,
    regions_path: Path | None = None,
) -> None:
    cost_files = sorted(raw.glob(f"*관리비정보_{year}.xlsx"))
    basis_files = sorted(raw.glob("*기본정보.xlsx"))
    area_files = sorted(raw.glob("*면적정보.xlsx"))
    for label, files in (("관리비", cost_files), ("기본정보", basis_files), ("면적정보", area_files)):
        if not files:
            raise SystemExit(f"{label} 엑셀이 {raw} 에 없다 — kapt_files.py 로 먼저 받는다")

    area = load_area(area_files[-1])
    basis = load_basis(basis_files[-1])
    agg, months, where = load_cost(cost_files[-1])

    # 추이. 기준 연도는 전체 지표를 싣지만 나머지 연도는 공용·개별 두 값만 얹는다.
    # 9개 연도를 전부 같은 모양으로 넣으면 시군구 파일이 9배가 된다.
    #
    # ⚠️ 연도끼리는 **같은 단지끼리만** 비교해야 한다. 공개 의무 대상이
    #    2024-10-25 부터 100세대 이상으로 넓어져서, 전국 평균을 연도별로 늘어놓으면
    #    값이 변한 게 아니라 단지 구성이 바뀐 것을 보게 된다.
    #    단지별 추이는 이 문제가 없다 — 그래서 추이를 단지 단위로만 만든다.
    # ⚠️ 진행 중인 연도는 개월 수가 모자란다. months 를 같이 넣어 앱이 판단하게 한다.
    trend, prev_base = recover_trend(out)
    trend = collections.defaultdict(dict, trend)
    if trend:
        kept = sorted({y for d in trend.values() for y in d})
        print(f"  이전 산출물에서 추이 복구: {len(trend):,} 단지 · 연도 {kept}"
              + (f" (직전 기준 {prev_base})" if prev_base else ""))
    trend_meta: dict[int, dict] = {}
    for ty in sorted(trend_years or []):
        if ty == year:
            continue
        files = sorted(raw.glob(f"*관리비정보_{ty}.xlsx"))
        if not files:
            print(f"  추이: {ty} 엑셀 없음 — 건너뜀")
            continue
        t_agg, t_months, _ = load_cost(files[-1])
        n_hit = 0
        for code, a in t_agg.items():
            if code not in area or a["n"] == 0:
                continue
            m2 = area[code]["area"]
            trend[code][ty] = [
                round(a["common"] / a["n"] / m2, 1),
                round(a["indiv"] / a["n"] / m2, 1),
                a["n"],
            ]
            n_hit += 1
        trend_meta[ty] = {"complexes": n_hit, "months": len(t_months)}
        print(f"  추이: {ty} · 단지 {n_hit:,} · {len(t_months)}개월")

    code_of = load_region_index(regions_path or DEFAULT_REGIONS)

    complexes: dict[str, dict] = {}
    by_region: dict[str, list[str]] = collections.defaultdict(list)
    unmatched = collections.Counter()

    for code, a in agg.items():
        if code not in area or a["n"] == 0:
            continue
        m2 = area[code]["area"]
        w = where[code]
        region = code_of.get((w["sido"], w["sgg"]))
        if region is None:
            unmatched[(w["sido"], w["sgg"])] += 1
            continue
        rec = {
            "name": w["name"],
            "sido": w["sido"],
            "sgg": w["sgg"],
            "dong": w["dong"],
            "region": region,
            "hh": area[code]["hh"],
            "area": m2,
            "months": a["n"],
            **{k: round(a[k] / a["n"] / m2, 1) for k in COST_FIELDS},
            **{k: v for k, v in basis.get(code, {}).items() if v is not None},
        }
        if code in trend:
            # [공용, 개별, 개월수] — 연도를 키로. 앱은 개월수로 진행 중인 해를 가린다.
            # 기준 연도는 대표 지표로 따로 실리므로 추이에서 뺀다(복구분에 섞여 들어온다).
            rec["trend"] = {
                str(y): v for y, v in sorted(trend[code].items()) if y != year
            }
        complexes[code] = rec
        by_region[region].append(code)

    # 시군구별 파일. 앱은 자기 시군구 하나만 받는다.
    stats_dir = out / "stats"
    stats_dir.mkdir(parents=True, exist_ok=True)
    for old in stats_dir.glob("*.json"):
        old.unlink()
    for region, codes in by_region.items():
        rows = {c: complexes[c] for c in codes}
        dist = {
            key: percentiles([r[key] for r in rows.values() if r[key] > 0])
            for key in COST_FIELDS
        }
        (stats_dir / f"{region}.json").write_text(
            json.dumps({"region": region, "year": year, "dist": dist, "complexes": rows},
                       ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )

    # 앱의 단지 검색용 — 지표는 빼고 이름·주소만.
    (out / "complexes.json").write_text(
        json.dumps(
            {c: {"n": r["name"], "r": r["region"], "d": r["dong"], "h": r["hh"]}
             for c, r in complexes.items()},
            ensure_ascii=False, separators=(",", ":"),
        ),
        encoding="utf-8",
    )

    trend_count: collections.Counter = collections.Counter()
    trend_months: dict[int, int] = {}
    for r in complexes.values():
        for y, v in (r.get("trend") or {}).items():
            trend_count[int(y)] += 1
            trend_months[int(y)] = max(trend_months.get(int(y), 0), v[2])

    nationwide = {
        key: percentiles([r[key] for r in complexes.values() if r[key] > 0])
        for key in COST_FIELDS
    }
    (out / "meta.json").write_text(
        json.dumps(
            {
                "fetchedAt": datetime.now(KST).isoformat(timespec="seconds"),
                "source": "K-apt 자료실 (국토교통부·한국부동산원)",
                "sourceFile": cost_files[-1].name,
                "year": year,
                "complexes": len(complexes),
                "regions": len(by_region),
                "monthlyRows": {m: months[m] for m in sorted(months)},
                # 복구분까지 포함한 최종 추이 현황. 새로 읽은 연도만 세면
                # 정기 실행 메타에 과거가 사라진 것처럼 보인다.
                "trendYears": {
                    str(y): {"complexes": n, "months": trend_months[y]}
                    for y, n in sorted(trend_count.items())
                },
                "trendNote": (
                    "연도 비교는 같은 단지끼리만 한다. 공개 의무가 2024-10-25 부터 "
                    "100세대 이상으로 넓어져 전국 평균의 연도 비교는 단지 구성 변화를 본다."
                ),
                "nationwide": nationwide,
                "unmatchedRegions": {f"{s} {g}": n for (s, g), n in unmatched.most_common()},
            },
            ensure_ascii=False, indent=2,
        ),
        encoding="utf-8",
    )

    print(f"단지 {len(complexes):,} · 시군구 {len(by_region)} · {stats_dir}")
    if unmatched:
        print("지역 매칭 실패:", dict(unmatched.most_common(8)))
    print("전국 공용관리비 원/㎡·월:", nationwide["common"])


def main() -> None:
    ap = argparse.ArgumentParser(description="K-apt 엑셀 → aptcost/")
    ap.add_argument("--raw", default="_raw/aptcost", help="엑셀이 있는 디렉터리")
    ap.add_argument("--out", default="aptcost", help="산출 디렉터리")
    ap.add_argument(
        "--year",
        default="auto",
        help="기준 연도 (전체 지표를 싣는 해). 'auto' 는 12개월이 다 찬 가장 최근 연도",
    )
    ap.add_argument(
        "--regions",
        default="",
        help=f"시군구 마스터 경로 (기본 {DEFAULT_REGIONS.relative_to(REPO_ROOT)})",
    )
    ap.add_argument(
        "--trend",
        default="",
        help="추이로 얹을 연도. 'all' 또는 '2018,2019,…'. 기준 연도는 자동 제외",
    )
    args = ap.parse_args()
    raw = Path(args.raw)
    have = sorted(int(p.stem.rsplit("_", 1)[-1]) for p in raw.glob("*관리비정보_*.xlsx"))
    years = have if args.trend == "all" else [int(y) for y in args.trend.split(",") if y.strip()]

    if args.year == "auto":
        # 진행 중인 연도를 기준으로 삼으면 계절이 반쪽이 된다. 관리비는 난방비 때문에
        # 상반기만 평균 내면 겨울 쪽으로 쏠린다. 12개월이 다 찬 최근 연도를 쓴다.
        base = None
        for y in reversed(have):
            _, months, _ = load_cost(sorted(raw.glob(f"*관리비정보_{y}.xlsx"))[-1])
            if len(months) >= 12:
                base = y
                break
        if base is None:
            raise SystemExit("12개월이 다 찬 연도가 없다 — --year 로 직접 지정한다")
        print(f"기준 연도(auto): {base}")
    else:
        base = int(args.year)

    build(raw, Path(args.out), base, years, Path(args.regions) if args.regions else None)


if __name__ == "__main__":
    main()
