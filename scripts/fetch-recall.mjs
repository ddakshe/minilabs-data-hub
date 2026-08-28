/**
 * 소비자24 리콜정보 OpenAPI → recall-mini(리콜모아) 앱용 정적 JSON
 *
 * recall-mini 의 `scripts/fetch-fixtures.mjs`(개발용 픽스처 수집기)가 씨앗이다.
 * 정규화 로직은 거기서 그대로 옮겼고, 카테고리 전량 + 페이지네이션만 더했다.
 * **정규화 규칙을 여기서 바꾸면 앱의 `src/types.ts` 와 어긋난다.** 둘은 같은 계약이다.
 *
 * 출력
 *   recall/recalls.json  앱이 읽는 레코드 배열 (최신순)
 *   recall/meta.json     수집 시각·건수. 앱이 "기준일"을 표시하는 데 쓴다
 *
 * 키: `RECALL_API_KEYS` 하나에 JSON 맵. 카테고리마다 키가 달라 13개인데
 *     GitHub secret 을 13개 만드는 것보다 낫다.  {"0101":"...","0201":"...", ...}
 *
 *   node scripts/fetch-recall.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises';

const ENDPOINT = 'https://www.consumer.go.kr/openapi/recall/contents/index.do';

/**
 * MVP 대상 9개. 2026-08-15 실측 건수를 주석에 남긴다.
 *
 * 제외한 것들:
 *   위생용품 0208 (5건) · 축산물 0203 (1건) — 건수가 무의미하다
 *   먹는물   0403 (데이터없음 에러)
 *   해외리콜 0501 (98,969건) — 국내 리콜 앱의 범위를 벗어난다
 */
const CATEGORIES = [
  { id: '0101', name: '공산품' },            // 4,470
  { id: '0201', name: '식품' },              //   387
  { id: '0204', name: '의약품' },            //   479
  { id: '0205', name: '의약외품' },          //    88
  { id: '0206', name: '화장품' },            //    29
  { id: '0207', name: '의료기기' },          //   113
  { id: '0301', name: '자동차' },            //   602
  { id: '0401', name: '생활화학제품' },      // 6,722
  { id: '0405', name: '생활방사선제품' },    //    38
];

/**
 * API 기본 정렬이 최신순이라 전량 수집할 필요가 없다.
 * 생활화학 6,722 · 공산품 4,470 을 다 받으면 JSON 이 10MB 를 넘는데,
 * 앱은 최근 것만 보여주면 된다. 카테고리당 300건이면 가장 큰 카테고리도
 * 최근 수년치를 덮는다(생활화학 월 유입 3.6건 / 공산품 63건).
 */
const PER_PAGE = 100;
const MAX_PAGES = 3;

/*
 * ── 아래 정규화 블록은 recall-mini/scripts/fetch-fixtures.mjs 와 동일하다 ──
 */

/**
 * 원문 텍스트에서 HTML 태그를 걷어낸다.
 *
 * 자동차는 shrtcomCn 이 100% `<p>...</p>` 로 감싸여 오고, etcInfo 에도 섞여 있다.
 * 그대로 텍스트로 넣으면 `<p>` 가 화면에 보이고, innerHTML 로 넣으면 주입 경로가 된다.
 * → 태그만 제거하고 **문구 자체는 손대지 않는다** (원문 표시 원칙 / 재해석 금지).
 */
function stripTags(raw) {
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** `<태그><![CDATA[값]]></태그>` 와 `<태그>값</태그>` 를 모두 읽는다. */
function field(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) return '';
  const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return stripTags(cdata ? cdata[1] : m[1]);
}

/** 'YYYYMMDD' → 'YYYY.MM.DD'. 형식이 다르면 원문 그대로 둔다. */
function formatDate(yyyymmdd) {
  const m = yyyymmdd.match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : yyyymmdd || null;
}

function nullIfEmpty(v) {
  return v ? v : null;
}

/**
 * 레코드 1건 정규화.
 *
 * fallback 이 핵심이다 — 같은 의미가 카테고리마다 다른 필드에 들어간다.
 * 그래서 화면은 cntntsId 로 분기하지 않고, 여기서 채워진 필드만 보고 렌더한다.
 */
