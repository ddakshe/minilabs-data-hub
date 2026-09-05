/**
 * 정유사(상표)별 가격 → oil/app/brands.json
 *
 * 실행: node scripts/fetch-oil-brands.mjs
 * 주기: **주 1회면 충분하다.** 브랜드 간 격차는 일 단위로 의미 있게 안 변한다.
 *
 * 🚨 API 가 아니라 웹 폼이다(오피넷 「국내유가통계 → 주유소 → 상표별」).
 *    API 한도와는 무관하지만 상시 수집은 아니다 — 주 1회로 노출을 줄여 둔다.
 *    (oil-tools/README.md 「오피넷 이용 범위」 결정 참고)
 *
 * 🚨 파싱 함정 둘.
 *   1. 응답의 HTML 표는 **비어 있다.** 데이터는 <script> 안 `chartData` 배열에 있다.
 *   2. 값 키가 **선택한 유종이 아니라 고정 순서**로 붙는다 —
 *      A1 고급휘발유 · A2 보통휘발유 · A3 자동차용경유 · A4 실내등유 · A5 보일러등유.
 *      B034 만 골라도 A1 이고 B027 만 골라도 A2 다. A2 로 하드코딩하면
 *      고급휘발유에서 조용히 죽는다.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'oil');
const URL_ = 'https://www.opinet.co.kr/user/dopostrm/dopOsTrmView.do';

/**
 * 유종 → chartData 의 값 키. 키는 **화면 열 고정 순서**라 A1 이 고급휘발유다.
 * 여기 선언 순서는 앱 탭 순서가 되므로 보통휘발유를 먼저 둔다
 * (오늘의 판단 탭과 순서를 맞춘다).
 */
const FUEL = { B027: 'A2', B034: 'A1', D047: 'A3', C004: 'A4' };
/** 차트에 그릴 5종. 나머지는 표에만 — 계열 색을 9개로 늘리지 않는다. */
const CHART = ['SK에너지', 'GS칼텍스', 'HD현대오일뱅크', 'S-OIL', '알뜰주유소(전체)'];
const BRANDS = ['SKE', 'GSC', 'HDO', 'SOL', 'RTO', 'RTE', 'RTX', 'NHO', 'ETC'];

const body = new URLSearchParams([
  ['TERM', 'D'],
  ['STA_Y', '2016'], ['STA_M', '01'], ['STA_D', '01'],
  ['END_Y', String(new Date().getFullYear())],
  ['END_M', String(new Date().getMonth() + 1).padStart(2, '0')],
  ['END_D', String(new Date().getDate()).padStart(2, '0')],
  ['OIL_CD_B034', 'Y'], ['OIL_CD_B027', 'Y'], ['OIL_CD_D047', 'Y'], ['OIL_CD_C004', 'Y'],
  ['INIF_FLAG', 'N'], ['equal', 'Y'],
  ...BRANDS.map((b) => [`POLL_DIV_CD_${b}`, 'Y']),
]);

const res = await fetch(URL_, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
  body,
});
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const html = await res.text();
const m = html.match(/chartData\s*=\s*(\[[\s\S]*?\]);/);
if (!m) throw new Error('chartData 를 못 찾았다 — 화면 구조가 바뀌었을 수 있다');

/** { 유종: { 브랜드: { 날짜: 가격 } } } */
const series = {};
for (const r of JSON.parse(m[1])) {
  const d = r.YYYY;
  const date = d.slice(0, 4) + d.slice(5, 7) + d.slice(8, 10);
  for (const [code, key] of Object.entries(FUEL)) {
    const v = r[key];
    if (typeof v !== 'number' || v <= 0) continue;   // 취급 없는 브랜드는 0/누락이다
    (((series[code] ??= {})[r.POLL_DIV_CD] ??= {}))[date] = v;
  }
}

const prices = JSON.parse(await readFile(join(DIR, 'prices.json'), 'utf-8'));
const out = { asOf: null, chart: CHART, fuels: {} };

for (const [code, byBrand] of Object.entries(series)) {
  const avg = prices.series[code];
  const dates = Object.keys(byBrand[CHART[0]] ?? {}).filter((d) => d in avg).sort();
  if (!dates.length) continue;
  const last = dates.at(-1);
  out.asOf = out.asOf && out.asOf > last ? out.asOf : last;
  const tail = dates.slice(-180);

  const table = Object.entries(byBrand)
    .filter(([, v]) => v[last] > 0)
    .map(([b, v]) => ({ name: b, price: +v[last].toFixed(2), vs: +(v[last] - avg[last]).toFixed(2) }))
    .sort((a, b) => a.price - b.price);

  const majors = table.filter((t) => CHART.slice(0, 4).includes(t.name)).map((t) => t.price);

  out.fuels[code] = {
    name: prices.products[code],
    avg: +avg[last].toFixed(2),
    dates: tail,
    // 전국평균 대비 차이. 절대가로 그리면 브랜드들이 겹쳐 아무것도 안 보인다.
    diff: Object.fromEntries(CHART
      .filter((b) => byBrand[b])
      .map((b) => [b, tail.map((d) => +((byBrand[b][d] ?? NaN) - avg[d]).toFixed(2))])),
    table,
    // 4대 정유사 격차 — 유종마다 완전히 다르다(보통 3.9원 vs 고급 27.5원)
    majorSpread: majors.length ? +(Math.max(...majors) - Math.min(...majors)).toFixed(2) : null,
    totalSpread: +(table.at(-1).price - table[0].price).toFixed(2),
  };
}

await mkdir(join(DIR, 'app'), { recursive: true });
await writeFile(join(DIR, 'app', 'brands.json'), JSON.stringify(out), 'utf-8');
console.log(`oil/app/brands.json — 기준 ${out.asOf}`);
for (const [c, f] of Object.entries(out.fuels)) {
  console.log(`  ${c} ${f.name}: 브랜드 ${f.table.length}종 · 4사격차 ${f.majorSpread}원 · 전체격차 ${f.totalSpread}원`);
  console.log(`     최저 ${f.table[0].name} ${f.table[0].price}  ·  최고 ${f.table.at(-1).name} ${f.table.at(-1).price}`);
}
