// 마트 주간 전단 이미지 수집 → mart-flyer/leaflets.json (+ 하나로 이미지 재호스팅)
//
// 4개 마트지만 스크래퍼는 사실상 2종류다:
//   ① html/catalog  — URL 열어서 이미지 URL 뽑기. 어댑터 테이블 몇 줄이면 끝난다.
//   ② hanaro        — 세션쿠키 + 게시판 + 다운로드 + 리사이즈 + 재호스팅. 유일한 특수 케이스.
// 마트가 늘어도 대부분 ①이라 ADAPTERS 에 항목만 추가하면 된다.
//
// Usage:
//   node scripts/fetch-mart-flyer.mjs             # 전체
//   node scripts/fetch-mart-flyer.mjs emart       # 특정 마트만
//
// ⚠️ 하나로 이미지 리사이즈에 macOS `sips` 를 쓴다(의존성 0). 로컬 실행 전용이다 —
//    어차피 하나로는 세션쿠키가 필요해 해외 IP GitHub Actions 로는 불안정하다.

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../mart-flyer");
const IMG_DIR = path.join(OUT_DIR, "img");

const UA_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const ONLY = process.argv[2]
  ? new Set(process.argv[2].split(",").map((s) => s.trim()))
  : null;

// ── 지역은 시도 단위로 묶는다 ────────────────────────────────────
// 점포 단위로 두면 "부산 동래/문현/덕천/마리나/남천"이 각각 칩이 돼 너무 잘다.
// 시도로 묶으면 칩이 줄고, 위치로 "내 지역"을 찾을 때도 훨씬 잘 걸린다.
const REGIONS = [
  { id: "national", name: "전국" },
  { id: "seoul", name: "서울" },
  { id: "gyeonggi", name: "경기" },
  { id: "incheon", name: "인천" },
  { id: "busan", name: "부산" },
  { id: "daegu", name: "대구" },
  { id: "gwangju", name: "광주" },
  { id: "daejeon", name: "대전" },
  { id: "ulsan", name: "울산" },
  { id: "sejong", name: "세종" },
  { id: "gangwon", name: "강원" },
  { id: "chungbuk", name: "충북" },
  { id: "chungnam", name: "충남" },
  { id: "jeonbuk", name: "전북" },
  { id: "jeonnam", name: "전남" },
  { id: "gyeongbuk", name: "경북" },
  { id: "gyeongnam", name: "경남" },
  { id: "jeju", name: "제주" },
];

/**
 * 주소 앞머리 → 시도 region id.
 * 표기가 제각각이라(서울특별시/서울시/서울, 경기도/경기, 충청북도/충북) 앞 두 글자로 맞춘다.
 */
const SIDO_PREFIX = {
  서울: "seoul", 경기: "gyeonggi", 인천: "incheon", 부산: "busan",
  대구: "daegu", 광주: "gwangju", 대전: "daejeon", 울산: "ulsan",
  세종: "sejong", 강원: "gangwon", 충북: "chungbuk", 충청: null, // 충청남/북은 3글자로 구분
  전북: "jeonbuk", 전남: "jeonnam", 전라: null,
  경북: "gyeongbuk", 경남: "gyeongnam", 경상: null,
  제주: "jeju",
};
function regionFromAddr(addr) {
  const head = (addr || "").trim().split(/\s+/)[0] || "";
  if (head.startsWith("충청남") || head.startsWith("충남")) return "chungnam";
  if (head.startsWith("충청북") || head.startsWith("충북")) return "chungbuk";
  if (head.startsWith("전라남") || head.startsWith("전남")) return "jeonnam";
  if (head.startsWith("전라북") || head.startsWith("전북")) return "jeonbuk";
  if (head.startsWith("경상남") || head.startsWith("경남")) return "gyeongnam";
  if (head.startsWith("경상북") || head.startsWith("경북")) return "gyeongbuk";
  return SIDO_PREFIX[head.slice(0, 2)] ?? null;
}

