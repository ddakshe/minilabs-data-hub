/**
 * 환율 스냅샷 생성기 — fx-lens-mini(환율 고시) 앱이 쓴다.
 *
 * 출력: fx/rates.json
 *
 * 실행: ECOS_API_KEY=... node scripts/fetch-fx.mjs
 * 키가 없으면 sample 키로 떨어진다 — 동작은 하지만 호출당 10건이라 매우 느리다.
 *
 * 설계 결정:
 *  - 원화 기준(731Y001)과 달러 기준(731Y002)을 **둘 다** 담는다. 두 percentile 을 나란히
 *    놓아야 "원화가 강해진 것"과 "그 통화가 약해진 것"이 구분된다. 이 앱의 시그니처다.
 *  - 달러 기준은 원/X ÷ 원/달러로 나눈 계산값이 아니라 **한국은행 고시값**을 쓴다.
 *    출처를 "한국은행"이라고 말할 수 있어야 하기 때문이다. 위안만 예외(고시 없음 → 역산).
 *  - percentile 윈도우는 1년이다. 5년은 원화 약세 추세 탓에 극단(상·하위 5%)에
 *    43~59% 의 날 동안 고정되고 최장 7.7개월 붙박이였다 — 매일 같은 말을 하는 앱이 된다.
 *    (2026-08-20 10년치 실측)
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { series, usingSampleKey } from './ecos.mjs';

const KRW_TABLE = '731Y001'; // 주요국 통화의 대원화환율 (일별, 1964~)
const USD_TABLE = '731Y002'; // 주요국 통화의 대미달러환율 (일별)
const KRW_MONTH = '731Y004'; // 월별 대원화환율. 2차항목 0000100 = 평균자료
const POLICY = '902Y006'; // 국제 주요국 중앙은행 정책금리 (월별)

/**
 * 통화 카탈로그.
 *  usd      — 731Y002 의 항목코드. null 이면 고시가 없어 역산한다.
 *  usdFlip  — 표기가 '달러/X'(1X = N달러)라 '1달러 = N X'로 뒤집어야 하는 통화.
 *  region   — 여행 성격 기준. 지리적 정확성보다 "어디 갈까"의 단위에 맞췄다.
 */
const CURRENCIES = [
  { id: '0000002', code: 'JPY', name: '일본 엔', unit: '100엔', flag: '🇯🇵', region: 'east', usd: '0000002', usdFlip: false, long: true },
  { id: '0000053', code: 'CNY', name: '중국 위안', unit: '1위안', flag: '🇨🇳', region: 'east', usd: null, usdFlip: false, long: false },
  { id: '0000031', code: 'TWD', name: '대만 달러', unit: '1달러', flag: '🇹🇼', region: 'east', usd: '0000031', usdFlip: false, long: false },
  { id: '0000015', code: 'HKD', name: '홍콩 달러', unit: '1달러', flag: '🇭🇰', region: 'east', usd: '0000015', usdFlip: false, long: false },
  { id: '0000028', code: 'THB', name: '태국 바트', unit: '1바트', flag: '🇹🇭', region: 'sea', usd: '0000028', usdFlip: false, long: false },
  { id: '0000035', code: 'VND', name: '베트남 동', unit: '100동', flag: '🇻🇳', region: 'sea', usd: '0000035', usdFlip: false, long: false },
  { id: '0000034', code: 'PHP', name: '필리핀 페소', unit: '1페소', flag: '🇵🇭', region: 'sea', usd: '0000034', usdFlip: false, long: false },
  { id: '0000029', code: 'IDR', name: '인도네시아 루피아', unit: '100루피아', flag: '🇮🇩', region: 'sea', usd: '0000029', usdFlip: false, long: false },
  { id: '0000024', code: 'SGD', name: '싱가포르 달러', unit: '1달러', flag: '🇸🇬', region: 'sea', usd: '0000024', usdFlip: false, long: false },
  { id: '0000025', code: 'MYR', name: '말레이시아 링깃', unit: '1링깃', flag: '🇲🇾', region: 'sea', usd: '0000025', usdFlip: false, long: false },
  { id: '0000001', code: 'USD', name: '미국 달러', unit: '1달러', flag: '🇺🇸', region: 'west', usd: null, usdFlip: false, long: true, isBase: true },
  { id: '0000003', code: 'EUR', name: '유로', unit: '1유로', flag: '🇪🇺', region: 'west', usd: '0000003', usdFlip: true, long: true },
  { id: '0000012', code: 'GBP', name: '영국 파운드', unit: '1파운드', flag: '🇬🇧', region: 'west', usd: '0000012', usdFlip: true, long: false },
  { id: '0000017', code: 'AUD', name: '호주 달러', unit: '1달러', flag: '🇦🇺', region: 'west', usd: '0000017', usdFlip: true, long: false },
];

const POLICY_ITEMS = [
  { item: 'KR', name: '한국', flag: '🇰🇷' },
  { item: 'US', name: '미국', flag: '🇺🇸' },
  { item: 'JP', name: '일본', flag: '🇯🇵' },
  { item: 'XM', name: '유로 지역', flag: '🇪🇺' },
];

/** KST 기준 오늘. UTC 로 계산하면 한국 시간 오전 9시 이전에 하루 전 날짜가 나온다. */
function kstToday() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
}

function ymd(dateStr) {
  return dateStr.replaceAll('-', '');
}

function shiftYears(dateStr, years) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

/**
 * values 안에서 target 이 하위 몇 %인지. 동점은 절반으로 나눠 센다.
 * 반환은 0~100.
 */
