/**
 * 기아 **내연차** 가격표 PDF → 트림 × 옵션 격자.
 *
 * 칸의 값은 세 가지뿐이고, 그게 이 앱의 전부다:
 *   "-"    그 트림에서는 선택 불가 (잠김)
 *   "기본"  이미 포함 (추가금 0)
 *   "NN만"  돈을 더 내면 넣을 수 있다
 *
 * 트림은 "프레스티지  2,944만" 처럼 **한 줄에 이름과 가격**이 함께 온다.
 * 전기차는 이 모양이 아니다 — parse-kia-ev.mjs 가 따로 맡는다.
 *
 * 격자를 세우는 부분은 전기차와 같아서 pdf-table.mjs 로 뺐다.
 */
import { execFileSync } from 'node:child_process';

import { buildGrid, readContents } from './pdf-table.mjs';

const file = process.argv[2];
if (!file) {
  console.error('사용: node parse-kia.mjs <pdf경로>');
  process.exit(1);
}

const lines = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' }).split('\n');

/**
 * 파워트레인 머리글·빈 이름은 트림이 아니다.
 *
 * ⚠️ 차종 하나 때문에 생기는 예외는 여기 넣지 말 것. 이 정규식은 기아 전 차종이
 * 통과하는 길목이라, 한 차종을 고치려다 나머지를 조용히 깨뜨린다.
 * 그런 예외는 models.config.mjs 의 dropTrims 로 그 차종에만 붙인다.
 */
const NOT_TRIM = /^(가솔린|디젤|하이브리드|터보|\s*)$/;

// 1) 트림 가격
const trims = [];
for (const line of lines) {
  const m = line.match(/^\s*([가-힣A-Za-z0-9\-\. ]{2,14}?)\s{2,}(\d,\d{3})만(?:\s|$)/);
  if (!m) continue;
  const name = m[1].trim();
  if (NOT_TRIM.test(name) || trims.some((t) => t.name === name)) continue;
  trims.push({ name, price: Number(m[2].replace(',', '')) });
}
const trimNames = trims.map((t) => t.name);

// 2) 격자
const grids = [];
for (let i = 0; i < lines.length; i += 1) {
  if (!/^\s*구분\s{2,}/.test(lines[i])) continue;
  const g = buildGrid(lines, i, (s) => trimNames.includes(s));
  if (g) grids.push(g);
}

/**
 * 전기차는 레이아웃이 아예 다르다 — 트림명이 가격과 다른 줄·다른 칼럼에 세로로
 * 쪼개져 있고, 가격도 트림당 두 개다(판매가 / 친환경차 세제혜택 후).
 * 내연차 파서로는 못 잡으므로 조용히 0을 돌려주지 않고 분명히 알린다.
 */
const looksEv = /친환경차|세제혜택/.test(lines.join('\n'));
if (trims.length === 0) {
  console.error(
    looksEv
      ? '⚠️ 전기차 레이아웃이다. parse-kia-ev.mjs 를 쓸 것.'
      : '⚠️ 트림을 하나도 못 찾았다. 레이아웃을 확인할 것.',
  );
  process.exit(2);
}

const known = new Set(grids.flatMap((g) => g.options.map((o) => o.replace('*', '').trim())));
const contents = readContents(lines, known, trimNames);

console.log(JSON.stringify({ trims, grids, contents }, null, 2));
