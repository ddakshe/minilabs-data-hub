/**
 * 현대 가격표 PDF → 트림 × 옵션 격자.
 *
 * ⚠️ 기아와 서식이 근본적으로 다르다. 기아는 **격자를 발행**한다 —
 * "이 옵션이 어느 트림에서 얼마인가" 가 표에 그대로 적혀 있다. 현대는 **트림별 목록**을
 * 발행한다. 각 트림 아래에 "여기서 고를 수 있는 것" 만 나열되고 격자는 없다.
 * 그래서 격자를 역으로 세워야 한다.
 *
 * 세우는 규칙:
 *   1. 그 트림의 "선택 품목" 에 ▶ 로 적혀 있으면      → paid(가격)
 *   2. 안 적혀 있는데 **패키지 구성품이 그 트림의
 *      기본 품목 안에 들어 있으면**                 → included
 *   3. 둘 다 아니면                                → locked
 *
 * 2번이 이 파서의 핵심이다. 옵션명을 산문에서 찾는 퍼지 매칭이 아니라,
 * 뒤쪽 "패키지 품목" 표에서 구성품 집합을 얻어 **포함 관계**를 본다.
 * 예: 아반떼 Smart 의 컨비니언스 I(90만) 구성품이 Modern 기본 품목에 그대로 있으면
 * Modern 에서는 기본 포함이다.
 *
 * 가격은 **판매가격**을 쓴다. 현대는 "개별소비세 3.5% 적용시" 가격도 함께 싣는데,
 * 기아 가격표에는 그 열이 없다. 3.5% 쪽을 쓰면 현대만 3~4% 싸 보여서, 차종을
 * 넘나들며 총액을 비교하는 이 앱에서는 비교 자체가 거짓이 된다.
 */
import { execFileSync } from 'node:child_process';

import { tokens } from './pdf-table.mjs';

const file = process.argv[2];
if (!file) {
  console.error('사용: node parse-hyundai.mjs <pdf경로>');
  process.exit(1);
}

const lines = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' }).split('\n');

/** 공급가액(부가세). 트림마다 정확히 한 번 나오므로 트림의 기준점으로 쓴다. */
/* 괄호 앞에 공백이 있는 차종이 있다(싼타페: "32,236,364 (3,223,636)"). */
const SUPPLY = /([\d]{1,3}(?:,\d{3})+)\s*\((\d{1,3}(?:,\d{3})+)\)/;
/** 판매가격. 천 단위 구분이 있는 8자리 이상 금액. */
const PRICE = /\b(\d{2},\d{3},\d{3})\b/;
/** 선택 품목 한 줄. "▶ 컨비니언스 I  [900,000]" / "[추가비용없음]" */
const PICK = /▶\s*([^[\]▶]{2,40}?)\s*\[([\d,]+|추가비용없음)\]/g;
/** 섹션 머리. 이 네 낱말이 한 줄에 있으면 파워트레인 표의 시작이다. */
const HEAD = (l) => /구분/.test(l) && /판매가격/.test(l) && /기본\s*품목/.test(l) && /선택\s*품목/.test(l);

const won = (s) => Math.round(Number(s.replace(/,/g, '')) / 10_000);

/** "▶스마트스트림 가솔린 1.6 모던 기본 품목 및" 같은 안내는 옵션이 아니다. */
const NOT_OPTION = /기본\s*품목|이상|참조|선택\s*시/;

