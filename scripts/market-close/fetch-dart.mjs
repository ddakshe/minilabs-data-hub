#!/usr/bin/env node
// ⚠️ 생성된 사본이다. 고치지 말 것.
// 원본: market-close-mini/pipeline/fetch-dart.mjs
// 갱신: node pipeline/sync-to-hub.mjs
/**
 * fetch-dart.mjs — 종목별 그날 공시를 DART OpenAPI 에서 받는다.
 *
 *   out/corpmap.json    종목코드 → DART corp_code (주 1회 갱신)
 *   out/dart/{code}.json
 *
 * HANDOFF §5-6 "DART corp_code 매핑 비용 확인" 이 여기서 해소된다.
 *
 * ⚠️ corpCode.xml 은 ZIP(3.6MB) 으로 오고 압축 해제 후 30MB XML 에 118,784건이 들어 있다.
 *    이걸 매일 받으면 낭비다 → out/corpmap.json 에 캐시하고 7일마다만 갱신한다.
 *    Node 에 zip 해제가 없어 `unzip` CLI 를 쓴다 (macOS·ubuntu-latest 러너 모두 기본 탑재).
 *
 *   node pipeline/fetch-dart.mjs --map-only    매핑만 갱신
 *   node pipeline/fetch-dart.mjs --preset
 */

import { OUT, p } from './paths.mjs';
import { fetchRetry } from './net.mjs';
import { resolveTargets } from './targets.mjs';

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEY = process.env.DART_API_KEY ?? '';
const MAP_PATH = p('corpmap.json');
const MAP_TTL_DAYS = 7;
const ABS_MAX_CALLS = 60;
const GAP_MS = 300;
const TIMEOUT_MS = 25000;

const argv = process.argv.slice(2);
const MAP_ONLY = argv.includes('--map-only');

if (!KEY) { console.error('DART_API_KEY 가 없다. ~/.config/stock-tools/dart.env'); process.exit(1); }

let calls = 0;
let maxCalls = ABS_MAX_CALLS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── ① corp_code 매핑 ─────────────────────────────────────────────
function mapIsFresh() {
  if (!existsSync(MAP_PATH)) return false;
  const ageDays = (Date.now() - statSync(MAP_PATH).mtimeMs) / 86400000;
  return ageDays < MAP_TTL_DAYS;
}

async function buildCorpMap() {
  console.log('corp_code 매핑 생성 — corpCode.xml 내려받는 중…');
  const res = await fetchRetry(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${KEY}`, {
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`corpCode HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  // 에러는 ZIP 이 아니라 XML 로 온다
  if (buf.subarray(0, 2).toString() !== 'PK') {
    throw new Error(`ZIP 이 아니다: ${buf.subarray(0, 200).toString('utf8')}`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'dartmap-'));
  try {
    const zipPath = join(dir, 'corp.zip');
    writeFileSync(zipPath, buf);
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', dir]);
    const xml = readFileSync(join(dir, 'CORPCODE.xml'), 'utf8');

    const map = {};
    let total = 0;
    for (const m of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
      total += 1;
      const b = m[1];
      const stock = (b.match(/<stock_code>([\s\S]*?)<\/stock_code>/)?.[1] ?? '').trim();
      if (!/^[0-9]{6}$/.test(stock)) continue;   // 비상장은 공백이다
      const corp = (b.match(/<corp_code>([\s\S]*?)<\/corp_code>/)?.[1] ?? '').trim();
      const name = (b.match(/<corp_name>([\s\S]*?)<\/corp_name>/)?.[1] ?? '').trim();
      map[stock] = { corp, name };
    }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(MAP_PATH, JSON.stringify({
      generatedAt: new Date().toISOString(),
      totalEntries: total,
      listedCount: Object.keys(map).length,
      map,
    }, null, 0) + '\n');
    console.log(`  전체 ${total.toLocaleString()}건 중 상장 ${Object.keys(map).length.toLocaleString()}건 → ${MAP_PATH}`);
    return map;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function getCorpMap() {
  if (mapIsFresh()) {
    const j = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
    console.log(`corp_code 매핑 캐시 사용 — 상장 ${j.listedCount.toLocaleString()}건`);
    return j.map;
  }
  return buildCorpMap();
}

// ── ② 일자별 공시 ────────────────────────────────────────────────
async function fetchDisclosures(corp, basDt) {
  if (calls >= maxCalls) throw new Error(`호출 상한 ${maxCalls} 초과 — 중단`);
  if (calls > 0) await sleep(GAP_MS);
  calls += 1;

  const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${KEY}`
    + `&corp_code=${corp}&bgn_de=${basDt}&end_de=${basDt}&page_count=50`;
  const res = await fetchRetry(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const j = await res.json();

  // 013 = 조회된 데이터가 없습니다 (정상)
  if (j.status === '013') return [];
  if (j.status !== '000') throw new Error(`${j.status} ${j.message}`);

  return (j.list ?? []).map((d) => ({
    title: d.report_nm,
    filer: d.flr_nm,
    receiptNo: d.rcept_no,
    date: d.rcept_dt,
    link: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${d.rcept_no}`,
  }));
}

async function main() {
  const map = await getCorpMap();
  if (MAP_ONLY) return;

  const targets = resolveTargets(argv).map((t) => ({ code: t.code, name: map[t.code]?.name ?? t.name }));
  if (!targets.length) { console.error('종목이 없다. 코드를 주거나 --preset / --wanted'); process.exit(1); }

  const basDt = JSON.parse(readFileSync(p('preset.json'), 'utf8')).basDt;
  maxCalls = Math.min(ABS_MAX_CALLS, targets.length + 2);
  console.log(`\n대상 ${targets.length}종목 · 기준일 ${basDt} · 상한 ${maxCalls}회\n`);

  mkdirSync(p('dart'), { recursive: true });
  let missing = 0;
  for (const { code, name } of targets) {
    const hit = map[code];
    if (!hit) { missing += 1; console.log(`  ✗ ${code} ${name} — corp_code 없음`); continue; }
    try {
      const items = await fetchDisclosures(hit.corp, basDt);
      writeFileSync(p(`dart/${code}.json`), JSON.stringify({
        code, name, corpCode: hit.corp, basDt,
        items, source: 'DART OpenAPI', generatedAt: new Date().toISOString(),
      }, null, 2) + '\n');
      console.log(`  ✓ ${code} ${name.padEnd(12)} ${items.length}건`);
    } catch (e) {
      console.log(`  ✗ ${code} ${name} — ${e.message}`);
    }
  }
  console.log(`\n매핑 누락 ${missing} · 총 호출 ${calls}회 / 상한 ${maxCalls}회\n→ ${OUT}/dart/*.json`);
}

main().catch((e) => { console.error('\n✗', e.message); process.exit(1); });
