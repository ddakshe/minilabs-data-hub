// [일회용 진단] 세븐일레븐 접근이 GitHub 러너(해외 IP)에서 왜 실패하는지 가려낸다.
// 연결 자체 차단 vs 큰 응답 타임아웃 vs 사이즈 의존을 구분.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15'

async function timed(label, fn) {
  const t0 = Date.now()
  try {
    const r = await fn()
    console.log(`✓ ${label}: ${r} (${Date.now() - t0}ms)`)
  } catch (err) {
    console.log(`✗ ${label}: ${err.name} "${err.message}" cause=${err.cause?.code || ''} (${Date.now() - t0}ms)`)
  }
}

async function get(url, ms) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' }, signal: AbortSignal.timeout(ms) })
  const text = await res.text()
  return `HTTP ${res.status}, ${text.length} chars`
}

async function post(size, ms) {
  const res = await fetch('https://www.7-eleven.co.kr/product/listMoreAjax.asp', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://www.7-eleven.co.kr/product/presentList.asp',
    },
    body: `intPageSize=${size}&intCurrentPage=1&pTab=1&pCd=`,
    signal: AbortSignal.timeout(ms),
  })
  const text = await res.text()
  const names = (text.match(/<div class=['"]name['"]/g) || []).length
  return `HTTP ${res.status}, ${text.length} chars, ${names} names`
}

console.log('--- 세븐일레븐 러너 접근 진단 ---')
await timed('GET presentList.asp (연결 확인)', () => get('https://www.7-eleven.co.kr/product/presentList.asp', 20000))
await timed('POST size=50  (작은 요청)', () => post(50, 20000))
await timed('POST size=500 (중간 요청)', () => post(500, 30000))
await timed('POST size=3000 (전체, 60s)', () => post(3000, 60000))
console.log('--- 끝 ---')
