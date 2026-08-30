/*
 * 재시도 + 백오프 공용 헬퍼. 컬리 상세 API, 오아시스 카테고리 목록 모두 이걸 쓴다.
 *
 * 몰마다 타임아웃·에러 메시지·응답 파싱(json/text)이 달라서 fetch 자체는 호출부가
 * 짜고, 여기서는 그 한 번의 시도를 감싸는 재시도 루프만 맡는다.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {() => Promise<T>} attempt 실패 시 그대로 throw 하는 단발 시도
 * @param {{ retries?: number }} [options]
 * @returns {Promise<T>}
 * @template T
 */
export async function withRetry(attempt, { retries = 3 } = {}) {
  let lastErr
  for (let i = 1; i <= retries; i++) {
    try {
      return await attempt()
    } catch (err) {
      lastErr = err
      if (i < retries) await sleep(1000 * i)
    }
  }
  throw lastErr
}
