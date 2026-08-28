/**
 * 가격표 PDF 를 받아 파싱해 JSON 으로 굽는다.
 *
 * 사용: node scripts/auto-option/bake.mjs <출력.json>
 *
 * 무엇을 굽고 무엇을 예외로 손볼지는 **models.config.mjs** 에 있다. 여기는 그 표를
 * 실행하는 기계일 뿐이다. 차종을 더하거나 예외를 두려면 이 파일이 아니라 그 표를 고친다.
 *
 * 예전에는 굽을 목록이 셸 인자에 있었다. zsh 가 여러 줄 인자를 다르게 펼치는 바람에
 * 실행할 때마다 **다른 차종이 조용히 빠졌고**, 결과 파일 크기를 비교하기 전까지
 * 아무도 몰랐다. 목록은 코드에 있어야 한다.
 *
 * PDF 는 저장하지 않고 매번 받는다. 75MB 를 git 에 넣을 이유가 없고, Actions 는
 * poppler 만 설치하면 그 자리에서 받아 쓸 수 있다.
 * 로컬에서는 캐시가 있으면 다시 받지 않는다 — 파서를 고치며 수십 번 돌리게 된다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { MODELS as CONFIG } from './models.config.mjs';

const out = process.argv[2];
if (!out) {
  console.error('사용: node scripts/auto-option/bake.mjs <출력.json>');
  process.exit(1);
}

/** 받은 PDF 를 두는 곳. git 에는 올리지 않는다. */
const CACHE = process.env.AUTO_OPTION_PDF_CACHE ?? '.pdf-cache';
mkdirSync(CACHE, { recursive: true });

/**
 * 가격표를 받는다. 이미 있고 비어 있지 않으면 다시 받지 않는다 —
 * 로컬에서 파서를 고치며 수십 번 돌리는데 매번 75MB 를 받을 이유가 없다.
 * CI 는 캐시가 비어 있으니 항상 새로 받는다.
 */
function fetchPdf(url, id) {
  const dest = path.join(CACHE, `${id}.pdf`);
  if (existsSync(dest) && statSync(dest).size > 10_000) return dest;
  execFileSync('curl', ['-sS', '-fL', '--retry', '3', '--max-time', '120', '-o', dest, url]);
  if (!existsSync(dest) || statSync(dest).size < 10_000) throw new Error(`빈 PDF: ${url}`);
  return dest;
}

const PARSERS = {
  kia: 'parse-kia.mjs',
  'kia-ev': 'parse-kia-ev.mjs',
  hyundai: 'parse-hyundai.mjs',
};

/** 격자 칸 문자열 → 상태. 이 세 가지가 가격표의 전부다. */
function cell(v) {
  if (v === '-' || v === '') return { kind: 'locked' };
  if (v === '기본') return { kind: 'included' };
  const m = /^([\d,]+)만$/.exec(v);
  return m ? { kind: 'paid', price: Number(m[1].replace(/,/g, '')) } : { kind: 'locked' };
}

/** dropOptions/dropTrims 는 문자열도 정규식도 받는다. */
const matches = (patterns, value) =>
  (patterns ?? []).some((p) => (p instanceof RegExp ? p.test(value) : p === value));

/**
 * 구운 결과가 쓸 만한지 본다.
 *
 * 지금까지 이름 없는 옵션(화면에 빈 줄로 보였다)과 통째로 빠진 차종이 조용히
 * 통과했다. 굽는 단계에서 못 걸러내면 화면에서 발견하게 되고, 그때는 원인이
 * 파서인지 설정인지 알 수 없다.
 */
function validate(m) {
  const bad = [];
  if (m.trims.length === 0) bad.push('트림이 없다');
  if (m.options.length === 0) bad.push('옵션이 없다');
  if (m.trims.some((t) => !(t.price > 0))) bad.push('기본가가 0 이하인 트림이 있다');
  if (m.options.some((o) => o.name.trim().length < 2)) bad.push('이름이 빈 옵션이 있다');

  const names = m.trims.map((t) => t.name);
  for (const o of m.options) {
    const missing = names.filter((n) => !o.byTrim[n]);
    if (missing.length > 0) {
      bad.push(`"${o.name}" 에 ${missing.join('/')} 트림 상태가 없다`);
      break;
    }
  }
  return bad;
}

const models = [];
let skipped = 0;
let failed = 0;

