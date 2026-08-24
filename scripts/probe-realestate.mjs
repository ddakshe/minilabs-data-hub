/**
 * 실거래가 API 원문 응답을 그대로 찍는 진단용. 앱·데이터에 영향 없다.
 * 전월세가 rows=0 / errors=0 으로 온 원인을 가리기 위해 만들었다 —
 * 미신청(30)·엔드포인트 오류(12)·응답 래핑 차이·진짜 0건을 구분한다.
 *
 *   node scripts/probe-realestate.mjs
 */
const K = process.env.DATA_GO_KR_KEY;
if (!K) { console.error('DATA_GO_KR_KEY 없음'); process.exit(1); }
const KEY = /%[0-9A-Fa-f]{2}/.test(K) ? K : encodeURIComponent(K);

const OPS = [
  'RTMSDataSvcAptTrade',   // 대조군 — 이건 54만 건을 받아왔다
  'RTMSDataSvcAptRent',
  'RTMSDataSvcRHRent',
  'RTMSDataSvcOffiRent',
];

for (const op of OPS) {
  const url = `https://apis.data.go.kr/1613000/${op}/get${op}`
    + `?serviceKey=${KEY}&LAWD_CD=11680&DEAL_YMD=202607&numOfRows=2&pageNo=1&_type=json`;
  console.log(`\n===== ${op} =====`);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const text = await res.text();
    console.log(`HTTP ${res.status} · content-type: ${res.headers.get('content-type')}`);
    console.log(text.slice(0, 700).replace(/\s+/g, ' '));
  } catch (e) {
    console.log(`요청 실패: ${e.message}`);
  }
}
