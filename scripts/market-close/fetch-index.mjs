#!/usr/bin/env node
// ⚠️ 생성된 사본이다. 고치지 말 것.
// 원본: market-close-mini/pipeline/fetch-index.mjs
// 갱신: node pipeline/sync-to-hub.mjs
/**
 * fetch-index.mjs — 코스피·코스닥 지수 시계열을 받는다.
 *
 *   out/index/market.json
 *
 * 🔑 **지수 숫자를 화면에 그리려는 게 아니다.** 코스피 종가는 토스 어디에나 있다.
 *    우리가 만드는 건 차이다 — "코스피가 0.4% 내린 날 1.8% 올랐어요".
 *    그 한 문장을 위해 필요한 것은 `fltRt` 하나뿐이고 나머지는 덤이다.
 *
 * ⚠️ **지수당 1회, 총 2회 호출.** `idxNm` 완전일치 + 기간 조회로 800일치가 한 번에 온다
 *    (실측 584거래일 · 392ms). 종목 수와 무관하므로 크론 비용이 늘지 않는다.
 *
 * 🚨 **`yrWRcrdLwst`(연중최저) 는 깨져 있다 — 쓰지 말 것.**
 *      코스피·코스닥·KRX300 전부 `0` 이고 날짜는 아직 데이터도 없는 미래로 온다
 *      (2026-08-28 실측: yrWRcrdLwst=0 / yrWRcrdLwstDt=20260827).
 *      같은 계열인 `yrWRcrdHgst` 도 신뢰할 근거가 없다. 범위가 필요하면
 *      §12 가 52주에 그랬듯 **시계열에서 직접 계산한다.**
 *
 * 🚨 **`idxNm` 은 유일하지 않다.** `IT 서비스`·`금융`·`제약` 등 업종지수 20개가
 *      KOSPI/KOSDAQ 양쪽에 같은 이름으로 있다. 구분하려면 `idxCsf` 를 함께 봐야 한다.
 *      `코스피`·`코스닥` 본지수는 각각 1건뿐이라 완전일치로 안전하다 — 확인하고 쓴다.
 *
 *   node pipeline/fetch-index.mjs --dry-run
 *   node pipeline/fetch-index.mjs
 */

import { OUT, p } from './paths.mjs';
import { fetchRetry } from './net.mjs';

const BASE =
  'https://apis.data.go.kr/1160100/service/GetMarketIndexInfoService/getStockMarketIndex';

/** 앱의 `market` 값('KOSPI'|'KOSDAQ')과 짝을 맞춘다. 키를 여기서만 정의한다. */
const INDEXES = [
  { key: 'kospi',  idxNm: '코스피', csf: 'KOSPI시리즈'  },
  { key: 'kosdaq', idxNm: '코스닥', csf: 'KOSDAQ시리즈' },
];

const ABS_MAX_CALLS = 4;    // 지수 2개 + 여유. 늘어날 일이 없다
// fetch-price 와 **같은 창**을 쓴다. 리포트 backfill 이 120일을 거슬러 올라가므로
// 그날의 지수도 함께 있어야 한다 — 창이 다르면 과거 리포트에서만 문장이 빠진다.
const LOOKBACK_DAYS = 800;
const ROWS = 600;
const GAP_MS = 1200;
const TIMEOUT_MS = 25000;

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const rawKey = process.env.DATA_GO_KR_KEY ?? '';

if (!rawKey && !DRY) {
  console.error('서비스키가 없다.  DATA_GO_KR_KEY=<키> node pipeline/fetch-index.mjs');
  process.exit(1);
}

const keyIsEncoded = /%[0-9A-Fa-f]{2}/.test(rawKey);
const serviceKey = keyIsEncoded ? rawKey : encodeURIComponent(rawKey);

const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const minusDay = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() - n); return x; };

let calls = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const buildUrl = (params) => {
  const qs = Object.entries({ serviceKey, resultType: 'json', ...params })
    .map(([k, v]) => (k === 'serviceKey' ? `${k}=${v}` : `${k}=${encodeURIComponent(v)}`))
    .join('&');
  return `${BASE}?${qs}`;
};

