/**
 * 국토교통부 실거래가 OpenAPI → 부동산 미니앱 2종용 정적 JSON
 *
 *   앱 A(아파트 매매)  ← realestate/trade/
 *   앱 B(아파트 전월세) ← realestate/rent/
 *
 * 스키마·집계 규칙의 근거는 `realestate-tools/_design/schema-v2.md` 에 있다.
 * **여기 집계 규칙을 바꾸면 두 앱의 화면이 같이 깨진다.** 셋은 같은 계약이다.
 *
 * 출력
 *   realestate/{trade|rent}/{YYYY-MM}.json  월별 축약본
 *   realestate/{trade|rent}/latest.json     앱이 읽는 최신월 (월별 파일의 사본)
 *   realestate/meta.json                    수집 시각·건수. 앱이 "기준일" 표시에 쓴다
 *
 * 키: `DATA_GO_KR_KEY` — data.go.kr 인증키. 인코딩·디코딩 어느 형태든 받는다. **계정 공통이다.**
 *     다른 프로젝트(medical-tools 등)와 하루 10,000회 한도를 나눠 쓴다.
 *
 *   node scripts/fetch-realestate.mjs                 # 3개월 롤링 (기본)
 *   node scripts/fetch-realestate.mjs --months=12     # 백필
 *   node scripts/fetch-realestate.mjs --ym=2026-07    # 특정 월만
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'realestate');
const ENDPOINT = 'https://apis.data.go.kr/1613000';

/**
 * v1 은 아파트 2종만. 빌라(RHRent)·오피스텔(OffiRent)은 앱 B v2에서 붙인다.
 * **종별로 순차 실행한다** — 429가 계정 단위라 병렬로 돌리면 서로의 한도를 갉아먹는다.
 */
const SERVICES = [
  { id: 'trade', op: 'RTMSDataSvcAptTrade' },
  { id: 'rent', op: 'RTMSDataSvcAptRent' },
];

/**
 * 동시성 3 = 실측 안전선.
 *   12 → 3,800건 중 실패 37%
 *    8 → 17,100건 중 실패 47% (후반 8.9분 → 94분으로 throttle)
 *    3 → 1,199건 중 실패 18건 (1.5%)
 * 올리지 말 것. 시간이 조금 더 걸릴 뿐, 올리면 실패분 재시도로 오히려 느려진다.
 */
const CONCURRENCY = 3;
const NUM_OF_ROWS = 2000;
const MAX_RETRY = 4;

/** 신고 기한이 계약일 +30일이라 지난달·전전달 숫자가 계속 늘어난다. 3개월을 매번 다시 받는다. */
const DEFAULT_MONTHS = 3;

/** 랭킹에서 제외할 표본 하한. 1~2건이 지역에 낙인을 찍는 걸 전세가율에서 확인했다. */
const MIN_RANK_CNT = 30;

/** 전용면적 구간. 전국 비교는 평형 고정이 전제이고 대표는 m(국민평형)이다. */
const AREA_BUCKETS = [
  ['s', 0, 60],
  ['m', 60, 85],
  ['l', 85, 135],
  ['xl', 135, Infinity],
];

const RAW_KEY = process.env.DATA_GO_KR_KEY;
if (!RAW_KEY) {
  console.error('DATA_GO_KR_KEY 가 없다. data.go.kr 인증키를 넣어야 한다.');
  process.exit(1);
}

/**
 * data.go.kr 은 인증키를 인코딩·디코딩 두 형태로 준다. 둘 다 받는다.
 *
 * 이걸 구분하지 않으면 인코딩 키의 `%2B` 가 `%252B` 로 이중 인코딩된다.
 * 증상이 고약하다 — 403 이 뜨는데 본문엔 "서비스키 오류"나 "미신청(30)"이 찍혀서
 * 키가 잘못된 줄 알고 재발급받는 삽질로 이어진다.
 */
const looksEncoded = /%[0-9A-Fa-f]{2}/.test(RAW_KEY);
const SERVICE_KEY = looksEncoded ? RAW_KEY : encodeURIComponent(RAW_KEY);
console.log(`인증키: ${looksEncoded ? '인코딩 형태 — 그대로 사용' : '디코딩 형태 — URL 인코딩함'}`);

