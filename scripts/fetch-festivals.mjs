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
  const header = json?.response?.header
  const body = json?.response?.body

  if (header?.resultCode !== '00') {
    throw new Error(`API error: ${header?.resultCode} ${header?.resultMsg}`)
  }

  return {
    items: body?.items ?? [],
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
