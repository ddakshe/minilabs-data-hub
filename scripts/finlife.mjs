/**
 * 금융감독원 금융상품통합비교공시(finlife) 오픈API 공용 유틸.
 *
 * rate-lens-mini(금리 돋보기) 앱이 쓰는 예적금 금리 데이터를 수집한다.
 * 이 앱의 핵심은 광고에 뜨는 최고금리(intr_rate2)가 아니라 우대조건을 하나도
 * 채우지 않았을 때 실제로 받는 기본금리(intr_rate)다. 두 값을 모두 보존한다.
 */

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

export const BASE_URL = 'http://finlife.fss.or.kr/finlifeapi';

/** 수집 대상 4개 조합. 예금·적금 × 은행·저축은행. */
export const TARGETS = [
  { endpoint: 'depositProductsSearch', type: 'deposit', group: 'bank', topFinGrpNo: '020000' },
  { endpoint: 'depositProductsSearch', type: 'deposit', group: 'savings', topFinGrpNo: '030300' },
  { endpoint: 'savingProductsSearch', type: 'saving', group: 'bank', topFinGrpNo: '020000' },
  { endpoint: 'savingProductsSearch', type: 'saving', group: 'savings', topFinGrpNo: '030300' },
];

/** 금융회사 개요(홈페이지·대표번호·지역별 점포). 권역당 1페이지면 전부 온다. */
export const COMPANY_GROUPS = ['020000', '030300'];

/**
 * finlife 응답은 mtrt_int / spcl_cnd 같은 장문 필드에 이스케이프되지 않은 생 개행(U+000A)을
 * 그대로 담아 보낸다. RFC 8259상 문자열 안의 제어문자는 반드시 이스케이프돼야 하므로
 * JSON.parse 가 그대로 실패한다.
 *
 * 개행을 공백으로 뭉개면 안 된다 — spcl_cnd 의 개행은 우대조건 항목 구분자이고,
 * 우대조건 원문 노출이 앱의 핵심 기능이다. 삭제가 아니라 이스케이프로 승격시킨다.
 *
 * 문자열 안/밖을 구분하지 않고 일괄 치환하면 pretty-print 된 응답의 구조적 개행까지
 * 리터럴 "\n" 으로 바꿔버려 오히려 파싱이 깨진다. 그래서 상태 기계로 문자열 내부만 손댄다.
 */
export function parseLenientJson(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    if (ch.codePointAt(0) < 0x20) {
      out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : '';
      continue;
    }
    out += ch;
  }

  return JSON.parse(out);
}

export function loadApiKey() {
  const key = process.env.FINLIFE_API_KEY;
  if (!key) {
    throw new Error(
      'FINLIFE_API_KEY 환경변수가 필요합니다. (GitHub Actions에서는 secrets.FINLIFE_API_KEY)',
    );
  }
  return key;
}

/**
 * finlife 는 브라우저가 아닌 User-Agent 를 https 단계에서 끊는다. UA 없이 부르면 응답이
 * 비어서 네트워크 장애로 오해하게 된다. http:// 는 307 로 https 리다이렉트되며 fetch 가 따라간다.
 */
export async function fetchPage(endpoint, topFinGrpNo, pageNo, apiKey) {
  const url = `${BASE_URL}/${endpoint}.json?auth=${apiKey}&topFinGrpNo=${topFinGrpNo}&pageNo=${pageNo}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${endpoint}/${topFinGrpNo} p${pageNo}: HTTP ${res.status}`);

  const text = await res.text();
  const result = parseLenientJson(text)?.result;
  if (!result) throw new Error(`${endpoint}/${topFinGrpNo} p${pageNo}: result 없음`);
  // err_cd 는 HTTP 200 본문 안에 담겨 온다. 인증키 오류·일일 호출 한도 초과도 여기로 떨어진다.
  if (result.err_cd !== '000') {
    throw new Error(`${endpoint}/${topFinGrpNo} p${pageNo}: ${result.err_cd} ${result.err_msg}`);
  }
  return result;
}
