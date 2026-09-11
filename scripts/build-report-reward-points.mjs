#!/usr/bin/env node
/*
 * 신고하고 포상금받자 — 「내 위치로 찾기」용 시군구 대표 좌표
 *
 *   node scripts/build-report-reward-points.mjs
 *
 * school-zones/schools.json(학교 12,011곳 좌표·주소) → report-reward/regions/points.json
 * 앱은 **기기 안에서** 가장 가까운 점의 시군구를 고른다 — 좌표를 밖으로 보내거나 저장하지 않는다.
 * 지오코딩 API(카카오·브이월드)는 약관상 결과를 저장할 수 없고 좌표를 외부로 보내야 해서 쓰지 않는다.
 *
 * 학교 주소 → 기초자치단체(scripts/report-reward/units.mjs):
 *   - 일반구 주소(경기도 수원시 장안구 …)는 모시(수원시) — 주소 둘째 토큰이 시 이름이다
 *   - 광주광역시 X구 · 전라남도 X시군 → 전남광주통합특별시 (2026 통합, 학교 주소는 옛 시도 이름)
 *   - 인천 2026-07 개편(학교 주소는 옛 구 이름):
 *       중구 → 영종도(경도 126.56 미만)는 영종구, 나머지 제물포구 / 동구 → 제물포구
 *       서구 → 검단(위도 37.575 이상)은 검단구, 나머지 서해구
 *     경계 근처는 틀릴 수 있다 — 앱이 「동네 바꾸기」를 늘 같이 보여준다
 *   - 세종·제주 → 광역
 * 격자(0.02° ≈ 2km)마다 시군구별 한 점만 남겨 파일을 작게 한다(버튼을 누를 때만 받는다).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadUnits } from './report-reward/units.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'report-reward', 'regions', 'points.json')
const GRID = 0.02

const units = await loadUnits(ROOT)
const codeByName = new Map(units.map((u) => [`${u.sido} ${u.sigungu}`, u.code]))
const code = (sido, sigungu) => codeByName.get(`${sido} ${sigungu}`)
const indexOf = new Map(units.map((u, i) => [u.code, i]))

function unitOf(s) {
  const [rawSido, a] = s.addr.trim().split(/\s+/)
  let sido = rawSido
  if (sido === '세종특별자치시') return code(sido, sido)
  if (sido === '제주특별자치도') return '50000'
  if (sido === '광주광역시' || sido === '전라남도') sido = '전남광주통합특별시'
  if (sido === '인천광역시') {
    if (a === '중구') return code(sido, s.lon < 126.56 ? '영종구' : '제물포구')
    if (a === '동구') return code(sido, '제물포구')
    if (a === '서구') return code(sido, s.lat >= 37.575 ? '검단구' : '서해구')
  }
  return code(sido, a)
}

const { schools } = JSON.parse(await fs.readFile(path.join(ROOT, 'school-zones', 'schools.json'), 'utf8'))
const seen = new Set()
const points = []
const missed = new Map()
for (const s of schools) {
  if (typeof s.lat !== 'number' || typeof s.lon !== 'number' || !s.addr) continue
  const c = unitOf(s)
  if (!c) {
    const key = s.addr.split(/\s+/).slice(0, 2).join(' ')
    missed.set(key, (missed.get(key) ?? 0) + 1)
    continue
  }
  const cell = `${c}:${Math.round(s.lat / GRID)}:${Math.round(s.lon / GRID)}`
  if (seen.has(cell)) continue
  seen.add(cell)
  points.push([Math.round(s.lat * 1e4) / 1e4, Math.round(s.lon * 1e4) / 1e4, indexOf.get(c)])
}
points.sort((p, q) => p[2] - q[2] || p[0] - q[0] || p[1] - q[1])

const covered = new Set(points.map((p) => p[2]))
const empty = units.filter((_, i) => !covered.has(i))
if (missed.size) console.warn('⚠ 시군구를 못 찾은 주소:', [...missed].map(([k, n]) => `${k}(${n})`).join(', '))
if (empty.length) {
  console.error('✗ 대표점이 하나도 없는 기초자치단체:', empty.map((u) => `${u.code} ${u.sido} ${u.sigungu}`).join(', '))
  process.exit(1)
}

const body = JSON.stringify({
  v: 1,
  source: 'school-zones/schools.json 학교 좌표를 0.02° 격자로 솎음 — 기기 안 최근접 판별용(시군구 경계 근처는 틀릴 수 있다)',
  units: units.map((u) => u.code),
  points,
})
await fs.writeFile(OUT, body)
console.log(`✓ points.json — 점 ${points.length}개 · 기초자치단체 ${units.length}곳 전부 · ${(body.length / 1024).toFixed(1)}KB`)