// ── 1) 패키지 품목: 옵션명 → 구성품 ───────────────────────────────────
/*
  표가 이렇게 생겼다 — 옵션명이 왼쪽 칼럼, 구성품이 오른쪽 칼럼이고 구성품이
  이름의 **위아래로 걸친다**.

      (빈 줄)
                        듀얼 풀오토 에어컨(...), 버튼시동 & 스마트키,
      컨비니언스 I
                        하이패스, ECM 룸미러
      (빈 줄)

  같은 줄로 가정하면 전부 놓친다. 그렇다고 빈 줄만 믿어도 안 된다 — 쏘나타·
  아이오닉9 은 빈 줄 없이 여러 항목이 붙어 있다.

      패키지 품목
                        10.25인치 내비게이션(...), 듀얼 풀
       인포테인먼트  내비 I
                        스마트폰 무선충전, 디지털 키, ...
       플래티넘          헤드업 디스플레이, 서라운드 뷰 모니터, ...

  그래서 **빈 줄로 레코드를 끊되, 레코드 안에서는 가장 가까운 앞 이름에 붙인다**.
  이름보다 위에 있는 구성품은 그 레코드의 첫 이름에 붙는다(위 아반떼 사례).
  틀린 구성품을 붙이면 없느니만 못하므로, 아는 이름일 때만 항목을 연다.
*/
/** 이 칼럼보다 왼쪽에서 시작하면 이름 칸으로 본다. */
const NAME_COL = 22;

function readPackages(lines, known) {
  const contents = {};
  const add = (name, text) => {
    const t = text.trim();
    if (!t || /^[※■]/.test(t)) return;
    contents[name] = contents[name] ? `${contents[name]}, ${t}` : t;
  };

  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*패키지\s*품목\s*$/.test(lines[i])) continue;

    let record = [];
    const flush = () => {
      if (record.length === 0) return;
      // 레코드 안의 줄을 [이름 | 내용] 으로 가른다.
      const items = record.map((l) => {
        const t = tokens(l);
        if (t.length === 0) return null;
        /*
          이름이 **가로로도 쪼개진다**. 쏘나타는 "인포테인먼트" 가 1열, "내비 I" 가
          26열에 있어서 첫 토큰만 보면 "인포테인먼트" 라는 없는 옵션이 된다.
          앞에서부터 한 토큰씩 이어 붙여 아는 이름이 나오는지 본다.
        */
        let take = 0;
        if (t[0].start < NAME_COL) {
          for (let n = 1; n <= Math.min(3, t.length); n += 1) {
            if (known.has(t.slice(0, n).map((x) => x.text).join(' '))) take = n;
          }
        }
        return {
          name: take > 0 ? t.slice(0, take).map((x) => x.text).join(' ') : null,
          body: t.slice(take).map((x) => x.text).join(' '),
        };
      });
      // 이름보다 위에 있는 구성품은 이 레코드의 첫 이름 것이다.
      const first = items.find((x) => x?.name)?.name ?? null;
      let current = first;
      for (const it of items) {
        if (!it) continue;
        if (it.name) current = it.name;
        if (current) add(current, it.body);
      }
      record = [];
    };

    for (let j = i + 1; j < Math.min(i + 60, lines.length); j += 1) {
      const l = lines[j];
      if (!l.trim()) { flush(); continue; }
      // 표가 끝나고 각주(※/■)가 시작되면 멈춘다.
      if (/^\s*[※■]/.test(l)) { flush(); break; }
      record.push(l);
    }
    flush();
  }
  return contents;
}

// ── 2) 파워트레인 섹션마다 격자를 따로 세운다 ──────────────────────────
/*
  섹션을 합치면 안 된다. 같은 "컨비니언스 I" 이 가솔린 표에서 90만, LPi 표에서 85만인데
  합쳐서 최솟값을 쓰면 **어느 파워트레인에도 없는 조합**의 가격이 만들어진다.
  기아 파서도 격자 하나만 고른다. 여기서도 가장 큰 섹션 하나만 쓴다.
*/
const heads = lines.map((l, i) => (HEAD(l) ? i : -1)).filter((i) => i >= 0);
if (heads.length === 0) {
  console.error('⚠️ 파워트레인 표 머리(구분/판매가격/기본 품목/선택 품목)를 못 찾았다.');
  process.exit(2);
}