// 점포 사전 — 시도 분류 + 좌표.
// 좌표는 대략값이다. 지오코딩 API 없이 손으로 박는다 — 가장 가까운 점포를 고르는
// 데만 쓰므로 동 단위면 충분하다.
// `match` 를 따로 두는 이유: "우만점"(수원)처럼 점포명과 지역명이 다르다.
const STORES = [
  // 서울
  { match: ["창동"], region: "seoul", lat: 37.653, lng: 127.048 },
  { match: ["양재"], region: "seoul", lat: 37.484, lng: 127.034 },
  { match: ["월계"], region: "seoul", lat: 37.632, lng: 127.058 },
  { match: ["양평"], region: "seoul", lat: 37.526, lng: 126.891 }, // 영등포 양평동
  { match: ["방이"], region: "seoul", lat: 37.512, lng: 127.115 },
  // 경기
  { match: ["수원", "우만"], region: "gyeonggi", lat: 37.264, lng: 127.029 },
  { match: ["하남"], region: "gyeonggi", lat: 37.539, lng: 127.215 },
  { match: ["고양"], region: "gyeonggi", lat: 37.658, lng: 126.832 },
  { match: ["평촌"], region: "gyeonggi", lat: 37.390, lng: 126.950 }, // 안양
  { match: ["서울역"], region: "seoul", lat: 37.556, lng: 126.972 },
  // 부산
  { match: ["부산"], region: "busan", lat: 35.18, lng: 129.075 },
  { match: ["동래"], region: "busan", lat: 35.205, lng: 129.084 },
  { match: ["남천"], region: "busan", lat: 35.137, lng: 129.104 },
  { match: ["문현"], region: "busan", lat: 35.137, lng: 129.07 },
  { match: ["덕천"], region: "busan", lat: 35.211, lng: 128.991 },
  { match: ["마리나"], region: "busan", lat: 35.163, lng: 129.163 },
  { match: ["기장"], region: "busan", lat: 35.244, lng: 129.222 },
  // 울산
  { match: ["울산"], region: "ulsan", lat: 35.538, lng: 129.311 },
  { match: ["언양"], region: "ulsan", lat: 35.567, lng: 129.113 }, // 울주군
  // 경남 / 경북
  { match: ["김해"], region: "gyeongnam", lat: 35.234, lng: 128.889 },
  { match: ["덕계"], region: "gyeongnam", lat: 35.416, lng: 129.135 }, // 양산
  { match: ["외동"], region: "gyeongbuk", lat: 35.783, lng: 129.257 }, // 경주
  // 충청 / 호남
  { match: ["대전"], region: "daejeon", lat: 36.351, lng: 127.385 },
  { match: ["청주"], region: "chungbuk", lat: 36.642, lng: 127.489 },
  { match: ["천안"], region: "chungnam", lat: 36.815, lng: 127.114 },
  { match: ["아산"], region: "chungnam", lat: 36.79, lng: 127.002 },
  { match: ["전주"], region: "jeonbuk", lat: 35.824, lng: 127.148 },
];

/** 점포명 → 점포 레코드(시도·좌표). 못 찾으면 null. */
function storeOf(storeName) {
  const s = storeName || "";
  return STORES.find((t) => t.match.some((m) => s.includes(m))) ?? null;
}
function regionOf(storeName) {
  return storeOf(storeName)?.region ?? null;
}

