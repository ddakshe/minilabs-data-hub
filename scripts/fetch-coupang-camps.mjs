#!/usr/bin/env node
// 쿠팡 배송캠프(CLS) 목록 — 캠프헬퍼 채용사이트.
//
//   https://helper.coupangls.com/camp-all/?e-page-825f530=N   (Elementor loop grid, 6개/페이지)
//
// CLS 캠프는 CFS 공식 API(/api/fc)에 없다. 별도 조직이라 근무지 목록도 따로 논다.
// 국민연금 사업장 데이터에도 안 잡힌다(전국 캠프가 강남 본사 1개 사업장으로 등록돼 있음).
// 여기가 사실상 유일한 공개 목록이다.
//
// curl 은 403(봇 차단). 서버 렌더링이지만 브라우저 UA 검증이 있어 playwright 로 긁는다.
//
// 얻는 것 (CFS API 보다 오히려 풍부하다):
//   - 캠프명 / 주소 / 지역
//   - **근무조** (심야조·야간조·주간조) — 캠프마다 다르다. CFS 3교대 모델이 안 맞는 이유.
//   - **셔틀 유무** — CSS 클래스 category-shuttle 로 표시된다
//
// 실행: node scripts/fetch-coupang-camps.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'coupang-facilities');

const BASE = 'https://helper.coupangls.com/camp-all/';
const PAGE_PARAM = 'e-page-825f530';

const SIDO_RE = /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/;

// category-* 클래스 → 의미. 지역 카테고리는 영문 슬러그라 한글로 되돌린다.
const REGION = {
  seoul: '서울', 'gyeonggi-south': '경기남부', 'gyeonggi-north': '경기북부',
  incheon: '인천', gangwon: '강원', daejeon: '대전', sejong: '세종',
  chungnam: '충남', chungbuk: '충북', busan: '부산', ulsan: '울산',
  gyeongnam: '경남', gyeongbuk: '경북', daegu: '대구', gwangju: '광주',
  jeonnam: '전남', jeonbuk: '전북', jeju: '제주',
};

// Akamai 봇차단 때문에 headless 는 403 이다(UA 를 바꿔도 마찬가지).
// 실제 Chrome 바이너리 + 헤드풀이어야 통과한다 — 실행하면 창이 잠깐 뜬다.
const browser = await chromium.launch({ headless: false, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

async function scrapePage(n) {
  const url = n === 1 ? BASE : `${BASE}?${PAGE_PARAM}=${n}`;
  // Elementor 루프 그리드가 lazy-load 라 domcontentloaded 시점엔 아직 비어 있다.
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.e-loop-item', { timeout: 30000 });

  return page.evaluate((REGION_MAP) => {
    return [...document.querySelectorAll('.e-loop-item')].map((el) => {
      const lines = el.innerText.split('\n').map((s) => s.trim()).filter(Boolean);

      // 줄 순서: [지역...] [캠프명] [주소] [근무조...]
      // 주소는 시도명으로 시작하는 줄이고, 캠프명은 그 바로 앞 줄이다.
      //
      // 단순히 "시도명으로 시작 + 8자 초과" 로 잡으면 안 된다.
      // "인천 4 M-Camp", "대전 3 Sub FC" 처럼 캠프명 자체가 지역명으로 시작하는 경우가 있어서
      // 이름을 주소로 오인하고, 그 앞의 지역 라벨이 이름으로 밀려난다.
      // → 시군구 토큰("○○시 ", "○○구 ", "○○군 ")과 숫자를 함께 요구한다.
      const sidoRe = /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/;
      const isAddr = (l) => sidoRe.test(l) && /[가-힣]+(시|군|구)\s/.test(l) && /\d/.test(l);
      const addrIdx = lines.findIndex(isAddr);
      if (addrIdx < 1) return null;

      const classes = [...el.classList];
      const regions = classes
        .filter((c) => c.startsWith('category-'))
        .map((c) => c.replace('category-', ''))
        .filter((c) => REGION_MAP[c])
        .map((c) => REGION_MAP[c]);

      // 주소 끝에 "(무료 주차 가능)", "(주차 불가)" 처럼 주차 정보가 붙는다.
      // 자차 동행에서는 이게 결정적인 정보라 따로 뽑아둔다.
      const rawAddr = lines[addrIdx];
      const parkNote = (rawAddr.match(/\(([^)]*주차[^)]*)\)/) ?? [])[1] ?? null;
      const parking = parkNote === null ? null : /불가/.test(parkNote) ? 'no' : 'yes';

      return {
        name: lines[addrIdx - 1],
        address: rawAddr,
        regions,
        // 근무조 라벨. "○○조" 로 끝나는 게 대부분이지만 "주간 short", "야간 short", "주간2" 처럼
        // 조로 안 끝나는 변형이 있어서 시간대 단어(주간/오전/오후/야간/저녁/심야)도 같이 잡는다.
        // (조로 안 끝나는 걸 놓치면 그 캠프는 근무조가 통째로 비어 셋 다 열리는 폴백으로 샌다.)
        shifts: lines.slice(addrIdx + 1)
          .filter((l) => /조$/.test(l) || /(주간|오전|오후|야간|저녁|심야)/.test(l)),
        hasShuttle: classes.includes('category-shuttle'),
        parking,
        parkNote,
        active: classes.includes('category-ing'),
        // 상세 페이지에 근무조별 시간·일급 표가 있다. 2차 수집용.
        url: el.querySelector('a')?.href ?? null,
      };
    }).filter(Boolean);
  }, REGION);
}

