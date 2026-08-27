#!/usr/bin/env node
// ⚠️ 생성된 사본이다. 고치지 말 것.
// 원본: market-close-mini/pipeline/fetch-ownership.mjs
// 갱신: node pipeline/sync-to-hub.mjs
/**
 * fetch-ownership.mjs — 종목별 '누가 들고 있나' 를 DART 지분공시에서 받는다.
 *
 *   out/ownership/{code}.json
 *
 * 🔑 **왜 이걸 만드는가.** 이용자가 원하는 것은 *"기관·외국인이 어떻게 움직였나"* 인데
 *    **일별 순매매는 경로가 전부 막혀 있다** (HANDOFF §2-a ⑩ · §17):
 *      토스 API 약관 금지 · KRX OpenAPI 제3자 제공 금지 · 네이버는 KRX 라이선시 ·
 *      data.go.kr 에 없음 · 대차거래는 KOGL 제4유형(상업적 이용금지) ·
 *      KDM 은 연 60만원인데 §6-1 이 재분배 목적 구매를 거절
 *    남은 유일한 경로가 **지분공시**다. 그리고 이게 오히려 §1 의 북극성에 더 맞는다 —
 *    익명 집계가 아니라 *"누가, 몇 %에서 몇 %로"* 라는 **법정 신고로 귀속된 사실**이다.
 *
 * ⚠️ **일별 순매매의 대체재가 아니다.** "오늘 외국인이 얼마 샀나" 에는 답하지 못한다.
 *    지분공시는 **사건이 있는 날만** 나온다. 대부분의 날은 비어 있는 것이 정상이다.
 *
 * 두 엔드포인트를 쓴다 (종목당 2회):
 *   majorstock.json  주식등의 대량보유상황보고서 (5%룰) — 국민연금·운용사·외국계
 *   elestock.json    임원·주요주주 특정증권등 소유상황보고서
 *
 * 🚧 **둘 다 '전체 이력' 을 돌려준다.** 날짜 파라미터가 없어 매번 전량을 받고
 *    우리가 자른다. 그래서 응답이 크지만 호출은 종목당 2회로 고정이다.
 *
 *   node pipeline/fetch-ownership.mjs 005930
 *   node pipeline/fetch-ownership.mjs --preset
 */

import { OUT, p } from './paths.mjs';
import { fetchRetry } from './net.mjs';
import { resolveTargets } from './targets.mjs';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isOpinionHeadline } from './forbidden.mjs';

const KEY = process.env.DART_API_KEY ?? '';
const MAP_PATH = p('corpmap.json');
const ABS_MAX_CALLS = 120;          // 종목당 2회 → 프리셋 20종목이면 40회
const GAP_MS = 300;
const TIMEOUT_MS = 25000;

/**
 * 얼마나 지난 신고까지 보여줄 것인가.
 *
 * 🔑 **90일이다.** 5%룰 신고는 드물어서(삼성전자 3개월 40건, 중소형주는 0건)
 *    당일만 보면 거의 항상 비어 있다. "최근 90일 안에 이런 변동이 있었다" 가
 *    이용자에게 실제로 쓸모 있는 창이다. 아카이브 보존(120일)보다 짧게 둔다 —
 *    리포트가 아카이브보다 오래된 사실을 말하면 안 된다.
 */
const WINDOW_DAYS = 90;
const MAX_ITEMS = 8;                // 한 종목에 담을 최대 건수 (최신순)

const argv = process.argv.slice(2);
if (!KEY) { console.error('DART_API_KEY 가 없다. ~/.config/stock-tools/dart.env'); process.exit(1); }

let calls = 0;
let maxCalls = ABS_MAX_CALLS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const num = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[,\s%]/g, ''));
  return Number.isFinite(n) ? n : null;
};
/** DART 는 'YYYY-MM-DD' 와 'YYYYMMDD' 를 섞어 쓴다. 우리 스키마는 YYYYMMDD 하나다. */
const ymd = (v) => String(v ?? '').replace(/-/g, '').slice(0, 8);

/**
 * 보고 사유 정리.
 *
 * DART 는 여러 사유를 줄바꿈 + `- ` 글머리로 이어 붙여 준다:
 *   "- 보유주식수 변동\n- 보유주식등에 관한 계약의 변경"
 * 화면은 한 줄이므로 ' · ' 로 잇는다. **문구 자체는 바꾸지 않는다** — 원문 인용이다.
 */
const cleanReason = (v) => String(v ?? '')
  .split(/\r?\n/)
  .map((x) => x.replace(/^\s*[-·•]\s*/, '').trim())
  .filter(Boolean)
  .join(' · ');

async function call(path, corp) {
  if (calls >= maxCalls) throw new Error(`호출 상한 ${maxCalls} 초과 — 중단`);
  if (calls > 0) await sleep(GAP_MS);
  calls += 1;

  const url = `https://opendart.fss.or.kr/api/${path}?crtfc_key=${KEY}&corp_code=${corp}`;
  const res = await fetchRetry(url, {}, { timeoutMs: TIMEOUT_MS });
  const j = await res.json();
  if (j.status === '013') return [];                       // 조회된 데이터가 없음 (정상)
  if (j.status !== '000') throw new Error(`${path} ${j.status} ${j.message}`);
  return j.list ?? [];
}

