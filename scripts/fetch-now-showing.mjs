#!/usr/bin/env node
// "지금 상영중 / 개봉예정" movies.json 생성 — 멀티체인 스파인 재설계 (spec: docs/specs/2026-07-03-now-showing-multichain.md)
// 앱(now-showing-mini)은 KOBIS/KMDb/체인을 직접 안 부르고 이 JSON 만 읽는다.
//
// [지금 상영중] 스파인 = 극장 체인 현재상영작. (KOBIS "개봉상태"는 실제 상영 여부가 아니라 부정확)
//   - 증분1(현재): 롯데시네마 현재상영(MoviePlayYN=Y). KOFMovieCd로 KOBIS 조인.
//   - 증분2/3(예정): 메가박스(playwright), CGV(playwright) 합집합.
//   - 포스터=체인 우선 → KMDb 보조 / 줄거리=KMDb 우선 / 랭킹=KOBIS 박스오피스+체인 예매율 / 상세=KOBIS
// [개봉예정] = 기존 KOBIS 영화목록 로직 유지(체인엔 개봉 전 영화가 없음).
//
// 로컬 실행:  node scripts/fetch-now-showing.mjs   (.env 의 KOBIS_KEY / KMDB_KEY 사용)
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── .env 로더 (의존성 없이) ──
(function loadEnv() {
  const p = resolve(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const KOBIS_KEY = process.env.KOBIS_KEY;
if (!KOBIS_KEY) {
  console.error("KOBIS_KEY 가 필요합니다 (.env 또는 환경변수).");
  process.exit(1);
}
const KMDB_KEY = process.env.KMDB_KEY; // 없으면 KMDb 보강 skip

const KOBIS_BASE = "https://www.kobis.or.kr/kobisopenapi/webservice/rest";
const KMDB_BASE =
  "http://api.koreafilm.or.kr/openapi-data2/wisenut/search_api/search_json2.jsp";
const LOTTE_URL = "https://www.lottecinema.co.kr/LCWS/Movie/MovieData.aspx";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const SOON_WINDOW_DAYS = 60;
const MAX_SOON = 24;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

const ymd = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const parseYmd = (s) => {
  const t = String(s).replace(/-/g, "");
  if (t.length !== 8) return null;
  return new Date(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8));
};
const toIso = (s) => {
  const t = String(s).replace(/[^0-9]/g, "").slice(0, 8);
  return t.length === 8 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : "";
};

// KMDb title/plot 의 !HS/!HE 마크업 + 이중공백 제거
const cleanText = (s) =>
  String(s ?? "").replace(/!HS|!HE/g, "").replace(/\s+/g, " ").trim();
// http → https (Toss WebView mixed-content 회피). 도메인 뒤 중복 슬래시도 정리.
const httpsUrl = (u) => {
  const s = String(u ?? "").trim();
  if (!s) return "";
  return s.replace(/^http:\/\//, "https://").replace(/([^:])\/\/+/g, "$1/");
};
const splitPipe = (s) =>
  String(s ?? "").split("|").map((x) => httpsUrl(x.trim())).filter(Boolean);
const normTitle = (s) => cleanText(s).replace(/\s/g, "");
const splitPeople = (s) =>
  String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

// ── 롯데시네마 현재상영작 (스파인) ──
async function fetchLotteNowPlaying() {
  const fd = new FormData();
  fd.append(
    "paramList",
    JSON.stringify({
      MethodName: "GetMovies",
      channelType: "HO",
      osType: "W",
      osVersion: "Chrome",
      multiLanguageID: "KR",
      division: 1,
      moviePlayYN: "Y",
      orderType: "1",
      blockSize: 100,
      pageNo: 1,
      memberOnNo: "",
    }),
  );
  const data = await getJson(LOTTE_URL, {
    method: "POST",
    headers: { Referer: "https://www.lottecinema.co.kr/NLCHS/Movie", "User-Agent": UA },
    body: fd,
  });
  const items = (data?.Movies?.Items ?? []).filter((m) => m.MoviePlayYN === "Y");
  return items.map((m) => ({
    source: "lotte",
    kofCd: m.KOFMovieCd ? String(m.KOFMovieCd) : null,
    title: m.MovieNameKR,
    titleEn: m.MovieNameUS || "",
    openDt: toIso(String(m.ReleaseDate).slice(0, 10)),
    poster: httpsUrl(m.PosterURL),
    gradeChain: m.ViewGradeNameKR || null, // 축약형("전체"/"15") — KOBIS 상세 등급 우선, 폴백용
    bookingRate: Number.isFinite(Number(m.BookingRate)) ? Number(m.BookingRate) : null,
  }));
}

// ── KOBIS: 어제 박스오피스 → movieCd 맵 ──
async function fetchBoxOffice() {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const url = `${KOBIS_BASE}/boxoffice/searchDailyBoxOfficeList.json?key=${KOBIS_KEY}&targetDt=${ymd(y)}`;
  const data = await getJson(url);
  const list = data?.boxOfficeResult?.dailyBoxOfficeList ?? [];
  const map = new Map();
  for (const m of list) {
    map.set(m.movieCd, {
      rank: Number(m.rank),
      rankInten: Number(m.rankInten),
      audiCnt: Number(m.audiCnt),
      audiAcc: Number(m.audiAcc),
    });
  }
  return map;
}

// ── KOBIS: 상세정보 (러닝타임/장르/배우/등급/국가) ──
async function fetchInfo(movieCd) {
  if (!movieCd) return {};
  try {
    const url = `${KOBIS_BASE}/movie/searchMovieInfo.json?key=${KOBIS_KEY}&movieCd=${movieCd}`;
    const data = await getJson(url);
    const info = data?.movieInfoResult?.movieInfo;
    if (!info) return {};
    return {
      runtime: info.showTm ? Number(info.showTm) : null,
      genre: (info.genres ?? []).map((g) => g.genreNm).join(", ") || null,
      grade: (info.audits ?? [])[0]?.watchGradeNm ?? null,
      directors: (info.directors ?? []).map((d) => d.peopleNm),
      actors: (info.actors ?? []).slice(0, 6).map((a) => a.peopleNm),
      nation: (info.nations ?? []).map((n) => n.nationNm).join(", ") || null,
    };
  } catch {
    return {};
  }
}

// ── KOBIS: 영화목록 (개봉예정 후보용) ──
async function fetchMovieList() {
  const year = new Date().getFullYear();
  const all = [];
  for (let page = 1; page <= 6; page++) {
    const url = `${KOBIS_BASE}/movie/searchMovieList.json?key=${KOBIS_KEY}&openStartDt=${year}&itemPerPage=100&curPage=${page}`;
    const data = await getJson(url);
    const list = data?.movieListResult?.movieList ?? [];
    all.push(...list);
    if (list.length < 100) break;
    await sleep(120);
  }
  return all;
}

// ── KMDb 보강 (줄거리/포스터 보조/키워드). KMDB_KEY 없으면 skip. 제목+개봉연도 매칭 ──
async function enrichKmdb({ title, openDt }) {
  if (!KMDB_KEY) return {};
  try {
    const year = String(openDt ?? "").slice(0, 4);
    const params = new URLSearchParams({
      collection: "kmdb_new2",
      ServiceKey: KMDB_KEY,
      title,
      listCount: "10",
      detail: "Y",
    });
    if (/^\d{4}$/.test(year)) {
      params.set("releaseDts", `${year}0101`);
      params.set("releaseDte", `${year}1231`);
    }
    const data = await getJson(`${KMDB_BASE}?${params}`);
    const results = data?.Data?.[0]?.Result ?? [];
    if (results.length === 0) return {};
    const want = normTitle(title);
    const hit = results.find((r) => normTitle(r.title) === want) ?? results[0];
    const plotList = hit?.plots?.plot ?? [];
    const ko = plotList.find((p) => p.plotLang === "한국어") ?? plotList[0];
    const posters = splitPipe(hit.posters);
    return {
      poster: posters[0] ?? "",
      plot: cleanText(ko?.plotText),
      keywords: cleanText(hit.keywords) || null,
      kmdbId: hit.movieId && hit.movieSeq ? `${hit.movieId}-${hit.movieSeq}` : null,
    };
  } catch {
    return {};
  }
}

async function main() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const soonTo = new Date(today);
  soonTo.setDate(soonTo.getDate() + SOON_WINDOW_DAYS);

  console.log(`· KMDb 보강: ${KMDB_KEY ? "ON" : "OFF (KMDB_KEY 없음)"}`);

  console.log("· KOBIS 박스오피스 조회…");
  const box = await fetchBoxOffice();
  console.log(`  박스오피스 ${box.size}편`);

  // ── 지금 상영중: 롯데 스파인 ──
  console.log("· 롯데시네마 현재상영 조회…");
  const lotte = await fetchLotteNowPlaying();
  console.log(`  롯데 현재상영 ${lotte.length}편`);

  console.log("· 상영중 보강(KOBIS 상세 + KMDb)…");
  const nowShowing = [];
  for (const s of lotte) {
    const info = await fetchInfo(s.kofCd);
    await sleep(60);
    const km = await enrichKmdb({ title: s.title, openDt: s.openDt });
    if (KMDB_KEY) await sleep(60);
    nowShowing.push({
      movieCd: s.kofCd,
      title: s.title,
      titleEn: s.titleEn,
      openDt: s.openDt,
      genre: info.genre ?? null,
      runtime: info.runtime ?? null,
      grade: info.grade ?? s.gradeChain ?? null,
      nation: info.nation ?? null,
      directors: info.directors ?? [],
      actors: info.actors ?? [],
      poster: s.poster || km.poster || "", // 체인 포스터 우선 → KMDb 보조
      plot: km.plot ?? "",
      keywords: km.keywords ?? null,
      kmdbId: km.kmdbId ?? null,
      boxOffice: s.kofCd ? box.get(s.kofCd) ?? null : null,
      bookingRate: s.bookingRate,
      availableAt: [s.source],
    });
  }
  // 정렬: 박스오피스 진입작(순위 asc) 먼저 → 예매율 desc
  nowShowing.sort((a, b) => {
    const ra = a.boxOffice?.rank ?? 999;
    const rb = b.boxOffice?.rank ?? 999;
    if (ra !== rb) return ra - rb;
    return (b.bookingRate ?? 0) - (a.bookingRate ?? 0);
  });

  // ── 개봉예정: 기존 KOBIS 목록 로직 ──
  console.log("· KOBIS 영화목록 조회(개봉예정용)…");
  const list = await fetchMovieList();
  const soonCand = [];
  for (const m of list) {
    const open = parseYmd(m.openDt);
    if (m.prdtStatNm === "개봉예정" && open && open > today && open <= soonTo) soonCand.push(m);
  }
  soonCand.sort((a, b) => String(a.openDt).localeCompare(String(b.openDt)));
  const soonSel = soonCand.slice(0, MAX_SOON);

  console.log(`· 개봉예정 보강… (${soonSel.length}편)`);
  const upcoming = [];
  for (const m of soonSel) {
    const info = await fetchInfo(m.movieCd);
    await sleep(60);
    const km = await enrichKmdb({ title: m.movieNm, openDt: m.openDt });
    if (KMDB_KEY) await sleep(60);
    upcoming.push({
      movieCd: m.movieCd,
      title: m.movieNm,
      titleEn: m.movieNmEn || "",
      openDt: toIso(m.openDt),
      genre: info.genre ?? m.genreAlt ?? null,
      runtime: info.runtime ?? null,
      grade: info.grade ?? null,
      nation: info.nation ?? m.nationAlt ?? null,
      directors: info.directors ?? (m.directors ?? []).map((d) => d.peopleNm),
      actors: info.actors ?? [],
      poster: km.poster ?? "",
      plot: km.plot ?? "",
      keywords: km.keywords ?? null,
      kmdbId: km.kmdbId ?? null,
      boxOffice: null,
      bookingRate: null,
      availableAt: [],
    });
  }

  const payload = {
    updatedAt: toIso(ymd(today)),
    counts: { nowShowing: nowShowing.length, upcoming: upcoming.length },
    nowShowing,
    upcoming,
  };
  const body = JSON.stringify(payload, null, 2);

  const outDir = resolve(ROOT, "now-showing");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "movies.json"), body, "utf-8");
  console.log(`✓ now-showing/movies.json  (상영중 ${nowShowing.length}, 개봉예정 ${upcoming.length})`);

  const appDir = resolve(ROOT, "../now-showing-mini");
  if (existsSync(appDir)) {
    const appPublic = resolve(appDir, "public");
    mkdirSync(appPublic, { recursive: true });
    writeFileSync(resolve(appPublic, "movies.json"), body, "utf-8");
    console.log("✓ ../now-showing-mini/public/movies.json (로컬 dev 미러)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
