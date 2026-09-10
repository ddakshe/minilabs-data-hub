#!/usr/bin/env node
/*
 * 도시계획 지도(city-plan-map) — GTX 계획노선 seed 검증 → urban-plan/gtx.json
 *
 *   node scripts/build-urban-gtx.mjs
 *
 * GTX 노선·역은 정형 공공데이터가 없다(data.go.kr 에서 GTX·수도권광역급행철도 오픈API 0건).
 * 그래서 urban-plan/seed/gtx.json 을 사람이 고치고, 이 스크립트는 **틀린 값이 앱에 가지 않게만** 막는다.
 * 네트워크 호출 없음 — CI 없이 로컬에서 seed 를 고친 뒤 돌린다.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SEED = path.join(ROOT, 'urban-plan', 'seed', 'gtx.json')
const OUT = path.join(ROOT, 'urban-plan', 'gtx.json')
const STATUS = new Set(['운행', '공사', '계획'])

const seed = JSON.parse(await fs.readFile(SEED, 'utf8'))
const fail = []
const inKorea = ([lat, lng]) => lat > 33 && lat < 39 && lng > 124.5 && lng < 131

if (!/^\d{4}-\d{2}-\d{2}$/.test(seed.updated ?? '')) fail.push('updated 가 YYYY-MM-DD 가 아니다')
if (!seed.sources?.length) fail.push('sources 가 비었다')
for (const line of seed.lines ?? []) {
  if (!STATUS.has(line.status)) fail.push(`${line.id}: status '${line.status}'`)
  if ((line.stations ?? []).length < 2) fail.push(`${line.id}: 역이 2개 미만`)
  for (const s of line.stations ?? []) {
    if (!Array.isArray(s.at) || s.at.length !== 2 || !inKorea(s.at)) fail.push(`${line.id} ${s.name}: 좌표 ${JSON.stringify(s.at)} — [lat,lng] 순서 확인`)
    if (!STATUS.has(s.status)) fail.push(`${line.id} ${s.name}: status '${s.status}'`)
    if (typeof s.approx !== 'boolean') fail.push(`${line.id} ${s.name}: approx 가 boolean 이 아니다`)
  }
  // 지선(예: GTX-C 금정→상록수) — 본선의 분기역에서 이어진다
  for (const br of line.branches ?? []) {
    if (!(line.stations ?? []).some((s) => s.name === br.from)) fail.push(`${line.id}: 지선 분기역 '${br.from}' 이 본선에 없다`)
    if (!(br.stations ?? []).length) fail.push(`${line.id}: '${br.from}' 지선에 역이 없다`)
    for (const s of br.stations ?? []) {
      if (!Array.isArray(s.at) || s.at.length !== 2 || !inKorea(s.at)) fail.push(`${line.id} 지선 ${s.name}: 좌표 ${JSON.stringify(s.at)}`)
      if (!STATUS.has(s.status)) fail.push(`${line.id} 지선 ${s.name}: status '${s.status}'`)
      if (typeof s.approx !== 'boolean') fail.push(`${line.id} 지선 ${s.name}: approx 가 boolean 이 아니다`)
    }
  }
  // 구간 상태 — 지도는 이걸로 운행/공사/계획을 나눠 그린다. 역 이름은 본선·지선 역을 가리켜야 한다.
  const known = new Set([...(line.stations ?? []), ...(line.branches ?? []).flatMap((b) => b.stations ?? [])].map((s) => s.name))
  if (!(line.sections ?? []).length) fail.push(`${line.id}: sections 가 없다`)
  for (const sec of line.sections ?? []) {
    if (!STATUS.has(sec.status)) fail.push(`${line.id}: 구간 status '${sec.status}'`)
    if ((sec.stations ?? []).length < 2) fail.push(`${line.id}: 구간에 역이 2개 미만`)
    for (const n of sec.stations ?? []) if (!known.has(n)) fail.push(`${line.id}: 구간의 역 '${n}' 이 역 목록에 없다`)
  }
  // 연장 계획 — 선은 긋지 않고 상세에 단계·경과·출처만. 출처 없는 연장은 싣지 않는다
  for (const ext of line.extensions ?? []) {
    if (!ext.id || !ext.section || !ext.stage) fail.push(`${line.id} 연장: id·section·stage 필요`)
    for (const m of ext.milestones ?? []) if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date ?? '') || !m.text) fail.push(`${line.id} 연장 ${ext.id}: 경과 날짜·내용 확인`)
    if (!(ext.sources ?? []).length) fail.push(`${line.id} 연장 ${ext.id}: sources 가 비었다`)
  }
  // 이웃 역이 30km 넘게 떨어져 있으면 순서나 좌표가 틀렸을 가능성이 크다
  const st = line.stations ?? []
  for (let i = 1; i < st.length; i++) {
    const [a, b] = [st[i - 1].at, st[i].at]
    const km = Math.hypot((a[0] - b[0]) * 111, (a[1] - b[1]) * 88)
    if (km > 30) fail.push(`${line.id}: ${st[i - 1].name}→${st[i].name} ${km.toFixed(0)}km — 순서·좌표 확인`)
  }
}
// 노선 미확정(D·E·F) — 선은 긋지 않고 발표 내용·경과·출처만 보여준다. 출처 없는 문장은 싣지 않는다.
for (const p of seed.undecided ?? []) {
  if (!p.id || !p.name || !p.stage || !p.summary || !p.note) fail.push(`미확정 ${p.id}: id·name·stage·summary·note 필요`)
  for (const m of p.milestones ?? []) if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date ?? '') || !m.text) fail.push(`미확정 ${p.id}: 경과 날짜·내용 확인`)
  if (!(p.sources ?? []).length) fail.push(`미확정 ${p.id}: sources 가 비었다`)
  // 발표 지역 점 — 선은 여전히 긋지 않는다. 좌표를 특정할 수 있는 곳만 찍고, 무엇을 근거로 찍었는지 적는다.
  for (const a of p.areaPoints ?? []) {
    if (!a.name || !a.basis) fail.push(`미확정 ${p.id}: areaPoints 에 name·basis 필요`)
    if (!Array.isArray(a.at) || a.at.length !== 2 || !inKorea(a.at)) fail.push(`미확정 ${p.id} ${a.name}: 좌표 ${JSON.stringify(a.at)} — [lat,lng] 순서 확인`)
    // 발표에 나온 지역 이름과 이어져야 한다 — 없는 지역에 점을 찍으면 발표 내용과 어긋난다
    if (!(p.areas ?? []).includes(a.name)) fail.push(`미확정 ${p.id}: areaPoints '${a.name}' 이 areas 에 없다`)
  }
}
if (fail.length) {
  console.error('✗ gtx seed 검증 실패\n  - ' + fail.join('\n  - '))
  process.exit(1)
}

const { _about, _verify, ...out } = seed
if (_verify) console.warn(`⚠ 대조 미완료: ${_verify}`)
await fs.writeFile(OUT, JSON.stringify(out))
console.log(`✓ gtx.json — ${out.lines.map((l) => `${l.name} ${l.stations.length + (l.branches ?? []).reduce((a, b) => a + b.stations.length, 0)}역`).join(' · ')} · 미확정 ${out.undecided.length}`)
