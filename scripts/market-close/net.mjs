// ⚠️ 생성된 사본이다. 고치지 말 것.
// 원본: market-close-mini/pipeline/net.mjs
// 갱신: node pipeline/sync-to-hub.mjs
import dns from 'node:dns';

/**
 * 네트워크 공통 설정.
 *
 * 🚨 **IPv4 우선.** GitHub Actions 러너는 IPv6 주소를 갖지만 국내 공공 API 로 가는
 *    IPv6 경로가 없는 경우가 있다. Node 18+ 는 AAAA 를 먼저 시도하므로 연결이 매달리다가
 *    undici 기본 connect 타임아웃(**정확히 10초**)에 걸려 `fetch failed` 로 끝난다.
 *    로컬(맥)에서는 재현되지 않아 원인을 찾기 어렵다 — 실패 시각이 10초인 것이 단서다.
 */
dns.setDefaultResultOrder('ipv4first');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 네트워크 오류에만 재시도하는 fetch. HTTP 4xx/5xx 는 그대로 돌려준다 —
 * 호출부가 이미 상태 코드로 판단하고 있고, 재시도할 성격이 아닌 경우가 많다.
 */
export async function fetchRetry(url, init = {}, { tries = 3, gapMs = 1500 } = {}) {
  let last;
  for (let i = 1; i <= tries; i += 1) {
    try {
      return await fetch(url, init);
    } catch (e) {
      last = e;
      if (i < tries) {
        console.warn(`  ⚠ 네트워크 오류 (${i}/${tries}) — ${gapMs}ms 뒤 재시도: ${e.message}`);
        await sleep(gapMs * i);
      }
    }
  }
  throw last;
}
