/**
 * 전국 전기차 충전소 위치 데이터 수집
 * 한국환경공단 전기자동차 충전소 정보 API → ev-chargers/chargers.json
 *
 * 실행: node scripts/fetch-ev-chargers.mjs
 * 환경변수: EV_API_KEY (공공데이터포털 인증키 Encoding 버전)
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const KEY = process.env.EV_API_KEY;
if (!KEY) { console.error('EV_API_KEY is not set'); process.exit(1); }

const BASE = 'https://apis.data.go.kr/B552584/EvCharger';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; minilabs-data-hub/1.0)' };
const OUT_DIR = path.resolve('ev-chargers');
const META_PATH = path.join(OUT_DIR, 'meta.json');
const NUM_PER_PAGE = 9999;

// 시도 코드 17개
const ZCODES = [
  { name: '서울',  code: '11' },
  { name: '부산',  code: '26' },
  { name: '대구',  code: '27' },
  { name: '인천',  code: '28' },
  { name: '광주',  code: '29' },
  { name: '대전',  code: '30' },
  { name: '울산',  code: '31' },
  { name: '세종',  code: '36' },
  { name: '경기',  code: '41' },
  { name: '강원',  code: '51' },
  { name: '충북',  code: '43' },
  { name: '충남',  code: '44' },
  { name: '전북',  code: '52' },
  { name: '전남',  code: '46' },
  { name: '경북',  code: '47' },
  { name: '경남',  code: '48' },
  { name: '제주',  code: '50' },
];

// 필요한 필드만 추출해서 용량 절감
function slim(item) {
  return {
    statId:      item.statId,
    statNm:      item.statNm,
    addr:        item.addr,
    lat:         item.lat,
    lng:         item.lng,
    output:      item.output,
    chgerType:   item.chgerType,
    parkingFree: item.parkingFree,
    useTime:     item.useTime,
    zcode:       item.zcode,
    kindDetail:  item.kindDetail,
    delYn:       item.delYn,
  };
}

async function fetchRegion(zcode, name) {
  const all = [];
  let page = 1;

  while (true) {
    const url = `${BASE}/getChargerInfo?serviceKey=${KEY}&pageNo=${page}&numOfRows=${NUM_PER_PAGE}&dataType=JSON&zcode=${zcode}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${name}`);
    const json = await res.json();
    if (json.resultCode !== '00') throw new Error(`API 오류: ${json.resultMsg}`);

    const items = Array.isArray(json.items?.item) ? json.items.item
      : json.items?.item ? [json.items.item] : [];
    all.push(...items.filter(i => i.delYn !== 'Y' && i.lat && i.lng).map(slim));

    const totalPages = Math.ceil(Number(json.totalCount) / NUM_PER_PAGE);
    if (page >= totalPages) break;
    page++;
    if (page % 3 === 0) await new Promise(r => setTimeout(r, 200)); // API 부하 분산
  }

  return all;
}

async function readMeta() {
  try { return JSON.parse(await fs.readFile(META_PATH, 'utf-8')); } catch { return null; }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const prev = await readMeta();
  if (prev && prev.lastFetched?.slice(0, 7) === today.slice(0, 7)) {
    console.log(`이미 이번 달(${today.slice(0, 7)}) 수집됨 — 스킵.`);
    return;
  }

  const all = [];
  let totalCalls = 0;

  for (const { name, code } of ZCODES) {
    console.log(`수집 중: ${name}(${code})...`);
    const items = await fetchRegion(code, name);
    all.push(...items);
    totalCalls++;
    console.log(`  → ${items.length}건`);
    await new Promise(r => setTimeout(r, 300)); // 지역 간 딜레이
  }

  // statId 기준 중복 제거 (같은 충전소의 충전기가 여러 개인 경우 대표 1개만)
  const unique = new Map();
  for (const c of all) {
    if (!unique.has(c.statId)) unique.set(c.statId, c);
  }
  const chargers = [...unique.values()];

  await fs.writeFile(path.join(OUT_DIR, 'chargers.json'), JSON.stringify(chargers));

  const meta = {
    lastFetched: today,
    total: chargers.length,
    apiCalls: totalCalls,
    source: 'https://apis.data.go.kr/B552584/EvCharger',
    license: '공공누리 제1유형',
    provider: '한국환경공단',
  };
  await fs.writeFile(META_PATH, JSON.stringify(meta, null, 2));

  const kb = (await fs.stat(path.join(OUT_DIR, 'chargers.json'))).size / 1024;
  console.log(`\n완료: ${chargers.length}개 충전소, ${kb.toFixed(0)}KB, API ${totalCalls}회`);
}

main().catch(err => { console.error(err); process.exit(1); });
