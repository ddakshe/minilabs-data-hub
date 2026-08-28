#!/usr/bin/env node
// OTT 인기순위 → ott/<service>.json 생성. 앱(ott-rank)은 이 JSON 만 읽는다.
//
// [넷플릭스] 공식 Top10 데이터(주간·국가별 TSV)를 받아 KR 최신 주차의 Films/TV Top10 추출.
//   - 소스: https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv
//   - 제목은 영어(국제 타이틀)만 제공됨. 딥링크는 제목 검색 폴백.
// [티빙] TODO: 랭킹 엔드포인트 역공학 (콘텐츠 ID로 정확한 딥링크 가능).
// [디즈니+] TODO: 공식 랭킹 없음 → 3자 추정 소스. estimated=true.
//
// 로컬 실행:  node scripts/fetch-ott.mjs
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// 넷플릭스 공개 Top10 페이지(로그인 불필요). reactContext(Apollo)에 순위·videoId·영어제목 포함.
// 영화/시리즈가 URL로 분리됨. videoId로 작동하는 작품 딥링크(kr/title/{id}) 생성.
const NETFLIX_TOP10 = {
  MOVIES: { url: "https://www.netflix.com/tudum/top10/south-korea", label: "영화 TOP 10" },
  SERIES: { url: "https://www.netflix.com/tudum/top10/south-korea/tv", label: "시리즈 TOP 10" },
};
const LAFTEL_RANKING = "https://api.laftel.net/api/home/v1/recommend/ranking/?type=4hour";
// 티빙 홈(Next.js SSR). __NEXT_DATA__ 안에 param="/all/ranking..." 밴드(TOP20_MAIN_DAY)가 박혀 있음.
// 2026-08-18: 전용 /ranking 페이지가 삭제(진짜 404, body 에도 밴드 없음)되고 밴드가 홈으로 옮겨졌다.
const TVING_RANKING_PAGE = "https://www.tving.com/";
// 디즈니+ 한국 랜딩. __NEXT_DATA__ 에 "오늘 한국의 TOP 10" 슬라이더(TopRankedCard)가 SSR됨.
const DISNEY_PAGE = "https://www.disneyplus.com/ko-kr";
// 쿠팡플레이 랜딩. __NEXT_DATA__ props.pageProps.top20Rail 에 "이번 주 TOP 20" 랭킹 SSR됨.
const COUPANG_PAGE = "https://www.coupangplay.com/";
// 넷플릭스 공식 신규/공개예정. __NEXT_DATA__ 에 title1·startTime(epoch ms)·image·videoID 가 SSR 된다.
const NETFLIX_UPCOMING = "https://about.netflix.com/ko/new-to-watch";
// 디즈니+ "공개 예정" 컬렉션 페이지. 랜딩 타일이 가리키는 곳.
const DISNEY_UPCOMING = "https://www.disneyplus.com/ko-kr/browse/page-36541dc7-6961-4bbb-a07b-ef97d7da7995";
// 티빙 광고주용 세일즈 사이트. "향후 3개월 오픈 예정" 이 여기에만 정리돼 있다.
const TVING_UPCOMING = "https://www.tvingads.com/content";
const disneyPoster = (imageId) =>
  `https://prod-ripcut-delivery.disney-plus.net/v1/variant/disney/${imageId}/scale?width=400&format=webp`;
// 웨이브 오늘의 Top20 (웹 공개 apikey, 익명 credential=none)
const WAVVE_RANKING =
  "https://apis.wavve.com/v1/catalog?broadcastid=CN2&catalogType=ranking&limit=20&offset=0&orderby=default&rankingType=top&uicode=CN2&isBand=true&apikey=E5F3E0D30947AA5440556471321BB6D9&device=pc&partner=pooq&region=kor&targetage=all&pooqzone=none&drm=wm&client_version=7.2.80";
// 웨이브 오늘의 영화 Top20 (MN503). 밴드 정의는 /v1/home 응답에 fetch URL 로 박혀 있다.
const WAVVE_MOVIE_RANKING =
  "https://apis.wavve.com/v1/catalog?broadcastid=MN503&catalogType=ranking&category=movie&genre=svod&limit=20&mtype=svod&offset=0&orderby=viewtime&rankingType=top&uicode=MN503&isBand=true&apikey=E5F3E0D30947AA5440556471321BB6D9&device=pc&partner=pooq&region=kor&targetage=all&pooqzone=none&drm=wm&client_version=7.2.80";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const nfSearchUrl = (title) =>
  `https://www.netflix.com/search?q=${encodeURIComponent(title)}`;

// KST 기준 오늘 (YYYY-MM-DD)
const todayKST = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// extra 조립 공통. 빈 값(빈 문자열·빈 배열·null)은 통째로 뺀다.
// 앱이 "있는 것만 그린다"는 전제라, 빈 키를 남기면 시트에 빈 줄이 생긴다.
function compactExtra(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && !v.trim()) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// "박세영, 한고은, 임지은" 같은 쉼표 문자열 → 배열. 시트가 길어지므로 상한을 둔다.
function splitNames(str, limit = 8) {
  return String(str || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, limit);
}

