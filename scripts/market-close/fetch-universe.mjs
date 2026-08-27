#!/usr/bin/env node
// ⚠️ 생성된 사본이다. 고치지 말 것.
// 원본: market-close-mini/pipeline/fetch-universe.mjs
// 갱신: node pipeline/sync-to-hub.mjs
/**
 * fetch-universe.mjs — 하루치 전종목을 받아 두 파일을 만든다.
 *
 *   out/tickers.json   전종목 마스터 (앱의 종목 검색 + 크론의 신청 검증에 함께 쓴다)
 *   out/preset.json    프리셋 20 = 코스피 10 + 코스닥 10 (시총 순)
 *
 * 설계 근거: HANDOFF.md §2-0 · §4
 *
 * ⚠️ 호출 상한을 코드로 강제한다(MAX_CALLS). data.go.kr 개발계정은 10,000건/일이고
 *    루프 버그 한 번이 그것을 태운다. probe-datagokr.mjs 와 같은 방침이다.
 *
 *   node pipeline/fetch-universe.mjs --dry-run     요청 모양만 (호출 0회)
 *   node pipeline/fetch-universe.mjs               DATA_GO_KR_KEY 사용
 */

import { OUT, p } from './paths.mjs';

const BASE =
  'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo';

const MAX_CALLS = 8;        // 하드 캡 — 어떤 경로로도 넘지 않는다
const PAGE_SIZE = 1000;     // 하루치 전종목 ~2,900건 → 3페이지
const MAX_DAY_WALK = 4;     // 데이터 없는 날(휴장·미반영) 되짚기 한도
const GAP_MS = 1200;
const TIMEOUT_MS = 25000;

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const rawKey = argv.find((a) => !a.startsWith('--')) ?? process.env.DATA_GO_KR_KEY ?? '';

if (!rawKey && !DRY) {
  console.error('서비스키가 없다.  DATA_GO_KR_KEY=<키> node pipeline/fetch-universe.mjs');
  process.exit(1);
}

// Encoding/Decoding 키 자동 판별 (probe-datagokr.mjs 와 동일한 함정 회피)
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

async function call(label, params) {
  const url = buildUrl(params);
  if (DRY) {
    console.log(`[dry-run] ${label}\n  ${url.replace(serviceKey || 'serviceKey=', '<KEY>')}`);
    return { ok: true, total: 0, items: [] };
  }
  if (calls >= MAX_CALLS) throw new Error(`호출 상한 ${MAX_CALLS} 초과 — 중단`);
  if (calls > 0) await sleep(GAP_MS);
  calls += 1;

  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* XML 에러 응답 */ }
  if (!json) return { ok: false, reason: 'JSON 아님', raw: text.slice(0, 300) };

  const err = json.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (err) return { ok: false, reason: `${err.errMsg} (code ${err.returnReasonCode})` };

  const header = json.response?.header;
  if (header && header.resultCode !== '00') {
    return { ok: false, reason: `resultCode=${header.resultCode} ${header.resultMsg}` };
  }
  const body = json.response?.body;
  const raw = body?.items?.item;
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return { ok: true, total: body?.totalCount ?? 0, items };
}

// ── 유니버스 규칙 ────────────────────────────────────────────────
// 이건 '종목 선정'이 아니라 '유니버스 정의'다. 기계적으로 적용하고 규칙을 공개한다.
// (HANDOFF §1 "사람이 고르면 안 된다" / §4 우선주 규칙)
const SPAC_RE = /스팩|기업인수목적/;
const REIT_RE = /리츠|위탁관리부동산투자회사|기업구조조정부동산투자회사/;

function classify(it) {
  const code = String(it.srtnCd ?? '').trim();
  const name = String(it.itmsNm ?? '').trim();
  const mkt  = String(it.mrktCtg ?? '').trim().toUpperCase();

  if (!/^[0-9]{6}$/.test(code)) return { drop: '코드형식' };
  if (mkt !== 'KOSPI' && mkt !== 'KOSDAQ') return { drop: `시장(${mkt || '미상'})` };
  if (!code.endsWith('0')) return { drop: '우선주' };        // 5·7·9 = 우선주
  if (SPAC_RE.test(name)) return { drop: '스팩' };
  if (REIT_RE.test(name)) return { drop: '리츠' };
  return { drop: null, code, name, mkt, cap: Number(it.mrktTotAmt ?? 0) };
}

