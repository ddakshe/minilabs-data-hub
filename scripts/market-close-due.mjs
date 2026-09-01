#!/usr/bin/env node
/**
 * 장마감 리포트를 지금 돌려야 하는지 판정한다. 호출 1~3회로 끝난다.
 *
 *   exit 0 → 돌려야 한다 (새 기준일이 공개됐다)
 *   exit 1 → 돌릴 필요 없다 (이미 최신이거나, 아직 공개 전)
 *   exit 2 → 판정 불가 (키 없음·네트워크)
 *
 * 🔑 **날짜를 계산하지 않는다.** '어제가 영업일인가'를 달력으로 따지면 공휴일 표가
 *    필요하고, 그 표가 틀리면 조용히 굶는다. 대신 두 값을 비교한다.
 *
 *      data.go.kr 에 있는 최신 기준일   vs   이미 만들어 둔 기준일
 *
 *    공휴일·임시휴장은 애초에 공개되지 않으므로 자동으로 맞는다.
 */
import { readFileSync } from 'node:fs';

const HUB_MARKET = new URL('../market-close/market.json', import.meta.url);
const API = 'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo';
const LOOKBACK = 5;   // 연휴가 길어도 이 안에는 영업일이 있다

function key() {
  if (process.env.DATA_GO_KR_KEY) return process.env.DATA_GO_KR_KEY;
  try {
    const env = readFileSync(`${process.env.HOME}/.config/stock-tools/datagokr.env`, 'utf8');
    return (env.match(/^DATA_GO_KR_KEY=(.*)$/m) || [])[1]?.trim() || '';
  } catch { return ''; }
}

/** 그 기준일 데이터가 공개됐는지. numOfRows=1 이라 응답이 작다. */
async function published(basDt, sk) {
  const url = `${API}?serviceKey=${sk}&resultType=json&numOfRows=1&pageNo=1&basDt=${basDt}`;
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  try {
    const j = JSON.parse(await r.text());
    return (j?.response?.body?.totalCount ?? 0) > 0;
  } catch { return false; }   // XML 오류 응답 = 없는 것으로 본다
}

const sk0 = key();
if (!sk0) { console.error('DATA_GO_KR_KEY 없음'); process.exit(2); }
const sk = /%[0-9A-Fa-f]{2}/.test(sk0) ? sk0 : encodeURIComponent(sk0);

let built = '';
try { built = JSON.parse(readFileSync(HUB_MARKET, 'utf8')).lastBasDt || ''; } catch {}

// 오늘부터 거슬러 올라가며 **공개된 첫 날**을 찾는다.
const d = new Date();
let latest = '';
for (let i = 0; i < LOOKBACK; i++) {
  const s = d.toISOString().slice(0, 10).replaceAll('-', '');
  // 이미 만들어 둔 날에 닿았으면 그보다 새 것은 없다는 뜻이다 — 더 볼 필요 없다.
  if (built && s === built) break;
  if (await published(s, sk)) { latest = s; break; }
  d.setDate(d.getDate() - 1);
}

const verdict = latest && latest > built;
console.log(`만든 기준일=${built || '(없음)'}  공개된 최신=${latest || '(아직 없음)'}  → ${verdict ? '실행' : '건너뜀'}`);
process.exit(verdict ? 0 : 1);