// og: 메타태그만 필요한 페이지용. 전체를 읽지 않고 둘 다 나오면 즉시 끊는다.
// 넷플릭스·디즈니 페이지가 1MB 에 가까워, 전부 읽으면 느릴 뿐 아니라
// 넷플릭스는 연결을 끊어버려서(IncompleteRead) 대부분 실패한다.
async function fetchOgMeta(url, headers = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9", ...headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  let buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    if (/og:title"/.test(buf) && /og:description"/.test(buf)) break;
    if (buf.length > 400_000) break;
  }
  res.body.cancel().catch(() => {});
  const pick = (re) => (buf.match(re) || [])[1] || "";
  return {
    title: pick(/og:title" content="([^"]*)"/).trim(),
    description: pick(/og:description" content="([^"]*)"/).trim(),
  };
}

// 직전 산출물의 watchUrl → extra. 조회가 실패한 항목이 빈 채로 저장되면
// 다음 실행에 다시 채워지면서 매번 diff 가 생긴다 — 이전 값을 깔아 그걸 막는다(래칫).
function previousExtraByWatchUrl(service) {
  const map = new Map();
  try {
    const path = resolve(ROOT, "ott", `${service}.json`);
    if (!existsSync(path)) return map;
    const prev = JSON.parse(readFileSync(path, "utf-8"));
    for (const g of prev.groups ?? []) {
      for (const it of g.items ?? []) {
        if (it.watchUrl && it.extra) map.set(it.watchUrl, it.extra);
      }
    }
  } catch {
    /* 없으면 없는 대로 */
  }
  return map;
}

// 항목의 watchUrl 페이지를 열어 og:description 을 줄거리로 채운다.
// 디즈니+·티빙이 같은 방식이라 공통으로 뺐다. 순차 + 간격 — 한 번에 때리지 않는다.
// 개별 실패는 삼킨다. 줄거리 없는 항목은 앱이 알아서 생략하므로 전체를 막을 이유가 없다.
async function enrichSynopsisFromWatchUrl(service, items, { delay = 400 } = {}) {
  const prev = previousExtraByWatchUrl(service);
  for (const it of items) {
    if (!it.watchUrl) continue;
    const carried = prev.get(it.watchUrl);
    if (carried?.synopsis) it.extra = { ...(it.extra ?? {}), ...carried };
    if (it.extra?.synopsis) continue;
    try {
      const og = await fetchOgMeta(it.watchUrl);
      if (og.description) {
        it.extra = { ...(it.extra ?? {}), synopsis: og.description, source: service };
      }
    } catch {
      /* 이 항목만 줄거리 없이 간다 */
    }
    await sleep(delay);
  }
  const n = items.filter((it) => it.extra?.synopsis).length;
  console.log(`  · 줄거리 ${n}/${items.length}`);
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.text();
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

// 넷플릭스 Top10 페이지 1개 파싱 → { week, items:[{rank,title,videoId}] }
// reactContext(Apollo)의 PulseTop10ItemEntity 에서 순위·엔티티키의 videoId·영어 title 추출.
// 항목이 두 번 중복 등장하므로 rank 기준으로 dedup.
const cleanNfTitle = (t) =>
  t.replace(
    /:\s*(Limited Series|Season \d+.*|Volume \d+.*|Part \d+.*|Chapter \d+.*|The Final Season|\d{4})$/i,
    "",
  );

// Apollo 캐시의 문자열은 JS 리터럴 이스케이프라 JSON 과 완전히 같지 않다.
// 예: "I\\'m SOLO" — \' 는 JS 에선 유효하지만 JSON 에선 무효라 JSON.parse 가 죽는다.
// 아포스트로피가 든 제목이 차트에 진입한 주에만 터지므로(2026-08 넷플릭스 3주 결측)
// JSON 이 모르는 이스케이프를 먼저 정규화하고, 그래도 실패하면 원문을 쓴다.
function unescapeJsString(raw) {
  try {
    return JSON.parse(`"${raw.replace(/\\'/g, "'")}"`);
  } catch {
    return raw.replace(/\\(['"\\/])/g, "$1");
  }
}

// Tudum 은 영문 제목만 주고 줄거리는 아예 없다. netflix.com/kr/title/{id} 의
// og:title·og:description 에 둘 다 있어서 항목마다 한 번 조회한다 (한 요청에서 둘 다 얻는다).
async function fetchNetflixMeta(videoId) {
  const og = await fetchOgMeta(`https://www.netflix.com/kr/title/${videoId}`);
  const title = og.title.replace(/(, 지금 시청하세요)? \| 넷플릭스.*$/, "").trim();

  // 페이지가 덜 로드되면 og:title 이 비고 og:description 은 사이트 공용 문구로 나온다.
  // 거르지 않으면 10편 전부 같은 안내 문구가 줄거리로 들어간다.
  const boilerplate = !title || /스마트 TV, 태블릿|다양한 디바이스에서 영화와 시리즈/.test(og.description);
  return {
    title: /[가-힣]/.test(title) ? title : null,
    synopsis: boilerplate ? null : og.description || null,
  };
}

// 직전 산출물의 videoId → { title, synopsis }. 파일이 없거나 깨져 있으면 빈 맵.
// 조회 실패가 매번 다른 항목에서 나기 때문에, 이전 값을 깔아두지 않으면
// 실행마다 제목·줄거리가 들어왔다 빠졌다 하며 노이즈 커밋이 쌓인다.
function previousNetflixMeta() {
  const map = new Map();
  try {
    const path = resolve(ROOT, "ott", "netflix.json");
    if (!existsSync(path)) return map;
    const prev = JSON.parse(readFileSync(path, "utf-8"));
    for (const g of prev.groups ?? []) {
      for (const it of g.items ?? []) {
        if (!it.watchUrl) continue;
        map.set(it.watchUrl.split("/").pop(), {
          title: /[가-힣]/.test(it.title || "") ? it.title : null,
          synopsis: it.extra?.synopsis || null,
        });
      }
    }
  } catch {
    /* 없으면 없는 대로 */
  }
  return map;
}

async function parseNetflixPage(url) {
  const html = await fetchText(url);
  const week = (html.match(/"weekEndDate":"(\d{4}-\d{2}-\d{2})"/) || [])[1] || todayKST();

  // boxshot 의 alternativeText("영문 (한글)")에서 한글 제목만 수집. (상위권 한국작품만 존재)
  const koByEn = new Map();
  const bre =
    /"PulseBoxShotEntity:[^"]+":\{[\s\S]{0,300}?"displayHeadline":"([^"]*)"[\s\S]{0,600}?"alternativeText":"([^"]*)"/g;
  let b;
  while ((b = bre.exec(html))) {
    const paren = (b[2].match(/\(([^)]+)\)\s*$/) || [])[1];
    if (paren && /[가-힣]/.test(paren)) koByEn.set(cleanNfTitle(b[1]), paren);
  }

  // 각 항목: 순위·videoId·가로썸네일(sdpArt)·큰이미지(storyArt)·영어제목.
  // 아트 순서는 캐시에서 sdpArt → storyArt → title 이다.
  // sdpArt 는 390x219 라 목록 썸네일용으로 충분하지만 상세 시트에는 작다.
  // storyArt 가 1200x675 로 같은 캐시에 들어 있어 함께 뽑아 extra.hero 로 보낸다
  // (목록은 계속 가벼운 sdpArt 를 쓰고, 큰 이미지는 시트를 열 때만 로드된다).
  const re =
    /"PulseTop10ItemEntity:top10-[^"]*?-(\d+)":\{[\s\S]{0,400}?"weeklyRank":(\d+)[\s\S]{0,900}?"sdpArt":\{[\s\S]{0,400}?"url":"([^"]+?)"([\s\S]{0,2500}?)"title":"((?:[^"\\]|\\.)*?)"/g;
  const byRank = new Map();
  let m;
  while ((m = re.exec(html))) {
    const rank = Number(m[2]);
    if (byRank.has(rank)) continue;
    const en = cleanNfTitle(unescapeJsString(m[5]));
    const story = m[4].match(/"storyArt":\{[\s\S]{0,400}?"url":"([^"]+?)"/);
    // 등급·연도·에피소드 수는 같은 엔티티에 이미 들어 있다 — 추가 요청 0건.
    // 뒤쪽(title 이후)에 있는 필드라 블록 전체에서 다시 찾는다.
    const tail = html.slice(m.index, m.index + 4000);
    const grab = (re) => (tail.match(re) || [])[1];
    byRank.set(rank, {
      rank,
      title: koByEn.get(en) || en, // 한글 있으면 한글, 없으면 영어 원제
      // 그리드가 2:3 으로 중앙 크롭하므로 큰 storyArt 를 쓴다. 없으면 sdpArt 로 폴백.
      poster: (story ? story[1] : m[3]).replace(/\\u002F/g, "/"),
      watchUrl: `https://www.netflix.com/kr/title/${m[1]}`,
      extra: compactExtra({
        hero: story ? story[1].replace(/\\u002F/g, "/") : undefined,
        ageRating: grab(/"maturityRating":"([^"]*)"/),
        year: Number(grab(/"releaseYear":(\d+)/)) || undefined,
        episodes: Number(grab(/"totalCount":(\d+)/)) || undefined,
      }),
    });
  }
  const items = [...byRank.values()].sort((a, b) => a.rank - b.rank);

  // 지난 실행에서 확보한 값(한글 제목·줄거리)을 먼저 깐다. 조회가 산발적으로 실패해서
  // 매 실행마다 값이 들어왔다 빠졌다 하면 의미 없는 커밋이 쌓인다 — 한 번 얻으면 유지(래칫).
  const prev = previousNetflixMeta();
  for (const it of items) {
    const p = prev.get(it.watchUrl.split("/").pop());
    if (!p) continue;
    if (p.title && !/[가-힣]/.test(it.title)) it.title = p.title;
    if (p.synopsis) it.extra = { ...(it.extra ?? {}), synopsis: p.synopsis, source: "netflix" };
  }

  // 남은 것을 작품 페이지에서 보충. 제목과 줄거리가 같은 응답에 있어 요청은 항목당 1건이다.
  // 순차 + 간격을 둔다(동시에 때리면 넷플릭스가 연결을 끊는다). 실패해도 영문 제목이 남는다.
  // 넷플릭스 한국은 외국 작품까지 전부 제목을 현지화한다(영화 TOP10 실측 10/10).
  // 그래서 영문이 남았다면 그건 "원래 영문"이 아니라 조회가 끊긴 것이다 —
  // 검색 같은 다른 출처로 메우면 틀린 제목이 섞이므로, 같은 출처를 끈질기게 다시 친다.
  const needs = (it) => !/[가-힣]/.test(it.title) || !it.extra?.synopsis;
  for (let round = 0; round < 4; round++) {
    const todo = items.filter(needs);
    if (todo.length === 0) break;
    for (const it of todo) {
      const videoId = it.watchUrl.split("/").pop();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const meta = await fetchNetflixMeta(videoId);
          if (meta.title && !/[가-힣]/.test(it.title)) it.title = meta.title;
          if (meta.synopsis && !it.extra?.synopsis) {
            it.extra = { ...(it.extra ?? {}), synopsis: meta.synopsis, source: "netflix" };
          }
          if (!needs(it)) break;
        } catch {
          /* 연결이 끊겼다 — 새 연결로 다시 */
        }
        await sleep(800 * (attempt + 1));
      }
      await sleep(1200);
    }
  }
  const koCount = items.filter((it) => /[가-힣]/.test(it.title)).length;
  const synCount = items.filter((it) => it.extra?.synopsis).length;
  console.log(`  · 한글 제목 ${koCount}/${items.length}, 줄거리 ${synCount}/${items.length}`);

  return { week, items };
}

