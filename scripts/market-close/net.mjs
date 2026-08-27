// ⚠️ 생성된 사본이다. 고치지 말 것.
// 원본: market-close-mini/pipeline/net.mjs
// 갱신: node pipeline/sync-to-hub.mjs
import dns from 'node:dns';

/**
 * 네트워크 공통 설정.
 *
 * ⚠️ **IPv4 우선 — 다만 이건 존재하지 않는 원인을 고친 것이었다(§17).**
 *    "러너가 IPv6 로 새어 나간다" 던 진단은 틀렸다. `apis.data.go.kr` 은 **AAAA 레코드가
 *    아예 없어서** Node 가 IPv6 를 시도할 일이 없다. 실패가 정확히 10초였던 것도 IPv6 의
 *    증거가 아니라 **undici connect 타임아웃 기본값**의 증거였다.
 *    진짜 원인은 국내 IP 외 차단이고, 그건 셀프호스티드 러너로 풀었다(워크플로의 runs-on).
 *    이 한 줄은 해롭지 않아 남겨 두지만, **여기서 원인을 찾지 말 것.**
 */
dns.setDefaultResultOrder('ipv4first');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 네트워크 오류에만 재시도하는 fetch. HTTP 4xx/5xx 는 그대로 돌려준다 —
 * 호출부가 이미 상태 코드로 판단하고 있고, 재시도할 성격이 아닌 경우가 많다.
 *
 * 🚨 **타임아웃은 시도마다 새로 만든다.** `init.signal` 에 `AbortSignal.timeout()` 을
 *    담아 넘기면 **세 번의 시도가 하나의 시계를 공유**한다. 첫 시도가 10초를 태우면
 *    남은 시도에 15초밖에 없고, 두 번째까지 실패하면 세 번째는 **아예 시작되지 못한 채**
 *    `The operation was aborted due to timeout` 으로 끝난다 — 재시도 로직이 스스로를
 *    무력화한다(실측: run 33045244993).
 *    그래서 시간 제한은 `signal` 이 아니라 **`timeoutMs` 옵션**으로 받는다.
 */
export async function fetchRetry(url, init = {}, { tries = 3, gapMs = 1500, timeoutMs = 25000 } = {}) {
  let last;
  for (let i = 1; i <= tries; i += 1) {
    // 호출부가 별도 signal 을 넘겼다면(취소 등) 시도별 타임아웃과 함께 묶는다.
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    try {
      return await fetch(url, { ...init, signal });
    } catch (e) {
      last = e;
      if (i < tries) {
        console.warn(`  ⚠ 네트워크 오류 (${i}/${tries}) — ${gapMs * i}ms 뒤 재시도: ${e.message}`);
        await sleep(gapMs * i);
      }
    }
  }
  throw last;
}
