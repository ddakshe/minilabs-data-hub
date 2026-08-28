#!/usr/bin/env node
// ⚠️ 생성된 사본이다. 고치지 말 것.
// 원본: market-close-mini/pipeline/build-report.mjs
// 갱신: node pipeline/sync-to-hub.mjs
/**
 * build-report.mjs — price·news·dart 를 합쳐 날짜별 리포트로 쌓는다.
 *
 *   out/reports/{code}/index.json    아카이브 목록 (최근 RETAIN_DAYS 일)
 *   out/reports/{code}/{basDt}.json  그날 상세
 *   out/reports/{code}/latest.json   최신일 사본 — 앱 첫 화면이 1회만 fetch 하면 되게
 *
 * ⚠️ **멱등하다.** 같은 basDt 로 몇 번을 돌려도 그날 항목을 교체할 뿐 중복되지 않는다.
 *    크론을 16:30/17:30/18:30 세 번 거는 설계(§4 ⓑ)가 이걸 전제로 한다.
 *
 * 보존: 저장 120일 (HANDOFF §2-b). 노출 제한은 두지 않는다 —
 *   '노출 5일'은 유료화 유인이 근거였는데 v1 이 광고 모델이라 근거가 사라졌고,
 *   아카이브가 북극성("쌓인다")이라 오히려 다 보여주는 편이 맞다.
 *
 *   node pipeline/build-report.mjs --preset
 */

import { OUT, p } from './paths.mjs';
import { resolveTargets } from './targets.mjs';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildFacts, buildHeadline } from './facts.mjs';
import { checkAll } from './forbidden.mjs';

const RETAIN_DAYS = 120;

const argv = process.argv.slice(2);
/** 이미 받아둔 시계열(out/history)로 과거 날짜를 채운다. API 호출 0회. */
const BACKFILL = argv.includes('--backfill');

const readJSON = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

/**
 * 시계열의 i 번째 날을 '그날의 리포트' 모양으로 되살린다.
 * 52주 창도 그날 기준으로 다시 자른다 — 오늘 기준으로 계산하면 과거 리포트가 거짓이 된다.
 */
function pastReport(rows, i, template) {
  const r = rows[i];
  const cutoff = String(Number(r.basDt.slice(0, 4)) - 1) + r.basDt.slice(4);
  const win = rows.slice(0, i + 1).filter((x) => x.basDt >= cutoff);
  const closes = win.map((x) => x.clpr);
  const low = Math.min(...closes), high = Math.max(...closes);
  const recent5 = rows.slice(Math.max(0, i - 4), i + 1).map((x) => ({
    basDt: x.basDt, fltRt: x.fltRt, open: x.mkp, high: x.hipr, low: x.lopr, close: x.clpr,
  }));
  const vol20 = rows.slice(Math.max(0, i - 20), i).map((x) => x.trqu).filter((v) => v !== null && v > 0);
  const avg20 = vol20.length ? Math.round(vol20.reduce((a, b) => a + b, 0) / vol20.length) : null;

  return {
    code: template.code, name: template.name, market: template.market,
    basDt: r.basDt,
    close: r.clpr, vs: r.vs, fltRt: r.fltRt,
    open: r.mkp, high: r.hipr, low: r.lopr,
    prevClose: r.vs === null ? null : r.clpr - r.vs,
    volume: r.trqu, tradeValue: r.trPrc,
    week52: {
      low, high,
      position: high === low ? 0.5 : (r.clpr - low) / (high - low),
      days: win.length, from: win[0]?.basDt ?? r.basDt,
    },
    recent5,
    volumeVs20d: avg20 && r.trqu !== null ? { avg20, ratio: Number((r.trqu / avg20).toFixed(2)) } : null,
    source: template.source,
    generatedAt: new Date().toISOString(),
  };
}