// ── 넷플릭스: 영화/시리즈 Top10 (공개 Tudum 페이지, 영어 원제 + 작동 딥링크) ──
// ── 공개 예정작 ──────────────────────────────────────────────
// 순위가 아니라 "언제 나온다" 목록이다. rank 는 공개일 순서를 담는 자리로 쓴다.
// 예정작은 부가 그룹이라 실패해도 순위 그룹은 그대로 나가야 한다 — 호출부에서 try 로 감싼다.

const stripTags = (x) =>
  x.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();

// YYYY-MM-DD (KST). 예정작은 날짜가 핵심이라 시간대를 흘리면 하루가 어긋난다.
const ymdKST = (ms) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date(ms));

// 넷플릭스 공식 신규/공개예정. __NEXT_DATA__ 에 배열이 통째로 SSR 되어 브라우저가 필요 없다.
// 항목: { country, startTime(epoch ms), title1, image, videoID }
// 예정작 그룹을 붙인다. 실패하면 로그만 남기고 넘어간다 —
// 예정작 때문에 순위가 못 나가면 주객이 전도된다.
async function addUpcoming(groups, name, builder) {
  try {
    const items = await builder();
    if (items.length > 0) groups.push({ label: "공개 예정", items });
    console.log(`  · 공개 예정 ${items.length}편`);
  } catch (e) {
    console.error(`  · ${name} 공개 예정 건너뜀: ${e.message}`);
  }
}

