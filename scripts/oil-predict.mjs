/**
 * 오늘의 예측을 기록하고, 지난 예측을 채점한다.
 *
 * 출력: oil/predictions/{YYYY-MM}.json · oil/actuals/{YYYY-MM}.json · oil/scoreboard.json
 *       oil/app/today.json · oil/app/score.json   ← 앱이 직접 읽는 파일
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
/**
 * 🚨 자동차부탄(K015)은 제외한다 — prices.json 에 8일치뿐이다. 과거 소급에 쓴 웹 폼
 *    (주유소 평균판매가격)에 LPG 가 없다. LPG 는 「자동차충전소」 별도 화면이라
 *    소스가 다르다. 이력 없이 확률을 말할 수 없다.
 */
const PRODUCTS = ['B027', 'B034', 'D047', 'C004'];
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
/** 국제가는 **모델 입력이 아니라 설명·경보용**이다 (PROBE-RESULTS.md ablation 판정). */
const intl = await readJson(join(DIR, 'intl.json'), { series: {} });
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
    if (r.origin === 'tune') continue;   // scoreboard 에도 넣지 않는다
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

// ── 4) 앱이 읽을 파일 ────────────────────────────────────────────────
// 앱은 이 저장소의 raw URL 을 직접 읽는다. 배치가 값을 고쳐도 앱을 다시 배포할
// 필요가 없다. (형제 앱 stock-dividend-kr/src/lib/data.ts 와 같은 방식)
const APP = join(DIR, 'app');
await mkdir(APP, { recursive: true });

/**
 * 방향이 한 번 정해지면 평균 며칠 가는가. **유종마다 다르다** —
 * 휘발유 12.1일 / 고급휘발유 3.0일 / 실내등유 4.4일 (2026-09-05 실측).
 * 화면에 "평균 12일"을 하드코딩하면 고급휘발유에서 거짓말이 된다.
 */
function runAvgOf(y) {
  const runs = [];
  let cur = 1;
  for (let i = 2; i < y.length; i++) {
    const a = Math.sign(y[i] - y[i - 1]), b = Math.sign(y[i - 1] - y[i - 2]);
    if (a !== 0 && a === b) cur++; else { runs.push(cur); cur = 1; }
  }
  return +(runs.reduce((s, v) => s + v, 0) / runs.length).toFixed(1);
}

/**
 * 최근 30일 적중률. **급락하면 "지금은 이 모델이 안 통하는 국면"이라는 신호**다.
 * 예측 불가능한 것을 예측하는 대신, 예측이 안 되는 시기를 감지한다.
 * 60% 를 경고선으로 잡았다 — 과거 분포의 10~15퍼센타일이고(중앙값 83%),
 * 전체 시점의 11% 에서만 뜬다. 더 높이면 늘 켜져 있어 무의미해진다.
 */
const REGIME_WARN = 0.60;
const REGIME_WIN = 30;

/**
 * 국내 소매가 − 국제가(원/L) 스프레드의 역대 백분위.
 *
 * 이게 **왜 틀렸나**를 설명한다. 최악 손실 5건 모두 스프레드가 역대 하위 0~4% 였다 —
 * 국제가가 폭등했는데 국내가 아직 못 따라간 상태다. 곧 따라잡을 수밖에 없는데
 * **언제**가 어긋나 7일 지평 밖으로 밀렸다.
 * (분포: 중앙값 1,028원 · 5% 831원 · 95% 1,160원)
 */
const spreadHist = [];
for (const d of Object.keys(prices.series.B027 ?? {})) {
  const i = intl.series[d];
  if (i) spreadHist.push(prices.series.B027[d] - i.g);
}
spreadHist.sort((a, b) => a - b);
function spreadPctAt(d) {
  const i = intl.series[d];
  if (!i || !prices.series.B027[d]) return null;
  const v = prices.series.B027[d] - i.g;
  let lo = 0;
  for (const x of spreadHist) { if (x < v) lo++; else break; }
  return +(lo / spreadHist.length).toFixed(3);
}

