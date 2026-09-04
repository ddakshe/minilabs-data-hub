// car-deals/promotions.json 커밋 전 검증 게이트.
//
// 왜 필요한가 — 2026-08-28 사고:
//   스크래퍼가 현대·제네시스·KGM을 통째로 떨구고 기아·르노 28건만 남긴 파일을 썼는데,
//   month 필드는 멀쩡했고 diff도 있었으므로 워크플로가 그대로 커밋·푸시했다.
//   앱은 month가 맞으니 stale로도 error로도 안 걸리고 "정상"인 척 기아만 보여줬다.
//   깨진 걸 아무도 몰랐다. 조용한 실패를 시끄러운 실패로 바꾸는 것이 이 스크립트의 일이다.
//
// 판정 원칙: **건수가 아니라 brands[id].updatedAt을 본다.**
//   스크래퍼는 실패 시 직전 데이터를 유지하므로 건수는 0이 되지 않는다.
//
// Usage:
//   node scripts/validate-car-deals.mjs                  # 하나라도 어긋나면 exit 1
//   node scripts/validate-car-deals.mjs --allow-partial  # 신선도 미달을 경고로만 (수동 실행용)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_PATH = path.resolve(__dirname, '../car-deals/promotions.json')

const ALLOW_PARTIAL = process.argv.includes('--allow-partial')

/** 앱(auto-deal-mini)이 아는 브랜드. 하나라도 비면 사용자 화면에서 브랜드 탭이 사라진다. */
const REQUIRED_BRANDS = ['hyundai', 'kia', 'genesis', 'kgm', 'renault']

const todayKST = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())

const errors = []
const warns = []
const fail = (msg) => (ALLOW_PARTIAL ? warns : errors).push(msg)

const data = JSON.parse(await fs.readFile(DATA_PATH, 'utf8'))
const today = todayKST()
const thisMonth = today.slice(0, 7)

// ── 1. 월 ─────────────────────────────────────────────
// 앱은 month가 이번 달과 다르면 stale 화면으로 물러선다. 여기서 미리 잡는다.
if (data.month !== thisMonth) errors.push(`month가 이번 달이 아니다: ${data.month} (기대 ${thisMonth})`)

// ── 2. 브랜드 커버리지와 신선도 ────────────────────────
// 사고의 본체. 브랜드가 통째로 빠지거나, 지난달 데이터를 물려받은 채 남아 있는 경우를 잡는다.
const counts = {}
for (const it of data.items ?? []) counts[it.brand] = (counts[it.brand] ?? 0) + 1

for (const id of REQUIRED_BRANDS) {
  const n = counts[id] ?? 0
  const meta = data.brands?.[id]
  if (n === 0) {
    fail(`${id}: 항목이 0건이다 (앱에서 브랜드가 통째로 사라진다)`)
  } else if (!meta?.updatedAt) {
    fail(`${id}: ${n}건 있으나 신선도 기록이 없다 — 수집된 데이터가 맞는지 알 수 없다`)
  } else if (meta.updatedAt.slice(0, 7) !== thisMonth) {
    fail(`${id}: ${n}건이 지난 수집분이다 (updatedAt ${meta.updatedAt}) — 이번 달 수집이 실패했다`)
  }
}

// ── 3. 만료된 endsAt ──────────────────────────────────
// 앱의 isLive() 필터가 걸러내므로, 만료 항목은 화면에서 조용히 사라진다.
// 지난달 데이터를 물려받았을 때 이 형태로 나타난다(2026-09 르노 3건이 그랬다).
const expired = (data.items ?? []).filter((p) => p.endsAt && p.endsAt < today)
if (expired.length) {
  const by = [...new Set(expired.map((p) => p.brand))].join(', ')
  fail(`마감 지난 항목 ${expired.length}건 (${by}) — 앱에서 조용히 사라진다`)
}

// ── 4. 스키마 ─────────────────────────────────────────
// 앱의 타입과 어긋나면 렌더링 중에 터진다. 여기서 막는다.
for (const [i, p] of (data.items ?? []).entries()) {
  const where = `items[${i}] ${p?.brand ?? '?'}/${p?.model ?? '?'}`
  if (!REQUIRED_BRANDS.includes(p?.brand)) errors.push(`${where}: 알 수 없는 brand`)
  if (!p?.model) errors.push(`${where}: model 없음`)
  if (!Array.isArray(p?.benefits)) errors.push(`${where}: benefits가 배열이 아니다`)
  if (!Array.isArray(p?.conditionalBenefits)) errors.push(`${where}: conditionalBenefits가 배열이 아니다`)
  if (p?.endsAt === undefined) errors.push(`${where}: endsAt 필드 없음`)
  if (p?.basePrice === undefined) errors.push(`${where}: basePrice 필드 없음`)
}

// ── 리포트 ────────────────────────────────────────────
const line = REQUIRED_BRANDS.map((b) => {
  const u = data.brands?.[b]?.updatedAt
  return `${b} ${counts[b] ?? 0}${u === today ? '' : `(${u ?? '기록없음'})`}`
}).join(' · ')

console.log(`${data.month} · 총 ${data.items?.length ?? 0}건`)
console.log(line)

for (const w of warns) console.log(`::warning::${w}`)

if (errors.length) {
  for (const e of errors) console.log(`::error::${e}`)
  console.log(`\n❌ 검증 실패 ${errors.length}건 — 커밋하지 않는다.`)
  process.exit(1)
}

console.log(`\n✅ 검증 통과${warns.length ? ` (경고 ${warns.length}건)` : ''}`)
