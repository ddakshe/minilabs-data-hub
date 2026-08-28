/**
 * 기아 **전기차** 가격표 PDF → 트림 × 옵션 격자.
 *
 * 내연차와 격자는 똑같이 생겼다(pdf-table.mjs 를 그대로 쓴다). 다른 건 **트림**이다.
 *
 * 내연차:  "프레스티지  2,944만"        ← 한 줄에 이름과 가격
 * 전기차:  4,587만  •외장 : …          ← 가격이 먼저
 *         라이트    친환경차  …          ← 이름이 왼쪽 칼럼에 세로로 쪼개짐
 *         스탠다드   세제혜택 후
 *         4,360만                     ← 세제혜택 後 가격
 *
 * 그래서 이름을 가격 줄에서 못 읽는다. 대신 **격자 행에서 트림명을 먼저 얻고**,
 * 가격 구역에서 그 이름이 왼쪽 칼럼에 나오는 줄을 찾아 **위로 올라가며 처음 만나는
 * N,NNN만** 을 기본가로 잡는다.
 *
 * ⚠️ 반드시 **세제혜택 前** 가격을 쓴다. 後 가격을 쓰면 전기차만 수백만원 싸 보여
 * 내연차와의 총액 비교가 거짓이 된다 — 이 앱은 차종을 넘나들며 비교하는 앱이다.
 *
 * ⚠️ 트림 기본가는 배터리별로 여러 개다(라이트 스탠다드 4,587만 / 라이트 롱레인지
 * 5,008만). 옵션 격자는 배터리 구분 없이 트림만 쓰므로(행이 라이트·에어·어스),
 * **가장 싼 것 = 스탠다드**를 그 트림의 기본가로 잡는다. 앱이 "최소 트림·시작가" 를
 * 보여주는 것과 같은 원칙이다.
 */
import { execFileSync } from 'node:child_process';

import { buildGrid, CELL, readContents, tokens } from './pdf-table.mjs';

const file = process.argv[2];
if (!file) {
  console.error('사용: node parse-kia-ev.mjs <pdf경로>');
  process.exit(1);
}

const lines = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' }).split('\n');

const heads = [];
/*
  내연차는 "구분   옵션명  옵션명…" 처럼 헤더가 한 줄이지만, 전기차는 "구분" 이
  **줄에 혼자** 있는 차종이 있다(EV3·EV5). 뒤에 2칸 공백을 요구하면 통째로 놓친다.
*/
for (let i = 0; i < lines.length; i += 1) if (/^\s*구분\s*$|^\s*구분\s{2,}/.test(lines[i])) heads.push(i);
if (heads.length === 0) {
  console.error('⚠️ 격자 머리("구분")를 못 찾았다.');
  process.exit(2);
}

/** 트림명이 될 수 있는 모양. 값 칸·머리글은 아니다. */
/*
  트림명이 될 수 있는 모양. 값 칸·머리글은 아니다.
  하이픈을 빼먹으면 "GT-Line" "X-Line" 을 통째로 놓친다 — EV3 의 GT-Line 이
  격자에 멀쩡히 있는데도 트림 목록에서 사라졌던 원인이다.
*/
const MAYBE_TRIM = (s) =>
  /^[가-힣A-Za-z][가-힣A-Za-z0-9 \-]{1,14}$/.test(s) && !CELL.test(s) && s !== '구분';

/*
  1) 격자 행에서 트림명을 먼저 얻는다.
  값 칸이 3개 이상 뒤따르는 줄의 첫 토큰이 트림이다 — 헤더 조각은 값 칸을 달고
  오지 않으므로 이 조건만으로 갈린다.
*/
const trimNames = [];
for (const h of heads) {
  for (let j = h + 1; j < Math.min(h + 20, lines.length); j += 1) {
    const t = tokens(lines[j]);
    if (t.length < 3 || !MAYBE_TRIM(t[0].text)) continue;
    if (t.slice(1).filter((c) => CELL.test(c.text)).length < 3) continue;
    if (!trimNames.includes(t[0].text)) trimNames.push(t[0].text);
  }
}
if (trimNames.length === 0) {
  console.error('⚠️ 격자에서 트림 행을 못 찾았다.');
  process.exit(2);
}

/*
  2) 트림 기본가. 격자보다 **앞쪽**(가격 구역)만 본다 — 격자 행에도 같은 이름이
  나오므로 뒤까지 보면 옵션 가격을 기본가로 잡는다.
*/
const PRICE = /(\d,\d{3})만/;
const priceZone = heads[0];
const priceOf = {};
for (let i = 0; i < priceZone; i += 1) {
  /*
    고정 폭으로 자르면 안 된다. "라이트␣␣␣␣␣␣␣␣친환경차…" 처럼 옆 칼럼 글자가
    딸려 들어와 이름이 안 맞는다. 두 칸 이상 공백을 칸 구분으로 보는 tokens() 로
    첫 토큰을 얻고, 그게 **왼쪽 끝**(3칸 이내)에 있을 때만 트림 이름 줄로 본다.
  */
  const first = tokens(lines[i])[0];
  // 차종마다 들여쓰기가 다르다(EV6 는 0~1칸, EV3 는 4~5칸). 넉넉히 보되
  // trimNames 에 있는 이름만 받으므로 엉뚱한 토큰이 섞이지는 않는다.
  if (!first || first.start > 8) continue;
  const left = first.text;
  if (!trimNames.includes(left)) continue;
  // 이름 줄에서 위로 올라가며 처음 만나는 금액이 세제혜택 前 판매가다.
  for (let k = i; k >= Math.max(0, i - 4); k -= 1) {
    const m = PRICE.exec(lines[k]);
    if (!m) continue;
    const v = Number(m[1].replace(',', ''));
    priceOf[left] = priceOf[left] === undefined ? v : Math.min(priceOf[left], v);
    break;
  }
}

const trims = trimNames.filter((n) => priceOf[n] !== undefined).map((n) => ({ name: n, price: priceOf[n] }));
if (trims.length === 0) {
  console.error('⚠️ 트림 기본가를 못 찾았다. 가격 구역 레이아웃을 확인할 것.');
  process.exit(2);
}
// 기본가 오름차순. 앱은 "아래 트림부터" 를 전제로 계산한다.
trims.sort((a, b) => a.price - b.price);
const named = trims.map((t) => t.name);

// 3) 격자 — 내연차와 같은 알고리즘
const grids = [];
for (const h of heads) {
  const g = buildGrid(lines, h, (s) => trimNames.includes(s));
  // 기본가를 못 구한 트림의 행은 버린다. 가격 없는 트림은 계산에 못 쓴다.
  if (g) grids.push({ ...g, rows: g.rows.filter((r) => named.includes(r.trim)) });
}

const known = new Set(grids.flatMap((g) => g.options.map((o) => o.replace('*', '').trim())));
const contents = readContents(lines, known, named);

console.log(JSON.stringify({ trims, grids, contents }, null, 2));