async function buildNetflixUpcoming(limit = 10) {
  const html = await fetchText(NETFLIX_UPCOMING);
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("__NEXT_DATA__ 를 찾지 못함");

  let arr = null;
  (function walk(o) {
    if (arr || !o || typeof o !== "object") return;
    if (Array.isArray(o) && o.length > 3 && o[0] && typeof o[0] === "object" && "title1" in o[0] && "startTime" in o[0]) {
      arr = o;
      return;
    }
    for (const k in o) walk(o[k]);
  })(JSON.parse(m[1]));
  if (!arr) throw new Error("공개 예정 배열을 찾지 못함");

  const now = Date.now();
  return arr
    .filter((x) => x.country === "KR" && x.startTime >= now && x.title1)
    .sort((a, b) => a.startTime - b.startTime)
    .slice(0, limit)
    .map((x, i) => ({
      rank: i + 1,
      title: x.title1,
      poster: x.image || undefined,
      // videoID 가 있으면 작품 페이지로. 아직 공개 전이라 없을 수도 있다.
      watchUrl: x.videoID ? `https://www.netflix.com/kr/title/${x.videoID}` : undefined,
      extra: compactExtra({ releaseDate: ymdKST(x.startTime), source: "netflix" }),
    }));
}

// 디즈니+ "공개 예정" 컬렉션. 같은 페이지에 다른 섹션(이번 주 새로운 에피소드 등)이
// 이어지므로 첫 섹션까지만 자른다. 이 페이지에는 공개일 표기가 없다.
async function buildDisneyUpcoming(limit = 10) {
  const html = await fetchText(DISNEY_UPCOMING);
  const start = html.indexOf("공개 예정</h2>");
  if (start < 0) throw new Error('"공개 예정" 섹션을 찾지 못함');
  const next = html.indexOf("</h2>", start + 10);
  const seg = html.slice(start, next > start ? next : start + 60000);

  const seen = new Set();
  const items = [];
  for (const m of seg.matchAll(/aria-label="([^"]{1,60})" href="(\/ko-kr\/browse\/entity-[^"]+)"/g)) {
    const title = stripTags(m[1]);
    if (seen.has(title)) continue;
    seen.add(title);
    const img = seg.slice(m.index, m.index + 3000).match(/\/ripcut-delivery\/v2\/variant\/disney\/([0-9a-f-]+)\/compose/);
    items.push({
      rank: items.length + 1,
      title,
      poster: img ? disneyPoster(img[1]) : undefined,
      watchUrl: `https://www.disneyplus.com${m[2]}`,
      extra: compactExtra({ source: "disney" }),
    });
    if (items.length >= limit) break;
  }
  if (items.length === 0) throw new Error("공개 예정 항목 없음");
  return items;
}

