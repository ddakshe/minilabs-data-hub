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
import { chromium } from "playwright"; // 메가박스/CGV(봇차단·동적로딩)용

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

// ── 메가박스 현재상영작 (playwright AJAX 인터셉트) ──
// ⚠ 기본 /movie 페이지는 상위 ~20편만 로드(recordCountPerPage). 대부분 롯데와 겹치므로 net-new는 소수.
async function fetchMegaboxNowPlaying(browser) {
  const ctx = await browser.newContext({ userAgent: UA, locale: "ko-KR" });
  const page = await ctx.newPage();
  let cap = null;
  page.on("response", async (res) => {
    const u = res.url();
    if (u.includes("Movie") && u.includes(".do") && res.request().method() === "POST") {
      try {
        const j = await res.json();
        if (j && j.movieList) cap = j;
      } catch {}
    }
  });
  try {
    await page.goto("https://www.megabox.co.kr/movie", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2000);
  } finally {
    await ctx.close();
  }
  const list = cap?.movieList ?? [];
  if (list.length && list[0]?.totCnt > list.length) {
    console.log(`  (메가박스: 전체 ${list[0].totCnt}편 중 ${list.length}편만 로드 — 페이징 미구현, 후속 개선 여지)`);
  }
  return list
    .filter((m) => m.movieStatNm === "상영중" || m.rfilmAt === "Y")
    .map((m) => ({
      source: "megabox",
      kofCd: null, // 메가박스는 KOBIS 코드 미제공 → 제목+연도 매칭
      title: m.movieNm,
      titleEn: "",
      openDt: toIso(m.rfilmDeReal),
      poster: m.imgPathNm ? httpsUrl("https://img.megabox.co.kr" + m.imgPathNm) : "",
      gradeChain: m.admisClassNm || null,
      bookingRate: Number.isFinite(Number(m.boxoBokdRt)) ? Number(m.boxoBokdRt) : null,
      plotChain: cleanText(m.movieSynopCn) || null,
    }));
}

// ── CGV 현재상영작 (playwright: 홈 로드 시 무비차트 API 응답 인터셉트) ──
// 신규 cgv.co.kr(SPA)는 api.cgv.co.kr 호출에 브라우저 세션 필요(직접 curl은 403/401).
// 무비차트 = data.dspScrdispMovctTab.dspScrdispMovctDtlList[].movctSearchResDtoList (가장 큰 탭 사용).
const EVENT_RE =
  /라이브뷰잉|live\s*viewing|팬콘서트|팬미팅|fan\s*meet|meet[\s-]?up|콘서트|KBO|올스타|리그\s*-|내한공연/i;
async function fetchCgvNowPlaying(browser) {
  const ctx = await browser.newContext({ userAgent: UA, locale: "ko-KR" });
  const page = await ctx.newPage();
  let movies = null;
  page.on("response", async (res) => {
    if (!res.url().includes("api.cgv.co.kr") || res.status() !== 200) return;
    if (!(res.headers()["content-type"] || "").includes("json")) return;
    try {
      const j = await res.json();
      const tabs = j?.data?.dspScrdispMovctTab?.dspScrdispMovctDtlList;
      if (!Array.isArray(tabs)) return;
      let best = [];
      for (const t of tabs) {
        const l = t?.movctSearchResDtoList;
        if (Array.isArray(l) && l.length > best.length) best = l;
      }
      if (best.length) movies = best; // 가장 큰 무비차트 탭
    } catch {}
  });
  try {
    await page.goto("https://cgv.co.kr/", { waitUntil: "networkidle", timeout: 40000 });
    await page.waitForTimeout(3000);
  } finally {
    await ctx.close();
  }
  const list = movies ?? [];
  const films = list.filter((m) => !EVENT_RE.test(m.movNm || "")); // 라이브뷰잉/콘서트/중계 제외
  if (list.length - films.length > 0) {
    console.log(`  (CGV: 이벤트/중계 ${list.length - films.length}편 제외)`);
  }
  return films.map((m) => ({
    source: "cgv",
    kofCd: null, // CGV도 KOBIS 코드 미제공 → 제목+연도 매칭
    title: m.movNm,
    titleEn: "",
    openDt: toIso(m.realOpenYmd || m.rlsYmd),
    poster:
      m.imgPath && m.img320Fnm ? httpsUrl("https://cdn.cgv.co.kr" + m.imgPath + m.img320Fnm) : "",
    gradeChain: null,
    bookingRate: Number.isFinite(Number(m.atktRate)) ? Number(m.atktRate) : null,
    plotChain: null,
  }));
}

