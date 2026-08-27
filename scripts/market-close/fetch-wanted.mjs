#!/usr/bin/env node
// ⚠️ 생성된 사본이다. 고치지 말 것.
// 원본: market-close-mini/pipeline/fetch-wanted.mjs
// 갱신: node pipeline/sync-to-hub.mjs
/**
 * fetch-wanted.mjs — Firestore 의 추가 종목 신청을 읽어 out/wanted.json 을 만든다.
 *
 * 서비스 계정도 firebase-admin 도 쓰지 않는다 (HANDOFF §2-c ④):
 * 규칙이 `allow read: if true` 라 공개 REST 한 번이면 되고, **크론에 쓰기 권한을 주지 않는다.**
 *
 * ⚠️ 여기가 남용 방어선이다 (§2-c ⑤). 규칙은 '모양'만 보고 실재는 여기서 검증한다.
 *   ⓐ 6자리 · 끝자리 0 (보통주)      ⓑ tickers.json 에 실재      ⓒ 30일 이내 열람
 *   ⓓ count 내림차순 상한 MAX_WANTED
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { OUT, p } from './paths.mjs';
import { fetchRetry } from './net.mjs';

const PROJECT = 'minilabs-ranking';
const API_KEY = process.env.FIREBASE_WEB_KEY ?? 'AIzaSyB6IulmzT3IcN9LVBce8icId2I1Z1p4sfI';
const COLLECTION = 'market_close_wanted';

const MAX_WANTED = 30;          // 🚧 협상 대상이 아니다. 신청 1개 = 매일 API 호출이 영구히 붙는다
const STALE_DAYS = 30;          // 30일간 아무도 안 본 종목은 수집을 멈춘다 (§2-0)
const PAGE_SIZE = 300;

const DRY = process.argv.includes('--dry-run');

async function fetchAll() {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${COLLECTION}`
    + `?pageSize=${PAGE_SIZE}&key=${API_KEY}`;
  if (DRY) { console.log(`[dry-run] ${url.replace(API_KEY, '<KEY>')}`); return []; }

  const res = await fetchRetry(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    // 규칙 미배포(403)는 '신청 0건'과 같게 취급한다 — 크론 전체를 죽이지 않는다.
    console.warn(`  ⚠ Firestore 읽기 실패 (HTTP ${res.status}) — 신청 없음으로 진행한다`);
    console.warn(`    ${body}`);
    return null;
  }
  const j = await res.json();
  return (j.documents ?? []).map((d) => ({
    ticker: d.fields?.ticker?.stringValue ?? d.name.split('/').pop(),
    count: Number(d.fields?.count?.integerValue ?? 0),
    lastWantedAt: d.fields?.lastWantedAt?.timestampValue ?? null,
  }));
}

async function main() {
  const docs = await fetchAll();
  if (DRY) return;

  mkdirSync(OUT, { recursive: true });

  if (docs === null) {
    writeFileSync(p('wanted.json'), JSON.stringify({ generatedAt: new Date().toISOString(), unavailable: true, items: [] }, null, 2) + '\n');
    console.log('→ wanted.json (0건 · Firestore 접근 불가)');
    return;
  }

  const master = existsSync(p('tickers.json'))
    ? new Map(JSON.parse(readFileSync(p('tickers.json'), 'utf8')).items.map((x) => [x.code, x]))
    : new Map();

  const cutoff = Date.now() - STALE_DAYS * 86400000;
  const drop = {};
  const note = (k) => { drop[k] = (drop[k] ?? 0) + 1; };

  const kept = docs
    .filter((d) => {
      if (!/^[0-9]{6}$/.test(d.ticker)) return note('코드형식'), false;
      if (!d.ticker.endsWith('0')) return note('우선주'), false;
      if (!master.has(d.ticker)) return note('실재하지 않음'), false;
      if (d.lastWantedAt && new Date(d.lastWantedAt).getTime() < cutoff) return note('30일 미열람'), false;
      return true;
    })
    .sort((a, b) => b.count - a.count);

  const overflow = Math.max(0, kept.length - MAX_WANTED);
  const items = kept.slice(0, MAX_WANTED).map((d) => ({
    code: d.ticker,
    name: master.get(d.ticker)?.name ?? d.ticker,
    count: d.count,
    lastWantedAt: d.lastWantedAt,
  }));

  writeFileSync(p('wanted.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    maxWanted: MAX_WANTED, staleDays: STALE_DAYS,
    fetched: docs.length, kept: items.length, overflow,
    items,
  }, null, 2) + '\n');

  console.log(`신청 ${docs.length}건 → 채택 ${items.length}건${overflow ? ` (상한 초과 ${overflow}건 제외)` : ''}`);
  const dropped = Object.entries(drop).map(([k, v]) => `${k} ${v}`).join(' · ');
  if (dropped) console.log(`제외: ${dropped}`);
  for (const it of items) console.log(`  · ${it.code} ${it.name} (신청 ${it.count})`);
  console.log(`→ ${OUT}/wanted.json`);
}

main().catch((e) => { console.error('\n✗', e.message); process.exit(1); });
