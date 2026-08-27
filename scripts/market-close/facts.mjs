// ⚠️ 생성된 사본이다. 고치지 말 것.
// 원본: market-close-mini/pipeline/facts.mjs
// 갱신: node pipeline/sync-to-hub.mjs
/**
 * 사실 문장 생성 — 전부 템플릿이고 모든 숫자에 필드 소스가 있다 (HANDOFF §4-a).
 *
 * 🔑 앱이 아니라 파이프라인에 둔다. 이유가 셋이다.
 *   ① 아카이브 한 줄 요약과 리포트 본문이 같은 문장을 써야 한다
 *   ② §4-c 금지 어휘 게이트를 생성 시점에 통과시켜야 한다 (앱에서는 검사할 수 없다)
 *   ③ 같은 로직을 JS 두 벌로 두면 반드시 갈라진다
 *
 * ⚠️ **순서가 곧 우선순위다.** 아래에서 `slice(0, 3)` 으로 세 문장만 남기고,
 *    첫 문장이 그대로 아카이브 한 줄 요약(`buildHeadline`)이 된다.
 *    앞쪽에는 **화면의 숫자만 봐서는 알 수 없는 것**을 둔다 — 시가·고가·저가는
 *    이미 2×2 웰에 그려져 있어서, 그걸 문장으로 되풀이하면 칸만 먹는다.
 */

const won = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('ko-KR'));

/** 등락률 표기. `2.80%` 가 아니라 `2.8%`, `0.97%` 는 그대로. */
const pct = (n) => String(Number(n.toFixed(2)));

/** 받침이 있으면 '이', 없으면 '가'. 코스피**가** / 코스닥**이**. */
const ga = (word) => {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  return c >= 0 && c <= 11171 && c % 28 !== 0 ? '이' : '가';
};

/**
 * @param r    PriceReport
 * @param mkt  { name: '코스피'|'코스닥', fltRt: number } | null
 *             종목이 속한 시장의 지수만 넘어온다. 코스닥 종목을 코스피와 견주지 않는다.
 */
export function buildFacts(r, mkt = null) {
  const out = [];

  // ① 시장 대비 — 이 값은 우리가 빼 주지 않으면 어디에도 없다.
  //    지수는 없는 날이 있다(수집 실패·창 밖의 과거). 그때는 조용히 빠진다.
  if (mkt && mkt.fltRt !== null && mkt.fltRt !== undefined && r.fltRt !== null) {
    const day = mkt.fltRt === 0
      ? `${mkt.name}${ga(mkt.name)} 제자리였던 날`
      : `${mkt.name}${ga(mkt.name)} ${pct(Math.abs(mkt.fltRt))}% ${mkt.fltRt > 0 ? '오른' : '내린'} 날`;
    const mine = r.fltRt === 0
      ? '전날과 같은 가격으로 마감했어요.'
      : `${pct(Math.abs(r.fltRt))}% ${r.fltRt > 0 ? '올랐어요' : '내렸어요'}.`;
    out.push(`${day} ${mine}`);
  }

  // ② 거래량 배수 — 거래량 자체는 화면에 있지만 '평소 대비'는 여기에만 있다.
  if (r.volumeVs20d) {
    out.push(`거래량이 최근 20거래일 평균의 ${r.volumeVs20d.ratio.toFixed(1)}배였어요.`);
  }

  // ③ 이하는 화면의 숫자와 겹친다. 자리가 남을 때만 나간다.
  if (r.open !== null) {
    const d = r.close - r.open;
    if (d === 0) out.push(`시가 ${won(r.open)}원과 같은 가격으로 마감했어요.`);
    else out.push(`시가 ${won(r.open)}원보다 ${won(Math.abs(d))}원 ${d > 0 ? '높게' : '낮게'} 마감했어요.`);
  }

  if (r.high !== null && r.high > r.close) {
    out.push(`장중 ${won(r.high)}원까지 올랐다가 ${won(r.high - r.close)}원 낮은 가격에 마감했어요.`);
  } else if (r.low !== null && r.low < r.close) {
    out.push(`장중 ${won(r.low)}원까지 내렸다가 ${won(r.close - r.low)}원 높은 가격에 마감했어요.`);
  }

  out.push(`최근 1년 가격 범위에서 아래로부터 ${Math.round(r.week52.position * 100)}% 지점이에요.`);

  const valid = r.recent5.filter((d) => d.fltRt !== null).length;
  const ups = r.recent5.filter((d) => (d.fltRt ?? 0) > 0).length;
  if (valid > 0) out.push(`최근 ${valid}거래일 중 ${ups}일 올랐어요.`);

  return out.slice(0, 3);
}

/** 아카이브 목록에 쓰는 한 줄. 사실 문장 중 첫 번째를 쓴다. */
export const buildHeadline = (facts) => facts[0] ?? '';
