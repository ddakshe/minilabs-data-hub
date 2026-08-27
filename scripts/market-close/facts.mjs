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
 */

const won = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('ko-KR'));

export function buildFacts(r) {
  const out = [];

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

  if (r.volumeVs20d) {
    out.push(`거래량이 최근 20거래일 평균의 ${r.volumeVs20d.ratio.toFixed(1)}배였어요.`);
  }

  out.push(`최근 1년 가격 범위에서 아래로부터 ${Math.round(r.week52.position * 100)}% 지점이에요.`);

  const valid = r.recent5.filter((d) => d.fltRt !== null).length;
  const ups = r.recent5.filter((d) => (d.fltRt ?? 0) > 0).length;
  if (valid > 0) out.push(`최근 ${valid}거래일 중 ${ups}일 올랐어요.`);

  return out.slice(0, 3);
}

/** 아카이브 목록에 쓰는 한 줄. 사실 문장 중 첫 번째를 쓴다. */
export const buildHeadline = (facts) => facts[0] ?? '';
