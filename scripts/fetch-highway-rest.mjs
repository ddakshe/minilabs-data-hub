/**
 * 고속도로 휴게소 브랜드 + 베스트푸드 데이터 수집
 * data.ex.co.kr API → highway-rest/{brands.json, foods.json, meta.json}
 *
 * 실행: node scripts/fetch-highway-rest.mjs
 * 환경변수: EX_API_KEY (한국도로공사 공공데이터 포털 인증키)
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const KEY = process.env.EX_API_KEY;
if (!KEY) { console.error('EX_API_KEY is not set'); process.exit(1); }

const BASE = 'https://data.ex.co.kr/openapi/restinfo';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; minilabs-data-hub/1.0)',
  'Referer': 'https://data.ex.co.kr/',
  'Accept': 'application/json',
};
const OUT_DIR = path.resolve('highway-rest');
const META_PATH = path.join(OUT_DIR, 'meta.json');

const NUM_PER_PAGE = 99; // 서버 최대 반환 건수

async function fetchAll(endpoint, extraParams = {}) {
  const params = new URLSearchParams({ key: KEY, type: 'json', numOfRows: String(NUM_PER_PAGE), pageNo: '1', ...extraParams });
  const res = await fetch(`${BASE}/${endpoint}?${params}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${endpoint}`);
  const json = await res.json();
  const list = json.list ?? [];
  // pageSize = 전체 페이지 수 (count/numOfRows 올림)
  const totalPages = Number(json.pageSize ?? 1);
  let all = [...list];

  for (let p = 2; p <= totalPages; p++) {
    const p2 = new URLSearchParams({ key: KEY, type: 'json', numOfRows: String(NUM_PER_PAGE), pageNo: String(p), ...extraParams });
    const r2 = await fetch(`${BASE}/${endpoint}?${p2}`, { headers: HEADERS });
    if (!r2.ok) break;
    const j2 = await r2.json();
    all.push(...(j2.list ?? []));
    if (p % 5 === 0) console.log(`  page ${p}/${totalPages}`);
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

  // 월 1회 이상 갱신 방지 (같은 월이면 스킵)
  if (prev && prev.lastFetched?.slice(0, 7) === today.slice(0, 7)) {
    console.log(`이미 이번 달(${today.slice(0, 7)}) 수집됨 — 스킵.`);
    return;
  }

  console.log('브랜드 매장현황 수집 중...');
  const brands = await fetchAll('restBrandList');
  console.log(`  브랜드: ${brands.length}건`);

  console.log('베스트푸드 수집 중...');
  const foods = await fetchAll('restBestfoodList', { bestfoodyn: 'Y' });
  console.log(`  베스트푸드: ${foods.length}건`);

  console.log('추천메뉴 수집 중...');
  const recommended = await fetchAll('restBestfoodList', { recommendyn: 'Y' });
  console.log(`  추천메뉴: ${recommended.length}건`);

  // 두 메뉴 합치고 중복 제거 (seq 키 기준)
  const foodsMap = new Map();
  [...foods, ...recommended].forEach(f => foodsMap.set(`${f.stdRestCd}_${f.seq}`, f));
  const allFoods = [...foodsMap.values()];

  const meta = {
    lastFetched: today,
    brandCount: brands.length,
    foodCount: allFoods.length,
    source: 'https://data.ex.co.kr',
    license: '공공누리 제1유형',
    provider: '한국도로공사',
  };

  await fs.writeFile(path.join(OUT_DIR, 'brands.json'), JSON.stringify(brands));
  await fs.writeFile(path.join(OUT_DIR, 'foods.json'), JSON.stringify(allFoods));
  await fs.writeFile(META_PATH, JSON.stringify(meta, null, 2));

  const bKB = (await fs.stat(path.join(OUT_DIR, 'brands.json'))).size / 1024;
  const fKB = (await fs.stat(path.join(OUT_DIR, 'foods.json'))).size / 1024;
  console.log(`완료: brands.json (${bKB.toFixed(1)}KB), foods.json (${fKB.toFixed(1)}KB)`);
}

main().catch(err => { console.error(err); process.exit(1); });
