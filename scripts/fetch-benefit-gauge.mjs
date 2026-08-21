#!/usr/bin/env node
// 보조금24(행정안전부 대한민국 공공서비스 정보) — benefit-gauge/benefits.json 으로 저장.
// benefit-gauge-mini(내가 받을 수 있는 혜택) 앱이 "조건이 맞는 혜택" 개수·목록에 쓴다.
//
// 신규 제도 등록이 주 3~7건(2026-08 실측)이라 워크플로우는 주 1회 cron + 수동 실행이면 충분.
//
// 로컬 실행:
//   GOV24_KEY=<decoded key> node scripts/fetch-benefit-gauge.mjs
//
// ── API 함정 (실측 2026-08-21) ────────────────────────────────────────────
// 1. 호스트는 apis.data.go.kr 이 아니라 api.odcloud.kr/api 다. 포맷은 JSON.
// 2. totalCount 는 cond[...] 필터와 무관하게 항상 전체 건수를 낸다.
//    실제 일치 건수는 matchCount. totalCount 로 페이징하면 빈 페이지를 계속 긁는다.
// 3. perPage 상한은 1000. 초과하면 에러가 아니라 {"code":0,"msg":"정상"} 만 오고
//    data 키가 사라진다 — 성공처럼 보이는 조용한 실패라 data 존재를 반드시 검증한다.
// 4. 인증키는 디코딩 형태를 쓴다. Authorization: Infuser 헤더에 인코딩키를 넣으면 401 code:-4.
// 5. 401/-4 = 경로 유효·키 미등록, 404/-3 = 경로 없음. 이 둘을 구분하면 디버깅이 빠르다.
//
// ── 데이터 함정 ──────────────────────────────────────────────────────────
// - 지원유형 필드는 부정확하다. 국민내일배움카드(조회수 1위, 훈련비 500만원)가
//   "서비스(일자리)"로 분류돼 있어 현금 필터로 걸러내면 최상위가 빠진다.
//   그래서 유형이 아니라 지원내용의 금액 표현으로 판단한다.
// - 소관기관명에 "전남광주통합특별시" 같은 통합 행정구역이 섞여 있다.
//   시도명 하드코딩 매핑은 깨진다 → SIDO 배열을 데이터에 맞춰 관리한다.
// - 지역 필드가 따로 없다. 소관기관유형 + 소관기관명 파싱으로 추정한다.
//
// ⚠️ rows 의 배열 순서(ROW)와 비트 순서(SIT/HH/INC)는 앱의
//    src/data/types.ts · src/lib/match.ts 와 반드시 일치해야 한다.
//    어긋나면 에러 없이 조용히 틀린 개수를 센다.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'benefit-gauge');
const OUT_PATH = resolve(OUT_DIR, 'benefits.json');
const META_PATH = resolve(OUT_DIR, 'meta.json');

const key = process.env.GOV24_KEY;
if (!key) {
  console.error('GOV24_KEY 환경변수가 필요합니다 (data.go.kr 일반 인증키, 디코딩 형태).');
  process.exit(1);
}

const BASE = 'https://api.odcloud.kr/api/gov24/v3';
const PER_PAGE = 1000;

/** 앱 src/lib/match.ts 의 SIT_CODES 와 순서가 같아야 한다. */
const SIT = ['JA0301','JA0302','JA0303','JA0313','JA0314','JA0315','JA0316','JA0317',
  'JA0318','JA0319','JA0320','JA0326','JA0327','JA0328','JA0329','JA0330'];
/** 앱 src/lib/match.ts 의 HH_CODES 와 순서가 같아야 한다. */
const HH = ['JA0401','JA0402','JA0403','JA0404','JA0411','JA0412','JA0413','JA0414'];
const INC = ['JA0201','JA0202','JA0203','JA0204','JA0205'];
/** 기업·창업 전용 서비스를 걸러낸다. 개인 사용자에게 무의미하다. */
const BIZ = ['JA1101','JA1102','JA1103','JA1201','JA1202','JA1299',
  'JA2101','JA2102','JA2103','JA2201','JA2202','JA2203','JA2299'];

