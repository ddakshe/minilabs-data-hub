#!/usr/bin/env node
// facilities.json(CFS 물류센터) + camps.json(CLS 배송캠프) → 앱이 내장할 단일 목적지 모듈.
//
// 쿠팡 근무지는 크게 둘로 갈린다:
//   - CFS 풀필먼트센터: 교외, 셔틀 필수, 좌표 있음
//   - CLS 배송캠프:     도심 인근, 셔틀은 일부, 캠프마다 근무조가 다름
// 앱에서는 한 목록에 두고 operator 로 구분한다. 사용자는 "쿠팡 알바" 로 뭉뚱그려 찾기 때문에
// 목록을 쪼개면 오히려 못 찾는다.
//
// 실행: node scripts/build-coupang-facilities-module.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA = resolve(ROOT, 'coupang-facilities');
const APP = resolve(ROOT, '..', 'chulgeun-mate-mini');

const read = (f) => JSON.parse(readFileSync(resolve(DATA, f), 'utf8'));

// 근무조 라벨을 3개 id 로 접는다.
// CLS 는 "반품 야간조", "세척 주간조", "주간2조" 같은 변형이 있는데 이동 관점에선 같은 시간대다.
function shiftId(label) {
  // "주간 short" / "야간 short" / "주간(숏)" 같은 짧은 근무 변형은 부분매칭으로 자동 흡수된다
  // (short 는 이동 관점에선 같은 시간대다 — 시각은 shiftTimesOf 에서 별도로 드러난다).
  if (/심야/.test(label)) return 'dawn';
  // 저녁조(19:00~01:00, 대전2·3 / 청주1 Sub FC)는 라벨만 다를 뿐 야간대다.
  if (/야간|저녁/.test(label)) return 'night';
  if (/주간|오전|오후/.test(label)) return 'day';
  return null;
}

// 근무조 이름은 시간을 거의 알려주지 않는다 — 같은 "심야조" 가 제주1 Sub-hub 는 23:00,
// 영종도 캠프는 11:00 출근이다. 그래서 실제 시각을 같이 실어 화면에서 표시한다.
//
// 방은 3개로 유지하니까 한 id 안에 여러 시간표가 겹치는 경우가 생긴다. 두 종류다:
//   - 출근은 같고 퇴근만 갈림 (Sub FC 의 09:00~19:00 풀타임 / 09:00~13:30 파트타임) — 26건
//   - 출근 시각 자체가 갈림 (광주 1 Sub-hub 심야조 = 01:00 과 03:30)              — 8건
// 여기서 문자열로 접어 버리면 "갈린다" 는 사실이 사라져 앱이 틀린 시각을 확정해 버린다.
// 구조를 그대로 넘기고 표현은 앱(schema.js 의 formatShiftTime)에 맡긴다.
function shiftTimesOf(schedule, allowed) {
  const groups = {};
  for (const s of schedule ?? []) {
    const id = shiftId(s.shift);
    // 언로딩·세척·신호수·무버처럼 직무명만 있는 근무조는 시간대로 접을 수 없다 → 버린다.
    if (!id || !allowed.includes(id)) continue;
    (groups[id] ??= []).push(s);
  }

  const out = {};
  for (const [id, rows] of Object.entries(groups)) {
    const starts = [...new Set(rows.map((r) => r.start))].filter(Boolean).sort();
    if (!starts.length) continue;
    const ends = [...new Set(rows.map((r) => r.end))].filter(Boolean);
    // 퇴근 시각은 출근이 하나로 떨어지고 종료도 하나일 때만 신뢰할 수 있다.
    out[id] = { starts, end: starts.length === 1 && ends.length === 1 ? ends[0] : null };
  }
  return Object.keys(out).length ? out : null;
}

// 캠프 주소는 "경기도 하남시" 와 "경기 하남시" 가 섞여 있다.
// 시도 접미사(도/특별시/광역시/…)까지 같이 먹어야 시군구가 깨끗하게 남는다.
const SIDO_OF = /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(특별자치시|특별자치도|특별시|광역시|도)?\s*/;

// ── CFS 물류센터 ──
const fcSrc = read('facilities.json');
const fcs = fcSrc.facilities.map((f) => ({
  id: f.id,
  code: f.code,
  name: f.name,
  operator: 'cfs',
  kind: f.kind,
  sido: f.sido,
  sigungu: f.sigungu,
  address: f.address,
  lat: f.lat,
  lng: f.lng,
  // 센터별 근무조 정보는 공식 API 에 없다. 9시간 3교대라 셋 다 열어둔다.
  shifts: ['day', 'night', 'dawn'],
  // 권역별 안내 문서(cfs-shift-articles.json)에 이미지로만 있어서 아직 못 뽑았다.
  shiftTimes: null,
}));