async function main() {
  const now = kstNow();
  console.log(`기준 시각(KST) ${now.toISOString().slice(0, 16).replace('T', ' ')}`);
  console.log(`호출 상한 ${MAX_CALLS}회\n`);

  // ① 데이터가 있는 가장 최근 일자를 찾는다 (휴장·미반영이면 하루씩 되짚는다)
  let basDt = null, first = null;
  for (let back = 0; back <= MAX_DAY_WALK; back += 1) {
    const cand = ymd(minusDay(now, back));
    const r = await call(`전종목 ${cand} p1`, { basDt: cand, numOfRows: PAGE_SIZE, pageNo: 1 });
    if (!r.ok) { console.error(`  ✗ ${cand}: ${r.reason}`); if (DRY) break; continue; }
    if (r.total > 0) { basDt = cand; first = r; console.log(`  ✓ 기준일 ${cand} — totalCount ${r.total}`); break; }
    console.log(`  · ${cand}: 데이터 없음 (휴장 또는 미반영)`);
  }
  if (DRY) { console.log('\n[dry-run] 종료'); return; }
  if (!basDt) throw new Error(`최근 ${MAX_DAY_WALK + 1}일 안에 데이터가 있는 날이 없다`);

  // ② 남은 페이지
  const items = [...first.items];
  const pages = Math.ceil(first.total / PAGE_SIZE);
  for (let p = 2; p <= pages; p += 1) {
    const r = await call(`전종목 ${basDt} p${p}`, { basDt, numOfRows: PAGE_SIZE, pageNo: p });
    if (!r.ok) throw new Error(`p${p} 실패: ${r.reason}`);
    items.push(...r.items);
  }
  console.log(`  수집 ${items.length}건 / ${pages}페이지 / 호출 ${calls}회\n`);

  // ③ 규칙 적용
  const kept = [];
  const dropped = {};
  for (const it of items) {
    const c = classify(it);
    if (c.drop) { dropped[c.drop] = (dropped[c.drop] ?? 0) + 1; continue; }
    kept.push(c);
  }
  console.log('제외 내역:', Object.entries(dropped).map(([k, v]) => `${k} ${v}`).join(' · '));
  console.log(`유니버스 ${kept.length}종목\n`);

  const top = (mkt, n) => kept.filter((x) => x.mkt === mkt).sort((a, b) => b.cap - a.cap).slice(0, n);
  const kospi = top('KOSPI', 10);
  const kosdaq = top('KOSDAQ', 10);

  const won = (v) => `${(v / 1e12).toFixed(1)}조`;
  for (const [label, list] of [['KOSPI', kospi], ['KOSDAQ', kosdaq]]) {
    console.log(`── ${label} 상위 10`);
    list.forEach((x, i) => console.log(`  ${String(i + 1).padStart(2)}. ${x.code} ${x.name.padEnd(12)} ${won(x.cap)}`));
    console.log();
  }

  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(OUT, { recursive: true });
  writeFileSync(p('tickers.json'), JSON.stringify({
    basDt, generatedAt: new Date().toISOString(),
    rule: '보통주(코드 끝자리 0) · 스팩/리츠 제외 · KOSPI/KOSDAQ 만',
    count: kept.length,
    items: kept.map(({ code, name, mkt }) => ({ code, name, mkt })),
  }, null, 0) + '\n');

  writeFileSync(p('preset.json'), JSON.stringify({
    basDt, generatedAt: new Date().toISOString(),
    rule: '시가총액(mrktTotAmt) 내림차순 · 시장별 10개',
    kospi: kospi.map(({ code, name, cap }) => ({ code, name, cap })),
    kosdaq: kosdaq.map(({ code, name, cap }) => ({ code, name, cap })),
  }, null, 2) + '\n');

  console.log(`총 호출 ${calls}회 / 상한 ${MAX_CALLS}회`);
  console.log(`→ ${OUT}/tickers.json · ${OUT}/preset.json`);
}

main().catch((e) => { console.error('\n✗', e.message); process.exit(1); });