/** 데이터에 실제로 나타나는 시도명. 통합 행정구역 때문에 17개가 아니라 16개다. */
const SIDO = ['서울특별시','부산광역시','대구광역시','인천광역시','대전광역시','울산광역시',
  '세종특별자치시','경기도','강원특별자치도','충청북도','충청남도','전북특별자치도',
  '전남광주통합특별시','경상북도','경상남도','제주특별자치도'];

const Y = (row, code) => String(row?.[code] ?? '').trim().toUpperCase() === 'Y';

/** 지원내용에서 금액 표현을 뽑는다. 없으면 null → 스냅샷에서 제외된다. */
const AMOUNT = /(\d{1,3}(?:,\d{3})+)\s*원|(\d+)\s*만\s?원/;
function money(text) {
  const m = AMOUNT.exec(String(text ?? ''));
  if (!m) return null;
  return m[1] ? `${m[1]}원` : `${m[2]}만원`;
}

async function fetchAll(op) {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const url = `${BASE}/${op}?${new URLSearchParams({
      page: String(page),
      perPage: String(PER_PAGE),
      serviceKey: key,
    })}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${op} p${page}: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    // perPage 초과 시 data 가 사라지는 조용한 실패를 여기서 잡는다.
    if (!Array.isArray(json.data)) {
      throw new Error(`${op} p${page}: data 배열이 없습니다 — ${JSON.stringify(json).slice(0, 200)}`);
    }
    rows.push(...json.data);
    // totalCount 가 아니라 matchCount 다.
    const total = json.matchCount ?? json.totalCount ?? 0;
    if (rows.length >= total || json.data.length === 0) break;
  }
  return rows;
}

/** 소관기관유형 + 소관기관명 → [시도 인덱스, 시군구 이름]. 전국이면 [-1, null]. */
function region(svc) {
  const type = svc['소관기관유형'] ?? '';
  const name = String(svc['소관기관명'] ?? '').trim();
  if (type === '중앙행정기관' || type === '공공기관') return [-1, null];
  if (type === '시군구') {
    const parts = name.split(/\s+/);
    if (parts.length === 2 && SIDO.includes(parts[0])) return [SIDO.indexOf(parts[0]), parts[1]];
    return null;
  }
  if (type === '광역시도') {
    return SIDO.includes(name) ? [SIDO.indexOf(name), null] : null;
  }
  // 지방출자·출연기관 / 지방공기업 / 교육청은 기관명이 자유형식이다. 시도명을 찾아 추정한다.
  for (let i = 0; i < SIDO.length; i += 1) {
    if (name.includes(SIDO[i]) || name.includes(SIDO[i].slice(0, 2))) return [i, null];
  }
  return null;
}

async function main() {
  console.error('gov24 수집 중…');
  const [list, conds] = await Promise.all([
    fetchAll('serviceList'),
    fetchAll('supportConditions'),
  ]);
  console.error(`  serviceList ${list.length} · supportConditions ${conds.length}`);

  const condById = new Map(conds.map((c) => [c['서비스ID'], c]));
  const sgByS = new Map();
  const picked = [];
  let dropped = 0;

  for (const svc of list) {
    const cond = condById.get(svc['서비스ID']);
    if (!cond) continue;
    const user = String(svc['사용자구분'] ?? '');
    if (!user.includes('개인') && !user.includes('가구')) continue;
    const amount = money(svc['지원내용']);
    if (!amount) continue;
    // 기업 전용(상황 조건이 하나도 없고 기업 코드만 켜진 것)은 뺀다.
    if (BIZ.some((k) => Y(cond, k)) && !Y(cond, 'JA0322') && !SIT.some((k) => Y(cond, k))) continue;
    const reg = region(svc);
    if (!reg) { dropped += 1; continue; }

    const [si, sgName] = reg;
    if (si >= 0 && sgName) {
      if (!sgByS.has(si)) sgByS.set(si, new Set());
      sgByS.get(si).add(sgName);
    }
    picked.push({ svc, cond, amount, si, sgName });
  }
  console.error(`  후보 ${picked.length}건 (지역 판정 실패 ${dropped}건 제외)`);

  const sg = {};
  for (const [si, set] of [...sgByS].sort((a, b) => a[0] - b[0])) {
    sg[String(si)] = [...set].sort();
  }
  const fields = [...new Set(picked.map((p) => p.svc['서비스분야'] ?? ''))].sort();

  const rows = picked.map(({ svc, cond, amount, si, sgName }) => {
    const lo = cond['JA0110'];
    const hi = cond['JA0111'];
    return [
      String(svc['서비스명'] ?? '').slice(0, 40),
      si,
      si >= 0 && sgName ? sg[String(si)].indexOf(sgName) : -1,
      lo ?? -1,
      hi ?? -1,
      (Y(cond, 'JA0101') ? 1 : 0) | (Y(cond, 'JA0102') ? 2 : 0),
      INC.reduce((m, k, i) => m | (Y(cond, k) ? 1 << i : 0), 0),
      (Y(cond, 'JA0322') ? 1 : 0) | SIT.reduce((m, k, i) => m | (Y(cond, k) ? 1 << (i + 1) : 0), 0),
      (Y(cond, 'JA0410') ? 1 : 0) | HH.reduce((m, k, i) => m | (Y(cond, k) ? 1 << (i + 1) : 0), 0),
      svc['조회수'] ?? 0,
      amount,
      fields.indexOf(svc['서비스분야'] ?? ''),
      String(svc['서비스ID'] ?? ''),
    ];
  });

  // 조회수 내림차순으로 미리 정렬한다. 앱은 필터만 하고 정렬하지 않는다.
  rows.sort((a, b) => b[9] - a[9]);

  // ── 구조 검증. 비트 순서가 밀리면 앱이 에러 없이 틀린 개수를 센다 ──
  const problems = [];
  if (rows.length === 0) problems.push('rows 가 비어 있다');
  if (rows.some((r) => r.length !== 13)) problems.push('행 길이가 13이 아닌 것이 있다');
  const sitMax = (1 << (SIT.length + 1)) - 1;
  const hhMax = (1 << (HH.length + 1)) - 1;
  if (rows.some((r) => r[7] > sitMax)) problems.push('sitMask 가 정의된 비트 폭을 넘는다');
  if (rows.some((r) => r[8] > hhMax)) problems.push('hhMask 가 정의된 비트 폭을 넘는다');
  if (rows.some((r, i) => i > 0 && rows[i - 1][9] < r[9])) problems.push('조회수 정렬이 깨졌다');
  if (rows.some((r) => r[1] >= 0 && r[2] >= 0 && r[2] >= (sg[String(r[1])] ?? []).length)) {
    problems.push('시군구 인덱스가 범위를 넘는다');
  }
  if (problems.length) {
    problems.forEach((p) => console.error(`  실패: ${p}`));
    process.exit(1);
  }

  const nationwide = rows.filter((r) => r[1] === -1).length;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify({ sido: SIDO, sg, fields, rows }), 'utf-8');
  writeFileSync(
    META_PATH,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        total: rows.length,
        nationwide,
        local: rows.length - nationwide,
        sido: SIDO.length,
        sigungu: Object.values(sg).reduce((n, v) => n + v.length, 0),
        fields: fields.length,
        source: '보조금24 대한민국 공공서비스(혜택) 정보 (api.odcloud.kr/api/gov24/v3)',
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  console.error(`완료: ${rows.length}건 (전국 ${nationwide} / 지역 ${rows.length - nationwide})`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
