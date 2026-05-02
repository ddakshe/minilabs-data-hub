#!/usr/bin/env node
// 한국천문연구원 특일정보 (KASI) — 공휴일·대체공휴일을 holidays/holidays.json 으로 저장.
// 데이터는 정부 발표(보통 7~8월에 다음 해 공휴일 공포)에 따라 매우 드물게 변하므로
// 워크플로우는 월 1회 cron + 수동 실행으로 충분.
//
// 로컬 실행:
//   KASI_SERVICE_KEY=<decoded key> node scripts/fetch-holidays.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'holidays');
const OUT_PATH = resolve(OUT_DIR, 'holidays.json');

const ENDPOINT = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';

// 현재 연도부터 +2년
const NOW_YEAR = new Date().getUTCFullYear();
const YEARS = [NOW_YEAR, NOW_YEAR + 1, NOW_YEAR + 2];

const key = process.env.KASI_SERVICE_KEY;
if (!key) {
  console.error('KASI_SERVICE_KEY 환경변수가 필요합니다.');
  process.exit(1);
}

async function fetchYear(year) {
  const all = [];
  for (let month = 1; month <= 12; month++) {
    const url = new URL(ENDPOINT);
    url.searchParams.set('serviceKey', key);
    url.searchParams.set('solYear', String(year));
    url.searchParams.set('solMonth', String(month).padStart(2, '0'));
    url.searchParams.set('numOfRows', '50');
    url.searchParams.set('_type', 'json');

    const res = await fetch(url);
    if (!res.ok) throw new Error(`${year}-${month} fetch 실패: ${res.status}`);
    const json = await res.json();

    const items = json?.response?.body?.items?.item;
    if (!items) continue;
    const list = Array.isArray(items) ? items : [items];

    for (const it of list) {
      const locdate = String(it.locdate);
      const date = `${locdate.slice(0, 4)}-${locdate.slice(4, 6)}-${locdate.slice(6, 8)}`;
      const name = String(it.dateName);
      all.push({
        date,
        name,
        isHoliday: it.isHoliday === 'Y',
        isSubstitute: name.includes('대체'),
      });
    }
  }
  return all;
}

const result = {
  generated_at: new Date().toISOString(),
  source: 'KASI getRestDeInfo (data.go.kr)',
  years: {},
};

for (const y of YEARS) {
  console.log(`fetching ${y}...`);
  result.years[y] = await fetchYear(y);
  console.log(`  ${result.years[y].length} entries`);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(result, null, 2) + '\n');
console.log(`\n✓ wrote ${OUT_PATH}`);