// ── 유틸 ────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "8,000" · 8000 · null → 숫자. 실거래 API 는 금액을 콤마 문자열로 준다. */
const num = (v) => {
  if (v == null) return 0;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * ⚠️ 여기서 반올림하지 않는다.
 * 금액(만원)과 비율(%)이 같은 함수를 쓰는데, 짝수 길이에서 정수로 뭉개면
 * 비율의 소수점이 통째로 날아간다. 월세 환산 인상률 2.88% 가 3% 로 나온다.
 * 반올림은 금액이면 `won()`, 비율이면 `pct()` 에서 각각 한다.
 */
const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** 금액은 만원 단위 정수로. */
const won = (x) => (x == null ? null : Math.round(x));

/** 소수 1자리 퍼센트. 중앙값끼리 나누지 말고 개별 비율의 중앙값을 쓸 것. */
const pct = (x) => (x == null ? null : Math.round(x * 10) / 10);

const areaOf = (ar) => AREA_BUCKETS.find(([, lo, hi]) => ar >= lo && ar < hi)?.[0] ?? 'xl';

/** 환산보증금 = 보증금 + 월세×100. 월세 인상률의 유일한 성립 축이다(§아래 주석). */
const converted = (deposit, monthly) => deposit + monthly * 100;

// ── 수집 ────────────────────────────────────────────────

/**
 * 실패를 구분해서 다룬다.
 *   429           → 백오프 후 재시도
 *   returnReasonCode 30 → 서비스 미신청. 재시도해도 소용없으니 즉시 중단한다
 *   totalCount 0  → **에러가 아니다.** 잘못된 코드도 0으로 오기 때문에
 *                   "거래 없음"과 "코드 오류"가 구분되지 않는다. 상위에서 경보로 처리.
 */
async function fetchPage(op, lawd, ymd, pageNo) {
  const url =
    `${ENDPOINT}/${op}/get${op}` +
    `?serviceKey=${SERVICE_KEY}` +
    `&LAWD_CD=${lawd}&DEAL_YMD=${ymd}` +
    `&numOfRows=${NUM_OF_ROWS}&pageNo=${pageNo}&_type=json`;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    let res, text;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' } });
      text = await res.text();
    } catch (e) {
      if (attempt === MAX_RETRY) throw new Error(`network ${lawd}/${ymd}: ${e.message}`);
      await sleep(2 ** attempt * 1000);
      continue;
    }

    // 문서엔 XML 만 된다고 적혀 있지만 _type=json 이 실제로 동작한다.
    // (resultType=json 은 무시되고 XML 이 온다 — 파라미터명 주의)
    if (text.trimStart().startsWith('<')) {
      if (text.includes('<returnReasonCode>30<')) {
        throw new Error(`서비스 미신청(30): ${op} — data.go.kr 에서 활용신청할 것`);
      }
      if (text.includes('<returnReasonCode>12<')) {
        throw new Error(`엔드포인트 이름 오류(12): ${op}`);
      }
      // 그 밖의 XML 은 대개 일시적 오류. 재시도 대상.
      if (attempt === MAX_RETRY) throw new Error(`XML 응답 ${lawd}/${ymd}: ${text.slice(0, 160)}`);
      await sleep(2 ** attempt * 1500);
      continue;
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (attempt === MAX_RETRY) throw new Error(`JSON 파싱 실패 ${lawd}/${ymd}`);
      await sleep(2 ** attempt * 1000);
      continue;
    }

    const body = json?.response?.body;
    const code = json?.response?.header?.resultCode;
    if (code && code !== '000' && code !== '00') {
      if (res.status === 429 || /LIMIT|TRAFFIC/i.test(json?.response?.header?.resultMsg ?? '')) {
        if (attempt === MAX_RETRY) throw new Error(`429 소진 ${lawd}/${ymd}`);
        await sleep(2 ** attempt * 3000);
        continue;
      }
      throw new Error(`API ${code}: ${json?.response?.header?.resultMsg} (${lawd}/${ymd})`);
    }

    const raw = body?.items?.item ?? [];
    return {
      items: Array.isArray(raw) ? raw : raw ? [raw] : [],
      totalCount: Number(body?.totalCount ?? 0),
    };
  }
  throw new Error(`unreachable ${lawd}/${ymd}`);
}

async function fetchRegionMonth(op, lawd, ymd) {
  const first = await fetchPage(op, lawd, ymd, 1);
  const out = first.items;
  const pages = Math.ceil(first.totalCount / NUM_OF_ROWS);
  for (let p = 2; p <= pages; p++) {
    const next = await fetchPage(op, lawd, ymd, p);
    out.push(...next.items);
  }
  return out;
}

