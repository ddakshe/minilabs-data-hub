#!/usr/bin/env node
// ⚠️ 생성된 사본이다. 고치지 말 것.
// 원본: market-close-mini/pipeline/fetch-price.mjs
// 갱신: node pipeline/sync-to-hub.mjs
/**
 * fetch-price.mjs — 종목별 시계열을 받아 리포트 입력을 만든다.
 *
 *   out/price/{code}.json
 *
 * 화면 명세와의 대응은 HANDOFF.md §4-a 표 그대로다.
 *   종가/전일대비/등락률   clpr vs fltRt
 *   거래량/거래대금        trqu trPrc
 *   2×2 웰                mkp · clpr-vs(전일종가) · hipr · lopr
 *   52주 트랙              52주 clpr min/max + 현재가 위치
 *   최근 5거래일 막대       fltRt 5일치
 *   '평균 대비 거래량' 문장  trqu 20일 평균
 *
 * ⚠️ 종목당 1회 호출. 상한을 코드로 강제한다(MAX_CALLS).
 *
 *   node pipeline/fetch-price.mjs --dry-run
 *   node pipeline/fetch-price.mjs 005930 000660     특정 종목만
 *   node pipeline/fetch-price.mjs --preset          out/preset.json 의 20종목
 */

import { OUT, p } from './paths.mjs';
import { fetchRetry } from './net.mjs';
import { resolveTargets } from './targets.mjs';

const BASE =
  'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo';

const ABS_MAX_CALLS = 60;   // 절대 상한 — 종목 수와 무관하게 넘지 않는다
// 아카이브 backfill 때문에 1년치로는 부족하다. 120일 전 리포트도 '그날 기준 1년' 창이
// 필요하므로 365 + 120 거래일(~175 달력일) + 휴장 여유 → 800 달력일을 받는다.
// numOfRows 를 키우면 되므로 **호출 횟수는 그대로 종목당 1회**다.
const LOOKBACK_DAYS = 800;
const ROWS = 600;           // 800 달력일 ≈ 545 거래일 + 여유
const GAP_MS = 1200;
const TIMEOUT_MS = 25000;

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const rawKey = process.env.DATA_GO_KR_KEY ?? '';

if (!rawKey && !DRY) {
  console.error('서비스키가 없다.  DATA_GO_KR_KEY=<키> node pipeline/fetch-price.mjs ...');
  process.exit(1);
}

const keyIsEncoded = /%[0-9A-Fa-f]{2}/.test(rawKey);
const serviceKey = keyIsEncoded ? rawKey : encodeURIComponent(rawKey);

const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const minusDay = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() - n); return x; };

let calls = 0;
let maxCalls = ABS_MAX_CALLS;
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
  if (calls >= maxCalls) throw new Error(`호출 상한 ${maxCalls} 초과 — 중단`);
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

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/**
 * 🚨 **거래정지일은 시가·고가·저가·거래량이 `0` 으로 온다.** 종가만 직전 값을 그대로 들고
 *    등락률도 0 이다 (실측: 한화 20260730~0824 · 리노공업 20250410~0424 ·
 *    삼성바이오로직스 20251030~1121 — 24종목 중 3종목).
 *    **0 원짜리 가격은 없다.** 그대로 두면 캔들이 바닥에서 천장까지 solid 로 서고,
 *    20일 평균 거래량이 0 에 눌려 '평균의 5배' 같은 거짓 문장이 나온다.
 *    가격은 `null`(그날은 값이 없다)로 바꾸고, 거래량 0 은 사실이므로 남기되
 *    **평균에서는 뺀다.**
 */
const price = (v) => { const n = num(v); return n === 0 ? null : n; };

