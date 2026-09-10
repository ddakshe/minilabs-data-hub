#!/usr/bin/env node
/*
 * 도시계획 지도(city-plan-map) — 좌표 → 시도 판정용 격자 → urban-plan/sido-grid.json
 *
 *   node scripts/build-urban-sido-grid.mjs
 *
 * 왜: 앱을 열 때 내 위치로 지역 범위를 시도(예: 경기)까지 기본으로 잡는다. 역지오코딩 API 는
 *     쓰지 않는다 — VWorld 키에 지오코더가 없고, 카카오 등은 앱 번들에 키를 넣어야 한다.
 *     "가장 가까운 개발지구의 시도"는 서울·경기 경계에서 틀린다(강서구에서 부천 지구가 더 가깝다).
 *
 * 방법: 허브의 학교 위치(school-zones/schools.json, 12,011곳 · 시도 필드 있음)를 CELL 도(≈2km) 격자에 넣고
 *       칸마다 가장 많은 시도를 적는다. 앱은 내 좌표의 칸 → 없으면 가까운 칸을 찾는다.
 *       학교는 사람이 사는 곳이면 촘촘해서 경계 판정이 칸 크기만큼 정확하다.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'urban-plan', 'sido-grid.json')
const CELL = 0.02

const SIDO = [
  ['서울', /^서울/], ['부산', /^부산/], ['대구', /^대구/], ['인천', /^인천/], ['광주', /^광주/], ['대전', /^대전/],
  ['울산', /^울산/], ['세종', /^세종/], ['경기', /^경기/], ['강원', /^강원/], ['충북', /^충청북도|^충북/], ['충남', /^충청남도|^충남/],
  ['전북', /^전라북도|^전북/], ['전남', /^전라남도|^전남/], ['경북', /^경상북도|^경북/], ['경남', /^경상남도|^경남/], ['제주', /^제주/],
]
const sidoIndex = (name) => SIDO.findIndex(([, re]) => re.test(name ?? ''))

const { schools } = JSON.parse(await fs.readFile(path.join(ROOT, 'school-zones', 'schools.json'), 'utf8'))
const votes = new Map()
let used = 0
for (const s of schools) {
  if (!s.lat || !s.lon) continue
  const i = sidoIndex(s.sido) >= 0 ? sidoIndex(s.sido) : sidoIndex((s.addr ?? '').split(/\s+/)[0])
  if (i < 0) continue
  const key = `${Math.floor(s.lat / CELL)}:${Math.floor(s.lon / CELL)}`
  const v = votes.get(key) ?? new Array(SIDO.length).fill(0)
  v[i]++
  votes.set(key, v)
  used++
}
const cells = {}
for (const [key, v] of votes) cells[key] = v.indexOf(Math.max(...v))

// 검증 — 시청·도청 좌표와 서울·경기 경계 부근
function lookup([lat, lng]) {
  const la = Math.floor(lat / CELL)
  const lo = Math.floor(lng / CELL)
  for (let r = 0; r <= 15; r++) {
    let best = null
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dy), Math.abs(dx)) !== r) continue
      const c = cells[`${la + dy}:${lo + dx}`]
      if (c === undefined) continue
      const d = dy * dy + dx * dx
      if (!best || d < best.d) best = { c, d }
    }
    if (best) return SIDO[best.c][0]
  }
  return null
}
const CHECKS = [
  ['서울시청', [37.5665, 126.978], '서울'], ['수원시청', [37.2636, 127.0286], '경기'], ['인천시청', [37.4563, 126.7052], '인천'],
  ['부산시청', [35.1796, 129.0756], '부산'], ['세종시청', [36.48, 127.289], '세종'], ['제주도청', [33.4890, 126.4983], '제주'],
  ['강서구청(서울·경기 경계)', [37.5509, 126.8495], '서울'], ['부천시청(경계)', [37.5034, 126.766], '경기'],
  ['광명시청(경계)', [37.4786, 126.8646], '경기'], ['구로구청(경계)', [37.4954, 126.8874], '서울'], ['하남시청', [37.5393, 127.2148], '경기'],
  ['대전시청', [36.3504, 127.3845], '대전'], ['청주시청', [36.6424, 127.489], '충북'], ['창원시청', [35.2279, 128.6811], '경남'],
]
const fail = CHECKS.filter(([, at, want]) => lookup(at) !== want).map(([n, at, want]) => `${n}: ${lookup(at)} ≠ ${want}`)
const body = JSON.stringify({ cell: CELL, sidos: SIDO.map(([n]) => n), source: '학구도안내서비스 학교 위치(허브 school-zones)', cells })
console.log(`학교 ${used}곳 → 칸 ${Object.keys(cells).length}개 · ${(Buffer.byteLength(body) / 1024).toFixed(0)}KB`)
if (fail.length) {
  console.error('✗ 검증 실패\n  - ' + fail.join('\n  - '))
  process.exit(1)
}
await fs.writeFile(OUT, body)
console.log(`✓ sido-grid.json — 검증 ${CHECKS.length}곳 통과`)
