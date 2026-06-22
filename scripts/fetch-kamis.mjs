#!/usr/bin/env node
// KAMIS (한국농수산식품유통공사) 소매가격 — 매일 1회 전체 조회 → 정규화 JSON.
// 앱(sisae-mini)은 KAMIS 를 직접 안 부르고 이 JSON 만 읽는다(CORS·키노출·서버지연 회피).
//
// #6 dailySalesList: 단 1회 호출로 전 부류 최신가격.
//   day1~day4 = 당일/1일전/1개월전/1년전(dpr1~dpr4), productno(안정키), value(등락률) 포함.
//
// 로컬 실행:
//   node scripts/fetch-kamis.mjs              (.env 의 KAMIS_CERT_KEY/ID 사용)
//   KAMIS_CERT_KEY=... KAMIS_CERT_ID=... node scripts/fetch-kamis.mjs

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── .env 로더 (의존성 없이) ──
(function loadEnv() {
  const p = resolve(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const KEY = process.env.KAMIS_CERT_KEY;
const ID = process.env.KAMIS_CERT_ID;
if (!KEY || !ID) {
  console.error('KAMIS_CERT_KEY / KAMIS_CERT_ID 가 필요합니다 (.env 또는 환경변수).');
  process.exit(1);
}

const ENDPOINT = 'https://www.kamis.or.kr/service/price/xml.do';

// 부류코드 → 앱 CategoryKey (schema.js 와 일치)
const CATEGORIES = {
  '100': 'foodcrop',
  '200': 'vegetable',
  '400': 'fruit',
  '500': 'livestock',
  '600': 'seafood',
};

const num = (s) => {
  if (s == null) return null;
  const v = String(s).replace(/,/g, '').trim();
  if (v === '' || v === '-' || v === '0') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function ymd(d) {
  return d.toISOString().slice(0, 10);
}
function shift(base, { days = 0, months = 0, years = 0 }) {
  const d = new Date(base);
  d.setFullYear(d.getFullYear() - years);
  d.setMonth(d.getMonth() - months);
  d.setDate(d.getDate() - days);
  return ymd(d);
}

async function fetchAll() {
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    action: 'dailySalesList',
    p_cert_key: KEY,
    p_cert_id: ID,
    p_returntype: 'json',
  }).toString();

  const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.error_code && json.error_code !== '000') {
    throw new Error(`KAMIS error_code ${json.error_code}`);
  }
  return Array.isArray(json.price) ? json.price : [];
}

// item_name "쌀/20kg", "고등어/국산(냉장)" → {name, kind}
function splitName(raw, unit) {
  const [head, ...rest] = String(raw).split('/');
  const name = head.trim();
  const spec = rest.join('/').trim();
  const kind = spec && spec !== unit ? spec : '';
  return { name, kind };
}

function normalize(today, rows) {
  const out = [];
  for (const r of rows) {
    const category = CATEGORIES[r.category_code];
    if (!category) continue; // 우리가 다루는 5개 부류만

    const unit = (r.unit || '').trim();
    const { name, kind } = splitName(r.item_name || r.productName, unit);
    if (!name) continue;

    const d1 = num(r.dpr1); // 당일
    const d2 = num(r.dpr2); // 1일전
    const d3 = num(r.dpr3); // 1개월전
    const d4 = num(r.dpr4); // 1년전
    const price = d1 ?? d2 ?? d3 ?? d4;
    if (price == null) continue;

    // 4시점 미니 시계열 (과거→오늘)
    const series = [
      d4 != null && { date: shift(today, { years: 1 }), price: d4 },
      d3 != null && { date: shift(today, { months: 1 }), price: d3 },
      d2 != null && { date: shift(today, { days: 1 }), price: d2 },
      { date: r.lastest_day || ymd(today), price },
    ].filter(Boolean);

    out.push({
      id: `${category}:${r.productno}`, // productno = 안정 고유키
      category,
      categoryCode: r.category_code, // KAMIS 부류코드 (딥링크용)
      itemCode: null, // #1 매핑으로 채움 (KAMIS 추이 페이지 딥링크용)
      kindCode: null, // 품종코드 (변형 정밀 매칭 시)
      rankCode: null, // 등급코드 (변형 정밀 매칭 시)
      name,
      kind,
      unit,
      price,
      prevPrice: d2 ?? price,
      normalPrice: d4 ?? d3 ?? price, // 기본은 1년전 proxy. #1 dpr7(일평년)으로 아래에서 덮어씀.
      series,
      updatedAt: r.lastest_day || ymd(today),
    });
  }
  return out;
}

// #1 dailyPriceByCategoryList → 코드 매핑(딥링크용) + 일평년(dpr7) 수집.
//  itemCode/kindCode/rankCode 와 진짜 평년값(dpr7="일평년")은 #6 에 없고 #1 에만 있음.
//  - byName: 품목 레벨   { [cat]: { [name]: {itemCode, normalPrice} } }
//  - byVariant: 변형 레벨 { [cat]: { `${name}|${kind_name}(${rank})`: {item,kind,rank,normalPrice} } }
function variantKey(name, kindName, rank) {
  const r = (rank || '').trim();
  const disp = r && r !== '-' ? `${kindName}(${r})` : kindName;
  return `${name}|${disp}`;
}
async function fetchItemCodes(regday) {
  const byName = {};
  const byVariant = {};
  for (const [catCode, catKey] of Object.entries(CATEGORIES)) {
    const url = new URL(ENDPOINT);
    url.search = new URLSearchParams({
      action: 'dailyPriceByCategoryList',
      p_product_cls_code: '01',
      p_country_code: '',
      p_regday: regday,
      p_convert_kg_yn: 'N',
      p_item_category_code: catCode,
      p_cert_key: KEY,
      p_cert_id: ID,
      p_returntype: 'json',
    }).toString();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      const j = await res.json();
      const rows = j?.data?.item;
      if (!Array.isArray(rows)) continue;
      const n = (byName[catKey] = byName[catKey] || {});
      const v = (byVariant[catKey] = byVariant[catKey] || {});
      for (const it of rows) {
        const nm = (it.item_name || '').trim();
        if (!nm || !it.item_code) continue;
        const normalPrice = num(it.dpr7); // dpr7 = "일평년" (KAMIS 자체 평년값)
        if (!n[nm]) n[nm] = { itemCode: String(it.item_code), normalPrice };
        const key = variantKey(nm, (it.kind_name || '').trim(), it.rank);
        if (!v[key]) {
          v[key] = {
            itemCode: String(it.item_code),
            kindCode: it.kind_code ? String(it.kind_code) : null,
            rankCode: it.rank_code ? String(it.rank_code) : null,
            normalPrice,
          };
        }
      }
    } catch {
      /* 코드 매핑 실패해도 가격은 유지 (딥링크만 없음) */
    }
  }
  return { byName, byVariant };
}

