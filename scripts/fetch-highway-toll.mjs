/**
 * 고속도로 영업소 목록 + 통행요금 데이터 수집
 * data.ex.co.kr API → highway-toll/{stations.json, meta.json}
 *
 * 실행: node scripts/fetch-highway-toll.mjs
 * 환경변수: EX_API_KEY
 *
 * 통행요금 계산 방식:
 *   - 영업소(IC) 목록 확보 → 앱에서 출발/도착 선택
 *   - 실제 요금은 API 호출 (앱에서 직접) 또는 정적 매트릭스
 *   - 이 스크립트는 영업소 목록 + 기준요금 저장
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const KEY = process.env.EX_API_KEY;
if (!KEY) { console.error('EX_API_KEY is not set'); process.exit(1); }

const BASE = 'https://data.ex.co.kr/openapi';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; minilabs-data-hub/1.0)',
  'Referer': 'https://data.ex.co.kr/',
  'Accept': 'application/json',
};
const OUT_DIR = path.resolve('highway-toll');
const META_PATH = path.join(OUT_DIR, 'meta.json');

async function tryFetch(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
}

async function fetchStations() {
  // 영업소 목록 — 여러 endpoint 시도
  const endpoints = [
    `${BASE}/locationinfo/locationinfoTG?key=${KEY}&type=json&numOfRows=500`,
    `${BASE}/locationinfo/locationInfoTG?key=${KEY}&type=json&numOfRows=500`,
    `${BASE}/odtraffic/tollgateRoute?key=${KEY}&type=json&numOfRows=500`,
  ];

  for (const ep of endpoints) {
    console.log('  시도:', ep.split('?')[0].split('/').pop());
    const data = await tryFetch(ep);
    if (data?.list?.length) return data.list;
  }
  return null;
}

async function readMeta() {
  try { return JSON.parse(await fs.readFile(META_PATH, 'utf-8')); } catch { return null; }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const prev = await readMeta();

  // 월 1회 갱신
  if (prev && prev.lastFetched?.slice(0, 7) === today.slice(0, 7)) {
    console.log(`이미 이번 달 수집됨 — 스킵.`);
    return;
  }

  console.log('영업소 목록 수집 중...');
  const stations = await fetchStations();

  if (!stations) {
    console.warn('영업소 목록 API 미확인 — 영업소 코드 조회 실패.');
    console.warn('data.ex.co.kr 포털에서 영업소간 통행요금 조회 API endpoint를 확인해주세요.');

    // 메타만 업데이트
    await fs.writeFile(META_PATH, JSON.stringify({
      lastFetched: today,
      stationCount: 0,
      status: 'endpoint_not_found',
      note: 'data.ex.co.kr 포털에서 영업소간 통행요금 조회 API endpoint 확인 후 스크립트 업데이트 필요',
    }, null, 2));
    return;
  }

  console.log(`  영업소 ${stations.length}개 수집`);

  const meta = {
    lastFetched: today,
    stationCount: stations.length,
    source: 'https://data.ex.co.kr',
    license: '공공누리 제1유형',
    provider: '한국도로공사',
  };

  await fs.writeFile(path.join(OUT_DIR, 'stations.json'), JSON.stringify(stations));
  await fs.writeFile(META_PATH, JSON.stringify(meta, null, 2));
  console.log('완료: stations.json');
}

main().catch(err => { console.error(err); process.exit(1); });
