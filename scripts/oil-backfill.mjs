/**
 * 출시 전 구간의 예측 기록을 **walk-forward 로** 만든다 (origin: backtest).
 *
 * 실행: node scripts/oil-backfill.mjs        1회성. 스케줄에 걸지 않는다.
 *
 * 왜 필요한가 — 성적표 화면은 출시 첫날 비어 있으면 안 된다(콜드 스타트).
 * 왜 위험한가 — 결과를 알고 난 뒤 되돌려 만든 기록이라 **증거력이 다르다.**
 *
 * 그래서 셋을 지킨다.
 *  1. **walk-forward**: 날짜 D 의 예측은 **D 이전 데이터로만** 만든다. 버킷 경계와
 *     확률표를 매일 다시 적합한다. 미래를 훔칠 수 없다.
 *  2. **파라미터는 앞쪽에서 고른 것을 그대로 쓴다.** lookback 은 튜닝 구간(~2021)에서
 *     정한 값이고 여기서 다시 고르지 않는다. 표시 구간은 2022~ 뿐이다.
 *  3. **origin='backtest'** 로 박는다. scoreboard 는 live 와 절대 합산하지 않는다.
 *
 * 🚨 이미 있는 날짜는 덮지 않는다. live 기록이 있으면 그대로 둔다.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'oil');
const P_DIR = join(DIR, 'predictions');

const MODEL = { v: 'baseline-1', lookback: { 1: 14, 3: 14, 7: 10 }, fill: 0.60, wait: 0.25, buckets: 10 };
const PRODUCTS = ['B027', 'D047'];
const HORIZONS = [1, 3, 7];

/**
 * 표시 구간 = 홀드아웃(2022~). 파라미터를 고를 때 보지 않은 구간만 화면에 보여준다.
 *
 * `--tune` 을 주면 **그 이전 구간**을 만든다. origin 을 'tune' 으로 박아
 * 화면 집계에서 빠지게 한다 — 튜닝에 쓴 구간을 성적으로 보여주면 부풀려진다.
 * 이 구간은 오직 **임계값·보정 곡선을 적합하는 데만** 쓴다.
 */
const HOLDOUT_FROM = '20220101';
const TUNE_MODE = process.argv.includes('--tune');
const ORIGIN = TUNE_MODE ? 'tune' : 'backtest';
/** 적합에 쓸 최소 이력. 이보다 적으면 확률이 의미 없다. */
const MIN_HISTORY = 750;

const ym = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}`;
const readJson = async (p, d) => { try { return JSON.parse(await readFile(p, 'utf-8')); } catch { return d; } };

function edgesOf(vals, nb) {
  const s = [...vals].sort((a, b) => a - b);
  return Array.from({ length: nb - 1 }, (_, i) => s[Math.floor((s.length * (i + 1)) / nb)]);
}
const bucketOf = (v, e) => e.reduce((b, x) => (v > x ? b + 1 : b), 0);

const prices = JSON.parse(await readFile(join(DIR, 'prices.json'), 'utf-8'));
await mkdir(P_DIR, { recursive: true });

const files = {};
for (const f of (await readdir(P_DIR)).filter((x) => x.endsWith('.json'))) {
  files[f.replace('.json', '')] = await readJson(join(P_DIR, f), {});
}

let wrote = 0, kept = 0;
for (const code of PRODUCTS) {
  const m = prices.series[code];
  const ds = Object.keys(m).sort();
  const y = ds.map((d) => m[d]);
  const last = ds.length - Math.max(...HORIZONS) - 1;   // 지평이 다 해소되는 날까지만

  for (let t = MIN_HISTORY; t <= last; t++) {
    const date = ds[t];
    if (TUNE_MODE ? date >= HOLDOUT_FROM : date < HOLDOUT_FROM) continue;
    const key = `${date}_${code}`;
    const f = ym(date);
    const bag = (files[f] ??= {});
    if (bag[key]) { kept++; continue; }             // live 든 backtest 든 있으면 보존

    const horizons = [];
    for (const h of HORIZONS) {
      const L = MODEL.lookback[h];
      // 🔑 t 이전만 쓴다. rows 의 결과(o)도 t 안에서 이미 해소된 것만 들어간다.
      const rows = [];
      for (let s = L; s < t - h; s++) rows.push([y[s] - y[s - L], y[s + h] - y[s]]);
      const edges = edgesOf(rows.map((r) => r[0]), MODEL.buckets);
      const b = bucketOf(y[t] - y[t - L], edges);
      const same = rows.filter((r) => bucketOf(r[0], edges) === b);
      const up = same.filter(([, o]) => o > 0).length;
      horizons.push({ h, L, p: same.length ? up / same.length : 0.5, n: same.length, up });
    }
    const week = horizons.find((x) => x.h === 7);
    const verdict = week.p >= MODEL.fill ? 'fill' : week.p <= MODEL.wait ? 'wait' : 'neutral';

    let run = 1, i = t;
    const sgn = (a, b) => Math.sign(a - b);
    const s0 = sgn(y[i], y[i - 1]);
    while (i - 1 > 0 && sgn(y[i], y[i - 1]) === s0 && s0 !== 0) { run++; i--; }

    bag[key] = {
      date, product: code, origin: ORIGIN,
      price: y[t], horizons, verdict, runDays: run, runUp: s0 > 0, model: MODEL.v,
    };
    wrote++;
  }
}

for (const [f, bag] of Object.entries(files)) {
  await writeFile(join(P_DIR, `${f}.json`), JSON.stringify(bag, null, 1), 'utf-8');
}
console.log(`${ORIGIN} 예측 ${wrote}건 생성 · 기존 보존 ${kept}건 · 파일 ${Object.keys(files).length}개`);
