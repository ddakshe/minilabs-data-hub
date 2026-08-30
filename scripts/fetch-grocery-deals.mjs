#!/usr/bin/env node
/*
 * 컬리·오아시스 식품 특가 → grocery-deals/{kurly,oasis}.json
 *
 * 사용법:
 *   node scripts/fetch-grocery-deals.mjs            # 두 몰 모두
 *   MALLS=kurly node scripts/fetch-grocery-deals.mjs # 일부만
 *
 * 소비자: bapsang-deal-mini(특가로 밥상 차리기).
 *
 * 🔑 이 데이터의 고유값은 "슬롯이 붙은 특가"다. 특가 목록만 주는 앱은 33개가 있지만,
 *    국·메인·밑반찬으로 나뉜 특가는 예산 안에서 밥상을 조합할 수 있게 한다.
 *
 * ⚠️ 한 몰이 실패해도 다른 몰은 저장한다. 단 직전 산출보다 30% 이상 급감하면
 *    직전본을 유지한다 — 상류 장애로 앱이 빈 화면이 되는 것을 막는다.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SLOTS } from './grocery-deals/slots.mjs'
import { collectKurly } from './grocery-deals/kurly.mjs'
import { collectOasis } from './grocery-deals/oasis.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.resolve(ROOT, 'grocery-deals')

const todayKST = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())

const COLLECTORS = { kurly: collectKurly, oasis: collectOasis }

async function readPrev(name) {
  try {
    return JSON.parse(await fs.readFile(path.resolve(OUT_DIR, `${name}.json`), 'utf8'))
  } catch {
    return null
  }
}

function countBySlot(items) {
  const out = {}
  for (const s of SLOTS) out[s] = 0
  for (const it of items) out[it.slot] = (out[it.slot] ?? 0) + 1
  return out
}

async function main() {
  const only = process.env.MALLS?.split(',').map((s) => s.trim()).filter(Boolean)
  const targets = only?.length ? only : Object.keys(COLLECTORS)
  await fs.mkdir(OUT_DIR, { recursive: true })

  let failures = 0
  for (const mall of targets) {
    const collect = COLLECTORS[mall]
    if (!collect) {
      console.error(`✗ 알 수 없는 몰: ${mall}`)
      failures++
      continue
    }
    console.log(`▶ ${mall} 수집 시작`)
    try {
      const items = await collect()
      const prev = await readPrev(mall)
      const prevCount = prev?.items?.length ?? 0

      if (prevCount > 0 && items.length < prevCount * 0.7) {
        console.error(
          `✗ ${mall}: 직전 ${prevCount}건 → ${items.length}건 (30% 이상 급감) — 직전본을 유지한다`,
        )
        failures++
        continue
      }

      const payload = {
        updatedAt: todayKST(),
        mall,
        counts: { total: items.length, bySlot: countBySlot(items) },
        items,
      }
      await fs.writeFile(
        path.resolve(OUT_DIR, `${mall}.json`),
        JSON.stringify(payload, null, 2),
        'utf8',
      )
      console.log(`✓ grocery-deals/${mall}.json  (${items.length}건)`, payload.counts.bySlot)
    } catch (err) {
      console.error(`✗ ${mall}: ${err.message} — 직전본을 유지한다`)
      failures++
    }
  }

  if (failures === targets.length) {
    console.error('✗ 모든 몰이 실패했다. 저장된 것이 없다.')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