async function call(params) {
  const url = buildUrl(params);
  if (DRY) { console.log(`[dry-run]\n  ${url.replace(serviceKey || 'x', '<KEY>')}`); return { ok: true, items: [] }; }
  if (calls >= ABS_MAX_CALLS) throw new Error(`호출 상한 ${ABS_MAX_CALLS} 초과 — 중단`);
  if (calls > 0) await sleep(GAP_MS);
  calls += 1;

  const res = await fetchRetry(url, {}, { timeoutMs: TIMEOUT_MS });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* XML 에러 */ }
  if (!json) return { ok: false, reason: 'JSON 아님', raw: text.slice(0, 300) };

  const err = json.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (err) return { ok: false, reason: `${err.errMsg} (code ${err.returnReasonCode})` };
  const header = json.response?.header;
  if (header && header.resultCode !== '00') return { ok: false, reason: `${header.resultCode} ${header.resultMsg}` };

  const raw = json.response?.body?.items?.item;
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return { ok: true, total: json.response?.body?.totalCount ?? 0, items };
}

/** 문자열로 오는 숫자를 정규화한다. `fltRt` 는 선행 0 없이 `".97"` 로 온다. */
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

async function main() {
  const { mkdirSync, writeFileSync } = await import('node:fs');

  const now = kstNow();
  const endBasDt = ymd(now);
  const beginBasDt = ymd(minusDay(now, LOOKBACK_DAYS));
  console.log(`지수 ${INDEXES.length}개 · 조회범위 ${beginBasDt}~${endBasDt} · 호출 상한 ${ABS_MAX_CALLS}회\n`);

  /** basDt → { kospi, kosdaq }. build-report 가 날짜로 바로 집는다 */
  const days = {};
  const fail = [];

  for (const idx of INDEXES) {
    const r = await call({ idxNm: idx.idxNm, beginBasDt, endBasDt, numOfRows: ROWS, pageNo: 1 });
    if (DRY) break;
    if (!r.ok) { fail.push([idx.idxNm, r.reason]); console.log(`  ✗ ${idx.idxNm} ${r.reason}`); continue; }

    // 완전일치라 해도 확인하고 쓴다 — 업종지수는 이름이 겹친다(위 주석).
    const rows = r.items.filter((x) => String(x.idxNm).trim() === idx.idxNm && String(x.idxCsf).trim() === idx.csf);
    const dropped = r.items.length - rows.length;
    if (!rows.length) { fail.push([idx.idxNm, '행 없음']); console.log(`  ✗ ${idx.idxNm} 행 없음`); continue; }

    for (const x of rows) {
      const basDt = String(x.basDt);
      const clpr = num(x.clpr);
      if (clpr === null) continue;
      (days[basDt] ??= {})[idx.key] = { clpr, vs: num(x.vs), fltRt: num(x.fltRt) };
    }

    const dates = rows.map((x) => String(x.basDt)).sort();
    const last = days[dates[dates.length - 1]]?.[idx.key];
    console.log(
      `  ✓ ${idx.idxNm}  ${String(last?.clpr ?? '—').padStart(9)}  ` +
      `${((last?.fltRt ?? 0) > 0 ? '+' : '') + (last?.fltRt ?? '—')}%  ` +
      `${dates.length}거래일 (${dates[0]}~${dates[dates.length - 1]})${dropped ? ` · 이름겹침 ${dropped}건 버림` : ''}`
    );
  }

  if (DRY) { console.log('\n[dry-run] 종료'); return; }
  if (!Object.keys(days).length) { console.error('\n✗ 받은 지수가 없다'); process.exit(1); }

  const all = Object.keys(days).sort();
  const lastBasDt = all[all.length - 1];

  mkdirSync(p('index'), { recursive: true });
  writeFileSync(p('index/market.json'), JSON.stringify({
    lastBasDt,
    firstBasDt: all[0],
    count: all.length,
    days,
    source: 'data.go.kr 금융위원회_지수시세정보',
    generatedAt: new Date().toISOString(),
  }) + '\n');

  console.log(`\n총 호출 ${calls}회 · ${all.length}거래일 · 최신 ${lastBasDt}`);
  if (fail.length) console.log('실패:', fail.map(([n, r]) => `${n}(${r})`).join(' · '));
  console.log(`→ ${OUT}/index/market.json`);
}

main().catch((e) => { console.error('\n✗', e.message); process.exit(1); });