function percentile(values, target) {
  let below = 0;
  let equal = 0;
  for (const v of values) {
    if (v < target) below += 1;
    else if (v === target) equal += 1;
  }
  return Math.round(((below + equal / 2) / values.length) * 1000) / 10;
}

/** 소수 자릿수를 통화 규모에 맞춘다. 5.36원짜리 동을 2자리로 자르면 정보가 사라진다. */
function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function summarize(rows, digits) {
  const values = rows.map((r) => r.value);
  const today = values.at(-1);
  const prev = values.at(-2) ?? today;
  // 20영업일 ≈ 한 달. 추세 문구의 근거다.
  const monthAgo = values.at(-21) ?? values[0];
  return {
    today: round(today, digits),
    prevDelta: round(today - prev, digits),
    chg20: Math.round((today / monthAgo - 1) * 10000) / 100,
    pct: percentile(values, today),
    lo: round(Math.min(...values), digits),
    hi: round(Math.max(...values), digits),
    series: values.map((v) => round(v, digits)),
    from: rows[0].time,
    to: rows.at(-1).time,
  };
}

/** 달러 기준 표기 자릿수. 1달러 = 26,180동 과 1달러 = 1.27싱달러를 같은 규칙으로 못 쓴다. */
function usdDigits(v) {
  if (v >= 1000) return 0;
  if (v >= 10) return 3;
  return 4;
}

async function main() {
  const today = kstToday();
  const from1y = ymd(shiftYears(today, -1));
  const to = ymd(today);

  if (usingSampleKey) {
    console.warn('⚠️  ECOS_API_KEY 가 없어 sample 키로 돕니다 (호출당 10건 → 매우 느림).');
  }

  const out = {
    asOf: null,
    generatedAt: new Date().toISOString(),
    source: '한국은행 경제통계시스템(ECOS)',
    sourceUrl: 'https://ecos.bok.or.kr',
    policy: [],
    currencies: [],
  };

  // 정책금리는 월별이라 넉넉히 2년을 받고 마지막 값만 쓴다.
  const polFrom = shiftYears(today, -2).slice(0, 7).replace('-', '');
  const polTo = to.slice(0, 6);
  for (const p of POLICY_ITEMS) {
    const rows = await series(POLICY, 'M', polFrom, polTo, p.item);
    if (rows.length === 0) continue;
    const last = rows.at(-1);
    out.policy.push({ name: p.name, flag: p.flag, rate: last.value, time: last.time });
  }

  const usdKrwRows = await series(KRW_TABLE, 'D', from1y, to, '0000001');
  const usdKrwByTime = new Map(usdKrwRows.map((r) => [r.time, r.value]));

  for (const c of CURRENCIES) {
    const krwRows = await series(KRW_TABLE, 'D', from1y, to, c.id);
    if (krwRows.length < 30) {
      console.warn(`  건너뜀 ${c.code}: 영업일 ${krwRows.length}일치뿐`);
      continue;
    }
    const krw = summarize(krwRows, 2);

    let usd = null;
    if (!c.isBase) {
      if (c.usd) {
        const raw = await series(USD_TABLE, 'D', from1y, to, c.usd);
        if (raw.length >= 30) {
          // '달러/X' 표기는 뒤집어 '1달러 = N X' 로 통일한다.
          const rows = c.usdFlip ? raw.map((r) => ({ ...r, value: 1 / r.value })) : raw;
          usd = { ...summarize(rows, usdDigits(rows.at(-1).value)), derived: false };
        }
      } else {
        // 고시가 없는 통화(위안)만 역산한다. 두 계열의 공통 영업일에서만 계산해야
        // 한쪽 결측일에 엉뚱한 값이 만들어지지 않는다.
        const rows = krwRows
          .filter((r) => usdKrwByTime.has(r.time))
          .map((r) => ({ time: r.time, value: usdKrwByTime.get(r.time) / r.value }));
        if (rows.length >= 30) {
          usd = { ...summarize(rows, usdDigits(rows.at(-1).value)), derived: true };
        }
      }
    }

    let long = null;
    if (c.long) {
      const rows = await series(KRW_MONTH, 'M', '196401', polTo, c.id, '0000100');
      if (rows.length >= 24) {
        const values = rows.map((r) => r.value);
        long = {
          from: rows[0].time,
          to: rows.at(-1).time,
          pct: percentile(values, krw.today),
          series: values.map((v) => round(v, 2)),
        };
      }
    }

    out.currencies.push({
      code: c.code, name: c.name, unit: c.unit, flag: c.flag, region: c.region,
      isBase: Boolean(c.isBase), krw, usd, long,
    });
    out.asOf = out.asOf ?? krw.to;
    console.log(`  ${c.flag} ${c.name} — 원화 하위 ${krw.pct}%${usd ? ` / 달러 하위 ${usd.pct}%` : ''}`);
  }

  if (out.currencies.length === 0) throw new Error('수집된 통화가 없습니다.');

  // 싼 순서. 앱에서도 다시 정렬하지만, 스냅샷 자체가 의미 있는 순서를 갖는 편이 낫다.
  out.currencies.sort((a, b) => a.krw.pct - b.krw.pct);

  const target = fileURLToPath(new URL('../fx/rates.json', import.meta.url));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(out), 'utf-8');
  const kb = (JSON.stringify(out).length / 1024).toFixed(1);
  console.log(`\n완료: ${out.currencies.length}개 통화, ${kb}KB → ${target}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
