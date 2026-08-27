#!/usr/bin/env node
// ⚠️ 생성된 사본이다. 고치지 말 것.
// 원본: market-close-mini/pipeline/fetch-news.mjs
// 갱신: node pipeline/sync-to-hub.mjs
/**
 * fetch-news.mjs — 종목별 그날 뉴스를 구글 뉴스 RSS 에서 받는다.
 *
 *   out/news/{code}.json
 *
 * 키가 필요 없다 (HANDOFF §4 실측: HTTP 200, 삼성전자 109건, 한국어).
 * 의존성 0 — RSS 는 정규식으로 읽는다. XML 파서를 위해 node_modules 를 늘리지 않는다.
 *
 * ⚠️ 종목당 1회. 상한을 코드로 강제한다.
 *    §2-a ⑦ 이 "사업의 진짜 상한은 RSS 호출량" 이라고 지목한 지점이다.
 *
 *   node pipeline/fetch-news.mjs --dry-run
 *   node pipeline/fetch-news.mjs 005930
 *   node pipeline/fetch-news.mjs --preset
 */

import { OUT, p } from './paths.mjs';
import { resolveTargets } from './targets.mjs';

const ABS_MAX_CALLS = 60;
const GAP_MS = 1500;   // 800ms 는 너무 빨랐다 — 간헐적으로 빈 응답이 온다
const TIMEOUT_MS = 20000;
const KEEP = 8;             // 종목당 보관 건수

import { isOpinionHeadline } from './forbidden.mjs';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');

let calls = 0;
let maxCalls = ABS_MAX_CALLS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rssUrl = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`;

const unescapeXml = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? unescapeXml(m[1]) : null;
};

/**
 * 구글 뉴스 제목은 "제목 - 매체명" 형태다. 매체명을 떼어낸다.
 * 하이픈·공백 종류가 섞여 들어와서(‑ – — · NBSP) 정규화한 뒤 비교한다.
 */
const norm = (s) => s.replace(/[\u00A0\u2007\u202F]/g, ' ').replace(/[\u2010-\u2015]/g, '-');

function splitTitle(title, source) {
  let t = norm(title);
  if (source) {
    // ⚠️ 매체명이 두 번 붙어 온다. 매체 피드가 자기 이름을 달고, 구글이 또 단다:
    //    <title>HBM·파운드리 겹호재… 삼성 '양날개' - 머니투데이 - 머니투데이</title>
    //    한 번만 떼면 하나가 남는다. 반복해서 떼되 무한루프를 막는다.
    const suffix = ` - ${norm(source)}`;
    for (let i = 0; i < 3 && t.endsWith(suffix); i += 1) t = t.slice(0, -suffix.length).trim();
    if (t) return t;
  }
  const i = t.lastIndexOf(' - ');
  return i > 15 ? t.slice(0, i).trim() : t;
}

function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const source = tag(b, 'source');
    const rawTitle = tag(b, 'title') ?? '';
    const pub = tag(b, 'pubDate');
    const t = pub ? new Date(pub) : null;
    items.push({
      title: splitTitle(rawTitle, source),
      source: source ?? '출처 미상',
      link: tag(b, 'link'),
      publishedAt: t && !Number.isNaN(t.getTime()) ? t.toISOString() : null,
    });
  }
  return items;
}

/** KST 기준 YYYYMMDD */
const kstYmd = (iso) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
};

async function fetchOnce(query) {
  if (calls >= maxCalls) throw new Error(`호출 상한 ${maxCalls} 초과 — 중단`);
  if (calls > 0) await sleep(GAP_MS);
  calls += 1;

  const res = await fetchRetry(rssUrl(query), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; market-close-mini/0.1)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseRss(await res.text());
}

/**
 * 빈 응답에는 두 가지 원인이 있고 대처가 다르다 (2026-08-27 실측).
 *   ① 일시적   — 20종목 연속 호출 중 간헐적으로 0건이 온다. 재시도하면 온다
 *   ② 진짜 0건 — 'HLB' 처럼 짧은 영문 종목명은 구글 뉴스가 결과를 못 준다.
 *                 '종목명 주가' 로 물으면 나온다 (HLB → 100건)
 * ①은 재시도, ②는 대체 질의로 푼다. 둘 다 시도해야 하는 이유가 여기 있다.
 */
async function fetchNews(name) {
  if (DRY) { console.log(`[dry-run] ${rssUrl(name)}`); return { items: [], query: name }; }

  let items = await fetchOnce(name);
  if (items.length > 0) return { items, query: name };

  items = await fetchOnce(name);                    // ① 재시도
  if (items.length > 0) return { items, query: name, retried: true };

  const alt = `${name} 주가`;                        // ② 대체 질의
  items = await fetchOnce(alt);
  return { items, query: alt, fallback: items.length > 0 };
}

async function main() {
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');

  let targets = resolveTargets(argv);
  if (!targets.length && !DRY) { console.error('종목이 없다. 코드를 주거나 --preset / --wanted'); process.exit(1); }
  if (DRY) targets = [{ code: '005930', name: '삼성전자' }];

  // 리포트 기준일에 맞춘다. 없으면 오늘.
  let basDt = null;
  try { basDt = JSON.parse(readFileSync(p('preset.json'), 'utf8')).basDt; } catch { /* 무시 */ }

  maxCalls = Math.min(ABS_MAX_CALLS * 2, targets.length * 3 + 2);  // 재시도·대체질의 포함
  console.log(`대상 ${targets.length}종목 · 기준일 ${basDt ?? '오늘'} · 상한 ${maxCalls}회\n`);

  mkdirSync(p('news'), { recursive: true });
  for (const { code, name } of targets) {
    try {
      const { items: all, query, retried, fallback } = await fetchNews(name);
      if (DRY) break;
      const how = fallback ? ' [대체질의]' : retried ? ' [재시도]' : '';
      // 의견 헤드라인 제외 — 원문이어도 '고르는 것은 우리'다 (forbidden.mjs 주석 참고)
      const factual = all.filter((n) => !isOpinionHeadline(n.title));
      const droppedOpinion = all.length - factual.length;
      const sameDay = basDt ? factual.filter((n) => n.publishedAt && kstYmd(n.publishedAt) === basDt) : factual;
      // 그날 것이 없으면 최신 순으로 채운다 — 빈 화면보다 낫다. 화면에 날짜를 같이 보여준다.
      const picked = (sameDay.length ? sameDay : factual).slice(0, KEEP);
      writeFileSync(p(`news/${code}.json`), JSON.stringify({
        code, name, basDt, query,
        matchedSameDay: sameDay.length,
        totalFetched: all.length,
        droppedOpinion,
        items: picked,
        source: '구글 뉴스 RSS',
        generatedAt: new Date().toISOString(),
      }, null, 2) + '\n');
      console.log(`  ✓ ${code} ${name.padEnd(12)} 전체 ${String(all.length).padStart(3)} · 의견제외 ${String(droppedOpinion).padStart(2)} · 당일 ${String(sameDay.length).padStart(2)} → ${picked.length}건${how}`);
    } catch (e) {
      console.log(`  ✗ ${code} ${name} — ${e.message}`);
    }
  }
  if (DRY) { console.log('\n[dry-run] 종료'); return; }
  console.log(`\n총 호출 ${calls}회 / 상한 ${maxCalls}회\n→ ${OUT}/news/*.json`);
}

main().catch((e) => { console.error('\n✗', e.message); process.exit(1); });