// 티빙은 서비스 자체에 예정작 목록이 없고 광고주용 세일즈 사이트에만 정리돼 있다.
// ⚠️ Framer 로 만든 페이지라 클래스명이 해시(framer-14rvfvr)라서 리빌드마다 바뀐다.
//    그래서 클래스에 기대지 않고 "COMING SOON"~"DEMO RANKING" 구간의 h3 제목과
//    "공개일" 뒤 텍스트만 읽는다. 그래도 순위 스크래퍼보다 잘 깨지는 자리다.
async function buildTvingUpcoming(limit = 10) {
  const html = await fetchText(TVING_UPCOMING);
  const a = html.indexOf("COMING SOON");
  if (a < 0) throw new Error('"COMING SOON" 구간을 찾지 못함');
  const b = html.indexOf("DEMO RANKING");
  const seg = html.slice(a, b > a ? b : a + 200000);

  // 반응형이라 같은 카드가 모바일/데스크톱으로 두 번 나온다.
  // 제목만 dedup 하고 날짜는 별도 배열에서 같은 인덱스로 꺼내면 짝이 밀린다 —
  // 날짜는 중복이 남아 있기 때문이다. 그래서 제목이 나온 위치부터 앞을 훑어
  // 그 카드에 속한 "공개일" 을 집는다(DOM 순서상 제목 뒤에 온다).
  // 포스터는 카드 안에서 제목보다 앞에 온다 — 제목 직전의 이미지가 그 카드 것이다.
  // src 가 HTML 속성이라 쿼리의 & 가 &amp; 로 이스케이프돼 있다. 풀지 않으면
  // ?width=480&amp;height=693 이 그대로 요청돼 400 이 난다.
  const imgs = [...seg.matchAll(/<img[^>]+src="(https:\/\/framerusercontent[^"]+)"/g)].map((m) => ({
    at: m.index,
    url: m[1].replace(/&amp;/g, "&"),
  }));

  const seen = new Set();
  const items = [];
  for (const m of seg.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)) {
    const title = stripTags(m[1]);
    if (!title || title.includes("오픈 예정 콘텐츠")) continue; // 섹션 제목 자신
    if (seen.has(title)) continue;
    seen.add(title);
    const poster = imgs.filter((g) => g.at < m.index).pop()?.url;
    const after = seg.slice(m.index, m.index + 2500);
    // "2026. 9. 10." → 2026-09-10. "9월"·"미정" 은 그대로 둔다(원문이 확정 아님).
    const raw = stripTags((after.match(/공개일[\s\S]{0,400}?<p[^>]*>([\s\S]{0,40}?)<\/p>/) || [])[1] ?? "");
    const md = raw.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
    items.push({
      rank: items.length + 1,
      title,
      poster,
      extra: compactExtra({
        releaseDate: md ? `${md[1]}-${md[2].padStart(2, "0")}-${md[3].padStart(2, "0")}` : undefined,
        releaseText: md ? undefined : raw || undefined,
        source: "tving",
      }),
    });
    if (items.length >= limit) break;
  }
  if (items.length === 0) throw new Error("COMING SOON 항목 없음");
  return items;
}

async function buildNetflix() {
  console.log("▶ 넷플릭스 공개 Top10 페이지 조회(시리즈·영화)…");
  // 예전엔 시리즈만 노출했다 — "영화는 대부분 영어 제목" 이 이유였는데,
  // og:title 조회를 붙이면서 그 전제가 사라졌다(영화 TOP10 실측 한글 10/10).
  const series = await parseNetflixPage(NETFLIX_TOP10.SERIES.url);
  const groups = [];
  if (series.items.length > 0) groups.push({ label: NETFLIX_TOP10.SERIES.label, items: series.items });

  // 영화는 부가 그룹이라 실패해도 시리즈만으로 진행한다.
  try {
    const movies = await parseNetflixPage(NETFLIX_TOP10.MOVIES.url);
    if (movies.items.length > 0) {
      groups.push({ label: NETFLIX_TOP10.MOVIES.label, items: movies.items });
    }
  } catch (e) {
    console.error(`  · 영화 TOP10 건너뜀: ${e.message}`);
  }

  await addUpcoming(groups, "넷플릭스", buildNetflixUpcoming);

  const week = series.week;
  if (groups.length === 0) throw new Error("Top10 항목을 찾지 못함(페이지 구조 변경?)");

  return {
    service: "netflix",
    serviceName: "넷플릭스",
    brandColor: "#E50914",
    updatedAt: week,
    estimated: false,
    // 넷플릭스만 리스트라 6개 탭 중 혼자 한 줄에 하나씩 나왔다. 그리드로 통일한다.
    // 넷플릭스에 세로 포스터 자산은 없지만(§ storyArt 주석), Tudum 캐러셀 자체가
    // 이 가로 storyArt 를 세로로 중앙 크롭해 쓰므로 같은 방식이면 결과가 같다.
    // 그래서 poster 를 sdpArt(390x219) 대신 storyArt(1200x675)로 바꾼다 —
    // 2:3 으로 잘리면 폭의 37% 만 남아, 작은 이미지로는 화질이 무너진다.
    layout: "grid",
    subscribeUrl: "https://www.netflix.com/kr/",
    groups,
  };
}