function parseSection(from, to) {
  const anchors = [];
  for (let i = from + 1; i < to; i += 1) {
    if (!SUPPLY.test(lines[i])) continue;
    let price = null;
    let name = null;
    for (let d = 0; d <= 4; d += 1) {
      for (const k of [i - d, i + d]) {
        if (k < from || k >= to) continue;
        if (price === null) {
          // 공급가액 줄에서도 판매가격이 같은 줄에 올 수 있다(Inspiration). 괄호 앞의 값만 본다.
          const l = lines[k].replace(SUPPLY, ' ');
          const m = PRICE.exec(l);
          if (m) price = won(m[1]);
        }
        if (!name) {
          /*
            트림명은 왼쪽 끝의 라틴 낱말이다. 2칸 이상 공백으로 끊기길 요구하면
            "Inspiration 23,290,909(2,329,091)" 처럼 이름 바로 뒤에 금액이 한 칸
            띄고 붙는 줄에서 트림을 통째로 놓친다. 낱말 경계까지만 본다.
            기본 품목 산문에도 영문이 섞이지만 그쪽은 30칼럼 밖이라 안 걸린다.
          */
          /*
            한 글자 트림명이 있다 — 아반떼·코나의 "N Line". 첫 낱말에 두 글자를
            요구하면 통째로 놓친다(아반떼 N Line 2,845만이 빠져 있었다).
            그렇다고 한 글자를 무조건 허용하면 산문 속 대문자까지 트림이 된다.
            **한 글자는 뒤에 두 번째 낱말이 있을 때만** 인정한다.
          */
          const m =
            /^\s{0,14}([A-Z][A-Za-z\-]{1,18}(?: [A-Z][A-Za-z\-]{1,18})?|[A-Z] [A-Z][A-Za-z\-]{1,18})(?=\s|$)/.exec(
              lines[k],
            );
          if (m) name = m[1].trim();
        }
      }
      if (price !== null && name) break;
    }
    if (name && price) anchors.push({ line: i, name, price });
  }
  if (anchors.length === 0) return null;

  const trims = [];
  const paid = {};
  const baseText = {};
  for (let a = 0; a < anchors.length; a += 1) {
    const { name, price } = anchors[a];
    if (!trims.some((t) => t.name === name)) trims.push({ name, price });

    const start = a === 0 ? from + 1 : anchors[a].line - 2;
    const end = a + 1 < anchors.length ? anchors[a + 1].line - 2 : to;
    const block = lines.slice(Math.max(from, start), end).join('\n');
    baseText[name] = (baseText[name] ?? '') + '\n' + block;

    for (const m of block.matchAll(PICK)) {
      const opt = m[1].trim().replace(/^ㄴ\s*/, '');
      if (NOT_OPTION.test(opt) || opt.length < 2) continue;
      paid[opt] ??= {};
      paid[opt][name] = m[2] === '추가비용없음' ? 0 : won(m[2]);
    }
  }
  return { trims, paid, baseText };
}

const sections = heads
  .map((h, i) => parseSection(h, i + 1 < heads.length ? heads[i + 1] : lines.length))
  .filter((x) => x !== null);
if (sections.length === 0) {
  console.error('⚠️ 트림을 하나도 못 찾았다. 레이아웃을 확인할 것.');
  process.exit(2);
}
// 가장 많은 정보를 가진 섹션이 본 표다. 작은 표는 특장·단일 트림인 경우가 많다.
const { trims, paid, baseText } = sections.toSorted(
  (a, b) =>
    b.trims.length * Object.keys(b.paid).length - a.trims.length * Object.keys(a.paid).length,
)[0];

// ── 3) 격자 세우기 ────────────────────────────────────────────────────
/** 구성품 문자열 → 항목 배열. 괄호 안 쉼표는 자르지 않는다. */
function parts(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  /*
    중복을 지운다. 패키지 품목 표가 파워트레인마다 반복되는 차종이 있어서, 그대로
    이어 붙이면 하이패스의 구성품이 ["하이패스","하이패스","하이패스","하이패스"] 가 된다.
    개수를 근거로 쓰는 아래 판정이 통째로 어긋난다.
  */
  return [...new Set(out.filter((p) => p.length > 1))];
}

const norm = (s) => s.replace(/\s+/g, '');

/** 이 트림과 그보다 싼 모든 트림의 기본 품목을 합친 것. */
const byPrice = trims.toSorted((a, b) => a.price - b.price);
function cumulativeBase(name) {
  const upto = byPrice.findIndex((t) => t.name === name);
  return byPrice
    .slice(0, upto + 1)
    .map((t) => baseText[t.name] ?? '')
    .join('\n');
}