function normalize(block, cat) {
  const recallSe = field(block, 'recallSe');

  return {
    id: field(block, 'recallSn'),
    category: cat.name,

    productNm: field(block, 'productNm'),

    // makr 은 공산품·생활화학에서 0% 라 bsnmNm(업체명)이 받아준다.
    maker: nullIfEmpty(field(block, 'makr') || field(block, 'bsnmNm')),

    // shrtcomCn(결함) 과 injryCauseResult(원인) 은 서로 배타적으로 채워진다.
    // 둘 다 비는 레코드가 공산품에 31% 있다. 추측해 채우면 절대 안 된다.
    reason: nullIfEmpty(field(block, 'shrtcomCn') || field(block, 'injryCauseResult')),

    /*
     * 공통 날짜 필드가 없다. 식품은 공표일이 0% 라 날짜 없는 카드를 허용해야 한다.
     *
     * ⚠️ 두 필드는 **의미가 다르다** — `recallPublictBgnde` 는 정부가 리콜을 공표한 날이고
     * `recallBgnde` 는 회수가 시작된 날이다. fallback 으로 섞어놓고 숫자만 보여주면
     * 사용자는 그게 무슨 날짜인지 알 수 없다. 어느 쪽을 썼는지 같이 내보낸다.
     */
    ...(() => {
      const publict = field(block, 'recallPublictBgnde');
      const begin = field(block, 'recallBgnde');
      const raw = publict || begin;
      return {
        date: formatDate(raw),
        dateKind: raw ? (publict ? '공표' : '리콜시작') : null,
      };
    })(),

    // '기타' 는 식품·공산품·생활화학이 사실상 100% 라 정보량이 0 → 배지를 만들지 않는다.
    recallSe: recallSe === '기타' ? null : nullIfEmpty(recallSe),

    // 채움률을 결정하는 건 카테고리가 아니라 출처기관이다.
    // 원문 표시 원칙상 출처는 반드시 함께 노출한다.
    source: nullIfEmpty(field(block, 'infoOriginInstt')),
    sourceUrl: nullIfEmpty(field(block, 'infoOriginInsttUrl')),

    // ── "내가 산 그거 맞나?" 를 푸는 제품 식별 필드 ──
    ident: {
      model: nullIfEmpty(field(block, 'modlNmInfo')),
      barcode: nullIfEmpty(field(block, 'stdBrcd')),
      expiry: nullIfEmpty(field(block, 'distbTmlmtDe')),
      lotNo: nullIfEmpty(field(block, 'mnfcturNoInfo')),
      mfgPeriod: nullIfEmpty(field(block, 'mnfcturPd')),
      permitNo: nullIfEmpty(field(block, 'prmisnNo')),
    },

    // ── 상세화면 전용 ──
    tips: nullIfEmpty(field(block, 'cnsmrGhvrTips')),
    process: nullIfEmpty(field(block, 'recallProcssInfo')),
    contact: nullIfEmpty(field(block, 'recallEntrpsInfo')),

    // etcInfo 는 카테고리마다 의미가 완전히 다르다 (식품=품목코드 / 공산품=브랜드명+연락처 /
    // 자동차=조치내용). 공통 라벨을 붙일 수 없어 원문을 그대로 넘기고 화면에서 판단한다.
    etcInfo: nullIfEmpty(field(block, 'etcInfo')),

    // 콤마 구분 다중 URL. 원본이라 중앙값 208KB·최대 5.5MB 다.
    // 앱은 카드에 1장만 lazy load 한다 (디코딩 메모리 때문).
    images: field(block, 'recallImgUrls')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
  };

  // hrmflGrad(위해등급) 는 의도적으로 뺐다. 6개 카테고리가 0% 이고, 유일하게 채워지는
  // 의료기기의 값이 등급 숫자가 아니라 `시행규칙 제52조제2항제1호` 형태의 법조항 참조다.
  // 그대로 노출하면 무의미하고, "1등급 위해"로 번역하면 원문 재해석 = 법적 리스크.
}

/* ── 수집 ── */

function loadKeys() {
  const raw = process.env.RECALL_API_KEYS;
  if (!raw) throw new Error('RECALL_API_KEYS 가 비어 있다.');
  return JSON.parse(raw);
}

/**
 * 연결이 실패하면 잠시 쉬고 다시 시도한다.
 *
 * ⚠ AbortSignal.timeout 만으로는 부족하다. 실제로 죽은 방식은
 * `ConnectTimeoutError (attempted address: www.consumer.go.kr:443, timeout: 10000ms)` 였는데,
 * 이건 undici 의 **연결(connect) 타임아웃**이라 요청 전체에 거는 AbortSignal 이 닿지 않는다.
 * 소비자24가 간헐적으로 해외(Actions) IP 에 늦게 응답하는 것이라 재시도 말고 손쓸 방법이 없다.
 */
