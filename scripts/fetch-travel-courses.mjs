import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '../travel-courses');

const BASE = 'http://apis.data.go.kr/B551011/KorService2';
const KEY = process.env.KTO_API_KEY;
const DELAY_MS = 300; // 과도한 요청 방지

if (!KEY) {
  console.error('❌ KTO_API_KEY 환경변수가 없습니다.');
  process.exit(1);
}

const AREA_CODES = [
  { code: '1',  name: '서울' },
  { code: '2',  name: '인천' },
  { code: '3',  name: '대전' },
  { code: '4',  name: '대구' },
  { code: '5',  name: '광주' },
  { code: '6',  name: '부산' },
  { code: '7',  name: '울산' },
  { code: '8',  name: '세종' },
  { code: '31', name: '경기' },
  { code: '32', name: '강원' },
  { code: '33', name: '충북' },
  { code: '34', name: '충남' },
  { code: '35', name: '경북' },
  { code: '36', name: '경남' },
  { code: '37', name: '전북' },
  { code: '38', name: '전남' },
  { code: '39', name: '제주' },
];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function ktoFetch(endpoint, params) {
  const qs = new URLSearchParams({
    serviceKey: KEY,
    MobileOS: 'ETC',
    MobileApp: 'minilabs-data-hub',
    _type: 'json',
    ...params,
  });
  const url = `${BASE}/${endpoint}?${qs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${endpoint}`);
  const data = await res.json();
  if (data.response?.header?.resultCode !== '0000') {
    throw new Error(`API error: ${data.response?.header?.resultMsg}`);
  }
  return data.response.body;
}

async function fetchAllCoursesByArea(areaCode) {
  const first = await ktoFetch('areaBasedList2', {
    contentTypeId: 25, areaCode, numOfRows: 100, pageNo: 1,
  });
  const total = first.totalCount;
  const items = first.items?.item ?? [];
  const arr = Array.isArray(items) ? items : [items];

  let page = 2;
  while (arr.length < total) {
    await sleep(DELAY_MS);
    const body = await ktoFetch('areaBasedList2', {
      contentTypeId: 25, areaCode, numOfRows: 100, pageNo: page++,
    });
    const more = body.items?.item ?? [];
    arr.push(...(Array.isArray(more) ? more : [more]));
  }
  return arr;
}

async function fetchSpots(contentId) {
  try {
    const body = await ktoFetch('detailInfo2', {
      contentTypeId: 25, contentId, numOfRows: 30, pageNo: 1,
    });
    const items = body.items?.item;
    if (!items) return [];
    const arr = Array.isArray(items) ? items : [items];
    return arr
      .sort((a, b) => Number(a.subnum) - Number(b.subnum))
      .map(s => ({
        order: Number(s.subnum),
        contentId: s.subcontentid,
        name: s.subname,
        overview: s.subdetailoverview?.trim() ?? '',
        image: s.subdetailimg ?? '',
      }));
  } catch {
    return [];
  }
}

async function fetchDetail(contentId) {
  try {
    const body = await ktoFetch('detailCommon2', { contentId });
    const items = body.items?.item;
    if (!items) return null;
    const item = Array.isArray(items) ? items[0] : items;
    return {
      overview: item.overview?.trim() ?? '',
      addr1: item.addr1 ?? '',
      mapx: item.mapx ?? '',
      mapy: item.mapy ?? '',
    };
  } catch {
    return null;
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const summary = [];
  let totalCourses = 0;

  for (const area of AREA_CODES) {
    console.log(`\n📍 ${area.name} (${area.code}) 수집 중...`);
    const courses = await fetchAllCoursesByArea(area.code);
    console.log(`  코스 ${courses.length}개 발견`);

    const enriched = [];
    for (const [i, c] of courses.entries()) {
      process.stdout.write(`  [${i + 1}/${courses.length}] ${c.title.substring(0, 25)}...\r`);

      await sleep(DELAY_MS);
      const [spots, detail] = await Promise.all([
        fetchSpots(c.contentid),
        fetchDetail(c.contentid),
      ]);

      // 이미지 없으면 첫 스팟 이미지 fallback
      const image = c.firstimage || spots.find(s => s.image)?.image || '';

      enriched.push({
        id: c.contentid,
        title: c.title,
        image,
        areaCode: c.areacode,
        mapx: detail?.mapx || c.mapx,
        mapy: detail?.mapy || c.mapy,
        overview: detail?.overview || '',
        addr: detail?.addr1 || '',
        spots,
      });

      await sleep(DELAY_MS);
    }

    // 이미지 있는 것 먼저
    enriched.sort((a, b) => (b.image ? 1 : 0) - (a.image ? 1 : 0));

    const outPath = join(OUT_DIR, `${area.code}.json`);
    writeFileSync(outPath, JSON.stringify({ area, courses: enriched }, null, 2), 'utf-8');
    console.log(`\n  ✅ ${area.name} 저장 완료 → travel-courses/${area.code}.json`);

    summary.push({ code: area.code, name: area.name, count: enriched.length });
    totalCourses += enriched.length;
    await sleep(DELAY_MS * 2);
  }

  // 인덱스 파일 (지역별 코스 수 + 메타)
  const index = {
    updatedAt: new Date().toISOString(),
    totalCourses,
    areas: summary,
  };
  writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf-8');
  console.log(`\n🎉 완료! 전국 ${totalCourses}개 코스 수집 → travel-courses/index.json`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
