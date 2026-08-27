#!/usr/bin/env node
// ⚠️ 생성된 사본이다. 고치지 말 것.
// 원본: market-close-mini/pipeline/forbidden.mjs
// 갱신: node pipeline/sync-to-hub.mjs
/**
 * forbidden.mjs — 금지 어휘 게이트.
 *
 * 무인 크론이 AI 요약을 퍼블릭 저장소에 바로 커밋한다. 게이트가 없으면
 * 범위를 벗어난 문장이 아무도 모르게 나간다. (HANDOFF §1 · §5-7)
 *
 * ⚠️ 적용 대상은 **우리가 생성한 요약 문장**뿐이다.
 *    뉴스 제목·공시 제목은 원문 인용이라 게이트를 적용하지 않는다
 *    (공시 제목에 '최대주주 등의 소유주식 변동신고서' 같은 표현이 정상적으로 들어온다).
 *
 *   node pipeline/forbidden.mjs            자체 테스트 실행
 *   import { checkText } from './forbidden.mjs'
 */

/**
 * 카테고리별 금지 패턴.
 * 근거를 같이 적어둔다 — 나중에 "왜 이게 막히지"에 답할 수 있어야 한다.
 */
export const RULES = [
  {
    id: 'forecast',
    why: '전망·기대는 투자판단 자문에 닿는다 (HANDOFF §1 범위 경계)',
    re: /전망|기대감|기대돼|기대된다|예상돼|예상된다|보인다|호조|유망|수혜|모멘텀|저평가|고평가|매력적|투자\s*심리|심리\s*개선/,
  },
  {
    id: 'advice',
    why: '매매 의견·목표주가는 투자자문업 등록 대상',
    re: /목표\s*주가|매수\s*의견|매도\s*의견|비중\s*확대|비중\s*축소|사야|팔아야|추천/,
  },
  {
    id: 'flow',
    why: '수급(외국인·기관·개인)은 데이터 경로가 없다 — 쓰면 근거 없는 문장이 된다 (§2-a ⑩)',
    re: /외국인|순매수|순매도|매도세|매수세|수급|기관\s*투자자|기관투자자/,
  },
  {
    id: 'personalized',
    why: '개별 맞춤을 표방하면 투자자문 쪽으로 스스로를 민다 (§3 ①)',
    re: /맞춤형|나만의|당신에게\s*딱|회원님을\s*위한/,
  },
];

/** @returns {{ok: boolean, hits: {id: string, why: string, match: string}[]}} */
export function checkText(text) {
  const hits = [];
  for (const r of RULES) {
    const m = String(text).match(r.re);
    if (m) hits.push({ id: r.id, why: r.why, match: m[0] });
  }
  return { ok: hits.length === 0, hits };
}

/**
 * 뉴스 헤드라인 필터 — 위 RULES 와 목적이 다르다.
 *
 * RULES 는 '우리가 쓴 문장'을 막는다. 이건 '남이 쓴 제목을 우리가 고르는 것'을 막는다.
 * 실데이터에서 이런 헤드라인이 나왔다:
 *     "과도한 주가 조정" 삼성전자, 목표주가 37만원…
 * 원문 인용이라 우리가 작성한 건 아니지만, **고른 것은 우리다.**
 * 의견 기사를 큐레이션하면 §1 "사실만 전달한다"가 작성이 아니라 선별로 무너진다.
 *
 * 후보가 종목당 100건 넘게 나오므로 몇 건 버려도 화면이 비지 않는다 — 비용이 0에 가깝다.
 */
export const HEADLINE_DROP = {
  id: 'opinion-headline',
  why: '투자 의견을 담은 헤드라인을 고르면 큐레이션으로 §1 을 넘는다',
  re: /목표\s*주가|투자\s*의견|매수\s*추천|매도\s*추천|비중\s*확대|비중\s*축소|[""']?사라[""']?\s*$|주가\s*전망|급등\s*예상|폭락\s*예상|수혜주|테마주|유망주|추천주/,
};

export function isOpinionHeadline(title) {
  return HEADLINE_DROP.re.test(String(title));
}