async function fetchRetry(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(30000) });
    } catch (e) {
      last = e;
      if (i === tries - 1) break;
      const wait = 2000 * 2 ** i; // 2s → 4s → 8s
      console.warn(`  ⚠ 연결 실패 (${e.cause?.code ?? e.name}) — ${wait / 1000}초 뒤 재시도 ${i + 2}/${tries}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

async function fetchPage(cat, key, page) {
  const url =
    `${ENDPOINT}?serviceKey=${key}&pageNo=${page}&cntPerPage=${PER_PAGE}&cntntsId=${cat.id}`;

  const res = await fetchRetry(url);
  if (!res.ok) throw new Error(`${cat.name} p${page}: HTTP ${res.status}`);

  const xml = await res.text();

  const code = xml.match(/<code>(\d+)<\/code>/)?.[1];
  if (code && code !== '00') {
    const msg = xml.match(/<codeMsg>([\s\S]*?)<\/codeMsg>/)?.[1]?.trim();
    throw new Error(`${cat.name} p${page}: code=${code} ${msg ?? ''}`);
  }

  return (xml.match(/<content>[\s\S]*?<\/content>/g) ?? []).map((b) => normalize(b, cat));
}

const keys = loadKeys();
const all = [];
const perCategory = {};

for (const cat of CATEGORIES) {
  const key = keys[cat.id];
  if (!key) throw new Error(`RECALL_API_KEYS 에 ${cat.id}(${cat.name}) 키가 없다.`);

  let got = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = await fetchPage(cat, key, page);
    all.push(...rows);
    got += rows.length;
    // 마지막 페이지면 그만. 빈 페이지를 계속 부를 이유가 없다
    if (rows.length < PER_PAGE) break;
  }

  perCategory[cat.name] = got;
  console.log(`${cat.name.padEnd(14)} ${String(got).padStart(4)}건`);
}

/*
 * ── 최신순 정렬 ──
 *
 * 날짜만으로는 정렬할 수 없다. 33% 가 날짜 없음이고, 식품·의료기기는 아예 0% 다.
 * 반대로 `recallSn`(등록 순서) 역순은 빈 값이 없지만, 카테고리를 섞으면 14% 가 역전된다.
 * 실측: 카테고리 **안에서는** 거의 정확하다.
 *
 * 그래서 두 신호를 합친다.
 *   1) id 역순으로 늘어놓는다 → 카테고리 안 순서가 보장된다
 *   2) 날짜 없는 레코드에 바로 위 레코드의 날짜를 **정렬용으로만** 물려준다
 *   3) 그 날짜로 다시 정렬해 카테고리 간 순서를 맞춘다
 *
 * ⚠️ 물려준 날짜는 출력에 절대 넣지 않는다. 추정 날짜를 표시하면 거짓말이 된다.
 *    `date` 는 원본이 비어 있으면 null 그대로 남는다.
 */
all.sort((a, b) => b.id.localeCompare(a.id));

let carry = all.find((r) => r.date)?.date ?? '0000.00.00';
for (const r of all) {
  if (r.date) carry = r.date;
  r._sortDate = carry;
}
all.sort((a, b) =>
  a._sortDate === b._sortDate
    ? b.id.localeCompare(a.id)
    : b._sortDate.localeCompare(a._sortDate),
);
for (const r of all) delete r._sortDate;

/* ── 출력 ── */

const outDir = new URL('../recall/', import.meta.url);
await mkdir(outDir, { recursive: true });

// 앱이 매번 내려받는 파일이라 사람이 읽을 들여쓰기를 넣지 않는다.
// 실측: 들여쓰기가 있으면 16% 커진다 (387건 기준 463KB → 400KB).
await writeFile(new URL('recalls.json', outDir), JSON.stringify(all) + '\n');

const meta = {
  // 앱이 "○○ 기준" 으로 표시한다. 수집 실패 시 옛 데이터를 보여주고 있음을 알 수 있다
  fetchedAt: new Date().toISOString(),
  total: all.length,
  perCategory,
  // 원문 표시 원칙 — 데이터가 어디서 왔는지 파일 자체에 남긴다
  source: '소비자24 리콜정보 OpenAPI (consumer.go.kr)',
};
await writeFile(new URL('meta.json', outDir), JSON.stringify(meta, null, 2) + '\n');

const noReason = all.filter((r) => !r.reason).length;
const noDate = all.filter((r) => !r.date).length;
console.log(`\n총 ${all.length}건 → recall/recalls.json`);
console.log(`사유 없음 ${noReason}건 (${Math.round((100 * noReason) / all.length)}%)`);
console.log(`날짜 없음 ${noDate}건 (${Math.round((100 * noDate) / all.length)}%)`);