/** 시계열 → 리포트 입력. 순수 함수라 테스트가 쉽다. */
function buildPriceReport(code, rows) {
  // basDt 오름차순 정렬. API 정렬 순서를 신뢰하지 않는다.
  const s = rows
    .filter((r) => String(r.srtnCd).trim() === code)
    .map((r) => ({
      basDt: String(r.basDt), clpr: num(r.clpr), vs: num(r.vs), fltRt: num(r.fltRt),
      mkp: price(r.mkp), hipr: price(r.hipr), lopr: price(r.lopr),
      trqu: num(r.trqu), trPrc: num(r.trPrc),
      name: String(r.itmsNm).trim(), mkt: String(r.mrktCtg).trim(),
    }))
    .filter((r) => r.clpr !== null)
    .sort((a, b) => a.basDt.localeCompare(b.basDt));

  if (s.length === 0) return null;

  const last = s[s.length - 1];

  // 52주는 '조회해온 전부'가 아니라 기준일로부터 정확히 365일이다.
  // LOOKBACK_DAYS 는 휴장을 감안한 여유분이라 그대로 쓰면 13개월이 섞인다.
  const cutoff = ymd(minusDay(
    new Date(`${last.basDt.slice(0, 4)}-${last.basDt.slice(4, 6)}-${last.basDt.slice(6, 8)}T00:00:00Z`),
    365,
  ));
  const win52 = s.filter((r) => r.basDt >= cutoff);
  const closes = win52.map((r) => r.clpr);
  const low52 = Math.min(...closes);
  const high52 = Math.max(...closes);

  // 🔑 **5일은 그대로 두고 시·고·저·종을 얹는다.** 캔들(윗꼬리·아랫꼬리)을 그리려면
  //    등락률만으로는 부족하다. 시계열에 이미 있는 값이라 **호출은 늘지 않는다.**
  //    필드 이름을 `recent5` 로 두는 이유: 이미 커밋된 아카이브 상세 수천 개가
  //    이 이름을 쓰고 있다. 개수가 5로 유지되는 한 이름이 거짓이 아니다.
  const recent5 = s.slice(-5).map((r) => ({
    basDt: r.basDt, fltRt: r.fltRt,
    open: r.mkp, high: r.hipr, low: r.lopr, close: r.clpr,
  }));
  // 거래정지일(거래량 0)은 평균에서 뺀다. 넣으면 평균이 눌려 배수가 부풀려진다.
  const vol20 = s.slice(-21, -1).map((r) => r.trqu).filter((v) => v !== null && v > 0);
  const avgVol20 = vol20.length ? Math.round(vol20.reduce((a, b) => a + b, 0) / vol20.length) : null;

  return {
    /** 전체 시계열. 아카이브 backfill 용 — 이미 받아온 데이터를 버리지 않는다. */
    series: s,
    code, name: last.name, market: last.mkt,
    basDt: last.basDt,
    close: last.clpr, vs: last.vs, fltRt: last.fltRt,
    open: last.mkp, high: last.hipr, low: last.lopr,
    prevClose: last.vs === null ? null : last.clpr - last.vs,
    volume: last.trqu, tradeValue: last.trPrc,
    week52: {
      low: low52, high: high52,
      // 트랙 위 점의 위치(0~1). 52주 최저=0, 최고=1
      position: high52 === low52 ? 0.5 : (last.clpr - low52) / (high52 - low52),
      days: win52.length,
      from: cutoff,
    },
    recent5,
    volumeVs20d: avgVol20 ? { avg20: avgVol20, ratio: Number((last.trqu / avgVol20).toFixed(2)) } : null,
    source: { api: 'data.go.kr 금융위원회_주식시세정보', rows: s.length, rows52w: win52.length },
    generatedAt: new Date().toISOString(),
  };
}

async function main() {
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');

  const codes = resolveTargets(argv).map((t) => t.code);
  if (codes.length === 0) {
    console.error('종목이 없다.  종목코드를 인자로 주거나 --preset / --wanted 를 쓴다.');
    process.exit(1);
  }

  maxCalls = Math.min(ABS_MAX_CALLS, codes.length + 4);
  const now = kstNow();
  const endBasDt = ymd(now);
  const beginBasDt = ymd(minusDay(now, LOOKBACK_DAYS));

  console.log(`대상 ${codes.length}종목 · 조회범위 ${beginBasDt}~${endBasDt}`);
  console.log(`호출 상한 ${maxCalls}회 (절대 상한 ${ABS_MAX_CALLS})\n`);

  mkdirSync(p('price'), { recursive: true });
  const ok = [], fail = [];

  for (const code of codes) {
    const r = await call({ likeSrtnCd: code, beginBasDt, endBasDt, numOfRows: ROWS, pageNo: 1 });
    if (DRY) break;
    if (!r.ok) { fail.push([code, r.reason]); console.log(`  ✗ ${code} ${r.reason}`); continue; }

    const rep = buildPriceReport(code, r.items);
    if (!rep) { fail.push([code, '해당 종목 행 없음']); console.log(`  ✗ ${code} 행 없음`); continue; }

    // 시계열은 따로 저장한다. 앱에는 안 나가고 build-report --backfill 만 쓴다.
    const { series, ...daily } = rep;
    mkdirSync(p('history'), { recursive: true });
    writeFileSync(p(`history/${code}.json`), JSON.stringify({ code, name: rep.name, market: rep.market, rows: series }) + '\n');
    writeFileSync(p(`price/${code}.json`), JSON.stringify(daily, null, 2) + '\n');
    ok.push(daily);
    const sign = rep.fltRt > 0 ? '+' : '';
    console.log(
      `  ✓ ${code} ${rep.name.padEnd(12)} ${rep.close.toLocaleString().padStart(9)}원 ` +
      `${(sign + rep.fltRt).padStart(6)}%  52주 ${(rep.week52.position * 100).toFixed(0).padStart(3)}%  ` +
      `${rep.week52.days}일치`
    );
  }

  if (DRY) { console.log('\n[dry-run] 종료'); return; }
  console.log(`\n성공 ${ok.length} · 실패 ${fail.length} · 총 호출 ${calls}회 / 상한 ${maxCalls}회`);
  if (fail.length) console.log('실패:', fail.map(([c, r]) => `${c}(${r})`).join(' · '));
  console.log(`→ ${OUT}/price/*.json`);
}

main().catch((e) => { console.error('\n✗', e.message); process.exit(1); });