// ── CLS 배송캠프 ──
const campSrc = existsSync(resolve(DATA, 'camps.json')) ? read('camps.json') : { camps: [] };
const camps = campSrc.camps.map((c) => {
  // 주소 앞머리에서 시도를 뽑는다. 캠프 데이터에는 시도 필드가 따로 없다.
  const sido = (c.address.match(SIDO_OF) ?? [])[1] ?? '';
  // c.shifts 는 목록 카드에서 "…조" 로 끝나는 줄만 긁은 요약이고, c.schedule 은 상세 페이지의 표다.
  // 29개 캠프에서 표에만 있는 근무조가 나온다 — 광주 1 Sub-hub 는 심야조 시급까지 표에 있는데
  // 카드에는 야간/주간만 적혀 있다. 표가 더 정확한 출처라 둘을 합집합으로 본다.
  const shifts = [...new Set(
    [...c.shifts, ...(c.schedule ?? []).map((s) => s.shift)].map(shiftId).filter(Boolean),
  )];
  // 그래도 비어 있으면(직무명만 있는 근무조뿐인 캠프) 셋 다 열어둔다 — 목적지 자체는 유효하다
  const openShifts = shifts.length ? shifts : ['day', 'night', 'dawn'];

  return {
    id: `cls-${c.name.replace(/\s+/g, '')}`,
    code: null,
    name: c.name,
    operator: 'cls',
    kind: 'camp',
    sido,
    // 주소에서 시도를 뺀 앞 두 토큰이 시군구
    sigungu: c.address.replace(SIDO_OF, '').trim().split(/\s+/).slice(0, 2).join(' '),
    // 주차·역세권 안내가 괄호로 붙어 있는데 주소로선 잡음이라 떼어낸다(정보는 아래 필드로 보존)
    address: c.address.replace(/\s*\([^)]*\)/g, '').trim(),
    lat: null,
    lng: null,
    shifts: openShifts,
    shiftTimes: shiftTimesOf(c.schedule, openShifts),
  };
});
// 셔틀·주차는 앱 모듈에 싣지 않는다. 앱은 모집까지만 하고 이동 방법은 오픈채팅에서 정하므로
// 화면에 쓸 데가 없다. 원본(camps.json)에는 그대로 남아 있으니 필요해지면 다시 실으면 된다.
// 일급(schedule[].pay, 36,120~110,940원)도 싣지 않는다. 프로모션·직무별로 자주 바뀌어서
// 틀린 금액이 화면에 남으면 신뢰도에 바로 타격이 온다. 시각과 달리 확인해 줄 방법도 없다.

const facilities = [...fcs, ...camps].map((f) => {
  const tokens = (f.sigungu ?? '').split(/\s+/).filter(Boolean);
  const aliases = [...new Set([f.code, ...tokens, f.sido].filter(Boolean))]
    .filter((a) => !f.name.includes(a));
  return { ...f, aliases };
}).sort((a, b) => a.sido.localeCompare(b.sido, 'ko') || a.name.localeCompare(b.name, 'ko'));

const out = `// 자동 생성 — minilabs-data-hub/scripts/build-coupang-facilities-module.mjs
// CFS 물류센터: ${fcSrc.source}
// CLS 배송캠프: ${campSrc.source ?? '(없음)'}
//
// 갱신:
//   npm run fetch:coupang-facilities   (공식 API)
//   npm run fetch:coupang-camps        (스크래핑 — 실제 Chrome 창이 뜬다)
//   node scripts/build-coupang-facilities-module.mjs
export const FACILITIES = ${JSON.stringify(facilities, null, 2)};

export const FACILITY_BY_ID = Object.fromEntries(FACILITIES.map((f) => [f.id, f]));
`;

if (!existsSync(APP)) {
  console.error(`앱 폴더가 없습니다: ${APP}`);
  process.exit(1);
}
writeFileSync(resolve(APP, 'src/data/facilities.js'), out);
console.log(`chulgeun-mate-mini/src/data/facilities.js — 총 ${facilities.length}곳 (센터 ${fcs.length} / 캠프 ${camps.length})`);