// ── 라프텔: 실시간(4시간) 인기 랭킹 ──
// 응답은 아이템 배열(순서 = 순위). 한글 제목·포스터·장르·id 제공.
async function buildLaftel() {
  console.log("▶ 라프텔 인기 랭킹 조회…");
  const arr = await fetchJson(LAFTEL_RANKING, {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    Origin: "https://laftel.net",
    Referer: "https://laftel.net/",
    "sec-ch-ua": '"Chromium";v="120", "Not(A:Brand";v="24", "Google Chrome";v="120"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
  });
  if (!Array.isArray(arr) || arr.length === 0) throw new Error("랭킹 배열이 비었습니다");

  const items = arr.slice(0, 10).map((it, i) => ({
    rank: i + 1,
    title: it.name,
    poster: it.img || it.images?.[0]?.img_url || undefined,
    watchUrl: `https://laftel.net/item/${it.id}`,
    // genre 는 기존 앱이 카드에 쓰던 필드라 그대로 두고, 나머지를 옆에 붙인다.
    extra: compactExtra({
      genre: (it.genres ?? []).slice(0, 2).join("·"),
      genres: (it.genres ?? []).slice(0, 4),
      ageRating: it.content_rating,
      source: "laftel",
    }),
  }));

  // 줄거리는 랭킹 응답에 없고 detail API 에만 있다. 항목당 1건.
  const prev = previousExtraByWatchUrl("laftel");
  for (const [i, it] of items.entries()) {
    const carried = prev.get(it.watchUrl);
    if (carried?.synopsis) {
      it.extra = { ...(it.extra ?? {}), synopsis: carried.synopsis };
      continue;
    }
    try {
      const d = await fetchJson(`https://api.laftel.net/api/items/v1/${arr[i].id}/`, {
        Accept: "application/json, text/plain, */*",
        Referer: "https://laftel.net/",
      });
      it.extra = compactExtra({
        ...(it.extra ?? {}),
        synopsis: (d.content || "").trim(),
        tags: (d.tags ?? []).map((t) => t.name ?? t).filter(Boolean).slice(0, 5),
        rating: d.avg_rating,
      });
    } catch {
      /* 이 항목만 줄거리 없이 간다 */
    }
    await sleep(300);
  }
  console.log(`  · 줄거리 ${items.filter((it) => it.extra?.synopsis).length}/${items.length}`);

  return {
    service: "laftel",
    serviceName: "라프텔",
    brandColor: "#7C4DFF",
    updatedAt: todayKST(),
    estimated: false,
    layout: "grid",
    subscribeUrl: "https://laftel.net/",
    groups: [{ label: "실시간 인기", items }],
  };
}

// ── 티빙: 오늘의 티빙 TOP 20 ──
// 홈 HTML의 __NEXT_DATA__ 에서 param 이 "/all/ranking" 으로 시작하는 밴드를 추출.
// param 에 쿼리가 붙어 있으므로(예: "/all/ranking&pageNo=1&gradeCode=CPTG0019") 부분일치로 찾는다.
async function buildTving() {
  console.log("▶ 티빙 홈 조회…");
  // 상태코드로 판단하지 않고 body 를 파싱한다(과거 /ranking 이 soft-404 였던 이력).
  const res = await fetch(TVING_RANKING_PAGE, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "ko-KR,ko;q=0.9",
    },
  });
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("__NEXT_DATA__ 를 찾지 못함(페이지 구조 변경?)");

  const data = JSON.parse(m[1]);
  let band = null;
  (function walk(o) {
    if (band || !o || typeof o !== "object") return;
    if (o.param && String(o.param).includes("/all/ranking") && Array.isArray(o.items)) band = o;
    for (const k in o) walk(o[k]);
  })(data);
  if (!band) throw new Error("랭킹 밴드(param=/all/ranking...)를 찾지 못함");

  const items = band.items.slice(0, 10).map((it, i) => ({
    rank: i + 1,
    title: it.title,
    poster: it.imageUrl || undefined,
    watchUrl: `https://www.tving.com/contents/${it.code}`,
  }));

  // 랭킹 밴드에는 줄거리가 없다. 콘텐츠 페이지를 한 번씩 더 열어 og:description 을 쓴다.
  await enrichSynopsisFromWatchUrl("tving", items);

  const groups = [{ label: "오늘의 티빙 TOP 10", items }];
  await addUpcoming(groups, "티빙", buildTvingUpcoming);

  return {
    service: "tving",
    serviceName: "티빙",
    brandColor: "#FF153C",
    updatedAt: todayKST(),
    estimated: false,
    layout: "grid",
    subscribeUrl: "https://www.tving.com/",
    groups,
  };
}

// ── 웨이브: 오늘의 Top20 ──
// data.context_list[] 순서=순위. program.title(한글)·vertical_logo_y_image(포스터)·context_id(딥링크).
// 웨이브 랭킹 밴드 하나 → items[]. 밴드가 둘(통합/영화)이라 공통으로 뺐다.
async function fetchWavveBand(url) {
  const j = await fetchJson(url, {
    Accept: "application/json, text/plain, */*",
    Authorization: "Bearer none",
    "wavve-credential": "none",
    Origin: "https://www.wavve.com",
    Referer: "https://www.wavve.com/",
  });
  const list = j?.data?.context_list ?? [];
  return list.slice(0, 10).map((it, i) => {
    const p = it.program ?? it.series ?? it.content ?? {};
    // 줄거리·출연진은 series 에만 있다. 기존 코드는 program 만 읽고 series 를 버렸다 — 추가 요청 0건.
    const se = it.series ?? {};
    return {
      rank: i + 1,
      title: p.title,
      poster: p.vertical_logo_y_image || undefined,
      // 웨이브는 콘텐츠 상세가 SPA/로그인 벽이라 작품 딥링크가 실제 페이지로 안 감. 생략 → 홈페이지로 유도.
      extra: compactExtra({
        synopsis: (se.synopsis || "").trim(),
        cast: splitNames(se.actors),
        source: "wavve",
      }),
    };
  });
}