// 전체 페이지 수는 페이지네이션 링크의 ?e-page-...=N 최대값으로 잡는다.
// 화면 라벨은 "1 2 3 … 33" 처럼 생략(…)이 있어 텍스트만 보면 놓친다.
await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
await page.waitForSelector('.e-loop-item', { timeout: 30000 });
const totalPages = await page.evaluate((param) => {
  const ns = [...document.querySelectorAll('a[href]')]
    .map((a) => new URL(a.href, location.origin).searchParams.get(param))
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  return ns.length ? Math.max(...ns) : 1;
}, PAGE_PARAM);
console.log(`총 ${totalPages} 페이지`);

const seen = new Map();
for (let n = 1; n <= totalPages; n += 1) {
  const rows = await scrapePage(n);
  for (const r of rows) if (!seen.has(r.name)) seen.set(r.name, r);
  process.stdout.write(`\r[${n}/${totalPages}] ${seen.size}곳`);
}
console.log();

// ── 2차: 캠프 상세 페이지에서 근무조별 시간·일급 ──
//
// 상세 페이지에 "타입 / 근무 시간 / 일급" 표가 있다. 목록에는 근무조 이름만 나온다.
// 페이지를 167번 이동하면 느리므로, 이미 통과한 세션 안에서 같은 출처로 fetch 한다
// (Akamai 쿠키가 그대로 실려서 차단되지 않고, 전체 로드도 없어 훨씬 빠르다).
const urls = [...seen.values()].map((c) => ({ name: c.name, url: c.url })).filter((x) => x.url);
console.log(`상세 ${urls.length}건 수집…`);

const details = await page.evaluate(async (items) => {
  const TIME = /(\d{1,2}:\d{2})\s*[~\-–]\s*(\d{1,2}:\d{2})/;
  const out = {};
  for (const { name, url } of items) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) continue;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const rows = [];
      for (const tr of doc.querySelectorAll('tr')) {
        const cells = [...tr.querySelectorAll('td,th')].map((c) => c.textContent.trim());
        // 라벨이 늘 "○○조" 인 건 아니다. "세척3(구도)" 처럼 업무명을 쓰는 캠프가 있어서
        // 조 이름으로 찾으면 통째로 놓친다. 시간 범위가 있는 행을 기준으로 잡고,
        // 그 앞 칸에서 라벨을 가져온다.
        const timeIdx = cells.findIndex((c) => TIME.test(c));
        if (timeIdx < 1) continue;
        const time = cells[timeIdx].match(TIME);
        const pay = cells.map((c) => c.match(/([\d,]{5,})\s*원/)).find(Boolean);
        const label = cells.slice(0, timeIdx).filter(Boolean).pop();
        if (label) {
          rows.push({
            shift: label,
            start: time[1],
            end: time[2],
            pay: pay ? Number(pay[1].replace(/,/g, '')) : null,
          });
        }
      }
      if (rows.length) out[name] = rows;
    } catch { /* 개별 실패는 건너뛴다 */ }
  }
  return out;
}, urls);

console.log(`상세 확보: ${Object.keys(details).length}곳`);
await browser.close();

const camps = [...seen.values()]
  .map((c) => ({ ...c, schedule: details[c.name] ?? null }))
  .sort((a, b) => a.name.localeCompare(b.name, 'ko'));

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  resolve(OUT_DIR, 'camps.json'),
  JSON.stringify({
    updatedAt: new Date().toISOString(),
    source: 'helper.coupangls.com/camp-all (캠프헬퍼 채용사이트)',
    note: 'CLS 배송캠프. 근무조가 캠프마다 다르고 셔틀 유무도 제각각이라 CFS 3교대 모델과 다르다.',
    camps,
  }, null, 2) + '\n',
);

const shifts = camps.flatMap((c) => c.shifts);
console.log(`coupang-facilities/camps.json — ${camps.length}곳`);
console.log('셔틀 있는 캠프:', camps.filter((c) => c.hasShuttle).length);
console.log('근무조 종류:', [...new Set(shifts)].join(', '));
