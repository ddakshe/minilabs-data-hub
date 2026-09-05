/**
 * 오늘의 예측을 기록하고, 지난 예측을 채점한다.
 *
 * 출력: oil/predictions/{YYYY-MM}.json · oil/actuals/{YYYY-MM}.json · oil/scoreboard.json
 * 실행: node scripts/oil-predict.mjs        (fetch-oil.mjs 다음에 돈다)
 *
 * ┌─ 이 파일의 존재 이유 ────────────────────────────────────────────────┐
 * │ 앱이 "과거 142번 중 94번" 이라고 말하려면 그 기록이 실재해야 한다.      │
 * │ 백테스트는 나중에 언제든 만들 수 있지만 **오늘 발표하지 않은 예측은     │
 * │ 영영 만들 수 없다.** 그래서 화면보다 이게 먼저다.                      │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 🚨 **predictions 는 append-only 다.**
 *    이미 있는 날짜는 값이 달라져도 **덮지 않는다.** 하나라도 고치면 기록 전체의
 *    신뢰가 0이 된다 — 사후에 유리하게 바꾼 것과 구별할 방법이 없기 때문이다.
 *    실제값은 actuals 에 따로 쓰고 조회할 때 join 한다. 예측 파일에 채워 넣지 않는다.
 *
 * 🚨 **가격이 그대로여도 이 파일들은 커밋해야 한다.**
 *    "그날 발표했다"를 증명하는 게 git 커밋 타임스탬프다. 건너뛰면 기록에 구멍이
 *    나고, 나중에 채우면 사후 조작과 구별되지 않는다. (fetch-oil.yml 주석 참고)
 *
 * 모델 버전(`model.v`)을 함께 박는다. 나중에 모델을 바꾸면 채점을 구간별로 갈라야
 * 하는데, 버전이 없으면 어디서 갈렸는지 알 수 없다.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'oil');
const P_DIR = join(DIR, 'predictions');
const A_DIR = join(DIR, 'actuals');

/** 모델 파라미터. PROBE-RESULTS.md 에서 고른 값이며 바꾸면 v 를 올린다. */
const MODEL = {
  v: 'baseline-1',
  lookback: { 1: 14, 3: 14, 7: 10 },
  // 비대칭 임계값 — "기다리세요"가 틀리면 손실이 더 크다 (PROJECT.md §5)
  fill: 0.60,
  wait: 0.25,
  buckets: 10,
};
const PRODUCTS = ['B027', 'D047'];
const HORIZONS = [1, 3, 7];

