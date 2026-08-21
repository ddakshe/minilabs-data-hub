/**
 * 한국은행 ECOS 오픈API 클라이언트.
 *
 * 함정 셋 (2026-08-20 실측):
 *  1. 인증키가 URL 경로에 들어간다 → 브라우저에서 부르면 키가 노출된다.
 *  2. 응답에 CORS 헤더가 없다 → 어차피 브라우저에서 못 부른다.
 *     이 둘 때문에 수집은 반드시 빌드/CI 에서만 한다.
 *  3. `sample` 키는 호출당 10건 제한이다. 실제 키는 제한이 없으므로 PAGE 를 키워 잡는다.
 */

const KEY = process.env.ECOS_API_KEY || 'sample';
const BASE = 'https://ecos.bok.or.kr/api';

/** sample 키는 10건이 하드 리밋이다. 실제 키에서는 한 번에 크게 받는다. */
export const PAGE = KEY === 'sample' ? 10 : 1000;

export const usingSampleKey = KEY === 'sample';

async function call(path) {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`ECOS ${res.status}: ${path}`);
  const json = await res.json();
  const key = Object.keys(json)[0];
  if (key === 'RESULT') {
    const { CODE, MESSAGE } = json.RESULT;
    // INFO-200 = 해당하는 데이터 없음. 결측은 오류가 아니다.
    if (CODE === 'INFO-200') return { total: 0, rows: [] };
    const err = new Error(`ECOS ${CODE}: ${String(MESSAGE).split('\n')[0]}`);
    err.code = CODE;
    throw err;
  }
  return { total: json[key].list_total_count, rows: json[key].row ?? [] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ERROR-602(3분간 300회 초과)는 **키 단위**로 걸린다. 실제 키로 이 수집기는 40회 안팎만
 * 부르므로 스스로 넘길 일은 없지만, 같은 키를 쓰는 다른 작업과 겹치면 맞을 수 있다.
 * 짧은 경합은 기다렸다 넘기고, 진짜 차단(30분)이면 깨끗이 실패해 다음 예약 실행에 맡긴다.
 */
async function callWithRetry(path, attempt = 0) {
  try {
    return await call(path);
  } catch (err) {
    if (err.code !== 'ERROR-602' || attempt >= 3) throw err;
    const wait = 60_000 * 2 ** attempt;
    console.warn(`  호출 제한 — ${wait / 1000}초 후 재시도 (${attempt + 1}/3)`);
    await sleep(wait);
    return callWithRetry(path, attempt + 1);
  }
}

/** 전체를 페이지 단위로 훑는다. 첫 호출의 list_total_count 로 남은 페이지를 정한다. */
export async function fetchAll(service, tail) {
  const first = await callWithRetry(`${service}/${KEY}/json/kr/1/${PAGE}/${tail}`);
  const rows = [...first.rows];
  for (let start = PAGE + 1; start <= first.total; start += PAGE) {
    const { rows: more } = await callWithRetry(
      `${service}/${KEY}/json/kr/${start}/${start + PAGE - 1}/${tail}`,
    );
    if (more.length === 0) break; // 방어: 총계가 실제보다 크게 잡히는 경우
    rows.push(...more);
  }
  return rows;
}

/**
 * 통계 시계열. DATA_VALUE 가 빈 문자열인 행은 결측이며 0이 아니다.
 * 0으로 치환하면 percentile 이 조용히 오염된다 — 반드시 버린다.
 */
export async function series(statCode, cycle, from, to, ...items) {
  const rows = await fetchAll('StatisticSearch', `${statCode}/${cycle}/${from}/${to}/${items.join('/')}`);
  const out = [];
  for (const r of rows) {
    if (r.DATA_VALUE === null || r.DATA_VALUE === '') continue;
    out.push({ time: r.TIME, value: Number(r.DATA_VALUE) });
  }
  // 같은 (시점) 중복이 올 수 있다. 나중 값으로 덮고 시간순으로 세운다.
  const byTime = new Map(out.map((r) => [r.time, r.value]));
  return [...byTime.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([time, value]) => ({ time, value }));
}
