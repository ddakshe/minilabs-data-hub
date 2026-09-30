/**
 * 구운 트림 기본가가 **원본 PDF 본문에 실제로 있는 숫자인지** 확인한다.
 *
 * 사용(단독): node scripts/auto-option/verify-prices.mjs <구운.json> [--pdf-dir .pdf-cache]
 *             종료코드 0 = 전부 원본에 있다 · 2 = 원본에 없는 값이 있다 · 1 = 오류
 * 사용(모듈): verifyModel(model, pdfPath) → 문제 문자열 배열(빈 배열이면 통과)
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────
 * bake 의 validate() 는 "이 값이 말이 되는가"(0원이 아닌가, 트림이 있는가) 만 본다.
 * guard 는 "지난달과 얼마나 달라졌는가" 를 본다. 둘 다 통과하면서도 값이 **원본에
 * 없는 숫자**일 수 있다 — 칼럼이 밀려 옆 파워트레인의 금액을 집어 오거나,
 * 공급가액(부가세 전) 열을 판매가격으로 읽으면 그렇게 된다. 그 경우 숫자는
 * 그럴듯하고 작년 대비 변화도 몇 %p 라서 어느 장치에도 안 걸린다.
 *
 * 그래서 마지막 확인은 **원본 본문에 그 숫자가 글자로 있는지** 봐야 한다.
 * 이건 파서 구현과 독립적이다 — 파서를 어떻게 고쳐도 이 검사는 같은 것을 묻는다.
 *
 * ── 무엇을 인정하는가 ────────────────────────────────────────────
 * 브랜드마다 가격을 적는 단위가 다르다.
 *   현대: "42,450,000"  (원)
 *   기아: "4,245만"     (만원)
 * 둘 중 하나로 본문에 있으면 통과다. 어느 쪽으로도 없으면 그 값은 우리가 만든
 * 숫자이므로 내보내면 안 된다.
 *
 * 만원 단위로 반올림해 저장하므로 원 단위는 ±1만원 흔들릴 수 있다(예: 공급가액에서
 * 온 값). 반올림 구간을 전부 받아 주면 검사가 헐거워지므로 **정확히 일치**만 본다.
 *
 * ── 무엇을 못 잡는가 ─────────────────────────────────────────────
 * 이 검사는 "그 숫자가 이 문서에 판매가격으로 실려 있는가" 까지만 본다.
 * **같은 문서 안에서 값이 뒤바뀐 경우는 못 잡는다** — 그랜저 Premium 에 LPG 3.5 의
 * 4,393만이나 Exclusive 의 4,694만이 들어가면 둘 다 진짜 판매가격이라 통과한다.
 * 그건 트림과 금액의 짝이 틀린 것이고, 짝을 확인하려면 레이아웃을 다시 읽어야 해서
 * 파서와 독립적이라는 이 검사의 장점이 사라진다.
 *
 * 실제로 겪은 사고는 전부 이 검사가 잡는 쪽이었다 —
 *   · 공급가액(부가세 전) 열을 판매가격으로 읽음
 *   · 2~4년 된 가격표를 받아 옛 가격이 들어옴 (그랜저 3,193만)
 *   · 반올림이 어긋나 원본에 없는 만원 값이 생김
 * 짝이 뒤바뀌는 쪽은 guard.mjs 의 전월 대비 비교가 더 잘 잡는다(값이 크게 튄다).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** PDF 본문. 한 파일을 여러 트림이 보므로 캐시한다. */
