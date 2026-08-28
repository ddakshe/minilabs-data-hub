/**
 * 가격표 PDF 를 표로 읽는 공통 부분.
 *
 * tokens() 는 브랜드와 무관한 도구다 — pdftotext -layout 출력에서 "두 칸 이상 공백"
 * 을 칸 구분으로 보고 토큰과 그 문자 위치를 뽑는다. 현대 파서도 이걸 쓴다.
 * buildGrid()/readContents() 는 기아 서식 전용이다.
 *
 * ⚠️ 헤더를 그냥 읽으면 안 된다. 옵션명이 길면 pdftotext 가 **세로로 여러 줄에 쪼개
 * 놓는다** — "19인치 / 전면가공 휠" 이 두 줄, "헤드업 / 디스플레이" 도 두 줄이다.
 * 그래서 헤더 줄만 파싱하면 열 개수가 데이터 행과 안 맞는다.
 *
 * 대신 **데이터 행의 값 위치를 칼럼 기준점으로 삼고**, 헤더 조각들을 그 위치에
 * 겹치는 것끼리 모은다. 표의 진실은 헤더가 아니라 값의 정렬에 있다.
 *
 * 내연차와 전기차가 이 알고리즘을 공유한다. 다른 건 트림을 어떻게 알아내느냐다 —
 * 내연차는 "프레스티지 2,944만" 한 줄에서, 전기차는 격자 행에서 얻는다.
 */

/** 값 칸으로 인정하는 형태. 이 셋 말고는 격자 값이 아니다. */
export const CELL = /^(-|기본|[\d,]+만)$/;

/** 토큰과 그 문자 위치를 뽑는다. 두 칸 이상 공백이 칸 구분이다. */
export function tokens(line) {
  const out = [];
  const re = /\S+(?:\s\S+)*?(?=\s{2,}|\s*$)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const t = m[0].trim();
    if (t) out.push({ text: t, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * 격자 하나를 세운다.
 *
 * @param lines   PDF 전체 줄
 * @param i       "구분" 헤더 줄 번호
 * @param isTrim  이 토큰이 트림명인가 (내연차는 미리 아는 목록, 전기차는 모양으로 판정)
 */
export function buildGrid(lines, i, isTrim) {
  // 데이터 행 모으기 — 헤더 아래에서 트림명으로 시작하고 값 칸이 여럿인 줄
  const rows = [];
  for (let j = i + 1; j < Math.min(i + 20, lines.length); j += 1) {
    const t = tokens(lines[j]);
    if (t.length < 3) continue;
    if (!isTrim(t[0].text)) continue;
    const cells = t.slice(1).filter((c) => CELL.test(c.text));
    if (cells.length >= 3) rows.push({ trim: t[0].text, cells });
  }
  if (rows.length === 0) return null;

  // 칼럼 기준점 = 값이 가장 많은 행의 값 위치
  const anchor = rows.reduce((a, b) => (b.cells.length > a.cells.length ? b : a));
  const centers = anchor.cells.map((c) => (c.start + c.end) / 2);

  // 헤더 조각을 기준점에 배정 — 위아래 세 줄까지 본다(세로로 쪼개지므로)
  const names = centers.map(() => []);
  for (let k = Math.max(0, i - 3); k <= i + 3; k += 1) {
    for (const tok of tokens(lines[k] ?? '')) {
      if (tok.text === '구분' || isTrim(tok.text) || CELL.test(tok.text)) continue;
      const mid = (tok.start + tok.end) / 2;
      let best = 0;
      for (let c = 1; c < centers.length; c += 1) {
        if (Math.abs(centers[c] - mid) < Math.abs(centers[best] - mid)) best = c;
      }
      // 너무 멀면 그 칼럼의 헤더가 아니다
      if (Math.abs(centers[best] - mid) <= 12) names[best].push({ text: tok.text, line: k });
    }
  }
  const options = names.map((parts) =>
    parts
      .sort((a, b) => a.line - b.line)
      .map((p) => p.text)
      .join(' ')
      .trim(),
  );

  return {
    options,
    rows: rows.map((r) => ({
      trim: r.trim,
      // 값 개수가 칼럼 수와 다르면 위치로 다시 맞춘다.
      // 개수가 맞으면 순서대로가 정답이다. 위치로 맞추면 ±오차 때문에 옆 칸을
      // 두 번 집거나 마지막 칸을 놓친다.
      cells:
        r.cells.length === centers.length
          ? r.cells.map((c) => c.text)
          : centers.map((ctr) => {
              const hit = r.cells.find((c) => Math.abs((c.start + c.end) / 2 - ctr) <= 14);
              return hit ? hit.text : '';
            }),
    })),
  };
}

/**
 * 선택품목 상세 — 패키지 안에 뭐가 들었는지.
 *
 * "컴포트 I" 같은 이름만으로는 무엇이 들어오는지 알 수 없다. 가격표 뒤쪽에 구성품이
 * 적혀 있고, 왼쪽 칼럼에 옵션명 오른쪽에 구성품이며 **구성품은 여러 줄로 이어진다**
 * (드라이브 와이즈는 네 줄). 옵션명이 나온 줄부터 시작해 왼쪽이 빈 줄을 이어 붙인다.
 */
/**
 * 선택품목 상세 — 패키지 안에 뭐가 들었는지.
 *
 * "컴포트 I" 같은 이름만으로는 무엇이 들어오는지 알 수 없다. 가격표 뒤쪽에 구성품이
 * 적혀 있고, 왼쪽 칼럼에 옵션명 오른쪽에 구성품이며 **구성품은 여러 줄로 이어진다**
 * (드라이브 와이즈는 네 줄). 옵션명이 나온 줄부터 시작해 왼쪽이 빈 줄을 이어 붙인다.
 *
 * ⚠️ 예전에는 `line.slice(0, 32)` 로 이름 칸을 잘랐다. 칼럼 폭이 PDF 마다 달라서
 * 셀토스에서는 이름 뒤 내용 첫 글자까지 딸려 들어왔고("빌트인 캠 2 플러스     빌"),
 * 이름이 안 맞아 **차종 절반이 구성품 0개**가 됐다. 고정 폭 대신 격자와 같은
 * 토큰 분리(두 칸 이상 공백 = 칸 구분)를 쓴다.
 */
/** 이 칼럼보다 왼쪽에서 시작하면 "이름 칸", 오른쪽이면 내용 칸으로 본다. */
const NAME_COL = 24;

export function readContents(lines, known, trimNames) {
  const contents = {};
  const add = (name, text) => {
    const t = text.trim();
    if (!t || t.startsWith('※')) return;
    contents[name] = contents[name] ? `${contents[name]} ${t}` : t;
  };

  let current = null;
  for (const line of lines) {
    if (!line.trim()) {
      current = null;
      continue;
    }
    const t = tokens(line);
    if (t.length === 0) {
      current = null;
      continue;
    }

    if (t[0].start < NAME_COL) {
      // 이름 칸에 글자가 있다. 아는 옵션이면 그 항목이 시작된 것이다.
      if (known.has(t[0].text)) {
        current = t[0].text;
        add(current, t.slice(1).map((x) => x.text).join(' '));
      } else if (!trimNames.includes(t[0].text)) {
        // 트림명이 오는 줄(스타일처럼 트림별로 구성이 다른 경우)은 앞 항목의 연속으로 본다.
        current = null;
      }
      continue;
    }

    // 이름 칸이 비었다 = 앞 항목이 여러 줄로 이어지는 중
    if (current) add(current, t.map((x) => x.text).join(' '));
  }
  return contents;
}
