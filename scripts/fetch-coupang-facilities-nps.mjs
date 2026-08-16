#!/usr/bin/env node
// [보조 소스] 쿠팡 근무지 — 국민연금 가입 사업장 내역에서 역추출.
//
// ⚠️ 주 소스는 fetch-coupang-facilities.mjs (쿠팡 공식 API, 119곳 + 좌표) 다.
//    이 스크립트는 공식 API 에 없는 **가입자수(센터 규모)** 만 얻기 위해 남겨둔다.
//    규모는 "동행이 붙을 확률" 의 대리지표라 목록 정렬에 쓴다.
//
// 왜 국민연금이었나 (역사):
//   공식 목록 API 를 찾기 전에는 쿠팡이 근무지를 공개하지 않는다고 보고 우회했다.
//   나무위키 정리본은 CC BY-NC-SA(상업적 이용 불가) + 403 이라 못 쓴다.
//   국민연금 가입 사업장 내역은 "이용허락범위 제한 없음" + 사업장명/상세주소/가입자수를 준다.
//   부산물로 건설 하도급명에서 시설코드(INC4, CHA6…)를 찾아냈는데,
//   나중에 공식 API 의 fcAbbr 와 정확히 일치하는 것으로 확인됐다.
//
// 두 갈래로 뽑는다:
//   A. 쿠팡 법인이 직접 등록한 사업장  → 센터명 + 정확한 도로명주소 + 인원수 (verified)
//   B. 센터 신축·보수 건설 하도급 사업장명 → "쿠팡 INC4 FC 전기공사" 처럼
//      쿠팡 내부 시설코드가 그대로 노출된다. 주소는 읍면동까지만 (unverified)
//
// 한계(중요):
//   쿠팡로지스틱스서비스(CLS)가 운영하는 배송캠프는 전국 수백 개지만
//   전부 강남 수서동 본사 1개 사업장으로 등록돼 있어 이 데이터로는 한 곳도 안 나온다.
//   캠프는 앱에서 사용자 제보(크라우드소싱)로 채우는 수밖에 없다.
//
// 실행:
//   node scripts/fetch-coupang-facilities.mjs
//   KAKAO_REST_KEY=... node scripts/fetch-coupang-facilities.mjs   (좌표까지 채움)

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'coupang-facilities');