for (const cfg of CONFIG) {
  if (cfg.skip) {
    console.error(`⏭  ${cfg.label}: ${cfg.skip}`);
    skipped += 1;
    continue;
  }

  const parser = PARSERS[cfg.parser];
  if (!parser) {
    console.error(`✗ ${cfg.label}: 모르는 파서 "${cfg.parser}"`);
    failed += 1;
    continue;
  }

  let parsed;
  try {
    const pdf = fetchPdf(cfg.url, cfg.id);
    parsed = JSON.parse(
      execFileSync('node', [new URL(`./${parser}`, import.meta.url).pathname, pdf], {
        encoding: 'utf8',
      }),
    );
  } catch {
    // 경고 문구는 파서가 이미 냈다. 한 차종이 안 된다고 나머지를 못 굽게 하지 않는다.
    console.error(`✗ ${cfg.label}: 파싱 실패`);
    failed += 1;
    continue;
  }

  // 현대 파서는 원본에 격자가 없어 직접 세워서 준다. 기아는 격자 후보를 여럿 준다.
  let trims;
  let options;
  if (parsed.options) {
    trims = parsed.trims;
    options = parsed.options;
  } else {
    // 격자가 여러 개면 가장 큰 것이 본 표다. 작은 표는 특장·액세서리인 경우가 많다.
    // 자동 선택이 틀리는 차종은 설정에서 grid 로 지정한다.
    const grid =
      cfg.grid !== undefined
        ? parsed.grids[cfg.grid]
        : parsed.grids.toSorted(
            (a, b) => b.rows.length * b.options.length - a.rows.length * a.options.length,
          )[0];
    if (!grid) {
      console.error(`✗ ${cfg.label}: 격자를 못 찾았다`);
      failed += 1;
      continue;
    }
    const rowNames = grid.rows.map((r) => r.trim);
    trims = parsed.trims.filter((t) => rowNames.includes(t.name));
    options = grid.options
      .map((name, i) => ({ name: name.replace('*', '').trim(), i }))
      .filter(({ name }) => name.length > 1)
      .map(({ name, i }) => {
        // 구성품에 섞여 들어온 ※ 주석은 잘라낸다 — 안내지 구성품이 아니다.
        const detail = (parsed.contents?.[name] ?? '').split('※')[0].trim();
        return {
          name,
          includes: detail ? detail.split(/,\s*/).filter(Boolean) : [],
          byTrim: Object.fromEntries(grid.rows.map((r) => [r.trim, cell(r.cells[i])])),
        };
      });
  }

  // ── 차종별 예외 ──
  if (cfg.dropTrims) trims = trims.filter((t) => !matches(cfg.dropTrims, t.name));
  if (cfg.dropOptions) options = options.filter((o) => !matches(cfg.dropOptions, o.name));
  if (cfg.renameTrims) {
    trims = trims.map((t) => ({ ...t, name: cfg.renameTrims[t.name] ?? t.name }));
    options = options.map((o) => ({
      ...o,
      byTrim: Object.fromEntries(
        Object.entries(o.byTrim).map(([k, v]) => [cfg.renameTrims[k] ?? k, v]),
      ),
    }));
  }
  // 트림을 뺐으면 옵션에 남은 그 트림의 상태도 버린다. 없는 트림의 값이 남으면
  // 화면이 없는 칼럼을 그리려 든다.
  const live = new Set(trims.map((t) => t.name));
  options = options.map((o) => ({
    ...o,
    byTrim: Object.fromEntries(Object.entries(o.byTrim).filter(([k]) => live.has(k))),
  }));

  const model = {
    id: cfg.id,
    brand: cfg.brand,
    model: cfg.label,
    trims,
    options: options.map((o, i) => ({ id: `${cfg.id}-${i}`, ...o })),
  };
  cfg.fix?.(model);

  const bad = validate(model);
  if (bad.length > 0) {
    console.error(`✗ ${cfg.label}: ${bad.join(' / ')}`);
    failed += 1;
    continue;
  }

  models.push(model);
  console.error(`✓ ${cfg.label}: 트림 ${model.trims.length} · 옵션 ${model.options.length}`);
}

mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
writeFileSync(out, JSON.stringify(models));

console.error(
  `\n구움 ${models.length} · 건너뜀 ${skipped} · 실패 ${failed}` +
    ` · ${out} ${(JSON.stringify(models).length / 1024).toFixed(1)}KB`,
);
// 하나라도 실패하면 0 이 아닌 값으로 끝낸다 — CI 나 스크립트가 성공으로 오해하면 안 된다.
if (failed > 0) process.exit(1);
