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

// ── 지역 코드 목록 (regions.ts 에서 추출한 249개) ──────────────────
// 직접 임포트 대신 인라인 — Node에서 TS 의존성 없이 실행하기 위함
const REGIONS = await loadRegionCodes()

async function loadRegionCodes() {
  const src = await fs.readFile(
    path.resolve(__dirname, '../..', 'local-currency-map/src/data/regions.ts'),
    'utf-8'
  ).catch(() => null)

  if (src) {
    const matches = [...src.matchAll(/"code":\s*"(\d+)"/g)]
    return [...new Set(matches.map(m => m[1]))]
  }

  // fallback: local-currency 디렉토리에 이미 있는 파일 목록 사용
  const files = await fs.readdir(OUT_DIR).catch(() => [])
  return files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
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

async function fetchRegion(regionCd) {
  const items = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fetchPage(regionCd, page)
    const pageItems = (data.data ?? []).map(pickFields)
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
  }

  if (i < REGIONS.length - 1) await sleep(DELAY_MS)
}

// 마지막 업데이트 시각 기록
await fs.writeFile(
  path.join(OUT_DIR, '_updated.json'),
  JSON.stringify({ updatedAt: new Date().toISOString(), total: REGIONS.length, success, fail, unchanged })
)

console.log(`\n완료: ✅ ${success} 갱신 / = ${unchanged} 동일 / ❌ ${fail} 실패`)