// ── .env 로더 (의존성 없이) ──
(function loadEnv() {
  const p = resolve(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

// 공공데이터포털 - 국민연금공단_국민연금 가입 사업장 내역 (월 1회 갱신, CSV ~110MB)
const PORTAL_PK = '15083277';
const PAGE = `https://www.data.go.kr/data/${PORTAL_PK}/fileData.do`;

// ── 1. 다운로드 토큰 해석 ──
// 포털은 상세페이지의 fn_fileDataDown(pk, detailPk) → selectFileDataDownload.do 로
// atchFileId 를 받아온 뒤에야 실제 파일을 준다. detailPk 는 갱신될 때마다 바뀌므로 매번 긁는다.
async function resolveDownloadUrl() {
  const html = await (await fetch(PAGE)).text();
  const m = html.match(new RegExp(`fn_fileDataDown\\('${PORTAL_PK}',\\s*'(uddi:[^']+)'`));
  if (!m) throw new Error('상세페이지에서 publicDataDetailPk 를 못 찾았습니다. 포털 마크업이 바뀐 듯합니다.');

  const tokenUrl = `https://www.data.go.kr/tcs/dss/selectFileDataDownload.do`
    + `?recommendDataYn=Y&publicDataPk=${PORTAL_PK}&publicDataDetailPk=${encodeURIComponent(m[1])}`;
  const j = await (await fetch(tokenUrl, { headers: { Referer: PAGE } })).json();
  if (!j.status) throw new Error('파일 다운로드 토큰 발급 실패');

  return {
    url: `https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=${j.atchFileId}&fileDetailSn=${j.fileDetailSn}`,
    dataNm: j.dataSetFileDetailInfo?.dataNm ?? '',
  };
}

// ── 2. CP949 CSV 스트리밍 파싱 ──
// 110MB 를 통째로 문자열로 올리지 않도록 청크 디코딩 + 라인 버퍼로 흘려보낸다.
// 이 CSV 는 따옴표 이스케이프 없이 콤마로만 구분되므로 split(',') 로 충분하다.
async function* streamRows(url) {
  const res = await fetch(url, { headers: { Referer: PAGE } });
  if (!res.ok) throw new Error(`다운로드 실패: HTTP ${res.status}`);

  const decoder = new TextDecoder('euc-kr');
  let carry = '';
  let header = null;

  for await (const chunk of res.body) {
    carry += decoder.decode(chunk, { stream: true });
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      if (!header) { header = line.split(','); continue; }
      if (line.trim()) yield line.split(',');
    }
  }
  if (carry.trim() && header) yield carry.split(',');
}

// CSV 컬럼 인덱스 (자료생성년월,사업장명,사업자등록번호,...)
const COL = { NAME: 1, ZIP: 4, ADDR_JIBUN: 5, ADDR_ROAD: 6, SIDO: 9, HEADCOUNT: 18 };

// ── 3. 분류 ──
// 쿠팡 시설코드 규칙: [도시 영문 3자][번호][유형]  예) INC4 FC, CHA6 FC, GEW3 ARC
// FC=Fulfillment Center(물류센터), ARC=자동화 센터, HUB/Sub Hub=간선 분류 거점
const CODE_RE = /(?:쿠팡\s*)?\b([A-Z]{3})\s?(\d{1,2})\s?(FC|ARC|ACR)\b/g;
const KO_RE = /쿠팡\s*([가-힣]{2,4}\d?)\s*(FC|물류센터|센터|Sub\s?Hub)/gi;

function facilityType(raw) {
  if (/sub\s?hub|허브/i.test(raw)) return 'hub';
  if (/\bARC\b|\bACR\b/i.test(raw)) return 'arc';
  if (/신선|콜드|fresh/i.test(raw)) return 'fresh';
  return 'fc';
}

function isCoupangOperated(name) {
  // "쿠팡풀필먼트 인천센터" 는 O, "(주)부현전기/일용/쿠팡 INC4 FC 전기공사" 는 X
  return /^쿠팡/.test(name) && !/일용|상용|건설|공사|전기|설비|방재/.test(name);
}

async function geocode(query) {
  const key = process.env.KAKAO_REST_KEY;
  if (!key) return null;
  const url = 'https://dapi.kakao.com/v2/local/search/address.json?query=' + encodeURIComponent(query);
  const r = await fetch(url, { headers: { Authorization: `KakaoAK ${key}` } });
  if (!r.ok) return null;
  const doc = (await r.json()).documents?.[0];
  return doc ? { lat: Number(doc.y), lng: Number(doc.x) } : null;
}

// ── main ──
const { url, dataNm } = await resolveDownloadUrl();
console.log(`[1/3] ${dataNm}`);

const operated = [];   // A. 쿠팡 직접 등록 사업장
const codeHits = new Map(); // B. 건설 하도급명에서 역추출한 시설코드

for await (const c of streamRows(url)) {
  const name = c[COL.NAME];
  if (!name || !name.includes('쿠팡')) continue;

  if (isCoupangOperated(name)) {
    // 본사·계열사(쿠팡페이/이츠/파이낸셜)는 근무지가 아니므로 제외
    if (!/풀필먼트\s|로지스틱스\s/.test(name) && !/센터|캠프/.test(name)) continue;
    if (!/센터|캠프/.test(name)) continue;
    operated.push({
      rawName: name,
      name: name.replace(/^쿠팡(풀필먼트|로지스틱스서비스)?\s*/, ''),
      addressJibun: c[COL.ADDR_JIBUN],
      addressRoad: c[COL.ADDR_ROAD],
      zipcode: c[COL.ZIP],
      headcount: Number(c[COL.HEADCOUNT]) || 0,
    });
    continue;
  }

  // B. 건설 하도급 — 사업장명에 시설코드, 주소는 해당 센터 소재지
  const addr = c[COL.ADDR_JIBUN];
  for (const m of name.matchAll(CODE_RE)) {
    const code = `${m[1]}${m[2]}`;
    if (!codeHits.has(code)) codeHits.set(code, { code, type: facilityType(m[0]), addressJibun: addr, evidence: name });
  }
  for (const m of name.matchAll(KO_RE)) {
    if (/사옥|이전/.test(name)) continue;
    // "쿠팡 부산 물류센터" 와 "쿠팡부산물류센터" 가 각각 부산 / 부산물류 로 잡히므로 꼬리를 떼어 통일
    const code = m[1].replace(/물류$/, '');
    if (!code) continue;
    if (!codeHits.has(code)) codeHits.set(code, { code, type: facilityType(m[0]), addressJibun: addr, evidence: name });
  }
}

console.log(`[2/3] 직접등록 ${operated.length}곳 / 코드역추출 ${codeHits.size}곳`);

// ── 4. 병합 + 좌표 ──
const facilities = [];

for (const o of operated) {
  const address = o.addressRoad || o.addressJibun;
  facilities.push({
    id: o.name.replace(/센터$|캠프$/, '').toLowerCase(),
    name: o.name,
    type: 'fc',
    operator: /로지스틱스/.test(o.rawName) ? 'cls' : 'cfs',
    address,
    addressJibun: o.addressJibun,
    zipcode: o.zipcode,
    headcount: o.headcount,
    ...(await geocode(address) ?? { lat: null, lng: null }),
    verified: true,
    source: 'nps-workplace',
  });
}

for (const [code, h] of codeHits) {
  facilities.push({
    id: code.toLowerCase(),
    name: code,
    type: h.type,
    operator: 'cfs',
    address: null,            // 건설 데이터는 읍면동까지만 — 상세주소는 제보로 보정
    addressJibun: h.addressJibun,
    zipcode: null,
    headcount: null,
    ...(await geocode(h.addressJibun) ?? { lat: null, lng: null }),
    verified: false,
    source: 'nps-construction',
    evidence: h.evidence,
  });
}

// 이름이 다른데 소재지가 같으면 같은 시설일 가능성 (예: 인천센터 ↔ INC4, 둘 다 서구 오류동)
for (const f of facilities.filter((x) => x.verified)) {
  const twin = facilities.find((x) => !x.verified && x.addressJibun === f.addressJibun);
  if (twin) { f.aliases = [twin.name]; twin.mergeCandidate = f.id; }
}

mkdirSync(OUT_DIR, { recursive: true });
const payload = {
  updatedAt: new Date().toISOString(),
  source: dataNm,
  note: 'CLS 배송캠프는 본사 일괄등록이라 미포함. 앱 사용자 제보로 보완 필요.',
  facilities: facilities.sort((a, b) => (b.headcount ?? 0) - (a.headcount ?? 0)),
};
writeFileSync(resolve(OUT_DIR, 'facilities-nps.json'), JSON.stringify(payload, null, 2) + '\n');
console.log(`[3/3] coupang-facilities/facilities-nps.json — ${facilities.length}곳`);