/** 국제가 2주 변화율. 예측일 **전날까지**만 본다 — 미래를 훔치지 않는다. */
const intlDates = Object.keys(intl.series).sort();
function intlChgBefore(d) {
  for (let i = intlDates.length - 1; i >= 0; i--) {
    if (intlDates[i] < d) return intl.series[intlDates[i]].chg2w ?? null;
  }
  return null;
}

/**
 * 국제가는 주 1회 갱신이라 국내 시세보다 며칠 묵을 수 있다.
 * **자체 기준일을 함께 낸다** — 화면에서 "오늘 기준"인 것처럼 보이면 안 된다.
 */
const todayOut = { asOf: today, intlAsOf: intlDates.at(-1) ?? null, products: {} };
for (const code of PRODUCTS) {
  const r = preds[`${today}_${code}`];
  if (!r) continue;
  const m = prices.series[code];
  const ds = Object.keys(m).sort();
  todayOut.products[code] = {
    name: prices.products[code], price: r.price,
    diff: +(m[ds.at(-1)] - m[ds.at(-2)]).toFixed(2),
    horizons: r.horizons, runDays: r.runDays, runUp: r.runUp,
    verdict: r.verdict,
    runAvg: runAvgOf(ds.map((d) => m[d])),
    /**
     * 국내 판정과 국제가 방향이 **어긋나는가.** 크게 틀린 날의 절반이 여기 걸린다
     * (기다리라고 했는데 국제가는 오르는 중이던 2026-03-22~26).
     * 다만 나머지 절반(국내가 오버슈팅 후 되돌림)은 이걸로 못 잡는다 —
     * 경고이지 방어막이 아니다.
     */
    intlChg2w: intlChgBefore(today),
    spark: ds.slice(-60).map((d) => +m[d].toFixed(2)),
  };
}
// 최근 30건(대표 유종·침묵 제외)의 적중률
{
  const done = [];
  for (const f of (await readdir(P_DIR)).filter((x) => x.endsWith('.json')).sort()) {
    const rows = await readJson(join(P_DIR, f), {});
    const acts = await readJson(join(A_DIR, f), {});
    for (const [key, r] of Object.entries(rows)) {
      if (r.product !== 'B027' || r.verdict === 'neutral' || r.origin === 'tune') continue;
      const a = acts[`${key}_h7`];
      if (!a) continue;
      const g = r.verdict === 'fill' ? a.delta : -a.delta;
      done.push({ date: r.date, hit: g > 0 });
    }
  }
  done.sort((a, b) => a.date.localeCompare(b.date));
  const win = done.slice(-REGIME_WIN);
  const hit = win.length ? win.filter((x) => x.hit).length / win.length : null;
  todayOut.regime = {
    window: REGIME_WIN, n: win.length,
    hit: hit === null ? null : +hit.toFixed(3),
    warn: hit !== null && win.length >= REGIME_WIN && hit < REGIME_WARN,
    threshold: REGIME_WARN,
    asOf: win.at(-1)?.date ?? null,
  };
}
await writeFile(join(APP, 'today.json'), JSON.stringify(todayOut), 'utf-8');

// 성적표 — 대표 유종(휘발유) 7일 지평
const SC = 'B027', SH = 7;
const scoreRows = [];
for (const f of (await readdir(P_DIR)).filter((x) => x.endsWith('.json'))) {
  const rows = await readJson(join(P_DIR, f), {});
  const acts = await readJson(join(A_DIR, f), {});
  for (const [key, r] of Object.entries(rows)) {
    // 🚨 tune 구간은 화면에서 뺀다 — 파라미터를 고를 때 본 데이터라 성적이 부풀려진다.
    if (r.product !== SC || r.verdict === 'neutral' || r.origin === 'tune') continue;
    const a = acts[`${key}_h${SH}`];
    if (!a) continue;
    const gain = r.verdict === 'fill' ? a.delta : -a.delta;
    const p7 = r.horizons.find((x) => x.h === SH);
    scoreRows.push({ date: r.date, origin: r.origin, verdict: r.verdict, price: r.price,
                     gain: +gain.toFixed(2), hit: gain > 0, p: p7.p, n: p7.n,
                     // 말한 방향의 확신도. 크게 틀린 날일수록 이 값이 높았다(94~95%).
                     conf: +(r.verdict === 'fill' ? p7.p : 1 - p7.p).toFixed(3),
                     intlChg2w: intlChgBefore(r.date),
                     spreadPct: spreadPctAt(r.date),
                     runDays: r.runDays, runUp: r.runUp });
  }
}
scoreRows.sort((a, b) => a.date.localeCompare(b.date));

