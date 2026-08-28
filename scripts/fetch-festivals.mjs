// 공공데이터포털 전국문화축제표준데이터 → festivals/festivals.json
//
// Usage:
//   FESTIVAL_API_KEY=xxx node scripts/fetch-festivals.mjs
//
// 이 스크립트는 minilabs-data-hub의 GitHub Actions cron에서 실행되어
// korea-festival-mini 앱이 소비하는 festivals.json을 생성한다.
//
// API: https://api.data.go.kr/openapi/tn_pubr_public_cltur_fstvl_api

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../festivals/festivals.json')

const API_KEY = process.env.FESTIVAL_API_KEY
if (!API_KEY) {
  console.error('✗ FESTIVAL_API_KEY env var required')
  process.exit(1)
}

const ENDPOINT = 'https://api.data.go.kr/openapi/tn_pubr_public_cltur_fstvl_api'
const PAGE_SIZE = 100

// ───────────────────────────── 지역 매핑 ─────────────────────────────

function extractRegion(address) {
  if (!address) return '기타'
  const map = [
    ['서울', '서울'], ['부산', '부산'], ['대구', '대구'],
    ['인천', '인천'], ['광주광역', '광주'], ['대전', '대전'],
    ['울산', '울산'], ['세종', '세종'], ['경기', '경기'],
    ['강원', '강원'], ['충청북', '충북'], ['충북', '충북'],
    ['충청남', '충남'], ['충남', '충남'], ['전라북', '전북'],
    ['전북', '전북'], ['전라남', '전남'], ['전남', '전남'],
    ['경상북', '경북'], ['경북', '경북'], ['경상남', '경남'],
    ['경남', '경남'], ['제주', '제주'],
  ]
  for (const [prefix, region] of map) {
    if (address.includes(prefix)) return region
  }
  return '기타'
}

// ───────────────────────────── API 호출 ─────────────────────────────

async function fetchPage(pageNo) {
  const params = new URLSearchParams({
    serviceKey: API_KEY,
    pageNo: String(pageNo),
    numOfRows: String(PAGE_SIZE),
    type: 'json',
  })

  const url = `${ENDPOINT}?${params}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const json = await res.json()

  // 인증 실패·트래픽 초과는 아래 정상 스키마가 아니라 이 모양으로 온다.
  // 먼저 걸러내지 않으면 '알 수 없는 응답' 으로 뭉개져 원인을 못 찾는다.
  const err = json?.OpenAPI_ServiceResponse?.cmmMsgHeader
  if (err) throw new Error(`API 거부: ${err.errMsg} (${err.returnAuthMsg ?? ''})`)

  // ⚠ 이 엔드포인트는 `response` 래퍼가 없다. 최상위에 header·body 가 바로 온다.
  // 표준데이터(tn_pubr_public_*) 계열이 다른 data.go.kr API 와 다른 지점이며,
  // 예전에 json.response.header 로 읽어 header 가 undefined 가 되는 바람에
  // 'API error: undefined undefined' 만 남기고 넉 달간 한 번도 성공하지 못했다.
  const header = json?.header
  const body = json?.body

  if (header?.resultCode !== '00') {
    throw new Error(`API error: ${header?.resultCode ?? '응답 형식 불명'} ${header?.resultMsg ?? JSON.stringify(json).slice(0, 200)}`)
  }

  // items 도 배열이 아니라 { item: [...] } 다. 1건일 때 객체로 오는 API 가 있어 배열로 맞춘다.
  const item = body?.items?.item ?? []

  return {
    items: Array.isArray(item) ? item : [item],
    totalCount: Number(body?.totalCount ?? 0),
  }
}

async function fetchAll() {
  console.log('⏳ Fetching page 1...')
  const first = await fetchPage(1)
  const allItems = [...first.items]
  const totalPages = Math.ceil(first.totalCount / PAGE_SIZE)

  console.log(`  총 ${first.totalCount}건, ${totalPages}페이지`)

  for (let page = 2; page <= totalPages; page++) {
    console.log(`⏳ Fetching page ${page}/${totalPages}...`)
    const { items } = await fetchPage(page)
    allItems.push(...items)
  }

  return allItems
}

// ───────────────────────────── 변환 ─────────────────────────────

function transform(raw) {
  return raw.map((item, i) => ({
    id: `f${String(i + 1).padStart(3, '0')}`,
    name: item.fstvlNm?.trim() || '',
    location: item.opar?.trim() || '',
    startDate: formatDate(item.fstvlStartDate),
    endDate: formatDate(item.fstvlEndDate),
    description: item.fstvlCo?.trim() || '',
    organizer: item.mnnstNm?.trim() || item.auspcInsttNm?.trim() || '',
    sponsor: item.sponsrInsttNm?.trim() || '',
    phone: item.phoneNumber?.trim() || '',
    homepage: item.homepageUrl?.trim() || '',
    address: item.rdnmadr?.trim() || item.lnmadr?.trim() || '',
    lat: parseFloat(item.latitude) || 0,
    lng: parseFloat(item.longitude) || 0,
    region: extractRegion(item.rdnmadr || item.lnmadr || ''),
    referenceDate: item.referenceDate || '',
  })).filter((f) => f.name) // 이름 없는 항목 제거
}

function formatDate(raw) {
  if (!raw) return ''
  // "2026-04-11" 또는 "20260411" 형식 처리
  const cleaned = raw.replace(/[^0-9]/g, '')
  if (cleaned.length === 8) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}`
  }
  return raw.trim()
}

// ───────────────────────────── 메인 ─────────────────────────────

async function main() {
  const rawItems = await fetchAll()
  console.log(`✓ ${rawItems.length}건 수신`)

  const festivals = transform(rawItems)
  console.log(`✓ ${festivals.length}건 변환 완료`)

  // 지역별 통계
  const regionCounts = {}
  for (const f of festivals) {
    regionCounts[f.region] = (regionCounts[f.region] || 0) + 1
  }
  console.log('  지역별:', JSON.stringify(regionCounts, null, 0))

  const output = {
    updatedAt: new Date().toISOString().slice(0, 10),
    source: '공공데이터포털 전국문화축제표준데이터',
    totalCount: festivals.length,
    festivals,
  }

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8')
  console.log(`✓ ${OUTPUT_PATH} 저장 완료 (${festivals.length}건)`)
}

main().catch((err) => {
  console.error('✗ Fatal:', err.message)
  process.exit(1)
})
