/**
 * 국내 주유소 평균가 **과거 소급 수집** — 1회성. oil/prices.json 에 병합한다.
 *
 * 실행: node scripts/fetch-oil-history.mjs [시작연도]      (기본 2010)
 *
 * 🚨 이건 API 가 아니라 **웹 폼 POST** 다. fetch-oil.mjs(매일, API)와 성격이 다르다.
 *
 *  - 왜 필요한가: 오피넷 일반 API 에는 과거 조회 수단이 없다. 문서화된 8종에 시계열이
 *    없고, 「특정 7일간」은 엔드포인트 이름조차 공개되지 않았다. 반면 이 웹 폼은
 *    임의 기간을 한 번에 준다(2020~2026 = 2,439일을 단일 요청으로 확인).
 *
 *  - 왜 스케줄에 걸지 않는가: **매일 수집은 API(fetch-oil.yml)가 한다.** 이 스크립트는
 *    앱 출시 전 백테스트 표본을 만들기 위한 1회성이다. 상시로 긁으면 저작권정책의
 *    "수익 목적 사전 협의" 문제와 서버 부하가 둘 다 커진다.
 *    → 오피넷 문의 회신 전까지 **반복 실행하지 말 것.**
 *
 *  - 요청은 **한 번에 긴 기간**으로 보낸다. 잘게 쪼개 여러 번 때리는 것보다 서버에
 *    가볍다. DART 를 동시 요청으로 긁다 IP 차단당한 전례(2026-08-25)를 기억할 것.
 *
 *  - 평균 정의는 페이지에 명시돼 있다: **개별 주유소 판매가격의 합 / 전체 주유소 개수**
 *    = 판매량 가중이 아니라 **단순평균**이다. (미검증 항목 5 해소)
 *
 * 출처 표기 의무: 앱 하단에 "한국석유공사 오피넷" 을 명시한다.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRICES = join(ROOT, 'oil', 'prices.json');
const URL_ = 'https://www.opinet.co.kr/user/dopospdrg/dopOsPdrgSelect.do';

/** 화면 열 이름 → prices.json 의 유종 코드. 헤더를 읽어 매핑하므로 순서에 의존하지 않는다. */
const COL_TO_CODE = {
  '고급휘발유': 'B034',
  '보통휘발유': 'B027',
  '자동차용경유': 'D047',
  '실내등유': 'C004',
};

const pad = (n) => String(n).padStart(2, '0');

async function query(staY, endY, endM, endD) {
  const body = new URLSearchParams({
    TERM: 'D',
    STA_Y: String(staY), STA_M: '01', STA_D: '01',
    END_Y: String(endY), END_M: pad(endM), END_D: pad(endD),
    OIL_CD_B034: 'Y', OIL_CD_B027: 'Y', OIL_CD_D047: 'Y', OIL_CD_C004: 'Y',
    all_chk_cnt: '5', chk_cnt: '4', INIF_FLAG: 'N', equal: 'Y',
  });
  const res = await fetch(URL_, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 날짜 행이 들어 있는 <table> 하나를 골라 헤더로 열을 매핑하고 파싱한다. */
function parse(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  const table = tables.find((t) => /\d{4}년\d{2}월\d{2}일/.test(t));
  if (!table) throw new Error('날짜 행이 있는 표를 못 찾았다 — 화면 구조가 바뀌었을 수 있다');

  const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  // 🚨 본문 행은 <tr> 를 열기만 하고 </tr> 로 닫지 않는다(2,440번 열고 1번 닫음).
  //    브라우저는 자동 교정하지만 정규식은 못 하므로 **여는 태그로 쪼갠다.**
  //    <td>…</td> 는 정상이라 셀 추출은 그대로 된다.
  const trs = table.split(/<tr\b/i).slice(1);

  // 헤더: th 로 된 첫 행에서 열 이름을 읽는다.
  let cols = null;
  for (const tr of trs) {
    const ths = (tr.match(/<th[\s\S]*?<\/th>/gi) ?? []).map(strip);
    if (ths.length >= 2 && ths.some((h) => COL_TO_CODE[h.replace(/\s/g, '')])) {
      cols = ths.map((h) => COL_TO_CODE[h.replace(/\s/g, '')] ?? null);
      break;
    }
  }
  if (!cols) throw new Error('표 헤더에서 유종 열을 못 찾았다');

  const out = {};
  for (const tr of trs) {
    const tds = (tr.match(/<td[\s\S]*?<\/td>/gi) ?? []).map(strip);
    if (!tds.length) continue;
    const m = tds[0].match(/(\d{4})년(\d{2})월(\d{2})일/);
    if (!m) continue; // '전일대비' 같은 행은 건너뛴다
    const date = m[1] + m[2] + m[3];
    tds.forEach((v, i) => {
      const code = cols[i];
      if (!code) return;
      const n = Number(v.replace(/,/g, ''));
      if (Number.isFinite(n) && n > 0) (out[code] ??= {})[date] = n;
    });
  }
  return out;
}

const startYear = Number(process.argv[2] ?? 2010);
const now = new Date();
const html = await query(startYear, now.getFullYear(), now.getMonth() + 1, now.getDate());
const got = parse(html);

const prev = JSON.parse(await readFile(PRICES, 'utf-8'));
let added = 0;
for (const [code, m] of Object.entries(got)) {
  prev.series[code] ??= {};
  for (const [d, v] of Object.entries(m)) {
    if (prev.series[code][d] === undefined) added++;
    prev.series[code][d] = v; // upsert — 확정치가 잠정치를 덮는다
  }
}
// 날짜 오름차순 정렬 (git diff 가 끝에만 붙도록)
for (const code of Object.keys(prev.series)) {
  prev.series[code] = Object.fromEntries(
    Object.entries(prev.series[code]).sort(([a], [b]) => a.localeCompare(b)),
  );
}
await writeFile(PRICES, JSON.stringify(prev), 'utf-8');

const b027 = Object.keys(prev.series.B027 ?? {});
console.log(
  `oil/prices.json — 휘발유 ${b027.length}일치 (${b027[0]} ~ ${b027[b027.length - 1]}), ` +
  `신규 ${added}건, ${((await readFile(PRICES, 'utf-8')).length / 1024).toFixed(0)}KB`,
);
