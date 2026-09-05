/**
 * 국내 주유소 평균가 시계열 수집기 — 기름값 예측 미니앱이 쓴다.
 *
 * 출력: oil/prices.json · oil/meta.json · oil/regions.json
 *
 * 실행: OPINET_API_KEY=... node scripts/fetch-oil.mjs
 *       키가 없으면 ~/.config/stock-tools/opinet.env 를 읽는다 (러너 파일 방식).
 *
 * 설계 결정:
 *  - **호출은 하루 6건이다** (시세 2 + 시도별 4유종). 오피넷 일반 API 한도가 2026-09-01 부터 1,500 → 300 으로
 *    내려갔다. 런타임(앱)에서 부르는 설계였다면 그날로 죽었을 것이다. 이 허브의
 *    배치 → 정적 JSON 원칙이 그대로 방어막이 됐다. **앱에서 직접 부르지 말 것.**
 *
 *  - avgRecentPrice 는 **어제까지 7일** 확정치를 준다. 오늘 값은 avgAllPrice 의
 *    잠정치라 다음 날 확정치로 덮인다 — 그래서 병합은 upsert 다. 나중 응답이 이긴다.
 *
 *  - 7일 창이라 **하루 거르면 그만큼만 구멍이 난다.** 6일 안에 복구하면 메워지므로
 *    실행 실패 하루는 치명적이지 않다. 다만 7일을 넘기면 영구 결번이다.
 *
 *  - 시계열을 유종 → 날짜 → 가격 맵으로 둔다. 매일 몇 개 키만 추가되므로 git diff 가
 *    작고, 앱은 유종 하나만 읽으면 된다.
 *
 *  - 원본을 **누적 보관**한다. 무료 한도를 5분의 1로 조인 전례가 있어 앞으로 더 줄거나
 *    유료화될 수 있다. 한 번 받은 과거는 우리 것이고, 그러면 하루 2콜만 살아 있어도
 *    앱은 계속 산다.
 *
 *  - 순차 호출 + sleep. 동시 요청으로 DART 에서 IP 차단을 당한 전례가 있다(2026-08-25).
 *    2콜짜리 배치에 병렬은 아무 이득이 없다.
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'oil');
const PRICES = join(OUT_DIR, 'prices.json');
const META = join(OUT_DIR, 'meta.json');

const BASE = 'http://www.opinet.co.kr/api';

/** 유종 코드. 앱이 쓰는 건 휘발유·경유뿐이지만 응답에 다 오므로 전부 저장한다. */
const PRODUCTS = {
  B027: '휘발유',
  B034: '고급휘발유',
  D047: '경유',
  C004: '실내등유',
  K015: '자동차부탄',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 키 찾는 순서: 환경변수 → ~/.config/stock-tools/opinet.env. 소스에 박지 않는다. */
async function apiKey() {
  if (process.env.OPINET_API_KEY) return process.env.OPINET_API_KEY.trim();
  try {
    const txt = await readFile(join(homedir(), '.config/stock-tools/opinet.env'), 'utf-8');
    const m = txt.match(/^OPINET_API_KEY\s*=\s*(.+)$/m);
    if (m) return m[1].trim();
  } catch {
    /* 파일이 없으면 아래에서 죽는다 */
  }
  throw new Error('OPINET_API_KEY 없음 — 환경변수 또는 ~/.config/stock-tools/opinet.env');
}

async function call(name, key) {
  const url = `${BASE}/${name}.do?code=${encodeURIComponent(key)}&out=json`;
  const res = await fetch(url, { headers: { 'User-Agent': 'minilabs-data-hub' } });
  if (!res.ok) throw new Error(`${name}.do → HTTP ${res.status}`);
  // 응답에 공백·개행이 많이 섞여 오지만 JSON 자체는 유효하다.
  const body = await res.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`${name}.do → JSON 파싱 실패: ${body.slice(0, 120)}`);
  }
  const rows = json?.RESULT?.OIL;
  if (!Array.isArray(rows)) throw new Error(`${name}.do → RESULT.OIL 없음`);
  return rows;
}

/** 기존 시계열을 읽는다. 없으면 빈 구조. */
async function loadSeries() {
  try {
    const prev = JSON.parse(await readFile(PRICES, 'utf-8'));
    return prev.series ?? {};
  } catch {
    return {};
  }
}

function upsert(series, prodcd, date, price) {
  if (!PRODUCTS[prodcd]) return 0; // 모르는 유종이 늘면 조용히 흘린다
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return 0;
  series[prodcd] ??= {};
  const before = series[prodcd][date];
  series[prodcd][date] = n;
  return before === n ? 0 : 1;
}

