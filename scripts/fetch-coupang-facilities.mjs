#!/usr/bin/env node
// 쿠팡 근무지(물류센터) 목록 — 쿠팡풀필먼트서비스 채용사이트 공식 API.
//
//   GET https://coufc.coupang.com/api/fc?closeYn=0
//
// coufc.coupang.com 은 React SPA 라 HTML 만 받으면 빈 껍데기다.
// 센터 목록은 위 엔드포인트가 통째로 내려준다 — 코드(fcAbbr)·주소·위경도까지 다 들어있다.
//
// 이 소스가 국민연금 역추출(fetch-coupang-facilities-nps.mjs)보다 압도적으로 낫다:
//   21곳(읍면동까지, 좌표 없음) → 119곳(전체주소 + 좌표 + 공식코드)
// 국민연금 쪽은 공식 API 에 없는 '가입자수(규모)' 때문에 보조로만 남겨둔다.
//
// 실행: node scripts/fetch-coupang-facilities.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'coupang-facilities');

const API = 'https://coufc.coupang.com/api/fc?closeYn=0';
const REFERER = 'https://coufc.coupang.com/central/centerIntro';

// district1 이 '경기도'/'경기', '충청남도 '(뒤 공백) 처럼 제각각이라 통일한다.
const SIDO = {
  서울특별시: '서울', 서울: '서울',
  부산광역시: '부산', 부산: '부산',
  대구광역시: '대구', 대구: '대구',
  인천광역시: '인천', 인천: '인천',
  광주광역시: '광주', 광주: '광주',
  대전광역시: '대전', 대전: '대전',
  울산광역시: '울산', 울산: '울산',
  세종특별자치시: '세종', 세종: '세종',
  경기도: '경기', 경기: '경기',
  강원특별자치도: '강원', 강원도: '강원', 강원: '강원',
  충청북도: '충북', 충북: '충북',
  충청남도: '충남', 충남: '충남',
  전북특별자치도: '전북', 전라북도: '전북', 전북: '전북',
  전라남도: '전남', 전남: '전남',
  경상북도: '경북', 경북: '경북',
  경상남도: '경남', 경남: '경남',
  제주특별자치도: '제주', 제주: '제주',
};

// fcAbbr 접두로 시설 성격이 갈린다.
//   VF = Vendor Flex(판매자 창고 내 쿠팡 운영), WF = 소형 거점, 나머지는 일반 FC.
// VF/WF 는 한글 이름 없이 코드로만 불리고 규모가 작다 — 앱에서 구분해 보여줄 수 있게 남긴다.
function kindOf(abbr = '') {
  if (/^VF/.test(abbr)) return 'vf';
  if (/^WF/.test(abbr)) return 'wf';
  return 'fc';
}

const res = await fetch(API, { headers: { Referer: REFERER } });
if (!res.ok) throw new Error(`공식 API 응답 실패: HTTP ${res.status}`);
const raw = (await res.json()).result ?? [];

const facilities = raw
  // clusterYn 은 '서울/경기권', '중남부권' 같은 권역 묶음이지 실제 근무지가 아니다.
  // 주소·좌표가 없는 행(VF, WF 같은 상위 카테고리)도 목적지가 될 수 없으므로 뺀다.
  .filter((f) => !f.clusterYn && f.zipcodeAddress && f.latitude && f.longitude)
  .map((f) => {
    const abbr = (f.fcAbbr ?? '').trim();
    const name = (f.fcName ?? '').trim();
    const sido = SIDO[(f.district1 ?? '').trim()] ?? (f.district1 ?? '').trim();
    const address = [f.zipcodeAddress, f.detailAddress].filter(Boolean).join(' ').trim();

    return {
      id: abbr.toLowerCase(),
      code: abbr,
      // WF02 처럼 한글명이 없는 곳은 fcName 이 코드와 같다. 그대로 두면 "WF02 [WF02]" 가 되므로 이름만 쓴다.
      name: name || abbr,
      kind: kindOf(abbr),
      sido,
      sigungu: [f.district2, f.district3].filter(Boolean).join(' ').trim(),
      address,
      zipcode: f.zipcode ?? null,
      lat: Number(f.latitude),
      lng: Number(f.longitude),
      shuttleId: f.shuttlebusFcId ?? null,
      intro: f.introShortMessage ?? null,
    };
  })
  .sort((a, b) => a.sido.localeCompare(b.sido, 'ko') || a.name.localeCompare(b.name, 'ko'));

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  resolve(OUT_DIR, 'facilities.json'),
  JSON.stringify({
    updatedAt: new Date().toISOString(),
    source: 'coufc.coupang.com/api/fc (쿠팡풀필먼트서비스 채용사이트)',
    note: 'CFS(물류센터)만 포함. CLS 배송캠프는 별도 조직이라 이 API 에 없다.',
    facilities,
  }, null, 2) + '\n',
);

const byKind = facilities.reduce((a, f) => ({ ...a, [f.kind]: (a[f.kind] ?? 0) + 1 }), {});
console.log(`coupang-facilities/facilities.json — ${facilities.length}곳`, byKind);
