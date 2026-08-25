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
 * 키: `DATA_GO_KR_KEY` — data.go.kr 인증키. 인코딩·디코딩 어느 형태든 받는다. 계정당 1개다.
 *     **다만 일일 요청제한은 서비스(활용신청) 단위다** — 2026-08-24 실측: AptRent 가 22(한도초과)를
 *     뱉는 순간에도 AptTrade·RHRent·OffiRent 는 200 을 줬다. 종목 하나를 태워도 나머지는 산다.
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
 * **종별로 순차 실행한다** — 한도는 서비스 단위지만, 동시에 돌리면 초당 요청이 겹쳐
 * 각자의 throttle 을 앞당긴다. 로그에서 어느 종목이 막혔는지 가리기도 어려워진다.
 */
const SERVICES = [
  { id: 'trade', op: 'RTMSDataSvcAptTrade', kind: 'trade', areas: 'apt' },
  { id: 'rent', op: 'RTMSDataSvcAptRent', kind: 'rent', areas: 'apt' },
  // 앱 B 는 아파트만으로 성립하지 않는다 — 전월세 수요의 상당수가 빌라·오피스텔이다.
  { id: 'rhrent', op: 'RTMSDataSvcRHRent', kind: 'rent', areas: 'small' },
  { id: 'offirent', op: 'RTMSDataSvcOffiRent', kind: 'rent', areas: 'small' },
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
/**
 * 평형 구간은 **종목군마다 다르다.**
 *
 * 아파트 기준(60/85/135㎡)을 빌라·오피스텔에 그대로 쓰면 물량이 전부 `s` 한 칸에 몰려
 * 평형 구분이 무의미해진다 — 실측 표본에서 오피스텔 25.16㎡, 빌라 27.72·37.8㎡ 였다.
 *
 * `small` 경계는 잠정값이다. 첫 수집 뒤 meta.json 의 `areaDist` 로 분포를 확인하고
 * 필요하면 조정한다(조정하면 재집계가 필요하므로 첫 판에 최대한 맞춘다).
 */
const AREA_BUCKET_SETS = {
  apt: [
    ['s', 0, 60],
    ['m', 60, 85],
    ['l', 85, 135],
    ['xl', 135, Infinity],
  ],
  small: [
    ['s', 0, 30],
    ['m', 30, 45],
    ['l', 45, 60],
    ['xl', 60, Infinity],
  ],
};

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

/** 오늘은 더 못 받는다. 재시도·후속 월 진행 모두 무의미하니 그 종목을 즉시 접는다. */
class QuotaExceeded extends Error {}
/** 설정 문제(미신청·엔드포인트 오류). 재시도해도 소용없다. */
class Fatal extends Error {}

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

const areaOf = (ar, set = 'apt') =>
  AREA_BUCKET_SETS[set].find(([, lo, hi]) => ar >= lo && ar < hi)?.[0] ?? 'xl';

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

    /**
     * ⚠️ 게이트웨이 오류는 **완전히 다른 봉투**로 온다.
     *
     *   정상: { response: { header, body } }
     *   오류: { OpenAPI_ServiceResponse: { cmmMsgHeader: { returnReasonCode, errMsg } } }
     *
     * `response.header.resultCode` 만 보면 오류 봉투에선 undefined 가 되어
     * 검사를 통째로 건너뛰고, `items` 도 없으니 **"거래 0건"으로 둔갑한다.**
     * 실제로 이것 때문에 전월세 12개월이 errors=0 / rows=0 으로 조용히 비었다.
     *
     *   22 = 일일 요청제한 초과 (오늘은 재시도해도 소용없다 — 서비스 단위로 걸린다)
     *   30 = 미신청 · 12 = 엔드포인트 이름 오류
     */
    const gw = json?.OpenAPI_ServiceResponse?.cmmMsgHeader;
    if (gw) {
      const rc = String(gw.returnReasonCode ?? '');
      const msg = `${gw.errMsg ?? ''} ${gw.returnAuthMsg ?? ''}`.trim();
      if (rc === '22') throw new QuotaExceeded(`${op}: 일일 요청제한 초과 (22) — ${msg}`);
      if (rc === '30' || rc === '12') throw new Fatal(`${op}: ${rc === '30' ? '미신청' : '엔드포인트 이름 오류'}(${rc}) — ${msg}`);
      if (attempt === MAX_RETRY) throw new Error(`게이트웨이 오류 ${rc} ${lawd}/${ymd}: ${msg}`);
      await sleep(2 ** attempt * 3000);
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
/**
 * 평형대별 풀을 중앙값·건수로 접는다.
 *
 * 전국·시도에도 이걸 붙이는 이유: 전 평형 혼합 중앙값은 **평형 구성비가 흔들리면 같이 흔들린다.**
 * 큰 평형 거래가 몰린 달은 시장이 안 올랐어도 중앙값이 오른다. 앱 첫 화면이 약속하는 숫자는
 * "국민평형 84㎡ 시세"이므로 비교 축을 평형으로 고정해야 한다(`_design/schema-v2.md` 의
 * "전국 비교는 평형 고정이 전제"). 데이터 증가량은 전국 4개 + 시도 16×4 로 무시할 수준이다.
 */
const areaDigest = (pools) =>
  Object.fromEntries(
    Object.entries(pools).map(([k, v]) => [k, { med: won(median(v)), cnt: v.length }]),
  );

/** 평형대별 풀에 다른 풀을 합친다. */
const mergeArea = (into, from) => {
  for (const [b, v] of Object.entries(from)) (into[b] ??= []).push(...v);
};

function aggregateTrade(byRegion, regionMap, areaSet = 'apt') {
  const nat = [];
  const natArea = {};
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
      const b = areaOf(ar, areaSet);
      (byArea[b] ??= []).push(amt);
    }
    if (!prices.length) continue;

    nat.push(...prices);
    mergeArea(natArea, byArea);
    const sidoCode = code.slice(0, 2);
    if (!sidoPool.has(sidoCode)) sidoPool.set(sidoCode, { name: meta.sido, vals: [], area: {} });
    const sp = sidoPool.get(sidoCode);
    sp.vals.push(...prices);
    mergeArea(sp.area, byArea);

    sigungu[code] = {
      n: meta.sigungu,
      sido: sidoCode,
      med: won(median(prices)),
      cnt: prices.length,
      byArea: areaDigest(byArea),
    };
  }

  return {
    national: { med: won(median(nat)), cnt: nat.length, byArea: areaDigest(natArea) },
    sido: [...sidoPool.entries()]
      .map(([code, { name, vals, area }]) => ({
        code,
        n: name,
        med: won(median(vals)),
        cnt: vals.length,
        byArea: areaDigest(area),
      }))
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
function aggregateRent(byRegion, regionMap, areaSet = 'apt') {
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
      const bucket = Number.isFinite(ar) ? areaOf(ar, areaSet) : null;
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
async function attachPrev(svc, kind, ym, doc) {
  const prev = prevYm(ym);
  const f = path.join(OUT, svc, `${prev}.json`);
  if (!existsSync(f)) return doc;
  const old = JSON.parse(await readFile(f, 'utf8'));
  doc.prevYm = prev;

  const chg = (cur, before) =>
    cur != null && before ? pct((cur / before - 1) * 100) : null;

  /**
   * 평형대별 전월 대비도 붙인다. 첫 화면이 읽는 숫자가 `byArea.m`(84㎡)이라
   * 여기에 변화율이 없으면 화면이 전 평형 혼합 변화율을 빌려 쓰게 된다 — 다른 지표를
   * 같은 줄에 나란히 놓는 셈이다.
   */
  const attachArea = (cur, before) => {
    for (const [b, v] of Object.entries(cur ?? {})) {
      v.prevMed = before?.[b]?.med ?? null;
      v.chg = chg(v.med, v.prevMed);
    }
  };

  if (kind === 'trade') {
    doc.national.prevMed = old.national?.med ?? null;
    doc.national.chg = chg(doc.national.med, old.national?.med);
    attachArea(doc.national.byArea, old.national?.byArea);
    const oldSido = new Map((old.sido ?? []).map((s) => [s.code, s]));
    for (const s of doc.sido) {
      const before = oldSido.get(s.code);
      s.prevMed = before?.med ?? null;
      s.chg = chg(s.med, s.prevMed);
      attachArea(s.byArea, before?.byArea);
    }
    for (const [code, cur] of Object.entries(doc.sigungu)) {
      const before = old.sigungu?.[code];
      cur.prevMed = before?.med ?? null;
      cur.chg = chg(cur.med, cur.prevMed);
      /**
       * 시군구 평형대에도 변화율을 붙인다.
       *
       * 랭킹을 전 평형 혼합 `chg` 로 매기면 **"많이 오른 곳"이 아니라 "평형 구성이 널뛴 곳"**
       * 이 상위를 독점한다. 2026-07 실측(182개 지역): 지역 내 소형/중형 가격 격차가
       * 2배 미만이면 |chg| 중앙 3.4%인데 3배 이상이면 13.1%, |chg|>20% 비율이 3% → 30% 로 뛴다.
       * 상위 5곳이 전부 격차 2.3~3.9배였다(익산 +64.6%, 219건 — 표본 부족이 아니다).
       * 평형을 고정해야 시장 신호가 남는다.
       */
      attachArea(cur.byArea, before?.byArea);
    }
  } else {
    doc.national.jeonse.prevMed = old.national?.jeonse?.med ?? null;
    doc.national.jeonse.chg = chg(doc.national.jeonse.med, old.national?.jeonse?.med);

    /**
     * ⚠️ 시도를 빠뜨리면 안 된다.
     *
     * 매매 분기는 전국·시도·시군구 셋 다 처리하는데 여기서는 시도가 빠져 있었다.
     * 그 결과 앱 B 의 **시도 격자 변화율이 전부 비고, 상승폭·하락폭 정렬이 통째로
     * 비활성**됐다 — 전국과 시군구만 보고 있으면 드러나지 않는 종류의 결함이다.
     *
     * 월세는 변화율을 붙이지 않는다. 보증금과 월세액 두 축이라 하나로 접을 수 없다.
     */
    const oldSido = new Map((old.sido ?? []).map((s) => [s.code, s]));
    for (const s of doc.sido) {
      const before = oldSido.get(s.code);
      s.jeonse.prevMed = before?.jeonse?.med ?? null;
      s.jeonse.chg = chg(s.jeonse.med, s.jeonse.prevMed);
    }

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

  /**
   * `--service=rent` 로 한 종목만 돌린다.
   *
   * 한도는 서비스(활용신청) 단위로 걸린다 — 2026-08-24 실측: `AptRent` 가 22 를 뱉는 순간
   * `AptTrade`·`RHRent`·`OffiRent` 는 같은 키로 정상 응답했다. 그래서 한 종목만 막히는 일이
   * 실제로 생기고, 그때 전체를 다시 돌리면 이미 받아둔 종목의 호출까지 다시 태운다.
   */
  const svcArg = arg('service');
  const services = svcArg ? SERVICES.filter((s) => s.id === svcArg) : SERVICES;
  if (!services.length) {
    console.error(`--service=${svcArg} 는 없는 종목이다. 가능: ${SERVICES.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`지역 ${codes.length}개 · 월 ${targets.join(', ')} · 종별 ${services.map((s) => s.id).join('+')}`);
  console.log(`예상 호출 ${codes.length * targets.length * services.length}회 (동시성 ${CONCURRENCY})\n`);

  /**
   * ⚠️ meta 를 빈 객체로 시작하면 **이번에 안 돌린 종목의 기록이 사라진다.**
   * 한 종목만 재수집하는 건 위의 이유로 상시 벌어지는 일이라 기존 meta 를 읽어 병합한다.
   * 즉 `meta.services` 는 "마지막 실행 결과"가 아니라 **"지금 디스크에 있는 파일"** 을 뜻한다.
   */
  const prevMeta = await readFile(path.join(OUT, 'meta.json'), 'utf8').then(JSON.parse).catch(() => null);
  const meta = {
    fetchedAt: new Date().toISOString(),
    months: targets,
    minRankCnt: MIN_RANK_CNT,
    services: structuredClone(prevMeta?.services ?? {}),
  };
  // 이번에 돌리는 종목의 지난 aborted 는 지운다 — 이번 실행 결과로 다시 판정해야 한다.
  for (const svc of services) {
    meta.services[svc.id] ??= {};
    delete meta.services[svc.id].aborted;
  }
  let hadFailure = false;
  const zeroStreak = new Map(); // 코드 오류 경보용

  for (const svc of services) {
    await mkdir(path.join(OUT, svc.id), { recursive: true });
    const errors = [];
    let aborted = null;

    for (const ym of targets) {
      const ymd = ym.replace('-', '');
      const tasks = codes.map((code) => ({ key: `${code}/${ymd}`, run: () => fetchRegionMonth(svc.op, code, ymd) }));

      let done = 0;
      const results = await pool(tasks, CONCURRENCY, (n, total) => {
        if (n - done >= 50 || n === total) { done = n; process.stdout.write(`\r  ${svc.id} ${ym}  ${n}/${total}`); }
      });
      process.stdout.write('\n');

      // 한도 초과·설정 오류가 하나라도 있으면 그 종목은 오늘 끝이다.
      // 남은 월을 계속 돌면 빈 파일만 쌓이고, 그게 좋은 데이터를 덮어쓴다.
      const blocker = results.find((r) => !r.ok && /요청제한 초과 \(22\)|미신청|엔드포인트 이름 오류/.test(r.error));
      if (blocker) {
        aborted = blocker.error;
        console.warn(`\n  ⛔ ${svc.id} 중단: ${blocker.error}`);
        break;
      }

      const byRegion = new Map();
      results.forEach((r, i) => {
        if (!r.ok) { errors.push(`${r.key}: ${r.error}`); return; }
        byRegion.set(codes[i], r.value);
        if (!r.value.length) zeroStreak.set(codes[i], (zeroStreak.get(codes[i]) ?? 0) + 1);
      });

      // ⚠️ 전 지역 0건이면 정상 결과가 아니다. 기존 파일을 빈 파일로 덮어쓰지 않는다.
      if (!byRegion.size || [...byRegion.values()].every((v) => !v.length)) {
        console.warn(`  ⚠ ${svc.id} ${ym}: 전 지역 0건 — 파일을 쓰지 않는다 (기존 데이터 보존)`);
        meta.services[svc.id] ??= {};
        meta.services[svc.id][ym] = { rows: 0, regions: 0, skipped: '전 지역 0건' };
        continue;
      }

      const agg = svc.kind === 'trade'
        ? aggregateTrade(byRegion, regionMap, svc.areas)
        : aggregateRent(byRegion, regionMap, svc.areas);

      const doc = await attachPrev(svc.id, svc.kind, ym, { ym, updatedAt: meta.fetchedAt, minRankCnt: MIN_RANK_CNT, ...agg });
      await writeFile(path.join(OUT, svc.id, `${ym}.json`), JSON.stringify(doc), 'utf8');

      /**
       * 평형 구간 분포를 meta 에 남긴다.
       *
       * `small` 경계(30/45/60㎡)는 표본 몇 건으로 잡은 잠정값이다. 한 칸에 80% 이상이
       * 몰리면 구간이 잘못 잡힌 것이고, 그때 재집계가 필요하다 — 그 판단을 **이번 수집
       * 결과만 보고** 할 수 있어야 다시 3,072회를 태우지 않는다.
       */
      const dist = {};
      for (const v of Object.values(agg.sigungu)) {
        for (const [b, a] of Object.entries(v.byArea ?? {})) {
          dist[b] = (dist[b] ?? 0) + (a.cnt ?? 0);
        }
      }
      meta.areaDist ??= {};
      meta.areaDist[svc.id] = { set: svc.areas, ...dist };

      const rows = [...byRegion.values()].reduce((s, v) => s + v.length, 0);
      console.log(`  → ${ym}: 거래 ${rows.toLocaleString()}건 · 시군구 ${Object.keys(agg.sigungu).length}개`);
      meta.services[svc.id] ??= {};
      meta.services[svc.id][ym] = { rows, regions: Object.keys(agg.sigungu).length };
    }

    /**
     * ⚠️ latest 를 "마지막 월"로 잡으면 안 된다.
     *
     * 당월은 신고 기한(계약일 +30일)이 지나지 않아 항상 미완성이다.
     * 2026-08-24 실측: 7월 42,498건 vs 8월 15,631건 → 전월 대비 **-15%** 가 찍혔다.
     * 시장이 빠진 게 아니라 데이터가 덜 들어온 것인데, 사용자는 구분할 방법이 없다.
     * "아파트 실거래가"를 표방하는 앱이 첫 화면에 가짜 폭락률을 띄우게 된다.
     *
     * 그래서 나눈다.
     *   latest.json   직전 완료월. 앱의 기본 화면이 읽는다.
     *   current.json  당월. `partial: true` 를 달아 "집계 중"으로만 보조 표시한다.
     *
     * 당월 하나만 수집한 경우(--ym)엔 나눌 게 없으니 그대로 latest 로 쓴다.
     */
    if (aborted) {
      meta.services[svc.id] ??= {};
      meta.services[svc.id].aborted = aborted;
      hadFailure = true;
      continue; // latest/current 를 건드리지 않는다
    }

    const isCurrentMonth = (ym) => ym === ymKST();
    const complete = targets.filter((ym) => !isCurrentMonth(ym));
    const latestYm = complete.length ? complete[complete.length - 1] : targets[targets.length - 1];

    const readMonth = (ym) => readFile(path.join(OUT, svc.id, `${ym}.json`), 'utf8');
    await writeFile(path.join(OUT, svc.id, 'latest.json'), await readMonth(latestYm), 'utf8');

    const currentYm = targets.find(isCurrentMonth);
    if (currentYm) {
      const cur = JSON.parse(await readMonth(currentYm));
      cur.partial = true;
      cur.partialNote = '신고 기한이 계약일 +30일이라 당월은 집계가 끝나지 않았다. 전월 대비 변화율을 쓰지 말 것.';
      // 미완성 월의 변화율은 하락으로만 보이는 착시다. 아예 내보내지 않는다.
      const strip = (o) => { if (o) { delete o.chg; delete o.prevMed; } };
      strip(cur.national); strip(cur.national?.jeonse);
      (cur.sido ?? []).forEach(strip);
      Object.values(cur.sigungu ?? {}).forEach((v) => { strip(v); strip(v.jeonse); });
      await writeFile(path.join(OUT, svc.id, 'current.json'), JSON.stringify(cur), 'utf8');
      meta.services[svc.id].currentYm = currentYm;
    }
    meta.services[svc.id].latestYm = latestYm;
    console.log(`  → latest=${latestYm}${currentYm ? ` · current=${currentYm} (집계 중)` : ''}`);

    if (errors.length) {
      meta.services[svc.id].errors = errors.length;
      console.warn(`  ⚠ ${svc.id} 실패 ${errors.length}건`);
      errors.slice(0, 10).forEach((e) => console.warn(`     ${e}`));
    }
  }

  // 모든 대상 월에서 0건인 코드는 "거래 없음"이 아니라 코드 오류일 수 있다.
  // API 가 잘못된 LAWD_CD 에도 totalCount 0 을 주기 때문에 여기서만 잡힌다.
  const suspect = [...zeroStreak.entries()]
    .filter(([, n]) => n === targets.length * services.length)
    .map(([code]) => code);
  if (suspect.length) {
    meta.suspectCodes = suspect;
    console.warn(`\n⚠ 전 기간 0건인 코드 ${suspect.length}개 — 코드 오류 가능성: ${suspect.join(', ')}`);
  } else if (svcArg && prevMeta?.suspectCodes) {
    // 한 종목만 돌렸으면 다른 종목을 다시 본 게 아니다. 지난 판정을 지우지 않는다.
    meta.suspectCodes = prevMeta.suspectCodes;
  }

  await writeFile(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  if (hadFailure) {
    // 성공으로 끝내면 "0건 = 거래 없음"으로 오해하고 넘어가게 된다. 실제로 그래서 한 번 놓쳤다.
    console.error('\n종목 중 하나가 중단됐다. meta.json 의 aborted 를 볼 것.');
    process.exit(1);
  }
  console.log('\n완료.');
}

main().catch((e) => {
  console.error(`\n실패: ${e.message}`);
  process.exit(1);
});