const textCache = new Map();
export function pdfText(pdf) {
  if (!textCache.has(pdf)) {
    textCache.set(pdf, execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' }));
  }
  return textCache.get(pdf);
}

const comma = (n) => n.toLocaleString('en-US');

/** 공급가액(부가세). 현대 가격표는 트림마다 이 쌍을 싣는다. */
const SUPPLY_PAIR = /([\d]{1,3}(?:,\d{3})+)\s*\((\d{1,3}(?:,\d{3})+)\)/g;
const num = (s) => Number(s.replace(/,/g, ''));

/**
 * 본문의 공급가액 쌍을 더해 만들 수 있는 판매가격 집합.
 *
 * 왜 이걸 쓰는가 — "숫자가 본문에 있다" 만으로는 약하다. 가격표에는 8자리 금액이
 * 수십 개 있어서 옆 파워트레인의 금액을 잘못 집어 와도 "본문에 있다" 는 통과한다.
 * 반면 **공급가액 + 부가세 = 판매가격** 은 그 트림 한 줄 안에서만 성립하는 관계다.
 * 팰리세이드 캘리그래피면 52,790,909 + 5,279,091 = 58,070,000 이 맞아야 한다.
 * 우연히 맞출 수 있는 값이 아니다.
 *
 * 기아 가격표에는 공급가액 열이 없다(만원 단위 판매가만 싣는다). 쌍이 없으면
 * 이 검사는 건너뛰고 문자열 대조만 한다 — 없는 근거를 요구하면 기아가 전부 실패한다.
 */
function saleTotals(text) {
  const out = new Set();
  for (const m of text.matchAll(SUPPLY_PAIR)) out.add(num(m[1]) + num(m[2]));
  return out;
}

/** 만원 단위 가격이 본문에 적힌 형태들. */
export function priceForms(manwon) {
  return [
    comma(manwon * 10_000), // 현대: 42,450,000
    `${comma(manwon)}만`, //   기아: 4,245만
  ];
}

/**
 * 한 차종의 트림 기본가가 전부 원본에 있는지 본다.
 * 반환: 문제 설명 배열. 빈 배열이면 통과.
 */
export function verifyModel(model, pdf) {
  if (!existsSync(pdf)) return [`원본 PDF 가 없어 대조하지 못했다: ${pdf}`];
  let text;
  try {
    text = pdfText(pdf);
  } catch {
    return [`원본 PDF 를 읽지 못했다: ${pdf}`];
  }
  // 공백·줄바꿈이 끼어도 같은 숫자로 보이게 눌러 둔다.
  const flat = text.replace(/\s+/g, ' ');
  const totals = saleTotals(text);
  const bad = [];
  for (const t of model.trims) {
    const forms = priceForms(t.price);
    if (!forms.some((f) => flat.includes(f))) {
      bad.push(`"${t.name}" 기본가 ${t.price}만(=${forms[0]})이 원본 본문에 없다`);
      continue;
    }
    // 공급가액을 싣는 가격표(현대)에서는 덧셈까지 맞아야 한다.
    if (totals.size > 0 && !totals.has(t.price * 10_000)) {
      bad.push(
        `"${t.name}" 기본가 ${t.price}만이 공급가액+부가세로 안 맞는다 (판매가격 열이 아닐 수 있다)`,
      );
    }
  }
  return bad;
}

// ── 단독 실행 ──────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('사용: node scripts/auto-option/verify-prices.mjs <구운.json> [--pdf-dir DIR]');
    process.exit(1);
  }
  const di = args.indexOf('--pdf-dir');
  const dir = di >= 0 ? args[di + 1] : (process.env.AUTO_OPTION_PDF_CACHE ?? '.pdf-cache');

  const models = JSON.parse(readFileSync(file, 'utf8'));
  let failed = 0;
  let checked = 0;
  let noPdf = 0;
  for (const m of models) {
    const pdf = path.join(dir, `${m.id}.pdf`);
    if (!existsSync(pdf)) {
      // 대조할 원본이 없는 건 실패가 아니다 — bake 가 그 차종을 안 받았을 뿐이다.
      console.error(`·  ${m.model}: 원본 없음 (${pdf})`);
      noPdf += 1;
      continue;
    }
    const bad = verifyModel(m, pdf);
    checked += 1;
    if (bad.length > 0) {
      console.error(`✗ ${m.model}: ${bad.join(' / ')}`);
      failed += 1;
    } else {
      console.error(`✓ ${m.model}: 트림 ${m.trims.length} 전부 원본에 있다`);
    }
  }
  console.error(`\n대조 ${checked} · 불일치 ${failed} · 원본없음 ${noPdf}`);
  process.exit(failed > 0 ? 2 : 0);
}