/**
 * 시도별 평균가. 지역 격차가 **72원**(대구 1,832 vs 서울 1,905)으로 이 앱의 시간축
 * 이득(7일 +12원)보다 6배 크다 — 감출 이유가 없다.
 *
 * 🚨 웹 폼(dopOsPdrgAreaView.do)으로 과거 시계열을 받으려 했으나 파라미터를 맞춰도
 *    799바이트 빈 응답이 온다. **추측을 늘리지 말고 공식 API 로 매일 쌓는다.**
 *    과거는 없이 시작하지만 하루씩 붙으면 된다. (prices.json 과 같은 방식)
 *
 * 🚨 응답에 **'전국' 행이 섞여 있고 그 DIFF 가 가격값 그대로**다(+1859.37).
 *    거르지 않으면 지역 목록에 전국이 끼고 전일대비가 터무니없이 찍힌다.
 */
async function sido(key, prodcd) {
  const url = `${BASE}/avgSidoPrice.do?code=${encodeURIComponent(key)}&out=json&prodcd=${prodcd}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'minilabs-data-hub' } });
  if (!res.ok) throw new Error(`avgSidoPrice(${prodcd}) → HTTP ${res.status}`);
  const rows = JSON.parse(await res.text())?.RESULT?.OIL ?? [];
  const out = {};
  for (const r of rows) {
    if (r.SIDONM === '전국') continue;          // ← 위 주석 참고
    const v = Number(r.PRICE);
    if (Number.isFinite(v) && v > 0) out[r.SIDONM] = +v.toFixed(2);
  }
  return out;
}

async function main() {
  const key = await apiKey();
  const series = await loadSeries();
  let changed = 0;

  // ① 최근 7일 확정치 (어제까지)
  const recent = await call('avgRecentPrice', key);
  for (const r of recent) changed += upsert(series, r.PRODCD, String(r.DATE), r.PRICE);

  await sleep(600);

  // ② 오늘 잠정치 + 전일 대비. 내일 ①이 확정치로 덮는다.
  const today = await call('avgAllPrice', key);
  const todayDiff = {};
  let todayDate = null;
  for (const r of today) {
    const d = String(r.TRADE_DT);
    todayDate = d;
    changed += upsert(series, r.PRODCD, d, r.PRICE);
    todayDiff[r.PRODCD] = Number(r.DIFF);
  }

  // 날짜 오름차순으로 정렬해 둬야 git diff 가 끝에만 붙는다.
  const sorted = {};
  for (const code of Object.keys(PRODUCTS)) {
    if (!series[code]) continue;
    sorted[code] = Object.fromEntries(
      Object.entries(series[code]).sort(([a], [b]) => a.localeCompare(b)),
    );
  }

  const dates = Object.values(sorted).flatMap((m) => Object.keys(m));
  const out = {
    source: '한국석유공사 오피넷 유가정보 API',
    products: PRODUCTS,
    series: sorted,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(PRICES, JSON.stringify(out), 'utf-8');

  const latest = {};
  for (const [code, m] of Object.entries(sorted)) {
    const ds = Object.keys(m);
    const last = ds[ds.length - 1];
    latest[code] = { date: last, price: m[last], diff: todayDiff[code] ?? null };
  }

  await writeFile(
    META,
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      // 오늘 값은 잠정치다. 앱이 "기준일"을 표시할 때 이걸 그대로 쓴다.
      provisionalDate: todayDate,
      firstDate: dates.length ? dates.sort()[0] : null,
      days: sorted.B027 ? Object.keys(sorted.B027).length : 0,
      latest,
    }),
    'utf-8',
  );

  // ── ③ 시도별 평균가 — 유종별로 1콜씩, 날짜별로 누적한다 ──
  const REG = join(OUT_DIR, 'regions.json');
  const regions = await (async () => {
    try { return JSON.parse(await readFile(REG, 'utf-8')); }
    catch { return { products: PRODUCTS, series: {} }; }
  })();
  for (const code of ['B027', 'B034', 'D047', 'C004']) {
    await sleep(400);
    const byS = await sido(key, code);
    if (Object.keys(byS).length) {
      ((regions.series[code] ??= {}))[todayDate] = byS;
    }
  }
  for (const code of Object.keys(regions.series)) {
    regions.series[code] = Object.fromEntries(
      Object.entries(regions.series[code]).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  regions.products = PRODUCTS;
  await writeFile(REG, JSON.stringify(regions), 'utf-8');

  const kb = ((await readFile(PRICES, 'utf-8')).length / 1024).toFixed(1);
  console.log(`oil/prices.json — 휘발유 ${out.series.B027 ? Object.keys(out.series.B027).length : 0}일치, ${kb}KB, 변경 ${changed}건`);
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
