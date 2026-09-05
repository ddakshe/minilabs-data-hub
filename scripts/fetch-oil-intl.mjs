/**
 * 국제 석유제품가 + 원/달러 → oil/intl.json
 *
 * 실행: node scripts/fetch-oil-intl.mjs
 * 주기: **주 1회면 충분하다.** 예측 모델의 입력이 아니라 **설명·경보용**이다.
 *
 * 왜 모델에 안 넣나 — ablation 에서 평균 기대값이 +10% 밖에 안 올랐고, 그마저
 * 탐색 조합이 6배라 할인해야 했다(oil-tools/oil-price-mini/PROBE-RESULTS.md).
 * 국내 소매가가 이미 국제가 정보를 담고 있기 때문이다.
 *
 * 그런데 **크게 틀린 날들이 전부 국제가 급등 구간에 몰려 있다.** 2026-03 에
 * 국제 휘발유가 $79 → $157 로 2배 뛰었고, 그 2주에 최악 손실 6건이 모두 들어 있다.
 * 평균은 못 올려도 **꼬리 위험은 다를 수 있다** — 그걸 재려면 이 데이터가 필요하다.
 *
 * 🚨 CSV 엔드포인트를 쓴다. 조회 화면(glopopdSelect.do)의 표는 JS 로 그려져 비어 있다.
 * 🚨 히든 필드 OILSRTCD1..7 을 체크박스와 **함께** 보내야 값 열이 나온다.
 *    OILSRTCD 만 보내면 날짜 열만 오는 CSV 가 돌아온다(조용히).
 * 🚨 응답 인코딩이 EUC-KR 이다.
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'oil');
const BBL_L = 158.987;

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();

// ── 국제 제품가 (오피넷 CSV) ──
const codes = ['B001', 'B007', 'C001', 'D009', 'D008', 'E001', 'F001'];
const body = new URLSearchParams([
  ['TERM', 'D'], ['HOLIDAY_YN', 'Y'],
  ['STA_Y', '2010'], ['STA_M', '01'], ['STA_D', '01'],
  ['END_Y', String(now.getFullYear())], ['END_M', pad(now.getMonth() + 1)], ['END_D', pad(now.getDate())],
  ['SEL_DIV', 'div_dar'],
  ...codes.map((c, i) => [`OILSRTCD${i + 1}`, c]),
  ...codes.map((c) => ['OILSRTCD', c]),
]);
const res = await fetch('https://www.opinet.co.kr/glopopd_csv.do', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
  body,
});
if (!res.ok) throw new Error(`국제가 HTTP ${res.status}`);
const csv = new TextDecoder('euc-kr').decode(await res.arrayBuffer());

const lines = csv.trim().split(/\r?\n/);
const head = lines[0].split(',');
const col = { gasoline: head.indexOf('휘발유(92RON)'), diesel: head.indexOf('경유(0.001%)') };
if (col.gasoline < 0) throw new Error(`열을 못 찾았다: ${head.join('|')}`);

const intl = {};
const last = {};
for (const line of lines.slice(1)) {
  const c = line.split(',');
  const per = c[0];                                  // '10년01월04일'
  const date = `20${per.slice(0, 2)}${per.slice(3, 5)}${per.slice(6, 8)}`;
  for (const [k, i] of Object.entries(col)) {
    const v = parseFloat(c[i]);
    if (Number.isFinite(v) && v > 0) last[k] = v;    // 거래 없는 날은 직전 값으로
  }
  if (last.gasoline) intl[date] = { ...last };
}

// ── 원/달러 (ECOS) ──
async function ecosKey() {
  if (process.env.ECOS_API_KEY) return process.env.ECOS_API_KEY.trim();
  const txt = await readFile(join(homedir(), '.config/stock-tools/ecos.env'), 'utf-8');
  return (txt.match(/^ECOS_API_KEY\s*=\s*(.+)$/m)?.[1] ?? txt.split('\n')[0]).trim();
}
const key = await ecosKey();
const fx = {};
for (let start = 1; ; start += 1000) {
  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${key}/json/kr/${start}/${start + 999}` +
              `/731Y001/D/20100101/${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}/0000001`;
  const j = await (await fetch(url)).json();
  const rows = j?.StatisticSearch?.row ?? [];
  for (const r of rows) fx[r.TIME] = +r.DATA_VALUE;
  if (rows.length < 1000) break;
  await new Promise((r) => setTimeout(r, 300));
}

// ── 원화 환산 + 2주 변화율 ──
const dates = Object.keys(intl).sort();
let lastFx = null;
const out = {};
for (const d of dates) {
  if (fx[d]) lastFx = fx[d];
  if (!lastFx) continue;
  out[d] = {
    // $/bbl → 원/L
    g: +(intl[d].gasoline * lastFx / BBL_L).toFixed(2),
    d: intl[d].diesel ? +(intl[d].diesel * lastFx / BBL_L).toFixed(2) : null,
    usd: +intl[d].gasoline.toFixed(2),
  };
}
const ks = Object.keys(out).sort();
for (let i = 0; i < ks.length; i++) {
  const prev = out[ks[Math.max(0, i - 10)]];         // 영업일 10 ≈ 2주
  out[ks[i]].chg2w = prev ? +(((out[ks[i]].g - prev.g) / prev.g) * 100).toFixed(1) : null;
}

await mkdir(DIR, { recursive: true });
await writeFile(join(DIR, 'intl.json'), JSON.stringify({ asOf: ks.at(-1), series: out }), 'utf-8');
const l = out[ks.at(-1)];
console.log(`oil/intl.json — ${ks.length}일 (${ks[0]}~${ks.at(-1)})`);
console.log(`  최근: 국제 휘발유 $${l.usd}/bbl = ${l.g}원/L · 2주 ${l.chg2w > 0 ? '+' : ''}${l.chg2w}%`);
