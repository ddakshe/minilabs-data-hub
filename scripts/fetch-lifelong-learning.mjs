#!/usr/bin/env node
// 전국평생학습강좌표준데이터 (공공데이터포털) — 무료 강좌만 수집해서
// lifelong-learning/courses.json + lifelong-learning/by-region.json 으로 저장.
//
// 로컬 실행:
//   LIFELONG_LEARNING_API_KEY=<decoded key> node scripts/fetch-lifelong-learning.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'lifelong-learning');
const OUT_COURSES = resolve(OUT_DIR, 'courses.json');
const OUT_BY_REGION = resolve(OUT_DIR, 'by-region.json');

const ENDPOINT = 'https://api.data.go.kr/openapi/tn_pubr_public_lftm_lrn_lctre_api';
const PAGE_SIZE = 1000;

const key = process.env.LIFELONG_LEARNING_API_KEY;
if (!key) {
  console.error('LIFELONG_LEARNING_API_KEY 환경변수가 필요합니다.');
  process.exit(1);
}

function isFree(course) {
  const cost = String(course.lctreCost ?? '').trim();
  return !cost || cost === '0' || cost === '무료';
}

function parseRegion(course) {
  const addr = course.edcRdnmadr || course.edcLrnAddr || '';
  const parts = addr.trim().split(/\s+/);

  const sidoKeywords = [
    '특별시', '광역시', '특별자치시', '특별자치도', '도',
  ];

  let sido = '';
  let sigungu = '';

  if (parts.length >= 2) {
    // 첫 번째 토큰이 시도인지 확인
    const first = parts[0];
    const isSido = sidoKeywords.some((kw) => first.endsWith(kw));

    if (isSido) {
      sido = first;
      // 두 번째 토큰이 시군구
      sigungu = parts[1] || '';
    } else {
      // 주소 파싱 실패 — operInstitutionNm 에서 추정
      sido = '기타';
      sigungu = '기타';
    }
  } else if (parts.length === 1 && parts[0]) {
    sido = parts[0];
    sigungu = '기타';
  } else {
    // 주소 없음 — 운영기관명에서 시도 추출 시도
    const inst = course.operInstitutionNm || '';
    const sidoList = [
      '서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종',
      '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주',
    ];
    const found = sidoList.find((s) => inst.includes(s));
    sido = found ? `${found}(추정)` : '기타';
    sigungu = '기타';
  }

  return { sido, sigungu };
}

// searchParams.set은 key를 다시 인코딩해서 이중 인코딩 문제가 생길 수 있음.
// 인코딩 키를 URL에 직접 삽입한다.
const isEncoded = key.includes('%');
const encodedKey = isEncoded ? key : encodeURIComponent(key);

async function fetchPage(pageNo, retries = 3) {
  const url = `${ENDPOINT}?serviceKey=${encodedKey}&numOfRows=${PAGE_SIZE}&pageNo=${pageNo}&type=json`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw new Error(`페이지 ${pageNo} fetch 실패 (${retries}회 시도): ${err.message}`);
      console.warn(`  재시도 ${attempt}/${retries}... (${err.message})`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function fetchAll() {
  const allCourses = [];
  let pageNo = 1;
  let totalCount = null;

  while (true) {
    console.log(`  page ${pageNo}...`);
    const json = await fetchPage(pageNo);

    const body = json?.response?.body;
    if (!body) {
      console.warn('응답 body 없음:', JSON.stringify(json).slice(0, 300));
      break;
    }

    if (totalCount === null) {
      totalCount = Number(body.totalCount ?? 0);
      console.log(`  총 ${totalCount}개 항목`);
      // 첫 페이지 응답 구조 디버그
      console.log('  body keys:', Object.keys(body));
      console.log('  items type:', typeof body.items, '/ value head:', JSON.stringify(body.items)?.slice(0, 200));
    }

    const rawItems = body?.items;
    if (!rawItems || rawItems === '' || typeof rawItems === 'string') {
      console.warn('  items 없음 — 페이지 종료');
      break;
    }

    // API에 따라 items가 배열이거나 { item: [...] } 구조일 수 있음
    let list;
    if (Array.isArray(rawItems)) {
      list = rawItems;
    } else if (rawItems.item) {
      list = Array.isArray(rawItems.item) ? rawItems.item : [rawItems.item];
    } else {
      console.warn('  items 파싱 실패:', JSON.stringify(rawItems).slice(0, 100));
      break;
    }
    allCourses.push(...list);
    console.log(`  page ${pageNo}: ${list.length}개 수집 (누적 ${allCourses.length}개)`);

    const fetched = (pageNo - 1) * PAGE_SIZE + list.length;
    if (fetched >= totalCount || list.length < PAGE_SIZE) break;

    pageNo++;
  }

  return allCourses;
}

console.log('전국평생학습강좌 데이터 수집 시작...');
const all = await fetchAll();
console.log(`수집 완료: 총 ${all.length}개`);
console.log(`무료: ${all.filter(isFree).length}개 / 유료: ${all.filter(c => !isFree(c)).length}개`);

// 시도/시군구 파싱 및 저장 (전체 강좌, 무료 필터 제거)
const courses = all.map((c) => ({ ...c, ...parseRegion(c) }));

// by-region 중첩 객체 생성
const byRegion = {};
for (const course of courses) {
  const { sido, sigungu } = course;
  if (!byRegion[sido]) byRegion[sido] = {};
  if (!byRegion[sido][sigungu]) byRegion[sido][sigungu] = [];
  byRegion[sido][sigungu].push(course);
}

const meta = {
  generated_at: new Date().toISOString(),
  source: '공공데이터포털(data.go.kr) / 교육부 및 각 지방자치단체·교육청',
  total: courses.length,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_COURSES, JSON.stringify({ ...meta, courses }, null, 2) + '\n');
writeFileSync(OUT_BY_REGION, JSON.stringify({ ...meta, byRegion }, null, 2) + '\n');

console.log(`\n✓ wrote ${OUT_COURSES}`);
console.log(`✓ wrote ${OUT_BY_REGION}`);