const summarize = (rs) => rs.length ? {
  n: rs.length, hit: +(rs.filter((x) => x.hit).length / rs.length).toFixed(4),
  ev: +(rs.reduce((a, x) => a + x.gain, 0) / rs.length).toFixed(2),
  from: rs[0].date, to: rs.at(-1).date,
} : null;

// 보정도 — 말한 방향의 확신도별 실제 적중률
const cal = {};
for (const r of scoreRows) {
  if (r.origin !== 'backtest') continue;
  const conf = r.verdict === 'fill' ? r.p : 1 - r.p;
  const k = Math.min(Math.floor(conf * 10), 9);
  (cal[k] ??= [0, 0]);
  cal[k][0]++; if (r.hit) cal[k][1]++;
}

const pm = prices.series[SC];
const tail = Object.keys(pm).sort().slice(-180);
const tailSet = new Set(tail);

await writeFile(join(APP, 'score.json'), JSON.stringify({
  liveFrom: '20260905',   // 예측 기록 시작일 = 성적표의 출시선
  horizon: SH,
  byOrigin: { backtest: summarize(scoreRows.filter((r) => r.origin === 'backtest')),
              live: summarize(scoreRows.filter((r) => r.origin === 'live')) },
  recent: scoreRows.slice(-12).reverse(),
  /**
   * 최악 손실. **그 시점의 최근 30건 적중률**을 함께 낸다 —
   * 실측해 보니 최악 2건에서 이미 47~50% 로 떨어져 있었다. 국면 경고가 켜졌을
   * 상황이라는 뜻이고, 그 장치가 실제로 일한다는 증거다.
   */
  worst: (() => {
    const hist = [];
    const at = {};
    for (const r of scoreRows) {
      at[r.date] = hist.length >= 30
        ? +(hist.slice(-30).filter(Boolean).length / 30).toFixed(3) : null;
      hist.push(r.hit);
    }
    return scoreRows.filter((r) => !r.hit).sort((a, b) => a.gain - b.gain).slice(0, 3)
      .map((r) => ({ ...r, hitThen: at[r.date] }));
  })(),
  calibration: Object.entries(cal).filter(([, v]) => v[0] >= 30)
    .map(([k, v]) => ({ band: `${k * 10}~${k * 10 + 9}%`, n: v[0], actual: +(v[1] / v[0]).toFixed(3) })),
  chart: {
    dates: tail, price: tail.map((d) => +pm[d].toFixed(2)),
    marks: scoreRows.filter((r) => tailSet.has(r.date))
      .map((r) => ({ date: r.date, price: r.price, verdict: r.verdict, hit: r.hit })),
  },
}), 'utf-8');

console.log(
  `oil/predictions ${ym(today)} — 신규 ${wrote}건, 기존 보존 ${kept}건 (기준일 ${today})\n` +
  `oil/actuals — 채점 ${scored}건 신규\n` +
  `oil/scoreboard.json — ${Object.entries(board.byOrigin)
    .map(([k, v]) => `${k}: ${Object.values(v).reduce((a, s) => a + s.n, 0)}건`).join(' · ') || '아직 없음'}\n` +
  `oil/app/today.json · oil/app/score.json — 앱용 산출`,
);