async function buildWavve() {
  console.log("▶ 웨이브 오늘의 Top 조회…");
  const items = await fetchWavveBand(WAVVE_RANKING);
  if (items.length === 0) throw new Error("context_list 가 비었습니다");

  const groups = [{ label: "오늘의 TOP 10", items }];

  // 영화는 부가 그룹이라 실패해도 통합 랭킹만으로 진행한다.
  try {
    const movies = await fetchWavveBand(WAVVE_MOVIE_RANKING);
    if (movies.length > 0) groups.push({ label: "오늘의 영화 TOP 10", items: movies });
  } catch (e) {
    console.error(`  · 영화 TOP 건너뜀: ${e.message}`);
  }

  return {
    service: "wavve",
    serviceName: "웨이브",
    brandColor: "#2C5EFF",
    updatedAt: todayKST(),
    estimated: false,
    layout: "grid",
    subscribeUrl: "https://www.wavve.com/",
    groups,
  };
}

// ── 디즈니+: 오늘 한국의 TOP 10 ──
// 랜딩 HTML의 __NEXT_DATA__ 에서 TopRankedCard 노드를 직접 수집한다.
// 2026-08-18: 예전에는 "오늘 한국의 TOP 10" 텍스트 노드의 *형제* Slider 를 집었는데,
// 트리 구조가 바뀌면서 형제 관계가 어긋나 실패했다. 형제 관계에 기대지 않고 노드 타입으로
// 직접 찾는다 — 구조가 또 바뀌어도 카드 타입만 유지되면 살아남는다.
// 순서는 문서 순서가 아니라 카드의 index 필드로 정한다.
async function buildDisney() {
  console.log("▶ 디즈니+ 랜딩 조회…");
  const html = await fetchText(DISNEY_PAGE);
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("__NEXT_DATA__ 를 찾지 못함");

  // 다른 레일의 TopRankedCard 와 섞이지 않도록 해당 밴드가 실제로 있는지 먼저 확인한다.
  if (!m[1].includes("오늘 한국의 TOP 10")) {
    throw new Error('"오늘 한국의 TOP 10" 밴드를 찾지 못함');
  }

  const root = JSON.parse(m[1]);
  const cards = [];
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (o._type === "TopRankedCard") cards.push(o);
    for (const k in o) walk(o[k]);
  })(root);
  if (cards.length === 0) throw new Error("TopRankedCard 를 찾지 못함");
  cards.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  const items = cards.slice(0, 10).map((c, i) => {
    const imageId = c.imageVariants?.defaultImage?.imageId;
    return {
      rank: i + 1,
      title: c.title,
      poster: imageId ? disneyPoster(imageId) : undefined,
      watchUrl: `https://www.disneyplus.com${c.url}`,
    };
  });

  // 랜딩 카드에는 제목·이미지·URL 뿐이라, 각 엔티티 페이지를 한 번씩 더 열어 줄거리를 얻는다.
  await enrichSynopsisFromWatchUrl("disney", items);

  const groups = [{ label: "오늘 한국의 TOP 10", items }];
  await addUpcoming(groups, "디즈니+", buildDisneyUpcoming);

  return {
    service: "disney",
    serviceName: "디즈니+",
    brandColor: "#0063E5",
    updatedAt: todayKST(),
    estimated: false,
    layout: "grid",
    subscribeUrl: "https://www.disneyplus.com/ko-kr",
    groups,
  };
}

// ── 쿠팡플레이: 이번 주 TOP 10 ──
// 랜딩 __NEXT_DATA__ props.pageProps.top20Rail.data 에서 social "이번 주 랭킹 N위" 파싱.
async function buildCoupang() {
  console.log("▶ 쿠팡플레이 랜딩 조회…");
  const html = await fetchText(COUPANG_PAGE);
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("__NEXT_DATA__ 를 찾지 못함");
  const rail = JSON.parse(m[1])?.props?.pageProps?.top20Rail?.data ?? [];
  if (rail.length === 0) throw new Error("top20Rail 을 찾지 못함");

  const items = [];
  for (const it of rail) {
    const rk = (it.social || "").match(/이번 주 랭킹 (\d+)위/);
    if (!rk || Number(rk[1]) > 10) continue;
    items.push({
      rank: Number(rk[1]),
      title: it.title,
      poster: it.images?.poster_url || undefined,
      watchUrl: `https://www.coupangplay.com/content/${it.id}`,
      // rail 응답이 상세 메타를 통째로 싣고 있다 — 추가 요청 0건.
      extra: compactExtra({
        synopsis: (it.description || "").trim(),
        ageRating: it.ageRatingLocalized,
        year: it.releaseYear ? Number(it.releaseYear) : undefined,
        runtime: it.running_time_friendly,
        rating: it.averageUserRating,
        tags: (it.tags ?? []).map((t) => t.label).filter(Boolean).slice(0, 5),
        reviews: (it.bestReviews ?? [])
          .slice(0, 3)
          .map((r) => ({ text: r.review, meta: r.meta }))
          .filter((r) => r.text),
        source: "coupang",
      }),
    });
  }
  items.sort((a, b) => a.rank - b.rank);
  if (items.length === 0) throw new Error("이번 주 랭킹 항목 없음");

  return {
    service: "coupang",
    serviceName: "쿠팡플레이",
    brandColor: "#D6173A",
    updatedAt: todayKST(),
    estimated: false,
    layout: "grid",
    subscribeUrl: "https://www.coupangplay.com/",
    groups: [{ label: "이번 주 TOP 10", items }],
  };
}

