// 전국 지역사랑상품권 가맹점 데이터 → local-currency/{regionCode}.json
//
// Usage:
//   DATA_GO_KR_KEY=xxx node scripts/fetch-local-currency.mjs
//
// 한국조폐공사 API를 지역 코드별로 조회해 각 파일로 저장한다.
// GitHub Actions cron(매일 KST 04:00)에서 실행된다.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../local-currency')

const API_KEY = process.env.DATA_GO_KR_KEY
if (!API_KEY) {
  console.error('✗ DATA_GO_KR_KEY env var required')
  process.exit(1)
}

const API_BASE = 'https://apis.data.go.kr/B190001/localFranchisesV2/franchiseV2'
const PER_PAGE = 100
const MAX_PAGES = 3   // 지역당 최대 300개
const DELAY_MS = 400  // API 호출 간격 (rate limit 대응)

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://toss.im/',
}

// ── 지역 코드 목록 ────────────────────────────────────────────────
// _regions.json 은 이 저장소 안에 있다. 예전엔 이웃 저장소
// (../../local-currency-map/src/data/regions.ts)를 읽었는데, Actions 러너에는
// 그 저장소가 없어서 폴백이 _updated.json 을 지역코드로 착각했다.
// 그래서 1개 지역만 시도하고 실패했다(total:1 success:0 fail:1).
const REGIONS = JSON.parse(
  await fs.readFile(path.join(OUT_DIR, '_regions.json'), 'utf-8')
).map(r => r.code)

if (REGIONS.length < 200) {
  console.error(`✗ 지역 목록이 이상하다: ${REGIONS.length}개`)
  process.exit(1)
}

// ── API 호출 ────────────────────────────────────────────────────────

async function fetchPage(regionCd, page) {
  const params = new URLSearchParams({
    serviceKey: API_KEY,
    type: 'json',
    page: String(page),
    perPage: String(PER_PAGE),
  })
  params.append('cond[bzmn_stts::EQ]', '01')
  params.append('cond[usage_rgn_cd::EQ]', regionCd)

  const res = await fetch(`${API_BASE}?${params}`, { headers: BROWSER_HEADERS })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function pickFields(item) {
  return {
    frcs_nm: item.frcs_nm ?? '',
    frcs_addr: item.frcs_addr ?? '',
    frcs_dtl_addr: item.frcs_dtl_addr ?? '',
    frcs_rprs_telno: item.frcs_rprs_telno ?? '',
    ksic_cd: item.ksic_cd ?? '',
    ksic_cd_nm: item.ksic_cd_nm ?? '',
    frcs_stlm_info_se_nm: item.frcs_stlm_info_se_nm ?? '',
    lat: item.lat ? Number(item.lat) : null,
    lot: item.lot ? Number(item.lot) : null,
  }
}

// 업스트림은 두 가지로 실패한다: HTTP 오류, 그리고 **200 + 빈 배열**.
// 후자가 더 흔하다. 조건 검색 1회가 40~60초 걸리는 인덱스 없는 풀스캔이라
// 부하를 받으면 에러 대신 조용히 빈 결과를 준다.
// Actions 는 6시간까지 돌 수 있으니 넉넉히 재시도한다.
const ATTEMPTS = 5
const RETRY_DELAY_MS = 3000

async function fetchPageWithRetry(regionCd, page) {
  let lastErr
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const data = await fetchPage(regionCd, page)
      const items = (data.data ?? []).map(pickFields)
      // page 1 의 빈 결과는 가짜일 가능성이 높다 — 다시 시도한다.
      // (page 2 이후의 빈 결과는 "더 없음"이라는 정상 신호다.)
      if (page === 1 && items.length === 0) {
        lastErr = new Error('empty page 1')
      } else {
        return items
      }
    } catch (e) {
      lastErr = e
    }
    if (attempt < ATTEMPTS) await sleep(RETRY_DELAY_MS)
  }
  throw lastErr
}

async function fetchRegion(regionCd) {
  const items = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageItems = await fetchPageWithRetry(regionCd, page)
    items.push(...pageItems)
    if (pageItems.length < PER_PAGE) break
    if (page < MAX_PAGES) await sleep(DELAY_MS)
  }
  return items
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ── 메인 ────────────────────────────────────────────────────────────

await fs.mkdir(OUT_DIR, { recursive: true })

console.log(`📦 ${REGIONS.length}개 지역 수집 시작`)
let success = 0, fail = 0, unchanged = 0
const failed = []   // 어느 지역이 비었는지 _updated.json 에 남긴다

for (let i = 0; i < REGIONS.length; i++) {
  const code = REGIONS[i]
  const outPath = path.join(OUT_DIR, `${code}.json`)
  process.stdout.write(`[${i + 1}/${REGIONS.length}] ${code} ... `)

  try {
    const items = await fetchRegion(code)
    const json = JSON.stringify(items)

    // 변경된 경우에만 파일 쓰기
    const prev = await fs.readFile(outPath, 'utf-8').catch(() => null)
    if (prev === json) {
      console.log(`= ${items.length}개 (변경없음)`)
      unchanged++
    } else {
      await fs.writeFile(outPath, json)
      console.log(`✅ ${items.length}개`)
      success++
    }
  } catch (e) {
    console.log(`❌ ${e.message}`)
    fail++
    failed.push({ code, error: String(e.message ?? e) })
  }

  if (i < REGIONS.length - 1) await sleep(DELAY_MS)
}

// 마지막 업데이트 시각 기록
await fs.writeFile(
  path.join(OUT_DIR, '_updated.json'),
  JSON.stringify({
    updatedAt: new Date().toISOString(),
    total: REGIONS.length,
    success, fail, unchanged,
    failed,   // 실패 지역 목록 — 다음 실행에서 우선 재시도할 근거
  })
)

console.log(`\n완료: ✅ ${success} 갱신 / = ${unchanged} 동일 / ❌ ${fail} 실패`)