// ── 체인 항목 병합 (dedup 키 = 정규화제목 + 개봉연도). 포스터 우선순위 = 수집 순서(롯데>메가>CGV) ──
function mergeChains(items) {
  const map = new Map();
  for (const it of items) {
    // 키 = 정규화 제목만. (재개봉작은 체인마다 개봉연도가 원작/재개봉으로 달라 연도를 키에 넣으면 중복 발생)
    const key = normTitle(it.title);
    if (!map.has(key)) {
      map.set(key, {
        source: it.source,
        kofCd: it.kofCd ?? null,
        title: it.title,
        titleEn: it.titleEn ?? "",
        openDt: it.openDt ?? "",
        poster: it.poster ?? "",
        gradeChain: it.gradeChain ?? null,
        bookingRate: it.bookingRate ?? null,
        plotChain: it.plotChain ?? null,
        availableAt: [it.source],
      });
    } else {
      const u = map.get(key);
      if (!u.availableAt.includes(it.source)) u.availableAt.push(it.source);
      if (!u.kofCd && it.kofCd) u.kofCd = it.kofCd;
      if (!u.poster && it.poster) u.poster = it.poster; // 먼저 수집된 체인 포스터 우선
      if (!u.titleEn && it.titleEn) u.titleEn = it.titleEn;
      if (!u.gradeChain && it.gradeChain) u.gradeChain = it.gradeChain;
      if (!u.plotChain && it.plotChain) u.plotChain = it.plotChain;
      if (it.bookingRate != null) u.bookingRate = Math.max(u.bookingRate ?? 0, it.bookingRate);
    }
  }
  return [...map.values()];
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

  // ── 지금 상영중: 극장 체인 현재상영작 합집합 (롯데 + 메가박스 [+ CGV]) ──
  console.log("· 극장 체인 현재상영 조회…");
  const chainItems = [];
  try {
    const l = await fetchLotteNowPlaying();
    chainItems.push(...l);
    console.log(`  롯데 ${l.length}편`);
  } catch (e) {
    console.warn(`  ⚠ 롯데 실패: ${e.message}`);
  }
  const browser = await chromium.launch({ headless: true });
  try {
    try {
      const mb = await fetchMegaboxNowPlaying(browser);
      chainItems.push(...mb);
      console.log(`  메가박스 ${mb.length}편`);
    } catch (e) {
      console.warn(`  ⚠ 메가박스 실패: ${e.message}`);
    }
    try {
      const cg = await fetchCgvNowPlaying(browser);
      chainItems.push(...cg);
      console.log(`  CGV ${cg.length}편`);
    } catch (e) {
      console.warn(`  ⚠ CGV 실패: ${e.message}`);
    }
  } finally {
    await browser.close();
  }

  if (chainItems.length === 0) {
    console.error("모든 체인 실패 — 산출물 보존(덮어쓰기 안 함).");
    process.exit(1);
  }
  const merged = mergeChains(chainItems);
  // 이벤트/공연/중계 전역 제외 (콘서트·라이브뷰잉·팬미팅·스포츠 — 어느 체인發이든)
  const spine = merged.filter((m) => !EVENT_RE.test(m.title));
  console.log(`  병합 ${merged.length}편 → 이벤트 ${merged.length - spine.length}편 제외 → 상영중 ${spine.length}편`);

  console.log("· 상영중 보강(KOBIS 상세 + KMDb)…");
  const nowShowing = [];
  for (const s of spine) {
    const info = await fetchInfo(s.kofCd); // kofCd 없으면 {} 반환
    if (s.kofCd) await sleep(60);
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
      plot: km.plot || s.plotChain || "", // KMDb 우선 → 체인(메가박스 시놉시스) 폴백
      keywords: km.keywords ?? null,
      kmdbId: km.kmdbId ?? null,
      boxOffice: s.kofCd ? box.get(s.kofCd) ?? null : null,
      bookingRate: s.bookingRate,
      availableAt: s.availableAt,
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

  // 표시 필터: 성인물(청소년관람불가) + 포스터 없는 것 제외 (카드 UI 품질).
  // ⚠ 개봉예정의 포스터 없는 정상 신작(예: 명탐정 코난)도 빠짐 — 후속에 체인 예매목록에서 포스터 확보하면 복구 가능.
  const displayable = (m) => m.grade !== "청소년관람불가" && !!m.poster;
  const nowShow = nowShowing.filter(displayable);
  const upcome = upcoming.filter(displayable);
  console.log(
    `· 표시필터(성인/무포스터 제외): 상영중 ${nowShowing.length}→${nowShow.length}, 개봉예정 ${upcoming.length}→${upcome.length}`,
  );

  const payload = {
    updatedAt: toIso(ymd(today)),
    counts: { nowShowing: nowShow.length, upcoming: upcome.length },
    nowShowing: nowShow,
    upcoming: upcome,
  };
  const body = JSON.stringify(payload, null, 2);

  const outDir = resolve(ROOT, "now-showing");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "movies.json"), body, "utf-8");
  console.log(`✓ now-showing/movies.json  (상영중 ${nowShow.length}, 개봉예정 ${upcome.length})`);

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
