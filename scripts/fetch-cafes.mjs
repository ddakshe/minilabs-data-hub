// 카페렌즈 후보 수집 → cafes/candidates.json
//
// Usage:
//   KAKAO_REST_KEY=xxx node scripts/fetch-cafes.mjs
//
// 카카오 로컬 CE7(카페) 카테고리 검색으로 지정 지역 바운딩박스 안의
// 카페를 전수 수집한다. 카카오는 쿼리당 최대 45건(3페이지×15)만 주므로,
// 사각형 안에 45건 초과면 4분할로 재귀 세분해서 누락 없이 긁는다.
//
// 여기서 얻는 건 "팩트 층"뿐(이름·주소·좌표·전화·플레이스URL).
// 노키즈존·뻘vs바다·주차 같은 "판단 층"은 이 목록을 대상으로 사람이 채운다.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../cafes')

const KEY = process.env.KAKAO_REST_KEY
if (!KEY) {
  console.error('✗ KAKAO_REST_KEY env var required')
  console.error('  developers.kakao.com → 내 애플리케이션 → 앱 키 → REST API 키')
  process.exit(1)
}

// 수집 지역 — [minLng, minLat, maxLng, maxLat] 바운딩박스
// filter: 본토 스필오버 제거용 주소 키워드
// 첫 시드: 강화도(본섬+교동/석모), 영종도(영종+용유)
const REGIONS = [
  { name: '강화도', rect: [126.28, 37.57, 126.54, 37.80], filter: (a) => a.includes('강화') },
  { name: '영종도', rect: [126.36, 37.42, 126.60, 37.55], filter: (a) => a.includes('중구') },
]

const DELAY_MS = 250
const MAX_DEPTH = 6 // 4분할 재귀 최대 깊이(안전장치)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 카카오 rate limit(-10) / 429 대응: 지수 백오프 재시도
async function search(rect, page, attempt = 0) {
  const [x1, y1, x2, y2] = rect
  const url =
    'https://dapi.kakao.com/v2/local/search/category.json' +
    `?category_group_code=CE7&rect=${x1},${y1},${x2},${y2}&page=${page}&size=15`
  const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KEY}` } })
  if (!res.ok) {
    const body = await res.text()
    const limited = res.status === 429 || body.includes('limit')
    if (limited && attempt < 5) {
      const wait = 1000 * 2 ** attempt // 1s,2s,4s,8s,16s
      console.log(`    …rate limit, ${wait}ms 대기 후 재시도`)
      await sleep(wait)
      return search(rect, page, attempt + 1)
    }
    throw new Error(`Kakao ${res.status}: ${body}`)
  }
  return res.json()
}

// 사각형 하나를 긁어 acc(Map, id 기준 중복제거)에 담는다.
async function collectRect(rect, acc, depth = 0) {
  const first = await search(rect, 1)
  const total = first.meta.total_count
  if (total === 0) return

  // 45건 초과 → 4분할 재귀 (누락 방지)
  if (total > 45 && depth < MAX_DEPTH) {
    const [x1, y1, x2, y2] = rect
    const mx = (x1 + x2) / 2
    const my = (y1 + y2) / 2
    const quads = [
      [x1, y1, mx, my], [mx, y1, x2, my],
      [x1, my, mx, y2], [mx, my, x2, y2],
    ]
    for (const q of quads) {
      await collectRect(q, acc, depth + 1)
      await sleep(DELAY_MS)
    }
    return
  }

  // 45건 이하 → 페이지 전부 수집(최대 3페이지)
  let docs = first.documents
  const pages = Math.min(Math.ceil(total / 15), 3)
  for (let p = 2; p <= pages; p++) {
    await sleep(DELAY_MS)
    const j = await search(rect, p)
    docs = docs.concat(j.documents)
  }
  for (const d of docs) acc.set(d.id, d)
}

await fs.mkdir(OUT_DIR, { recursive: true })
const OUT_FILE = path.join(OUT_DIR, 'candidates.json')

const out = []
for (const region of REGIONS) {
  const acc = new Map()
  try {
    await collectRect(region.rect, acc)
  } catch (e) {
    console.error(`  ✗ ${region.name} 중단: ${e.message}`)
  }
  let kept = 0
  for (const d of acc.values()) {
    const address = d.road_address_name || d.address_name
    if (region.filter && !region.filter(address)) continue // 본토 스필오버 제거
    kept++
    out.push({
      kakaoId: d.id,
      name: d.place_name,
      region: region.name,
      address,
      phone: d.phone || '',
      lat: Number(d.y),
      lng: Number(d.x),
      placeUrl: d.place_url, // 카카오 플레이스(판단 속성 채울 때 참고용)
    })
  }
  console.log(`  ${region.name}: 원본 ${acc.size} → 필터 후 ${kept}곳`)
  // 지역마다 중간 저장 (뒤 지역이 실패해도 앞 데이터 보존)
  await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2))
}

console.log(`✓ 총 ${out.length}곳 → cafes/candidates.json`)