const today = new Date();
const items = [];
process.stdout.write('fetching dailySalesList… ');
try {
  const rows = await fetchAll();
  items.push(...normalize(today, rows));
  console.log(`${rows.length} rows → ${items.length} items`);
} catch (e) {
  console.log(`실패: ${e.message}`);
}

if (items.length === 0) {
  console.error('\n수집된 품목이 0개입니다. 키/네트워크 확인 필요.');
  process.exit(1);
}

// 코드 매핑 부착 (실데이터 기준일로 #1 조회). 변형 정밀 → 실패 시 품목 레벨 fallback.
const regday = (items[0].updatedAt || ymd(today)).replace(/\./g, '-');
process.stdout.write(`fetching item codes (#1, regday ${regday})… `);
const { byName, byVariant } = await fetchItemCodes(regday);
let exact = 0;
let itemLevel = 0;
let normalFilled = 0; // #1 dpr7(일평년)으로 평년값을 정밀 보강한 품목 수
for (const it of items) {
  const v = byVariant[it.category]?.[`${it.name}|${it.kind}`];
  if (v) {
    it.itemCode = v.itemCode;
    it.kindCode = v.kindCode;
    it.rankCode = v.rankCode;
    if (v.normalPrice != null) {
      it.normalPrice = v.normalPrice;
      normalFilled++;
    }
    exact++;
  } else {
    const m = byName[it.category]?.[it.name];
    if (m) {
      it.itemCode = m.itemCode;
      if (m.normalPrice != null) {
        it.normalPrice = m.normalPrice;
        normalFilled++;
      }
      itemLevel++;
    }
  }
}
console.log(`등급정밀 ${exact} + 품목레벨 ${itemLevel} = ${exact + itemLevel}/${items.length}`);
console.log(`평년(일평년) 보강 ${normalFilled}/${items.length} (나머지는 1년전 proxy)`);

const payload = {
  generated_at: new Date().toISOString(),
  source: 'KAMIS dailySalesList (소매) + dailyPriceByCategoryList (코드·일평년)',
  date: ymd(today),
  items,
};
const body = JSON.stringify(payload, null, 2) + '\n';

// 오늘 시세 1개 파일만 유지 (누적 X — 추이는 KAMIS 페이지 딥링크로 위임)
const OUT_DIR = resolve(ROOT, 'kamis');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(resolve(OUT_DIR, 'kamis-latest.json'), body);

// 앱 public (있으면 복사) → 로컬 dev 에서 /data/kamis-latest.json 로 로드
const APP_PUBLIC = resolve(ROOT, '../sisae-mini/public/data');
if (existsSync(resolve(ROOT, '../sisae-mini'))) {
  mkdirSync(APP_PUBLIC, { recursive: true });
  writeFileSync(resolve(APP_PUBLIC, 'kamis-latest.json'), body);
}

console.log(`\n✓ ${items.length} items → kamis/kamis-latest.json (app public 복사)`);