function main() {
  const codes = resolveTargets(argv).map((t) => t.code);
  if (!codes.length) { console.error('종목이 없다. 코드를 주거나 --preset / --wanted'); process.exit(1); }

  let built = 0, skipped = 0, blocked = 0;

  // 지수는 종목과 무관하게 하루 한 벌이다. 루프 밖에서 한 번만 읽는다.
  // 없으면 `null` 이 흐르고 시장 대비 문장만 조용히 빠진다 — 리포트는 그대로 나온다.
  const index = readJSON(p('index/market.json'));
  const marketAt = (basDt, mkt) => {
    const key = mkt === 'KOSPI' ? 'kospi' : mkt === 'KOSDAQ' ? 'kosdaq' : null;
    const d = key && index?.days?.[basDt]?.[key];
    return d ? { name: key === 'kospi' ? '코스피' : '코스닥', clpr: d.clpr, vs: d.vs, fltRt: d.fltRt } : null;
  };

  for (const code of codes) {
    const price = readJSON(p(`price/${code}.json`));
    if (!price) { skipped += 1; console.log(`  · ${code} 시세 없음 — 건너뜀`); continue; }

    const news = readJSON(p(`news/${code}.json`));
    const dart = readJSON(p(`dart/${code}.json`));
    // 지분공시는 90일 창이라 basDt 와 무관하게 최신 파일을 쓴다 (§17).
    const own = readJSON(p(`ownership/${code}.json`));
    const basDt = price.basDt;

    // ── 사실 문장 + 게이트 ──────────────────────────────────────
    const mkt = marketAt(basDt, price.market);
    const facts = buildFacts(price, mkt);
    const gate = checkAll(facts);
    if (!gate.ok) {
      // 템플릿이라 여기 걸릴 일이 없어야 정상이다. 걸렸다면 템플릿이 바뀐 것이다.
      blocked += 1;
      console.log(`  ✗ ${code} 금지 어휘 게이트에 걸렸다 — 커밋하지 않는다`);
      for (const b of gate.bad) console.log(`      "${b.text}"  ${b.hits.map((h) => `${h.id}:${h.match}`).join(', ')}`);
      continue;
    }

    const dir = p(`reports/${code}`);
    mkdirSync(dir, { recursive: true });

    // ── 전체보기용 캔들 시계열 ──────────────────────────────────────
    // 🔑 **날짜별 상세에 넣지 않고 종목당 한 파일로 뺀다.** 상세 파일마다
    //    120일치를 복제하면 종목당 120배가 되고 git 이 감당하지 못한다.
    //    앱은 '전체보기' 를 누를 때만 이 파일을 받는다 (lazy).
    {
      const hist = readJSON(p(`history/${code}.json`));
      const rows = (hist?.rows ?? []).slice(-RETAIN_DAYS);
      if (rows.length) {
        writeFileSync(`${dir}/candles.json`, JSON.stringify({
          code, name: price.name, market: price.market,
          count: rows.length, firstBasDt: rows[0].basDt, lastBasDt: rows[rows.length - 1].basDt,
          rows: rows.map((x) => ({
            basDt: x.basDt, fltRt: x.fltRt,
            open: x.mkp, high: x.hipr, low: x.lopr, close: x.clpr,
          })),
          source: price.source.api,
          updatedAt: new Date().toISOString(),
        }) + '\n');
      }
    }

    // ── backfill: 과거 거래일을 시계열로 채운다 ──────────────────
    // ⚠️ 뉴스·공시는 소급되지 않는다 (§2-b: 구글 RSS 가 과거를 주지 않는다).
    //    그래서 priceOnly 로 표시하고, 화면에서 그렇게 보여준다. 없는 걸 있는 척하지 않는다.
    let backfilled = 0;
    if (BACKFILL) {
      const hist = readJSON(p(`history/${code}.json`));
      const rows = hist?.rows ?? [];
      const start = Math.max(0, rows.length - RETAIN_DAYS);
      for (let i = start; i < rows.length - 1; i += 1) {
        const row = rows[i];
        // 이미 만든 날은 건드리지 않는다. backfill 은 최초 1회 씨뿌리기다 —
        // 매일 119개 파일을 다시 쓰면 내용이 같아도 git 이 커진다.
        if (existsSync(`${dir}/${row.basDt}.json`)) continue;
        const past = pastReport(rows, i, price);
        const pf = buildFacts(past, marketAt(row.basDt, price.market));
        if (!checkAll(pf).ok) continue;
        writeFileSync(`${dir}/${row.basDt}.json`, JSON.stringify({
          code, name: price.name, market: price.market, basDt: row.basDt,
          price: past, facts: pf, news: [], dart: [], priceOnly: true,
          marketIndex: marketAt(row.basDt, price.market),
          sources: { price: price.source.api, news: null, dart: null, marketIndex: index?.source ?? null },
          builtAt: new Date().toISOString(),
        }, null, 2) + '\n');
        backfilled += 1;
      }
    }

    // ── 그날 상세 ───────────────────────────────────────────────
    const detail = {
      code, name: price.name, market: price.market, basDt,
      price, facts,
      news: news?.items ?? [],
      dart: dart?.items ?? [],
      ownership: own?.items ?? [],
      ownershipWindowDays: own?.windowDays ?? null,
      marketIndex: mkt,
      sources: {
        price: price.source.api,
        news: news?.source ?? null,
        dart: dart?.source ?? null,
        ownership: own?.source ?? null,
        marketIndex: mkt ? index?.source ?? null : null,
      },
      builtAt: new Date().toISOString(),
    };
    // ── 아카이브 목록 (멱등 병합) ─ 을 먼저 만들어 '며칠치 쌓였는지'를 얻는다 ──
    // 🔑 **'쌓인다' 가 이 앱의 존재 이유(§1)인데 리포트에 그 숫자가 없었다.**
    //    앱은 목록 화면에서 종목마다 index.json(28KB)을 받을 수 없다 — 숫자 하나면 된다.

    // ── 아카이브 목록 (멱등 병합) ───────────────────────────────
    const prev = readJSON(`${dir}/index.json`);
    const days = (prev?.days ?? []).filter((d) => d.basDt !== basDt);   // 같은 날은 교체

    if (BACKFILL) {
      const hist = readJSON(p(`history/${code}.json`));
      const rows = hist?.rows ?? [];
      const have = new Set(days.map((d) => d.basDt));
      const start = Math.max(0, rows.length - RETAIN_DAYS);
      for (let i = start; i < rows.length - 1; i += 1) {
        const row = rows[i];
        if (have.has(row.basDt) || row.basDt === basDt) continue;
        const pf = buildFacts(pastReport(rows, i, price), marketAt(row.basDt, price.market));
        days.push({
          basDt: row.basDt, close: row.clpr, fltRt: row.fltRt,
          headline: buildHeadline(pf), newsCount: 0, dartCount: 0, priceOnly: true,
        });
      }
    }

    days.push({
      basDt,
      close: price.close,
      fltRt: price.fltRt,
      headline: buildHeadline(facts),
      newsCount: detail.news.length,
      dartCount: detail.dart.length,
    });
    days.sort((a, b) => b.basDt.localeCompare(a.basDt));               // 최신이 위
    const kept = days.slice(0, RETAIN_DAYS);

    detail.archiveDays = kept.length;
    detail.archiveFrom = kept[kept.length - 1]?.basDt ?? basDt;
    writeFileSync(`${dir}/${basDt}.json`, JSON.stringify(detail, null, 2) + '\n');
    writeFileSync(`${dir}/latest.json`, JSON.stringify(detail, null, 2) + '\n');

    writeFileSync(`${dir}/index.json`, JSON.stringify({
      code, name: price.name, market: price.market,
      retainDays: RETAIN_DAYS,
      firstBasDt: kept[kept.length - 1]?.basDt ?? basDt,
      lastBasDt: kept[0]?.basDt ?? basDt,
      count: kept.length,
      days: kept,
      updatedAt: new Date().toISOString(),
    }, null, 2) + '\n');

    built += 1;
    const isNew = !prev?.days?.some((d) => d.basDt === basDt);
    console.log(`  ✓ ${code} ${price.name.padEnd(12)} ${basDt} ${isNew ? '신규' : '갱신'} · 누적 ${String(kept.length).padStart(3)}일${backfilled ? ` (backfill ${backfilled})` : ''} · 뉴스 ${detail.news.length} 공시 ${detail.dart.length}`);
  }

  // ── 지수 한 줄 — 앱 헤더용 ───────────────────────────────────
  // 🔑 **종목과 무관한 전역 사실이라 파일도 하나다.** 리포트마다 넣으면 같은 값이
  //    종목 수만큼 복제되고, 헤더는 종목을 열기 전에도 그려야 한다.
  if (index?.lastBasDt) {
    // 🚨 **하루치만 실으면 아카이브에서 거짓말이 된다.** 기록에서 6월 리포트를 열면
    //    헤더 날짜는 6월인데 지수만 오늘 것이 남는다. 아카이브 보존 기간만큼 함께 싣는다
    //    (120거래일 × 2지수 ≈ 12KB, 앱이 시작에 한 번만 받는다).
    const keep = Object.keys(index.days).sort().slice(-RETAIN_DAYS);
    const days = {};
    for (const k of keep) days[k] = index.days[k];
    writeFileSync(p('market.json'), JSON.stringify({
      lastBasDt: index.lastBasDt,
      count: keep.length,
      days,
      source: index.source,
      updatedAt: new Date().toISOString(),
    }) + '\n');
    console.log(`→ ${OUT}/market.json (${keep.length}일 · 최신 ${index.lastBasDt})`);
  }

  console.log(`\n생성 ${built} · 건너뜀 ${skipped} · 게이트 차단 ${blocked}`);
  console.log(`→ ${OUT}/reports/{code}/`);
  if (blocked > 0) process.exit(1);   // 크론이 실패로 인지해야 한다
}

main();