const ym = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}`;
const readJson = async (p, dflt) => {
  try { return JSON.parse(await readFile(p, 'utf-8')); } catch { return dflt; }
};

function edgesOf(vals, nb) {
  const s = [...vals].sort((a, b) => a - b);
  return Array.from({ length: nb - 1 }, (_, i) => s[Math.floor((s.length * (i + 1)) / nb)]);
}
const bucketOf = (v, edges) => edges.reduce((b, e) => (v > e ? b + 1 : b), 0);

/** 확률은 **과거 빈도**다. 모델이 지어내지 않는다. 그래서 분모(n)를 항상 함께 낸다. */
function horizonStat(y, h, L) {
  const rows = [];
  for (let t = L; t < y.length - h; t++) rows.push([y[t] - y[t - L], y[t + h] - y[t]]);
  const edges = edgesOf(rows.map((r) => r[0]), MODEL.buckets);
  const cur = y[y.length - 1] - y[y.length - 1 - L];
  const b = bucketOf(cur, edges);
  const same = rows.filter((r) => bucketOf(r[0], edges) === b);
  const up = same.filter(([, o]) => o > 0).length;
  return { h, L, p: up / same.length, n: same.length, up };
}

function verdictOf(week) {
  if (week.p >= MODEL.fill) return 'fill';
  if (week.p <= MODEL.wait) return 'wait';
  return 'neutral';   // 애매하면 침묵한다. 조회기에서 침묵은 손해가 아니다.
}

// ── 1) 오늘의 예측 ────────────────────────────────────────────────────
const prices = JSON.parse(await readFile(join(DIR, 'prices.json'), 'utf-8'));
const today = Object.keys(prices.series.B027).sort().at(-1);

await mkdir(P_DIR, { recursive: true });
await mkdir(A_DIR, { recursive: true });

const pFile = join(P_DIR, `${ym(today)}.json`);
const preds = await readJson(pFile, {});
let wrote = 0, kept = 0;

for (const code of PRODUCTS) {
  const m = prices.series[code];
  if (!m) continue;
  const ds = Object.keys(m).sort();
  const y = ds.map((d) => m[d]);
  const key = `${today}_${code}`;

  // 🚨 append-only: 이미 있으면 절대 덮지 않는다.
  if (preds[key]) { kept++; continue; }

  const horizons = HORIZONS.map((h) => horizonStat(y, h, MODEL.lookback[h]));
  const week = horizons.find((x) => x.h === 7);

  // 며칠째 같은 방향인가 — 확률이 아니라 관측된 사실이다.
  let run = 1, i = y.length - 1;
  const sgn = (a, b) => Math.sign(a - b);
  const s0 = sgn(y[i], y[i - 1]);
  while (i - 1 > 0 && sgn(y[i], y[i - 1]) === s0 && s0 !== 0) { run++; i--; }

  preds[key] = {
    date: today, product: code, origin: 'live',
    price: m[today], horizons, verdict: verdictOf(week),
    runDays: run, runUp: s0 > 0,
    model: MODEL.v, publishedAt: new Date().toISOString(),
  };
  wrote++;
}
await writeFile(pFile, JSON.stringify(preds, null, 1), 'utf-8');

// ── 2) 채점 — 지평이 지난 예측의 실제값을 actuals 에 쓴다 ──────────────
const idxOf = {};
for (const code of PRODUCTS) {
  const ds = Object.keys(prices.series[code] ?? {}).sort();
  idxOf[code] = { ds, pos: Object.fromEntries(ds.map((d, i) => [d, i])) };
}

let scored = 0;
for (const f of (await readdir(P_DIR)).filter((x) => x.endsWith('.json'))) {
  const rows = await readJson(join(P_DIR, f), {});
  const aFile = join(A_DIR, f);
  const acts = await readJson(aFile, {});
  let touched = false;

  for (const [key, r] of Object.entries(rows)) {
    const { ds, pos } = idxOf[r.product] ?? {};
    if (!ds) continue;
    const i = pos[r.date];
    if (i === undefined) continue;
    for (const h of HORIZONS) {
      const k = `${key}_h${h}`;
      if (acts[k]) continue;                      // 실제값도 한 번 쓰면 고치지 않는다
      const j = i + h;
      if (j >= ds.length) continue;               // 아직 지평이 안 지났다
      acts[k] = {
        date: r.date, product: r.product, h,
        from: r.price, to: prices.series[r.product][ds[j]],
        delta: +(prices.series[r.product][ds[j]] - r.price).toFixed(2),
        onDate: ds[j],
      };
      touched = true; scored++;
    }
  }
  if (touched) await writeFile(aFile, JSON.stringify(acts, null, 1), 'utf-8');
}

// ── 3) scoreboard — 파생물이라 언제든 재생성 가능 ─────────────────────
// asOf 는 데이터에서 나오므로 **결정적**이다. generatedAt 같은 실행시각을 넣으면
// 내용이 그대로여도 매 실행 파일이 바뀌어 헛커밋이 쌓인다.
const board = { asOf: today, byOrigin: {} };
for (const f of (await readdir(P_DIR)).filter((x) => x.endsWith('.json'))) {
  const rows = await readJson(join(P_DIR, f), {});
  const acts = await readJson(join(A_DIR, f), {});
  for (const [key, r] of Object.entries(rows)) {
    // 🚨 출시 전(backtest)과 출시 후(live)를 절대 합산하지 않는다. 증거력이 다르다.
    const o = (board.byOrigin[r.origin] ??= {});
    for (const h of HORIZONS) {
      const a = acts[`${key}_h${h}`];
      if (!a) continue;
      if (r.verdict === 'neutral') continue;      // 침묵한 날은 채점하지 않는다
      const gain = r.verdict === 'fill' ? a.delta : -a.delta;
      const s = (o[h] ??= { n: 0, hit: 0, sum: 0, win: 0, winSum: 0, lose: 0, loseSum: 0 });
      s.n++; s.sum += gain;
      if (gain > 0) { s.hit++; s.win++; s.winSum += gain; } else { s.lose++; s.loseSum += gain; }
    }
  }
}
for (const o of Object.values(board.byOrigin)) {
  for (const s of Object.values(o)) {
    s.hitRate = +(s.hit / s.n).toFixed(4);
    s.ev = +(s.sum / s.n).toFixed(3);            // 대표 숫자는 적중률이 아니라 기대값이다
    s.winAvg = s.win ? +(s.winSum / s.win).toFixed(2) : 0;
    s.loseAvg = s.lose ? +(s.loseSum / s.lose).toFixed(2) : 0;
  }
}
await writeFile(join(DIR, 'scoreboard.json'), JSON.stringify(board, null, 1), 'utf-8');

console.log(
  `oil/predictions ${ym(today)} — 신규 ${wrote}건, 기존 보존 ${kept}건 (기준일 ${today})\n` +
  `oil/actuals — 채점 ${scored}건 신규\n` +
  `oil/scoreboard.json — ${Object.entries(board.byOrigin)
    .map(([k, v]) => `${k}: ${Object.values(v).reduce((a, s) => a + s.n, 0)}건`).join(' · ') || '아직 없음'}`,
);