/** 문장 배열을 통째로 검사. 하나라도 걸리면 전체를 막는다. */
export function checkAll(sentences) {
  const bad = [];
  sentences.forEach((s, i) => {
    const r = checkText(s);
    if (!r.ok) bad.push({ index: i, text: s, hits: r.hits });
  });
  return { ok: bad.length === 0, bad };
}

// ── 자체 테스트 ──────────────────────────────────────────────────
// FAIL 케이스는 전부 '실제로 생성기가 만들어낸 문장'이다. 가짜 예시가 아니다.
const MUST_FAIL = [
  ['외국인이 3거래일 연속 순매수했어요', '스티치 2차 · 리포트 화면'],
  ['기관 매도세 우위', '스티치 2차 · 아카이브 화면'],
  ['반도체 업황 호조 기대감', '스티치 2차 · 아카이브 화면'],
  ['업황 개선 기대감', '스티치 1차 (HANDOFF §4-a)'],
  ['투자 심리 개선', '스티치 1차'],
  ['맞춤형 리포트', '스티치 1차 — §1 과 정면충돌'],
  ['실적 시즌 기대감', '스티치 1차'],
];

// PASS 케이스는 §4-a 가 확정한 '소스가 있는 사실 문장'이다.
const MUST_PASS = [
  '시가 256,500원보다 5,000원 높게 마감했어요',
  '거래량이 최근 20일 평균의 0.63배였어요',
  '오전 한때 266,500원까지 올랐다가 상승폭을 줄여 마감했어요',
  '52주 최고가 362,500원 대비 28% 낮은 수준이에요',
  '5거래일 중 3일이 올랐어요',
];

const HEADLINE_FAIL = [
  ['"과도한 주가 조정" 삼성전자, 목표주가 37만원…대우건설, 대규모 신규 수주 자신감', '실제 RSS 수집분'],
  ['반도체 수혜주 총정리', '가공 예시'],
  ['증권가 투자의견 상향', '가공 예시'],
];
const HEADLINE_PASS = [
  '삼성, 갤럭시A1 DDI 후공정 LB세미콘→대만 칩본드 변경...원가 절감 차원',
  '"연산까지 하는 메모리 나왔다"...삼성전자, 온디바이스 겨냥 세계 최초 공개',
  '최대주주 등의 소유주식 변동신고서 (시간외 대량매매)',
];

function selfTest() {
  let fail = 0;
  console.log('── 막아야 하는 문장 (전부 실제 생성 사례)');
  for (const [text, src] of MUST_FAIL) {
    const r = checkText(text);
    const mark = r.ok ? '✗ 통과시킴' : '✓ 차단';
    if (r.ok) fail += 1;
    console.log(`  ${mark}  "${text}"  ${r.ok ? '' : `[${r.hits.map((h) => `${h.id}:${h.match}`).join(', ')}]`}`);
    if (r.ok) console.log(`         ↑ ${src}`);
  }
  console.log('\n── 통과해야 하는 문장 (소스가 있는 사실)');
  for (const text of MUST_PASS) {
    const r = checkText(text);
    const mark = r.ok ? '✓ 통과' : '✗ 오차단';
    if (!r.ok) fail += 1;
    console.log(`  ${mark}  "${text}"  ${r.ok ? '' : `[${r.hits.map((h) => `${h.id}:${h.match}`).join(', ')}]`}`);
  }
  console.log('\n── 버려야 하는 헤드라인 (남의 제목이지만 고르는 건 우리다)');
  for (const [t, src] of HEADLINE_FAIL) {
    const drop = isOpinionHeadline(t);
    if (!drop) { fail += 1; console.log(`  ✗ 통과시킴  "${t}"  ← ${src}`); }
    else console.log(`  ✓ 제외  "${t.slice(0, 40)}…"`);
  }
  console.log('\n── 남겨야 하는 헤드라인 (사실 보도·공시 원문)');
  for (const t of HEADLINE_PASS) {
    const drop = isOpinionHeadline(t);
    if (drop) { fail += 1; console.log(`  ✗ 오제외  "${t}"`); }
    else console.log(`  ✓ 유지  "${t.slice(0, 40)}…"`);
  }

  console.log(`\n${fail === 0 ? '✅ 전부 통과' : `❌ ${fail}건 실패`}`);
  return fail;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(selfTest() === 0 ? 0 : 1);