/** 동시성 고정 워커 풀. Promise.all 로 한꺼번에 던지면 429가 난다. */
async function pool(tasks, limit, onDone) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < tasks.length) {
      const i = cursor++;
      try {
        results[i] = { ok: true, value: await tasks[i].run() };
      } catch (e) {
        results[i] = { ok: false, error: e.message, key: tasks[i].key };
      }
      onDone?.(i + 1, tasks.length);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── 집계 ────────────────────────────────────────────────

/**
 * ⚠️ 시도 롤업은 시군구 중앙값의 평균이 아니다.
 * 원본 거래를 시도 단위로 모아 직접 중앙값을 낸다.
 * 강남 45건과 도봉 500건을 같은 무게로 평균 내면 서울이 실제보다 비싸진다.
 * (구 단위 중앙값끼리 나눈 전세가율이 종로 82.7%로 왜곡됐던 것과 같은 함정)
 */
function aggregateTrade(byRegion, regionMap) {
  const nat = [];
  const sidoPool = new Map();
  const sigungu = {};

  for (const [code, rows] of byRegion) {
    const meta = regionMap.get(code);
    if (!meta) continue;
    const prices = [];
    const byArea = {};
    for (const r of rows) {
      const amt = num(r.dealAmount);
      const ar = Number(r.excluUseAr);
      if (!amt || !Number.isFinite(ar)) continue;
      prices.push(amt);
      const b = areaOf(ar);
      (byArea[b] ??= []).push(amt);
    }
    if (!prices.length) continue;

    nat.push(...prices);
    const sidoCode = code.slice(0, 2);
    if (!sidoPool.has(sidoCode)) sidoPool.set(sidoCode, { name: meta.sido, vals: [] });
    sidoPool.get(sidoCode).vals.push(...prices);

    sigungu[code] = {
      n: meta.sigungu,
      sido: sidoCode,
      med: won(median(prices)),
      cnt: prices.length,
      byArea: Object.fromEntries(
        Object.entries(byArea).map(([k, v]) => [k, { med: won(median(v)), cnt: v.length }]),
      ),
    };
  }

  return {
    national: { med: won(median(nat)), cnt: nat.length },
    sido: [...sidoPool.entries()]
      .map(([code, { name, vals }]) => ({ code, n: name, med: won(median(vals)), cnt: vals.length }))
      .sort((a, b) => b.cnt - a.cnt),
    sigungu,
  };
}

/**
 * 전월세 집계.
 *
 * 월세 인상률은 **환산보증금 기준**이 유일하게 성립한다.
 * 서울 2026-07 갱신 3,510건 실측: 보증금만 기준 +0.00% / 환산보증금 +2.88% / 월세액만 +4.88%.
 * 보증금을 동결하고 월세만 조정한 계약이 71%라서 보증금 기준은 중앙값이 0이 된다.
 * 화면에서 "+0.0%"가 뜨면 앱이 고장난 것처럼 보인다.
 *
 * `preDeposit` 는 결측이 아니라 **갱신계약에만 있는 값**이다(전체 채움률 47.4%).
 * contractType === '갱신' 으로 거른 뒤에 봐야 한다.
 */
function aggregateRent(byRegion, regionMap) {
  const mk = () => ({ jeonse: [], wolseDep: [], wolseMon: [], rateJ: [], rateW: [], rateWMon: [], rr: 0, rrTot: 0, allTot: 0, frozen: 0, frozenTot: 0 });
  const nat = mk();
  const sidoPool = new Map();
  const sigungu = {};

  for (const [code, rows] of byRegion) {
    const meta = regionMap.get(code);
    if (!meta) continue;
    const acc = mk();
    const byArea = {};

    for (const r of rows) {
      const dep = num(r.deposit);
      const mon = num(r.monthlyRent);
      const ar = Number(r.excluUseAr);
      if (!dep && !mon) continue;
      acc.allTot++;
      const bucket = Number.isFinite(ar) ? areaOf(ar) : null;
      const isJeonse = mon === 0;

      if (isJeonse) acc.jeonse.push(dep);
      else {
        acc.wolseDep.push(dep);
        acc.wolseMon.push(mon);
      }
      if (bucket) {
        const b = (byArea[bucket] ??= { jeonse: [], wolse: [] });
        (isJeonse ? b.jeonse : b.wolse).push(isJeonse ? dep : mon);
      }

      if (r.contractType !== '갱신') continue;
      acc.rrTot++;
      if (r.useRRRight === '사용') acc.rr++;

      const pDep = num(r.preDeposit);
      const pMon = num(r.preMonthlyRent);
      if (isJeonse) {
        if (pDep > 0) acc.rateJ.push((dep / pDep - 1) * 100);
      } else {
        const before = converted(pDep, pMon);
        if (before > 0) acc.rateW.push((converted(dep, mon) / before - 1) * 100);
        if (pMon > 0) acc.rateWMon.push((mon / pMon - 1) * 100);
        if (pDep > 0) {
          acc.frozenTot++;
          if (dep === pDep) acc.frozen++;
        }
      }
    }

    if (!acc.jeonse.length && !acc.wolseDep.length) continue;

    const sidoCode = code.slice(0, 2);
    if (!sidoPool.has(sidoCode)) sidoPool.set(sidoCode, { name: meta.sido, acc: mk() });
    for (const target of [nat, sidoPool.get(sidoCode).acc]) {
      for (const k of ['jeonse', 'wolseDep', 'wolseMon', 'rateJ', 'rateW', 'rateWMon']) target[k].push(...acc[k]);
      target.rr += acc.rr; target.rrTot += acc.rrTot; target.allTot += acc.allTot;
      target.frozen += acc.frozen; target.frozenTot += acc.frozenTot;
    }

    sigungu[code] = { n: meta.sigungu, sido: sidoCode, ...shapeRent(acc), byArea: shapeRentArea(byArea) };
  }

  return {
    national: shapeRent(nat),
    sido: [...sidoPool.entries()]
      .map(([code, { name, acc }]) => ({ code, n: name, ...shapeRent(acc) }))
      .sort((a, b) => (b.jeonse?.cnt ?? 0) - (a.jeonse?.cnt ?? 0)),
    sigungu,
  };
}

function shapeRent(a) {
  const rate = [...a.rateJ, ...a.rateW];
  return {
    renew: {
      medRate: pct(median(rate)),
      medRateJeonse: pct(median(a.rateJ)),
      medRateWolse: pct(median(a.rateW)),          // 환산보증금 기준
      medRateWolseMonthly: pct(median(a.rateWMon)), // 월세액만 — 보조 표시용
      depositFrozenPct: a.frozenTot ? pct((a.frozen / a.frozenTot) * 100) : null,
      // 갱신요구권 행사율은 분모를 반드시 명시해야 한다. 서울 2026-07 기준
      // 갱신계약 중 43.4% / 전체 계약 중 20.7% 로 두 배 넘게 벌어진다.
      // 화면에 인상률(갱신계약 기준)과 나란히 놓으므로 **기본은 OfRenew** 를 쓴다.
      rrPctOfRenew: a.rrTot ? pct((a.rr / a.rrTot) * 100) : null,
      rrPctOfAll: a.allTot ? pct((a.rr / a.allTot) * 100) : null,
      renewShare: a.allTot ? pct((a.rrTot / a.allTot) * 100) : null,
      cnt: rate.length,
    },
    jeonse: { med: won(median(a.jeonse)), cnt: a.jeonse.length },
    wolse: { medDeposit: won(median(a.wolseDep)), medMonthly: won(median(a.wolseMon)), cnt: a.wolseMon.length },
  };
}

const shapeRentArea = (byArea) =>
  Object.fromEntries(
    Object.entries(byArea).map(([k, v]) => [
      k,
      { jeonse: won(median(v.jeonse)), wolse: won(median(v.wolse)), cnt: v.jeonse.length + v.wolse.length },
    ]),
  );

/** 직전 월 파일에서 med 를 끌어와 변화율을 붙인다. 원본을 두 번 받지 않는다. */
async function attachPrev(svc, ym, doc) {
  const prev = prevYm(ym);
  const f = path.join(OUT, svc, `${prev}.json`);
  if (!existsSync(f)) return doc;
  const old = JSON.parse(await readFile(f, 'utf8'));
  doc.prevYm = prev;

  const chg = (cur, before) =>
    cur != null && before ? pct((cur / before - 1) * 100) : null;

  if (svc === 'trade') {
    doc.national.prevMed = old.national?.med ?? null;
    doc.national.chg = chg(doc.national.med, old.national?.med);
    const oldSido = new Map((old.sido ?? []).map((s) => [s.code, s.med]));
    for (const s of doc.sido) {
      s.prevMed = oldSido.get(s.code) ?? null;
      s.chg = chg(s.med, s.prevMed);
    }
    for (const [code, cur] of Object.entries(doc.sigungu)) {
      cur.prevMed = old.sigungu?.[code]?.med ?? null;
      cur.chg = chg(cur.med, cur.prevMed);
    }
  } else {
    doc.national.jeonse.prevMed = old.national?.jeonse?.med ?? null;
    doc.national.jeonse.chg = chg(doc.national.jeonse.med, old.national?.jeonse?.med);
    for (const [code, cur] of Object.entries(doc.sigungu)) {
      cur.jeonse.prevMed = old.sigungu?.[code]?.jeonse?.med ?? null;
      cur.jeonse.chg = chg(cur.jeonse.med, cur.jeonse.prevMed);
    }
  }
  return doc;
}

// ── 월 계산 ─────────────────────────────────────────────

const ymKST = (d = new Date(), offset = 0) => {
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  const dt = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth() + offset, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
};
const prevYm = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

// ── 실행 ────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];

  const master = JSON.parse(await readFile(path.join(OUT, 'region-master.json'), 'utf8'));
  const regionMap = new Map(master.regions.map((r) => [r.code, r]));
  const codes = master.regions.map((r) => r.code);

  const only = arg('ym');
  const months = Number(arg('months') ?? DEFAULT_MONTHS);
  const targets = only ? [only] : Array.from({ length: months }, (_, i) => ymKST(new Date(), -i)).reverse();

  console.log(`지역 ${codes.length}개 · 월 ${targets.join(', ')} · 종별 ${SERVICES.length}`);
  console.log(`예상 호출 ${codes.length * targets.length * SERVICES.length}회 (동시성 ${CONCURRENCY})\n`);

  const meta = { fetchedAt: new Date().toISOString(), months: targets, minRankCnt: MIN_RANK_CNT, services: {} };
  const zeroStreak = new Map(); // 코드 오류 경보용

  for (const svc of SERVICES) {
    await mkdir(path.join(OUT, svc.id), { recursive: true });
    const errors = [];

    for (const ym of targets) {
      const ymd = ym.replace('-', '');
      const tasks = codes.map((code) => ({ key: `${code}/${ymd}`, run: () => fetchRegionMonth(svc.op, code, ymd) }));

      let done = 0;
      const results = await pool(tasks, CONCURRENCY, (n, total) => {
        if (n - done >= 50 || n === total) { done = n; process.stdout.write(`\r  ${svc.id} ${ym}  ${n}/${total}`); }
      });
      process.stdout.write('\n');

      const byRegion = new Map();
      results.forEach((r, i) => {
        if (!r.ok) { errors.push(`${r.key}: ${r.error}`); return; }
        byRegion.set(codes[i], r.value);
        if (!r.value.length) zeroStreak.set(codes[i], (zeroStreak.get(codes[i]) ?? 0) + 1);
      });

      const agg = svc.id === 'trade'
        ? aggregateTrade(byRegion, regionMap)
        : aggregateRent(byRegion, regionMap);

      const doc = await attachPrev(svc.id, ym, { ym, updatedAt: meta.fetchedAt, minRankCnt: MIN_RANK_CNT, ...agg });
      await writeFile(path.join(OUT, svc.id, `${ym}.json`), JSON.stringify(doc), 'utf8');

      const rows = [...byRegion.values()].reduce((s, v) => s + v.length, 0);
      console.log(`  → ${ym}: 거래 ${rows.toLocaleString()}건 · 시군구 ${Object.keys(agg.sigungu).length}개`);
      meta.services[svc.id] ??= {};
      meta.services[svc.id][ym] = { rows, regions: Object.keys(agg.sigungu).length };
    }

    // 최신월을 latest 로 복제한다. 앱은 latest.json 만 읽는다.
    const last = targets[targets.length - 1];
    await writeFile(
      path.join(OUT, svc.id, 'latest.json'),
      await readFile(path.join(OUT, svc.id, `${last}.json`), 'utf8'),
      'utf8',
    );

    if (errors.length) {
      meta.services[svc.id].errors = errors.length;
      console.warn(`  ⚠ ${svc.id} 실패 ${errors.length}건`);
      errors.slice(0, 10).forEach((e) => console.warn(`     ${e}`));
    }
  }

  // 모든 대상 월에서 0건인 코드는 "거래 없음"이 아니라 코드 오류일 수 있다.
  // API 가 잘못된 LAWD_CD 에도 totalCount 0 을 주기 때문에 여기서만 잡힌다.
  const suspect = [...zeroStreak.entries()]
    .filter(([, n]) => n === targets.length * SERVICES.length)
    .map(([code]) => code);
  if (suspect.length) {
    meta.suspectCodes = suspect;
    console.warn(`\n⚠ 전 기간 0건인 코드 ${suspect.length}개 — 코드 오류 가능성: ${suspect.join(', ')}`);
  }

  await writeFile(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  console.log('\n완료.');
}

main().catch((e) => {
  console.error(`\n실패: ${e.message}`);
  process.exit(1);
});