// ── ① HTML/카탈로그 어댑터 ───────────────────────────────────────
const ADAPTERS = {
  emart: {
    label: "이마트",
    type: "html",
    url: "https://eapp.emart.com/leaflet/leafletView_EL.do",
    // stimg.emart.com/upload/news_leaflet/…jpg — CORS 열려 있어 원본 URL 그대로 쓴다
    re: /https:\/\/stimg\.emart\.com\/upload\/news_leaflet\/[^"']+\.jpg/g,
    store: "이마트",
    region: "national",
    grade: "national",
  },
  traders: {
    label: "트레이더스",
    type: "html",
    url: "https://eapp.emart.com/tradersclub/flyerImgView.do",
    re: /https:\/\/eapp-cdn\.emart\.com\/traders\/banners\/[0-9a-f-]+\.jpg/g,
    store: "트레이더스",
    region: "national",
    grade: "base",
    // ⚠️ "가격은 트레이더스 홀세일 클럽 수원점 기준 가격입니다"는 **가격 기준**이지
    //    적용 범위가 아니다. 전단 이미지에는 "전점(24개점) 행사", "22개점 행사"라고
    //    따로 인쇄돼 있어 대부분이 전국 행사다.
    //    한때 이걸 권역으로 읽어 "경기 전단"으로 분류했는데 틀린 분류였다.
    //    범위 문구(SCOPE)와 가격기준(PRICE)은 HTML 안에서 순서·개수가 일정하지 않아
    //    장별 범위를 신뢰성 있게 판정할 수 없다 → 전국으로 두고 가격 기준만 표기한다.
    priceBasisRe: /홀세일\s*클럽\s*([가-힣,]+점)/,
  },
  homeplus: {
    label: "홈플러스",
    type: "homeplus",
    // ⚠️ `mfront.homeplus.co.kr/leaflet` 은 **상품 목록**이고 전단 이미지가 없다.
    //    종이전단은 `my.homeplus.co.kr`(마이홈플러스)에 있다. 도메인이 다르다.
    //
    // 매장 API 가 전단보다 값지다 — 389곳의 **휴무일·영업시간·주소·좌표·전화**가 다 나온다.
    // (공공데이터 「대규모점포」를 찾을 필요가 없었다. 당사자가 이미 공개하고 있다.)
    storeApi: "https://my.homeplus.co.kr/store/get_list",
    storeBody:
      "viewHomeplus=H&viewExpress=E&viewPlus=P&viewSpecial=S&draw=1&pageSize=500&sortFlag=N&searchRegion=&locatePage=N&searchStoreNm=",
    leafletUrl: (storId) => `https://my.homeplus.co.kr/leaflet?storId=${storId}`,
    re: /https:\/\/mres\.my\.homeplus\.co\.kr\/files\/leaflet_thema\/[^"']+\.jpg/g,
    store: "홈플러스",
    grade: "exact",
    sourceUrl: "https://my.homeplus.co.kr/leaflet",
    // 매장 구분 코드 → 표시명
    divNm: { H: "홈플러스", E: "홈플러스 익스프레스", S: "홈플러스 스페셜", P: "홈플러스 플러스" },
  },
  emartSeason: {
    label: "이마트 명절",
    type: "html",
    // 명절 선물세트 카탈로그. 주간 전단과 **다른 축**이다 —
    // 주간은 매주 파일이 바뀌지만(20260831) 이건 한 번 올려 6주를 간다(20260722).
    // 그래서 기간을 weekPeriod() 로 계산하면 "이번주 전단"이라고 거짓말이 된다.
    // 페이지에 인쇄된 기간(08.06 (목) - 09.16 (수))을 그대로 읽는다.
    url: "https://store.emart.com/news/leaflet.do?division=6",
    re: /https:\/\/stimg\.emart\.com\/upload\/news_leaflet\/[^"']+\.jpg/g,
    periodRe: /(\d{2})\.(\d{2})\s*\([월화수목금토일]\)\s*[-~]\s*(\d{2})\.(\d{2})\s*\([월화수목금토일]\)/,
    // ⚠️ **데스크톱 UA 필수.** 모바일 UA 면 eapp.emart.com/webapp/product/flyer 로
    //    리다이렉트돼 이미지가 0장이 된다.
    ua: UA_DESKTOP,
    store: "이마트 명절 선물세트",
    mart: "emart",
    season: true,
    region: "national",
    grade: "national",
  },
  costco: {
    label: "코스트코",
    type: "costco",
    // 쿠폰북(MVM) 페이지 ID 는 회계기간마다 바뀐다(FY27P1MVM → FY27P2MVM …).
    // /events 페이지 JSON 안에 현재 ID 가 들어있어 2단계로 추적한다.
    eventsUrl:
      "https://www.costco.co.kr/rest/v3/korea/cms/pages?pageType=ContentPage&pageLabelOrId=events&lang=ko&curr=KRW",
    pageUrl: (id) =>
      `https://www.costco.co.kr/rest/v3/korea/cms/pages?pageType=ContentPage&pageLabelOrId=${id}&lang=ko&curr=KRW`,
    store: "코스트코",
    region: "national",
    grade: "national",
  },
  lotte: {
    label: "롯데마트",
    type: "lotte",
    // mlotte.net("롯데마트 롯데슈퍼 전단")의 백엔드. **POST + 전용 헤더**가 필요하다.
    //   x-ssp-channel: 1 / x-ssp-gateway-service-id: PRODUCT / Referer: mlotte.net
    // GET 으로 때리면 404 "잘못된 접속 시도를 했습니다".
    api: "https://www.lottemartgo.com/apis/fo/product/leaflet",
    store: "롯데마트",
    grade: "exact",
    sourceUrl: "https://www.mlotte.net/",
  },
  nobrand: {
    label: "노브랜드",
    type: "nobrand",
    // 이마트 챗봇 도메인에 전단 페이지가 있다. JSON API 를 못 찾아 렌더 후 DOM 에서 뽑는다.
    // 이미지는 CloudFront, 파일명이 한글이라 URL 추측이 불가능하다.
    url: "https://chatbot.emart.com/flyers",
    store: "노브랜드",
    region: "national",
    grade: "national",
  },
  megamart: {
    label: "메가마트",
    type: "catalog",
    // 지점 사전과 카탈로그 목록이 통째로 들어있는 메타 파일(EUC-KR).
    //   0100000000|AF000|동래점|              ← 앞 2자리가 지점코드
    //   016F000000|AFC00|2026.09.02|3285      ← 지점코드 + 발행일 + 카탈로그 ID
    // ID 를 무작정 훑는 것보다 정확하고(지점명·날짜가 나온다) 요청도 훨씬 적다.
    meta: "https://ebook.megamart.com/ebook2/catImage/catakind.txt",
    base: "https://ebook.megamart.com/ebook2/catImage",
    maxPages: 8,
    store: "메가마트",
    grade: "exact",
    sourceUrl: "https://ebook.megamart.com/ebook2/ecatalog5.jsp?Cate=0100000000",
  },
};

// ── 공용 fetch ───────────────────────────────────────────────────
async function getText(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

async function head(url, headers = {}) {
  return fetch(url, { method: "HEAD", headers: { "User-Agent": UA, ...headers } });
}

/**
 * 전단면이 아닌 이미지(표지·배너·상시 안내)를 걸러낸다.
 *
 * 이마트 실측(2026-09-03): 첫 장이 70,733B 인데 나머지 10장은 1.19~1.57MB 다.
 * 전단면은 인쇄물 스캔이라 크기가 비슷한 무리를 이루고, 표지·배너는 확연히 작다.
 * "첫 장 제외"로 하드코딩하면 다음 주에 표지가 없거나 두 장일 때 조용히 틀려지므로
 * **크기 분포로 판별한다.** 중앙값의 30% 미만이면 전단면이 아니다.
 */
async function keepLeafletPages(urls, label) {
  if (urls.length < 3) return urls; // 표본이 적으면 판단하지 않는다
  const sized = [];
  for (const u of urls) {
    const r = await head(u);
    sized.push({ u, len: r.ok ? Number(r.headers.get("content-length") || 0) : 0 });
  }
  const lens = sized.map((x) => x.len).filter(Boolean).sort((a, b) => a - b);
  if (!lens.length) return urls;
  const median = lens[Math.floor(lens.length / 2)];
  const cut = median * 0.3;
  const kept = sized.filter((x) => x.len >= cut);
  const dropped = sized.filter((x) => x.len < cut);
  if (dropped.length) {
    console.log(
      `  · ${label}: 표지·배너 ${dropped.length}장 제외 (${dropped
        .map((d) => `${Math.round(d.len / 1024)}KB`)
        .join(", ")} < 중앙값 ${Math.round(median / 1024)}KB)`
    );
  }
  return kept.length ? kept.map((x) => x.u) : urls;
}

/** 점포명으로 지역·좌표를 붙인다. 좌표는 앱이 "내 지역"을 찾을 때 쓴다. */
function withStore(base, storeName) {
  const t = storeOf(storeName);
  return { ...base, region: t?.region ?? null, coords: t ? { lat: t.lat, lng: t.lng } : null };
}

// ── ① html 어댑터 실행 ───────────────────────────────────────────
async function runHtml(key, a) {
  const html = await getText(a.url, a.ua ? { "User-Agent": a.ua } : {});
  const found = [...new Set(html.match(a.re) || [])];
  if (!found.length) throw new Error("이미지 URL 0개 — 페이지 구조가 바뀌었을 수 있다");
  const pages = await keepLeafletPages(found, a.label);

  return [
    {
      id: `${key}-${weekTag()}`,
      mart: a.mart ?? key, // 명절 카탈로그는 브랜드가 같고 성격만 다르다
      store: a.store,
      ...(a.season ? { season: true } : {}),
      region: a.region ?? null,
      coords: null, // 전국 전단은 좌표가 없다
      ...(a.priceBasisRe
        ? { priceBasis: html.match(a.priceBasisRe)?.[1] ?? null }
        : {}),
      regionGrade: a.grade,
      period: a.periodRe ? periodFromPage(html, a.periodRe) : weekPeriod(),
      pages,
      sourceUrl: a.sourceUrl ?? a.url,
    },
  ];
}

/** 페이지에 인쇄된 "08.06 (목) - 09.16 (수)" 를 ISO 기간으로. 못 읽으면 주간으로 폴백. */
function periodFromPage(html, re) {
  // ⚠️ &nbsp; 를 먼저 풀어야 한다. 페이지에 "08.06&nbsp;(목)" 로 들어있어
  //    \s* 로는 안 잡힌다.
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/\s+/g, " ");
  const m = text.match(re);
  if (!m) return weekPeriod();
  const y = Number(todayKST().slice(0, 4));
  const start = `${y}-${m[1]}-${m[2]}`;
  const end = `${m[3]}${m[4]}` < `${m[1]}${m[2]}` ? `${y + 1}-${m[3]}-${m[4]}` : `${y}-${m[3]}-${m[4]}`;
  return { start, end };
}

// ── ① catalog 어댑터 실행 ────────────────────────────────────────
async function runCatalog(key, a) {
  // catakind.txt 는 EUC-KR 이다. UTF-8 로 읽으면 지점명이 전부 깨진다.
  const res = await fetch(a.meta, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`메타 HTTP ${res.status}`);
  const text = new TextDecoder("euc-kr").decode(await res.arrayBuffer());

  const stores = new Map(); // 지점코드(2자) → 지점명
  const issues = []; // { code, date, catId }
  for (const line of text.split("\n")) {
    const c = line.trim().split("|");
    if (c.length < 3) continue;
    // 지점 정의: 0100000000|AF000|동래점|
    if (/^[0-9A-Z]{2}00000000$/.test(c[0]) && /점$/.test(c[2])) {
      stores.set(c[0].slice(0, 2), c[2]);
    }
    // 발행분: 016F000000|AFC00|2026.09.02|3285
    else if (c.length >= 4 && /^\d{4}\.\d{2}\.\d{2}$/.test(c[2]) && /^\d+$/.test(c[3])) {
      issues.push({ code: c[0].slice(0, 2), date: c[2].replace(/\./g, "-"), catId: c[3] });
    }
  }
  if (!issues.length) throw new Error("발행분 0건 — catakind.txt 형식 변경 의심");

  // 지점별 최신 1건만. 지난 주차가 섞여 들어오면 안 된다.
  const latest = new Map();
  for (const it of issues) {
    const prev = latest.get(it.code);
    if (!prev || it.date > prev.date || (it.date === prev.date && +it.catId > +prev.catId)) {
      latest.set(it.code, it);
    }
  }
  // 가장 최근 발행일 기준으로 오래된 지점은 버린다(전단이 안 올라온 지점).
  const newest = [...latest.values()].reduce((m, i) => (i.date > m ? i.date : m), "");

  // ⚠️ 메가마트는 지점마다 카탈로그가 따로 있지만 **내용은 대부분 같다**.
  //    2026-09-03 실측: 2·3면이 10개 지점 전부 바이트 단위로 동일(777,243B / 798,942B),
  //    1면은 지점명 때문에 미세하게 다르고, 4면은 3개 지점에만 있으며 각자 다르다.
  //
  //    이걸 하드코딩하면 다음 주에 구조가 바뀌었을 때 조용히 틀려진다.
  //    → **매번 Content-Length 로 재서** 공통면과 지점 전용면을 판별한다.
  //    다른 마트도 같은 일이 생길 수 있으니 판별 결과를 로그로 남긴다.
  const issued = [...latest.values()].filter((it) => it.date >= newest && stores.get(it.code));
  if (!issued.length) throw new Error("이번 주차 카탈로그 0건");

  const pageUrl = (catId, n) => `${a.base}/${catId}/s${String(n).padStart(3, "0")}.jpg`;

  // 지점별 면 크기 수집
  const sizeMap = new Map(); // catId → [{n, url, len}]
  for (const it of issued) {
    const list = [];
    for (let n = 1; n <= a.maxPages; n++) {
      const r = await head(pageUrl(it.catId, n));
      if (!r.ok) break;
      list.push({ n, url: pageUrl(it.catId, n), len: Number(r.headers.get("content-length") || 0) });
    }
    sizeMap.set(it.catId, list);
  }

  // 면 번호별로 모든 지점의 크기가 같으면 '공통면'
  const maxN = Math.max(...[...sizeMap.values()].map((l) => l.length));
  const commonNs = new Set();
  for (let n = 1; n <= maxN; n++) {
    const lens = [...sizeMap.values()].map((l) => l.find((x) => x.n === n)?.len ?? null);
    if (lens.some((v) => v == null)) continue; // 일부 지점에만 있는 면은 지점 전용
    if (new Set(lens).size === 1) commonNs.add(n);
  }
  console.log(
    `  · 지점 ${issued.length}곳 / 공통면 [${[...commonNs].join(",") || "없음"}] · 나머지는 지점별`
  );

  const rep = issued[0];
  const common = sizeMap.get(rep.catId).filter((x) => commonNs.has(x.n)).map((x) => x.url);

  const storeList = [];
  const regionSet = new Set();
  for (const it of issued) {
    const name = stores.get(it.code);
    const t = storeOf(name);
    const own = sizeMap.get(it.catId).filter((x) => !commonNs.has(x.n));
    storeList.push({
      name: `${a.store} ${name}`,
      region: t?.region ?? null,
      coords: t ? { lat: t.lat, lng: t.lng } : null,
      // 공통면 앞에 오는 지점 전용면(1면 표지)과 뒤에 오는 것(4면~)을 나눈다
      cover: own.find((x) => x.n < Math.min(...commonNs, Infinity))?.url ?? null,
      extras: own.filter((x) => x.n > Math.max(...commonNs, 0)).map((x) => x.url),
    });
    if (t?.region) regionSet.add(t.region);
  }

  const out = [
    {
      id: `${key}-${rep.date.replace(/-/g, "")}`,
      mart: key,
      store: a.store,
      region: null, // 전국이 아니다 — 아래 regions 에 있는 지역에서만 유효
      regions: [...regionSet],
      coords: null,
      regionGrade: a.grade,
      // 지점을 고르면 [cover, ...pages, ...extras] 로 조립한다.
      pages: common,
      stores: storeList,
      period: { start: rep.date, end: weekPeriod().end },
      sourceUrl: a.sourceUrl,
    },
  ];
  if (!out.length) throw new Error("살아있는 카탈로그 0개");
  return out;
}

// ── ① costco 어댑터 실행 ─────────────────────────────────────────
async function runCostco(key, a) {
  const events = await getText(a.eventsUrl);
  const id = events.match(/FY\d+P\d+MVM/)?.[0];
  if (!id) throw new Error("현재 MVM 페이지 ID 를 못 찾았다 — /events 구조 변경 의심");

  const page = await getText(a.pageUrl(id));
  // 쿠폰북은 큰 이미지 한 장이다(1.5MB). 로고를 빼고 고른다.
  const imgs = [
    ...new Set(page.match(/https?:\/\/[^"\\ ]+?\.(?:jpg|jpeg|png)/g) || []),
  ].filter((u) => !/logo/i.test(u));
  if (!imgs.length) throw new Error(`${id} 에 쿠폰 이미지가 없다`);

  console.log(`  · ${id} · ${imgs.length}장`);
  return [
    {
      id: `${key}-${id}`,
      mart: key,
      store: a.store,
      region: a.region,
      coords: null,
      regionGrade: a.grade,
      period: weekPeriod(),
      pages: imgs,
      sourceUrl: `https://www.costco.co.kr/${id}`,
    },
  ];
}

// ── ① 홈플러스 어댑터 실행 ───────────────────────────────────────
// 389개 매장을 전수 스캔해 **전단 종류별로** 묶는다(7초, 병렬 10).
// 실측: 마트(H)는 1종 공통, 익스프레스(E)는 2종. 매장마다 다른 게 아니다.
// 종류 수를 하드코딩하지 않는다 — 다음 주에 늘어도 그대로 굴러가야 한다.
async function runHomeplus(key, a) {
  const res = await fetch(a.storeApi, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Referer: "https://my.homeplus.co.kr/store",
    },
    body: a.storeBody,
  });
  const stores = (await res.json())?.data || [];
  if (!stores.length) throw new Error("매장 0곳 — store/get_list 응답 변경 의심");

  // 매장별 전단 이미지 세트 수집 (병렬 10)
  const scan = async (st) => {
    try {
      const html = await getText(a.leafletUrl(st.storId));
      const imgs = [...new Set(html.match(a.re) || [])].sort();
      return { st, imgs };
    } catch {
      return { st, imgs: [] };
    }
  };
  const scanned = [];
  for (let i = 0; i < stores.length; i += 10) {
    scanned.push(...(await Promise.all(stores.slice(i, i + 10).map(scan))));
  }

  // 같은 이미지 세트끼리 묶는다
  const groups = new Map();
  let empty = 0;
  for (const { st, imgs } of scanned) {
    if (!imgs.length) { empty++; continue; }
    const sig = imgs.join("|");
    if (!groups.has(sig)) groups.set(sig, { pages: imgs, stores: [] });
    groups.get(sig).stores.push(st);
  }
  console.log(
    `  · 매장 ${stores.length}곳 → 전단 ${groups.size}종 (전단없음 ${empty}곳)`
  );
  if (!groups.size) throw new Error("전단 0종");

  const out = [];
  for (const [, g] of [...groups.entries()].sort((x, y) => y[1].stores.length - x[1].stores.length)) {
    const divs = [...new Set(g.stores.map((s) => s.storDivCd))];
    const label = divs.length === 1 ? a.divNm[divs[0]] || a.store : a.store;
    const regions = [...new Set(g.stores.map((s) => regionFromAddr(s.storAddr)).filter(Boolean))];
    const pages = await keepLeafletPages(g.pages, label);
    out.push({
      id: `${key}-${weekTag()}-${g.stores[0].storId}`,
      mart: key,
      store: label,
      region: null,
      regions,
      coords: null,
      regionGrade: a.grade,
      period: weekPeriod(),
      pages,
      sourceUrl: a.sourceUrl,
      // 매장 정보 — 휴무일·영업시간이 전단만큼 값지다
      stores: g.stores.map((s) => ({
        name: `${a.divNm[s.storDivCd] || a.store} ${s.storKorNm}`,
        region: regionFromAddr(s.storAddr),
        coords: { lat: Number(s.storLat), lng: Number(s.storLon) },
        addr: s.storAddr,
        hours: (s.storSlesTime || "").trim() || null,
        dayoff: s.storDayoffCntt || null,
        tel: s.storTphnNo || null,
      })),
    });
    console.log(`    ${label} ${pages.length}장 · ${g.stores.length}곳 · ${regions.length}개 시도`);
  }
  return out;
}

// ── ① 노브랜드 어댑터 실행 (Playwright) ──────────────────────────
async function runNobrand(key, a) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(a.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(6000);
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 2200);
      await page.waitForTimeout(800);
    }
    // 전단 원본만. 작은 배지·상시 이미지는 폭으로 걸러낸다.
    const pages = await page.evaluate(() =>
      [...document.querySelectorAll("img")]
        .filter((i) => i.naturalWidth > 1500)
        .map((i) => i.currentSrc || i.src)
    );
    if (!pages.length) throw new Error("전단 이미지 0장 — 페이지 구조 변경 의심");
    console.log(`  · ${pages.length}장`);
    return [
      {
        id: `${key}-${weekTag()}`,
        mart: key,
        store: a.store,
        region: a.region,
        coords: null,
        regionGrade: a.grade,
        period: weekPeriod(),
        pages: [...new Set(pages)],
        sourceUrl: a.url,
      },
    ];
  } finally {
    await browser.close();
  }
}

// ── ① 롯데 어댑터 실행 ───────────────────────────────────────────
async function runLotte(key, a) {
  const post = async (path, body = {}) => {
    const res = await fetch(`${a.api}/${path}`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json; charset=UTF-8",
        "x-ssp-channel": "1",
        "x-ssp-gateway-service-id": "PRODUCT",
        Referer: "https://www.mlotte.net/",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
    return res.json();
  };

  // ⚠️ 웹으로는 **대표 전단 1건**이 한계다. 더 파지 말 것 (2026-09-03 전수 확인).
  //    · plate/select 는 파라미터를 통째로 무시한다 — plate_leaflet_id / leaflet_menu_id /
  //      id / str_type / str_grp_cd 5종을 넣어도 항상 같은 대표 1건이 온다.
  //    · 다른 엔드포인트(detail·page·img·list select)는 "등록된 API가 아닙니다".
  //    · menu/select 의 7개 항목은 전부 **배너 썸네일**(29~59KB)이고 전단면(1MB급)이 아니다.
  //    · mlotte.net 상단 4종 배너(HYPER/ZETTA/MAXX/SUPER)는 <li><img> 뿐으로 클릭 핸들러가 없다.
  //    mlotte.net 은 "롯데마트GO에서 더 많은 혜택을" 배너가 붙은 **앱 유도용 랜딩**이고,
  //    4종 본전단은 앱 전용이다. 남은 길은 앱 트래픽 캡처뿐인데 주 1회 자동갱신에 안 맞는다.
  const plate = await post("plate/select");
  const list = plate?.data?.plate_leaflet_list || [];
  if (!list.length) throw new Error("대표 전단 0건");

  const out = [];
  for (const it of list) {
    const pages = (it.leaflet_img_list || []).map((x) => x.img_url).filter(Boolean);
    if (!pages.length) continue;
    // 이름 예: "20260903-20260909_[통큰]평촌"
    const storeName = it.plate_leaflet_nm?.split("]").pop()?.trim() || "";
    out.push(
      withStore(
        {
          id: `${key}-${it.plate_leaflet_id}`,
          mart: key,
          store: storeName ? `${a.store} ${storeName}점` : a.store,
          regionGrade: a.grade,
          period: {
            start: (it.post_start_dt || "").slice(0, 10),
            end: (it.post_end_dt || "").slice(0, 10),
          },
          pages,
          sourceUrl: a.sourceUrl,
        },
        storeName
      )
    );
    console.log(`  · ${it.plate_leaflet_nm?.slice(0, 34)} ${pages.length}장`);
  }
  if (!out.length) throw new Error("이미지 있는 전단 0건");
  return out;
}

// ── ② 하나로 — 유일한 특수 케이스 ────────────────────────────────
// 세션쿠키 없이는 목록이 302 무한루프에 빠진다(.do JSP 사이트의 전형).
// 이미지도 쿠키+Referer 가 있어야 열려서, 받아서 줄여 재호스팅해야 한다.
const HANARO = {
  origin: "https://www.nhhanaro.co.kr",
  list: "/user/boardList.do?handle=61&siteId=nahh001&id=nahh001_020200000000",
  view: (seq) =>
    `/user/boardList.do?command=view&siteId=nahh001&boardId=61&boardSeq=${seq}&id=nahh001_020200000000`,
};

async function runHanaro() {
  // 1) 세션쿠키 획득.
  //    ⚠️ redirect:"follow" 로 두면 쿠키를 안 물고 따라가 302 루프에 빠진다
  //    ("redirect count exceeded"). 첫 응답만 받아 Set-Cookie 를 꺼낸다.
  const cookie = await getSessionCookie(HANARO.origin + "/");
  if (!cookie) throw new Error("세션 쿠키를 못 받았다");
  const H = { Cookie: cookie, Referer: HANARO.origin + "/" };

  // 2) 게시판 목록 — 제목에 점포·기간이 그대로 있다
  //    예: "하나로마트 청주점 전단행사(0827~0909)"
  const listHtml = await getText(HANARO.origin + HANARO.list, H);
  const posts = [];
  const re = /boardSeq=(\d+)[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of listHtml.matchAll(re)) {
    const title = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!title.includes("전단행사") || title.includes("[종료]")) continue;
    const store = title.match(/하나로마트\s*([가-힣]+점)/)?.[1];
    const span = title.match(/\((\d{4})\s*~?\s*(\d{4})\)/);
    if (!store) continue;
    if (posts.some((p) => p.store === store)) continue; // 점포당 최신 1건
    posts.push({ seq: m[1], store, span });
  }
  if (!posts.length) throw new Error("전단 게시물 0건 — 게시판 구조 변경 의심");

  const out = [];
  for (const post of posts) {
    const viewUrl = HANARO.origin + HANARO.view(post.seq);
    const html = await getText(viewUrl, H);
    const imgs = [...new Set(html.match(/\/user\/nahh001\/k2board\/61\/[^"']+_b_img\.jpg/g) || [])];
    if (!imgs.length) {
      console.log(`  · ${post.store} 이미지 0개 — 건너뜀`);
      continue;
    }

    const pages = [];
    for (const [i, rel] of imgs.entries()) {
      const name = `hanaro-${regionOf(post.store) || post.store}-${weekTag()}-${i + 1}.jpg`;
      const dest = path.join(IMG_DIR, name);
      const ok = await downloadResize(HANARO.origin + rel, dest, { ...H, Referer: viewUrl });
      if (ok) pages.push(name); // 파일명만 — 앱이 IMG_BASE 를 붙인다
    }
    if (!pages.length) continue;

    out.push(
      withStore(
        {
          id: `hanaro-${post.seq}`,
          mart: "hanaro",
          store: `하나로마트 ${post.store}`,
          regionGrade: "exact",
          period: post.span ? mmddPeriod(post.span[1], post.span[2]) : weekPeriod(),
          pages,
          hosted: true, // 허브 재호스팅분
          sourceUrl: HANARO.origin + HANARO.list,
        },
        post.store
      )
    );
    console.log(`  · ${post.store} ${pages.length}장`);
  }
  return out;
}

/**
 * 302 를 수동으로 따라가며 Set-Cookie 를 모은다.
 * `.do` JSP 사이트는 첫 요청에서 세션을 발급하고 리다이렉트하는데, 쿠키를 안 물고
 * 따라가면 무한히 같은 자리를 돈다.
 */
async function getSessionCookie(url, maxHops = 5) {
  const jar = new Map();
  let next = url;
  for (let i = 0; i < maxHops && next; i++) {
    const res = await fetch(next, {
      headers: {
        "User-Agent": UA,
        ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
      },
      redirect: "manual",
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
    if (res.status < 300 || res.status >= 400) break;
    const loc = res.headers.get("location");
    if (!loc) break;
    next = new URL(loc, next).href;
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** 원본을 받아 폭 1080 으로 줄여 저장. 2.3MB → 약 360KB. */
async function downloadResize(url, dest, headers) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = dest + ".orig";
    await fs.writeFile(tmp, buf);
    // macOS 내장 sips — 의존성 0. webp 출력은 지원 안 해 JPEG 로 둔다.
    await execFileP("sips", ["-Z", "1080", tmp, "--out", dest]);
    await fs.unlink(tmp);
    return true;
  } catch (e) {
    console.log(`    ! 이미지 실패 ${url.slice(-40)} — ${e.message.slice(0, 60)}`);
    return false;
  }
}

// ── 주차 유틸 ────────────────────────────────────────────────────
function todayKST() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
}
function weekTag() {
  return todayKST().replace(/-/g, "").slice(2, 8);
}
/** 이번 주 목요일~다음 수요일. 대형마트 전단 주기가 대체로 목요일 시작이다. */
function weekPeriod() {
  const d = new Date(todayKST() + "T00:00:00");
  const start = new Date(d);
  start.setDate(d.getDate() - ((d.getDay() + 3) % 7)); // 직전 목요일
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const f = (x) => x.toISOString().slice(0, 10);
  return { start: f(start), end: f(end) };
}
/** "0827","0909" → ISO 기간. 연말연시 넘어가는 경우 연도를 보정한다. */
function mmddPeriod(a, b) {
  const y = Number(todayKST().slice(0, 4));
  const mk = (s, yy) => `${yy}-${s.slice(0, 2)}-${s.slice(2, 4)}`;
  const start = mk(a, y);
  const end = mk(b, b < a ? y + 1 : y);
  return { start, end };
}

// ── main ─────────────────────────────────────────────────────────
async function main() {
  await fs.mkdir(IMG_DIR, { recursive: true });

  const tasks = [
    ["emart", () => runHtml("emart", ADAPTERS.emart)],
    ["homeplus", () => runHomeplus("homeplus", ADAPTERS.homeplus)],
    ["traders", () => runHtml("traders", ADAPTERS.traders)],
    ["emartSeason", () => runHtml("emartSeason", ADAPTERS.emartSeason)],
    ["costco", () => runCostco("costco", ADAPTERS.costco)],
    ["lotte", () => runLotte("lotte", ADAPTERS.lotte)],
    ["nobrand", () => runNobrand("nobrand", ADAPTERS.nobrand)],
    ["megamart", () => runCatalog("megamart", ADAPTERS.megamart)],
    ["hanaro", runHanaro],
  ].filter(([k]) => !ONLY || ONLY.has(k));

  // 실패한 마트는 건너뛰고 나머지를 살린다 — 한 곳 때문에 전체가 죽으면 안 된다.
  const leaflets = [];
  const failed = [];
  for (const [key, run] of tasks) {
    process.stdout.write(`▶ ${key}\n`);
    try {
      const got = await run();
      leaflets.push(...got);
      console.log(`  ✓ ${got.length}건, ${got.reduce((s, l) => s + l.pages.length, 0)}장`);
    } catch (e) {
      failed.push(`${key}: ${e.message}`);
      console.log(`  ✗ ${e.message}`);
    }
  }

  if (!leaflets.length) {
    console.error("\n전부 실패 — 기존 JSON 을 건드리지 않고 종료한다.");
    process.exit(1);
  }

  // 전역 중복 제거 — 같은 이미지가 두 전단에 들어가면 같은 걸 두 번 보여주게 된다.
  // (이마트 주간 vs 명절 카탈로그처럼 같은 CDN 경로를 쓰는 소스가 있다)
  const seenImg = new Set();
  let dupPages = 0;
  for (const l of leaflets) {
    const before = l.pages.length;
    l.pages = l.pages.filter((u) => !seenImg.has(u) && seenImg.add(u));
    dupPages += before - l.pages.length;
  }
  const emptied = leaflets.filter((l) => !l.pages.length).map((l) => l.store);
  if (dupPages) console.log(`\n· 중복 이미지 ${dupPages}장 제거`);
  if (emptied.length) console.log(`· 전부 중복이라 빠진 전단: ${emptied.join(", ")}`);
  const kept = leaflets.filter((l) => l.pages.length);
  leaflets.length = 0;
  leaflets.push(...kept);

  const out = {
    updatedAt: todayKST(),
    week: weekTag(),
    period: weekPeriod(),
    regions: REGIONS,
    leaflets,
    ...(failed.length ? { failed } : {}),
  };
  const dest = path.join(OUT_DIR, "leaflets.json");
  await fs.writeFile(dest, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `\n완료 — 전단 ${leaflets.length}건 / ${leaflets.reduce((s, l) => s + l.pages.length, 0)}장 → ${path.relative(process.cwd(), dest)}`
  );
  if (failed.length) console.log("실패:", failed.join(" | "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
