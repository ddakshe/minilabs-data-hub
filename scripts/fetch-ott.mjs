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
const disneyPoster = (imageId) =>
  `https://prod-ripcut-delivery.disney-plus.net/v1/variant/disney/${imageId}/scale?width=400&format=webp`;
// 웨이브 오늘의 Top20 (웹 공개 apikey, 익명 credential=none)
const WAVVE_RANKING =
  "https://apis.wavve.com/v1/catalog?broadcastid=CN2&catalogType=ranking&limit=20&offset=0&orderby=default&rankingType=top&uicode=CN2&isBand=true&apikey=E5F3E0D30947AA5440556471321BB6D9&device=pc&partner=pooq&region=kor&targetage=all&pooqzone=none&drm=wm&client_version=7.2.80";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const nfSearchUrl = (title) =>
  `https://www.netflix.com/search?q=${encodeURIComponent(title)}`;

// KST 기준 오늘 (YYYY-MM-DD)
const todayKST = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());

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

  // 각 항목: 순위·videoId·가로썸네일(sdpArt, 10개 전부)·영어제목. sdpArt 는 artwork 안, title 보다 앞.
  const re =
    /"PulseTop10ItemEntity:top10-[^"]*?-(\d+)":\{[\s\S]{0,400}?"weeklyRank":(\d+)[\s\S]{0,900}?"sdpArt":\{[\s\S]{0,400}?"url":"([^"]+?)"[\s\S]{0,2500}?"title":"((?:[^"\\]|\\.)*?)"/g;
  const byRank = new Map();
  let m;
  while ((m = re.exec(html))) {
    const rank = Number(m[2]);
    if (byRank.has(rank)) continue;
    const en = cleanNfTitle(JSON.parse(`"${m[4]}"`));
    byRank.set(rank, {
      rank,
      title: koByEn.get(en) || en, // 한글 있으면 한글, 없으면 영어 원제
      poster: m[3].replace(/\\u002F/g, "/"), // 가로 썸네일 (전 항목)
      watchUrl: `https://www.netflix.com/kr/title/${m[1]}`,
    });
  }
  const items = [...byRank.values()].sort((a, b) => a.rank - b.rank);
  return { week, items };
}

// ── 넷플릭스: 영화/시리즈 Top10 (공개 Tudum 페이지, 영어 원제 + 작동 딥링크) ──
async function buildNetflix() {
  console.log("▶ 넷플릭스 공개 Top10 페이지 조회(시리즈)…");
  // 시리즈만 노출: 세로 포스터·한글 제목이 시리즈에 집중돼 있고 영화는 대부분 영어 텍스트라 제외.
  const { url, label } = NETFLIX_TOP10.SERIES;
  const page = await parseNetflixPage(url);
  const groups = page.items.length > 0 ? [{ label, items: page.items }] : [];
  const week = page.week;
  if (groups.length === 0) throw new Error("Top10 항목을 찾지 못함(페이지 구조 변경?)");

  return {
    service: "netflix",
    serviceName: "넷플릭스",
    brandColor: "#E50914",
    updatedAt: week,
    estimated: false,
    layout: "list", // 가로 썸네일 리스트 (넷플릭스 공식 overview 스타일)
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
    extra: { genre: (it.genres ?? []).slice(0, 2).join("·") || undefined },
  }));

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

  return {
    service: "tving",
    serviceName: "티빙",
    brandColor: "#FF153C",
    updatedAt: todayKST(),
    estimated: false,
    layout: "grid",
    subscribeUrl: "https://www.tving.com/",
    groups: [{ label: "오늘의 티빙 TOP 10", items }],
  };
}

// ── 웨이브: 오늘의 Top20 ──
// data.context_list[] 순서=순위. program.title(한글)·vertical_logo_y_image(포스터)·context_id(딥링크).
async function buildWavve() {
  console.log("▶ 웨이브 오늘의 Top 조회…");
  const j = await fetchJson(WAVVE_RANKING, {
    Accept: "application/json, text/plain, */*",
    Authorization: "Bearer none",
    "wavve-credential": "none",
    Origin: "https://www.wavve.com",
    Referer: "https://www.wavve.com/",
  });
  const list = j?.data?.context_list ?? [];
  if (list.length === 0) throw new Error("context_list 가 비었습니다");

  const items = list.slice(0, 10).map((it, i) => {
    const p = it.program ?? it.series ?? it.content ?? {};
    return {
      rank: i + 1,
      title: p.title,
      poster: p.vertical_logo_y_image || undefined,
      // 웨이브는 콘텐츠 상세가 SPA/로그인 벽이라 작품 딥링크가 실제 페이지로 안 감. 생략 → 홈페이지로 유도.
    };
  });

  return {
    service: "wavve",
    serviceName: "웨이브",
    brandColor: "#2C5EFF",
    updatedAt: todayKST(),
    estimated: false,
    layout: "grid",
    subscribeUrl: "https://www.wavve.com/",
    groups: [{ label: "오늘의 TOP 10", items }],
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

  return {
    service: "disney",
    serviceName: "디즈니+",
    brandColor: "#0063E5",
    updatedAt: todayKST(),
    estimated: false,
    layout: "grid",
    subscribeUrl: "https://www.disneyplus.com/ko-kr",
    groups: [{ label: "오늘 한국의 TOP 10", items }],
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

function emit(service, payload) {
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
  // 성공한 서비스는 이미 저장됨(실패 서비스는 기존 JSON 유지). 전부 실패한 경우만 job 실패.
  if (ok === 0) throw new Error("모든 서비스 실패");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