/**
 * 대량보유(5%룰). `stkrt_irds` 가 비율 변동이다.
 *
 * 🚧 **`report_tp` 는 '일반'·'약식' 같은 보고 형태**이고 증감 방향이 아니다.
 *    방향은 `stkrt_irds` 의 부호로만 안다. 부호가 없으면(신규 보고) null 로 둔다.
 */
const mapMajor = (d) => ({
  kind: 'major',
  date: ymd(d.rcept_dt),
  holder: (d.repror ?? '').trim(),
  ratio: num(d.stkrt),
  ratioChange: num(d.stkrt_irds),
  reason: cleanReason(d.report_resn),
  link: d.rcept_no ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${d.rcept_no}` : null,
});

/**
 * 임원·주요주주 소유상황.
 *
 * 🚧 **개인 임원이 대부분이다.** 삼성전자는 3개월에 826건이 들어오는데 거의 전부
 *    임원 개인의 소량 변동이라 리포트에 넣으면 노이즈다. 그래서 **주요주주만** 남긴다
 *    (`isu_exctv_rgist_at` 이 아니라 `isu_main_shrholdr` 로 판별).
 */
const mapEle = (d) => ({
  kind: 'insider',
  date: ymd(d.rcept_dt),
  holder: (d.repror ?? '').trim(),
  position: (d.isu_exctv_ofcps ?? '').trim(),
  role: (d.isu_main_shrholdr ?? '').trim(),
  sharesAfter: num(d.sp_stock_lmp_cnt),
  sharesChange: num(d.sp_stock_lmp_irds_cnt),
  link: d.rcept_no ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${d.rcept_no}` : null,
});

async function main() {
  if (!existsSync(MAP_PATH)) {
    console.error('corpmap.json 이 없다. 먼저: node pipeline/fetch-dart.mjs --map-only');
    process.exit(1);
  }
  const map = JSON.parse(readFileSync(MAP_PATH, 'utf8')).map;

  const targets = resolveTargets(argv).map((t) => ({ code: t.code, name: map[t.code]?.name ?? t.name }));
  if (!targets.length) { console.error('종목이 없다. 코드를 주거나 --preset / --wanted'); process.exit(1); }

  const basDt = JSON.parse(readFileSync(p('preset.json'), 'utf8')).basDt;
  const from = (() => {
    const d = new Date(`${basDt.slice(0, 4)}-${basDt.slice(4, 6)}-${basDt.slice(6, 8)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - WINDOW_DAYS);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  })();

  maxCalls = Math.min(ABS_MAX_CALLS, targets.length * 2 + 2);
  console.log(`\n대상 ${targets.length}종목 · 창 ${from}~${basDt} (${WINDOW_DAYS}일) · 상한 ${maxCalls}회\n`);

  mkdirSync(p('ownership'), { recursive: true });
  let ok = 0, fail = 0, empty = 0;

  for (const { code, name } of targets) {
    const hit = map[code];
    if (!hit) { fail += 1; console.log(`  ✗ ${code} ${name} — corp_code 없음`); continue; }
    try {
      const [major, ele] = await Promise.all([
        call('majorstock.json', hit.corp),
        call('elestock.json', hit.corp),
      ]);

      const items = [
        ...major.map(mapMajor),
        // 주요주주만 남긴다 — 임원 개인의 소량 변동은 노이즈다
        ...ele.map(mapEle).filter((x) => x.role && x.role !== '-'),
      ]
        // 🔑 §11 의 경계를 그대로 적용한다: "원문이냐"가 아니라 "의견이냐"다.
        //    지분공시 사유는 신고인이 법정 서식에 적은 사실이라 통과하는 것이 정상이지만,
        //    통과를 **가정하지 않고 확인한다.** 실측에서 5개 문구 전부 통과했다.
        .filter((x) => !isOpinionHeadline(x.reason ?? ''))
        .filter((x) => x.date >= from && x.date <= basDt)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, MAX_ITEMS);

      writeFileSync(p(`ownership/${code}.json`), JSON.stringify({
        code, name, corpCode: hit.corp, basDt, from, windowDays: WINDOW_DAYS,
        items,
        source: 'DART 지분공시 (대량보유·임원주요주주)',
        generatedAt: new Date().toISOString(),
      }, null, 2) + '\n');

      if (items.length === 0) empty += 1;
      ok += 1;
      const head = items[0];
      console.log(`  ✓ ${code} ${name.padEnd(12)} ${String(items.length).padStart(2)}건`
        + (head ? `  최근 ${head.date} ${head.holder.slice(0, 14)}` : '  (창 안에 신고 없음)'));
    } catch (e) {
      fail += 1;
      console.log(`  ✗ ${code} ${name} — ${e.message}`);
    }
  }

  console.log(`\n성공 ${ok} · 실패 ${fail} · 신고 없음 ${empty} · 총 호출 ${calls}회 / 상한 ${maxCalls}회`);
  console.log(`→ ${OUT}/ownership/*.json`);
}

await main();