// 기존 산출과 동일하면 저장 생략(변경 노이즈 방지). 반환: 저장했는지 여부.
function writeIfChanged(path, body) {
  if (existsSync(path) && readFileSync(path, "utf-8") === body) {
    console.log(`· 변경 없음, 건너뜀: ${path}`);
    return false;
  }
  writeFileSync(path, body, "utf-8");
  return true;
}

// 직전 저장본과 비교해 prevRank(항목)·prevAt(서비스)을 채운다.
// 앱 localStorage 가 아니라 여기서 계산하는 이유: 첫 방문자에게도 변동이 보이고,
// 기기 간 값이 일치하며, 앱은 "받아서 그리기만" 하는 정적 클라이언트로 남는다.
//
// 매칭 키는 title 이다. 서비스 내부 ID 가 더 안정적이지만 웨이브는 항목에 ID 를
// 싣지 않아 6개 공통으로 쓸 수 있는 게 title 뿐이다. 제목 표기가 바뀌면 NEW 로
// 오인되는데, 오탐의 대가가 배지 하나라 감수한다.
//
// 순위가 그대로면 prevRank === rank 가 되고 앱이 알아서 아무것도 안 그린다 —
// "변동 없음" 을 위한 별도 분기가 필요 없다.
function injectRankDelta(service, payload) {
  let prev = null;
  try {
    const path = resolve(ROOT, "ott", `${service}.json`);
    if (existsSync(path)) prev = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    /* 없으면 전부 신규로 본다 */
  }

  const prevRankByTitle = new Map();
  for (const g of prev?.groups ?? []) {
    for (const it of g.items ?? []) {
      if (it.title != null) prevRankByTitle.set(it.title, it.rank);
    }
  }

  for (const g of payload.groups ?? []) {
    for (const it of g.items ?? []) {
      it.prevRank = prevRankByTitle.get(it.title) ?? null;
    }
  }
  // 기준 시점. 서비스마다 갱신 주기가 달라(라프텔 4시간, 넷플릭스 주간)
  // "언제 대비" 인지를 앱이 표기할 수 있어야 한다.
  if (prev?.updatedAt) payload.prevAt = prev.updatedAt;
  return payload;
}

function emit(service, payload) {
  injectRankDelta(service, payload);
  const body = JSON.stringify(payload, null, 2);

  const outDir = resolve(ROOT, "ott");
  mkdirSync(outDir, { recursive: true });
  const hubPath = resolve(outDir, `${service}.json`);
  const changed = writeIfChanged(hubPath, body);
  if (changed) console.log(`✓ ott/${service}.json`);

  // 로컬 dev 미러 (사이드 앱이 있으면)
  const appPublic = resolve(ROOT, "../ott-rank/public/data");
  if (existsSync(resolve(ROOT, "../ott-rank"))) {
    mkdirSync(appPublic, { recursive: true });
    writeFileSync(resolve(appPublic, `${service}.json`), body, "utf-8");
    console.log(`✓ ../ott-rank/public/data/${service}.json (로컬 dev 미러)`);
  }
}

// 서비스별 독립 실행. 하나가 실패해도 나머지는 계속(격리). 반환: 실패 개수.
async function runService(name, builder) {
  try {
    const payload = await builder();
    const total = payload.groups.reduce((n, g) => n + g.items.length, 0);
    emit(payload.service, payload);
    console.log(`✓ ${name} 완료 (${total}편, ${payload.groups.length}개 그룹)`);
    return 0;
  } catch (e) {
    console.error(`✗ ${name} 실패: ${e.message}`);
    return 1;
  }
}

async function main() {
  const services = [
    ["넷플릭스", buildNetflix],
    ["라프텔", buildLaftel],
    ["웨이브", buildWavve],
    ["티빙", buildTving],
    ["디즈니+", buildDisney],
    ["쿠팡플레이", buildCoupang],
  ];
  let failed = 0;
  for (const [name, builder] of services) failed += await runService(name, builder);

  const ok = services.length - failed;
  console.log(`── ${ok}/${services.length} 성공, ${failed} 실패`);
  // 성공한 서비스는 이미 저장됨(실패 서비스는 기존 JSON 유지).
  // 하나라도 실패하면 job 을 실패시킨다 — 예전엔 전부 실패할 때만 빨간불이라
  // 2/6 성공이 몇 주간 초록불로 지나갔고 넷플릭스가 8/09 에 멈춘 걸 아무도 몰랐다.
  if (failed > 0) throw new Error(`${failed}개 서비스 실패 (${ok}/${services.length} 성공)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