/*
  ⚠️ 구성품을 **격자보다 먼저** 읽어야 한다. 아래 기본/불가 판정이 구성품 집합에
  의존하기 때문이다. 한때 이걸 격자 뒤로 옮겼다가 판정 시점에 includes 가 늘 비어
  있어서 **현대 전 차종의 "기본 포함" 이 0개**가 됐다. 전부 '불가' 로 떨어졌고,
  상위 트림에 기본으로 들어오는 옵션을 "이 트림에선 못 넣음" 이라고 표시했다.
*/
const contents = readPackages(lines, new Set(Object.keys(paid)));

const options = Object.keys(paid).map((name, i) => {
  const includes = parts(contents[name] ?? '');
  const byTrim = {};
  for (const t of trims) {
    if (paid[name][t.name] !== undefined) {
      const p = paid[name][t.name];
      byTrim[t.name] = p === 0 ? { kind: 'included' } : { kind: 'paid', price: p };
      continue;
    }
    /*
      선택 목록에 없다. 구성품이 이 트림 기본 품목에 들어 있으면 기본 포함이다.

      ⚠️ **기본 품목은 누적이다.** 원본이 "▶ 모던 기본 품목 및" 한 줄로 아래 트림을
      통째로 상속하고, 그 트림에서 **새로 추가된 것만** 적는다. 자기 블록만 보면
      Modern 에서 기본이 된 옵션이 Inspiration 에서 '불가' 로 떨어진다 —
      상위 트림일수록 옵션이 줄어드는 거꾸로 된 결과가 나온다.
      그래서 자기보다 싼 트림의 기본 품목까지 합쳐서 본다.
    */
    const base = norm(cumulativeBase(t.name));
    const hit = includes.filter((p) => base.includes(norm(p))).length;
    /*
      ⚠️ 못 찾았을 때 무엇으로 두느냐가 이 파서에서 제일 중요한 판단이다.
      "불가" 와 "기본 포함" 은 **뜻이 반대**다 — 불가면 그 트림은 탈락이고,
      기본이면 그 트림이 정답이다. 틀리면 앱이 거꾸로 답한다.

      기아 원본 격자(정답이 적혀 있다)로 실측한 결과, 낮은 트림에서 유료였던
      옵션이 더 비싼 트림에서 선택 목록에 없으면 **기본 104 : 불가 7 (94%:6%)** 였다.
      상위 트림은 장비가 쌓이지 빠지지 않기 때문이다.

      그래서 **자기보다 싼 트림에서 유료였던 옵션은 기본 포함으로 본다.**
      그 아래(아직 안 나온 트림)는 불가가 맞다.
    */
    const at = byPrice.findIndex((x) => x.name === t.name);
    const paidBelow = byPrice.slice(0, at).some((x) => paid[name]?.[x.name] !== undefined);
    /*
      단, 더 비싼 트림에서 **여전히 유료**라면 여기서 기본이 됐을 리 없다.
      장비는 위로 갈수록 쌓이지 빠지지 않는다. 이 조건을 빼면
      "싼 트림에선 공짜인데 비싼 트림에선 돈 내야 한다" 는 모순이 생긴다.
    */
    const paidAbove = byPrice.slice(at + 1).some((x) => paid[name]?.[x.name] !== undefined);
    /*
      구성품이 하나뿐인 패키지는 근거로 쓰지 않는다. "선루프" 처럼 이름이 곧
      구성품인 것들은 그 단어가 다른 옵션 설명에 스쳐도 걸려서, Modern 에서만
      '기본' 이 되고 상위 Inspiration 에서 다시 '유료' 가 되는 거꾸로 된 결과가 나왔다.
      두 개 이상이 겹칠 때만 "이 패키지가 통째로 기본이 됐다" 고 본다.
    */
    const proven = includes.length >= 2 && hit / includes.length >= 0.6;
    byTrim[t.name] = proven || (paidBelow && !paidAbove) ? { kind: 'included' } : { kind: 'locked' };
  }
  return { id: `h-${i}`, name, includes, byTrim };
});

console.log(JSON.stringify({ trims, options, contents }, null, 2));
