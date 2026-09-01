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

// 업스트림 1회 호출이 40~60초 걸린다. 249개를 순차로 돌면 7~10시간이라
// GitHub Actions 잡 제한(6시간)을 넘긴다. 워커 여러 개로 나눠 받는다.
const CONCURRENCY = 6
const REQUEST_TIMEOUT_MS = 120_000

// 최근에 받아둔 지역은 요청 자체를 건너뛴다.
// 기존엔 "받아온 뒤 내용이 같으면 안 쓴다" 였다 — 파일은 안 바뀌지만
// API 호출 비용은 그대로 들어서 전량 재수집에 8.8시간이 걸렸다.
// 가맹점 정보는 느리게 바뀌므로 며칠에 한 번이면 충분하다.
//
// ⚠️ 파일 mtime 을 쓰면 안 된다. actions/checkout 이 체크아웃 시각으로
//    덮어써서 CI 에서는 전부 "방금 받은 것"으로 보이고 영원히 건너뛴다.
//    수집 시각을 _fetched.json 에 직접 기록한다.
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS ?? 7)
const FORCE_ALL = process.env.FORCE_ALL === '1'
const FETCHED_PATH = path.join(OUT_DIR, '_fetched.json')

// 한 실행의 시간 예산. 개수가 아니라 시간으로 끊는 이유는 지역마다 소요가
// 제각각이기 때문이다(1~3페이지 + 재시도). 오래 걸리는 지역은 예산을 많이 먹고
// 빨리 끝나는 지역은 여러 개가 같은 실행에 들어간다 — 실행 시간이 균일해진다.
//
// 전량 수집은 8.8시간이 걸렸다. 매일 그러면 러너를 하루 종일 점유한다.
// 60분씩 나눠 며칠에 걸쳐 한 바퀴 돈다. 가맹점 정보는 느리게 바뀌므로 충분하다.
const BUDGET_MINUTES = Number(process.env.BUDGET_MINUTES ?? 60)

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

  // Node fetch 는 기본 타임아웃이 없다. 멈춘 요청 하나가 워커를 영구히 붙잡는다.
  const res = await fetch(`${API_BASE}?${params}`, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
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

// 지역별 마지막 수집 시각. 없으면 빈 맵에서 시작한다.
const fetched = JSON.parse(await fs.readFile(FETCHED_PATH, 'utf-8').catch(() => '{}'))

// 받아야 할 지역을 **오래된 것부터** 고른다.
// 기록이 없는 지역(= 한 번도 못 받았거나 지난번에 실패한 곳)이 0 으로 맨 앞에 온다.
// 그래서 실패 목록을 따로 관리하지 않아도 다음 실행에서 우선 재시도된다.
const todo = REGIONS
  .map(code => ({ code, at: fetched[code] ? Date.parse(fetched[code]) : 0 }))
  .filter(x => FORCE_ALL || Date.now() - x.at >= MAX_AGE_DAYS * 86400_000)
  .sort((a, b) => a.at - b.at)
  .map(x => x.code)

const skipped = REGIONS.length - todo.length

console.log(`📦 대상 ${todo.length}개 / 전체 ${REGIONS.length} (건너뜀 ${skipped})`)
console.log(`   동시 ${CONCURRENCY} · 예산 ${BUDGET_MINUTES}분\n`)

let success = 0, fail = 0, unchanged = 0, done = 0
const failed = []

const t0 = Date.now()
const deadline = t0 + BUDGET_MINUTES * 60_000
let next = 0
let ranOut = false

// 공유 커서를 워커 CONCURRENCY 개가 나눠 집는다. 지역마다 소요가 제각각이라
// 미리 N등분하면 한 덩어리만 늦게 끝나 전체가 기다린다.
async function worker() {
  while (true) {
    // 예산을 넘겼으면 새 지역을 집지 않는다. 이미 받는 중인 건 끝까지 마친다
    // — 중간에 끊으면 그 지역에 쓴 시간이 통째로 버려진다.
    if (Date.now() >= deadline) { ranOut = true; return }

    const i = next++
    if (i >= todo.length) return

    const code = todo[i]
    const outPath = path.join(OUT_DIR, `${code}.json`)

    try {
      const items = await fetchRegion(code)
      const json = JSON.stringify(items)
      const prev = await fs.readFile(outPath, 'utf-8').catch(() => null)

      fetched[code] = new Date().toISOString()

      if (prev === json) {
        unchanged++
        console.log(`[${++done}/${todo.length}] ${code} = ${items.length}개 (변경없음)`)
      } else {
        await fs.writeFile(outPath, json)
        success++
        console.log(`[${++done}/${todo.length}] ${code} ✅ ${items.length}개`)
      }
    } catch (e) {
      fail++
      failed.push({ code, error: String(e.message ?? e) })
      console.log(`[${++done}/${todo.length}] ${code} ❌ ${e.message}`)
    }

    await sleep(DELAY_MS)
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

const mins = ((Date.now() - t0) / 60000).toFixed(1)
const remaining = Math.max(0, todo.length - done)

await fs.writeFile(FETCHED_PATH, JSON.stringify(fetched, null, 0))

// 마지막 업데이트 시각 기록
await fs.writeFile(
  path.join(OUT_DIR, '_updated.json'),
  JSON.stringify({
    updatedAt: new Date().toISOString(),
    total: REGIONS.length,
    success, fail, unchanged, skipped, remaining,
    budgetExhausted: ranOut,
    failed,   // 실패 지역 목록 — 다음 실행에서 우선 재시도할 근거
  })
)

console.log(`\n완료(${mins}분): ✅ ${success} 갱신 / = ${unchanged} 동일 / ⏭ ${skipped} 건너뜀 / ❌ ${fail} 실패`)
if (ranOut) {
  console.log(`⏱  예산 ${BUDGET_MINUTES}분 소진 — ${remaining}개는 다음 실행으로 넘긴다`)
}
if (failed.length) {
  console.log('실패 지역:', failed.map(f => f.code).join(', '))
}
