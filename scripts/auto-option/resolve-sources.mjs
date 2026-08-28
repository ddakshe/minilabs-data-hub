/**
 * 각 차종의 **현행** 가격표 주소를 찾고, 지난번과 달라진 차종을 골라낸다.
 *
 * 사용: node scripts/auto-option/resolve-sources.mjs [출력.json]
 * 출력: auto-option/sources.json  (id → url·etag·lastModified·size)
 * stdout: 다시 구워야 할 차종 id 를 공백으로 이어 붙인 줄 (없으면 빈 줄)
 *
 * ── 왜 주소를 매번 찾는가 ────────────────────────────────────────
 * 제조사가 연식마다 파일명을 바꾼다. `<모델>-price.pdf` 로 고정해 뒀다가
 * **현대 13종이 2~4년 된 가격표**로 등록된 적이 있다(그랜저는 2022년 10월 파일).
 * 슬러그까지 바뀐다 — sonata → sonata-the-edge, ioniq5 → ioniq-5.
 *
 * 규칙을 코드가 추측하면 내년에 또 틀린다. 후보를 전부 조회해
 * **Last-Modified 가 가장 최근인 것**을 고른다.
 *
 * ── 왜 변경 감지가 필요한가 ──────────────────────────────────────
 * PDF 30개는 75MB 다. 한 차종만 바뀌었는데 전부 받아 파싱하면 시간과 대역폭을
 * 버린다. 더 중요한 건 **가드 판정이 흐려진다**는 것이다 — 원본이 하나만 바뀌었는데
 * 파싱 결과가 열 종에서 달라졌다면 그건 갱신이 아니라 파서 고장이다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { MODELS as CONFIG } from './models.config.mjs';

const out = process.argv[2] ?? 'auto-option/sources.json';
const YEAR = new Date().getFullYear();

async function head(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (!r.ok) return null;
    const lm = r.headers.get('last-modified');
    return {
      url,
      etag: r.headers.get('etag') ?? '',
      lastModified: lm ?? '',
      at: lm ? Date.parse(lm) : 0,
      size: Number(r.headers.get('content-length') ?? 0),
    };
  } catch {
    // 한 차종을 못 찾아도 나머지는 봐야 한다.
    return null;
  }
}

/** 슬러그 × 연식 후보를 모두 조회해 가장 최근 것을 고른다. */
async function resolve(source) {
  const urls = [];
  for (const slug of source.slugs) {
    for (const y of [null, YEAR + 1, YEAR, YEAR - 1, YEAR - 2, YEAR - 3]) {
      for (const name of source.names(slug, y)) urls.push(`${source.base}/${name}`);
    }
  }
  const hits = (await Promise.all([...new Set(urls)].map(head))).filter(Boolean);
  return hits.toSorted((a, b) => b.at - a.at)[0] ?? null;
}

const prev = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
const next = {};
const changed = [];
const missing = [];

// 순서대로 돈다. 동시에 30개를 두드리면 차단당할 수 있다.
for (const cfg of CONFIG) {
  if (cfg.skip) continue;
  const best = await resolve(cfg.source);
  if (!best) {
    missing.push(cfg.label);
    // 못 찾았으면 지난번 주소를 남긴다. 지우면 다음 실행에서 "새 차종" 이 된다.
    if (prev[cfg.id]) next[cfg.id] = prev[cfg.id];
    continue;
  }
  const { at, ...keep } = best;
  next[cfg.id] = keep;

  const p = prev[cfg.id];
  // etag 가 가장 정확하고, 없으면 날짜·크기로 본다.
  const same = p && p.url === keep.url && p.etag === keep.etag && p.lastModified === keep.lastModified;
  if (!same) changed.push(cfg.id);
}

mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
writeFileSync(out, `${JSON.stringify(next, null, 2)}\n`);

if (missing.length > 0) console.error(`⚠️ 주소를 못 찾은 차종: ${missing.join(', ')}`);
console.error(`조회 ${Object.keys(next).length} · 변경 ${changed.length}`);
for (const id of changed) {
  const p = prev[id];
  console.error(`  ${id}: ${p ? `${p.lastModified} → ` : '(신규) '}${next[id].lastModified}`);
}
// 워크플로가 읽어 갈 줄. 비어 있으면 구울 게 없다.
console.log(changed.join(' '));
