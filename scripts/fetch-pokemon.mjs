// 포켓몬고 도감·레이드 데이터 — pokemongo-tools 앱용.
// 출력: pokemon/{pokemon,categories,raid-bosses,evolutions,moves,stats,meta}.json
//
// 두 소스를 합친다:
//   - pogoapi.net  : 포켓몬고에 **실제 출시된** 종·카테고리·레이드 보스 (커뮤니티 운영, 정적 JSON)
//   - pokeapi.co   : 한국어 이름 (본가 데이터. GO 전용 값은 없다)
//
// 🚨 함정 둘
//   1. pogoapi 는 기본 User-Agent 를 **403** 으로 막는다. curl 은 통과하는데 스크립트는 막힌다.
//      → UA 를 반드시 붙인다. (금감원 finlife 와 같은 패턴)
//   2. PokeAPI 는 1,025종을 주지만 그중 88종은 **GO 에 없다.** 반드시 released 와 교집합.
//      검색창에 뜨는데 못 잡는 포켓몬이 섞이면 사용자에겐 그냥 버그다.
//
// PokeAPI fair use: "요청한 리소스는 로컬에 캐시" → 그래서 여기서 받아 정적으로 내려둔다.
//
// Usage: node scripts/fetch-pokemon.mjs
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../pokemon')

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

async function j(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

const POGO = 'https://pogoapi.net/api/v1'

// ── 1. GO 출시 종 ────────────────────────────────────────
const released = await j(`${POGO}/released_pokemon.json`)
const ids = [...new Set(Object.values(released).map((p) => p.id))].sort((a, b) => a - b)
console.log('GO 출시 종:', ids.length)
const inGo = new Set(ids)

// ── 2. 카테고리 ─────────────────────────────────────────
const CATEGORY_EPS = [
  ['legendary', 'pokemon_rarity.json', '전설'],
  ['mythic', 'pokemon_rarity.json', '환상'],
  ['ultrabeast', 'pokemon_rarity.json', '울트라비스트'],
  ['baby', 'baby_pokemon.json', '베이비'],
  ['mega', 'mega_pokemon.json', '메가진화'],
  ['alolan', 'alolan_pokemon.json', '알로라'],
  ['galarian', 'galarian_pokemon.json', '가라르'],
  ['raid', 'raid_exclusive_pokemon.json', '레이드 전용'],
  ['shadow', 'shadow_pokemon.json', '섀도우'],
  ['nesting', 'nesting_pokemon.json', '둥지 출현'],
  ['ditto', 'possible_ditto_pokemon.json', '메타몽 변신'],
]
const RARITY_KEY = { legendary: 'Legendary', mythic: 'Mythic', ultrabeast: 'Ultra beast' }

const idsOf = (rows) =>
  [...new Set((Array.isArray(rows) ? rows : Object.values(rows).flat())
    .map((r) => r?.pokemon_id ?? r?.id).filter(Boolean))]

const categories = {}
const cache = new Map()
for (const [key, ep, label] of CATEGORY_EPS) {
  if (!cache.has(ep)) cache.set(ep, await j(`${POGO}/${ep}`))
  const raw = cache.get(ep)
  const rows = RARITY_KEY[key] ? raw[RARITY_KEY[key]] : raw
  const list = idsOf(rows).filter((id) => inGo.has(id)).sort((a, b) => a - b)
  categories[key] = { label, ids: list }
  console.log(`  ${label.padEnd(12)} ${list.length}`)
}

// 세대
const gens = await j(`${POGO}/pokemon_generations.json`)
categories.generations = Object.fromEntries(
  Object.entries(gens).map(([g, rows]) => [
    g.replace('Generation ', ''),
    idsOf(rows).filter((id) => inGo.has(id)).sort((a, b) => a - b),
  ])
)

// ── 3. 종별 타입 (Normal 폼 기준) ────────────────────────
const typeRows = await j(`${POGO}/pokemon_types.json`)
const typeOf = new Map()
for (const r of typeRows) {
  if (r.form !== 'Normal') continue
  if (inGo.has(r.pokemon_id)) typeOf.set(r.pokemon_id, r.type)
}

// ── 4. 한국어 이름 (PokeAPI, 동시성 8) ───────────────────
const out = []
let cursor = 0, done = 0
async function worker() {
  while (cursor < ids.length) {
    const id = ids[cursor++]
    try {
      const s = await j(`https://pokeapi.co/api/v2/pokemon-species/${id}`)
      const ko = s.names.find((n) => n.language.name === 'ko')?.name
      const en = s.names.find((n) => n.language.name === 'en')?.name
      out.push({ id, ko: ko || en, en, types: typeOf.get(id) ?? [] })
    } catch (e) {
      console.error('  실패', id, e.message)
    }
    if (++done % 200 === 0) console.log('  이름', done, '/', ids.length)
  }
}
await Promise.all(Array.from({ length: 8 }, worker))
out.sort((a, b) => a.id - b.id)

// ── 4-1. 진화 트리 ──────────────────────────────────────
// "이거 뭘로 진화하지? 사탕 몇 개?" 에 답한다.
// 이브이처럼 **조건부 분기**(버디 10km · 낮에만 · 아이템)가 있고 그게 진짜 고통 지점이라
// 조건 필드를 통째로 보존한다.
const evoRaw = await j(`${POGO}/pokemon_evolutions.json`)
const evolutions = {}
for (const r of Array.isArray(evoRaw) ? evoRaw : Object.values(evoRaw).flat()) {
  if (r.form !== 'Normal' || !inGo.has(r.pokemon_id)) continue
  evolutions[r.pokemon_id] = (r.evolutions ?? [])
    .filter((e) => inGo.has(e.pokemon_id))
    .map((e) => ({
      id: e.pokemon_id,
      candy: e.candy_required,
      buddyKm: e.buddy_distance_required,
      mustBuddy: e.must_be_buddy_to_evolve || undefined,
      daytime: e.only_evolves_in_daytime || undefined,
      nighttime: e.only_evolves_in_nighttime || undefined,
      item: e.item_requirement || undefined,
      lure: e.lure_requirement || undefined,
      trade: e.no_candy_cost_via_trade || undefined,
      priority: e.priority,
    }))
}
console.log('진화 트리:', Object.keys(evolutions).length, '종')

// ── 4-2. 카운터 계산 재료 ────────────────────────────────
// "꼬북이랑 싸우려면 누가 좋아?" 에 답하려면 타입 배율만으로 부족하다.
// 종족값 + 기술(위력·시전시간·에너지) 이 있어야 실제 DPS 를 낼 수 있다.
const statRows = await j(`${POGO}/pokemon_stats.json`)
const stats = {}
for (const r of statRows) {
  if (r.form !== 'Normal' || !inGo.has(r.pokemon_id)) continue
  stats[r.pokemon_id] = { atk: r.base_attack, def: r.base_defense, sta: r.base_stamina }
}
const cpRows = await j(`${POGO}/pokemon_max_cp.json`)
for (const r of cpRows) {
  if (r.form === 'Normal' && stats[r.pokemon_id]) stats[r.pokemon_id].maxCp = r.max_cp
}

const moveRows = await j(`${POGO}/current_pokemon_moves.json`)
const movesets = {}
for (const r of moveRows) {
  if (r.form !== 'Normal' || !inGo.has(r.pokemon_id)) continue
  movesets[r.pokemon_id] = {
    fast: [...(r.fast_moves ?? []), ...(r.elite_fast_moves ?? [])],
    charged: [...(r.charged_moves ?? []), ...(r.elite_charged_moves ?? [])],
  }
}
const moves = {
  fast: await j(`${POGO}/fast_moves.json`),
  charged: await j(`${POGO}/charged_moves.json`),
  byPokemon: movesets,
}
console.log('종족값:', Object.keys(stats).length, '· 기술셋:', Object.keys(movesets).length,
  '· 기술 fast', moves.fast.length, 'charged', moves.charged.length)

// ── 4-3. CP 배율표 ──────────────────────────────────────
// CP = floor((공격+IV) * sqrt(방어+IV) * sqrt(체력+IV) * CPM^2 / 10)
// 진화 후 CP 예측·개체 비교에 필요하다. ⚠️ 이 표는 레벨 45 까지만 준다
// (API 의 max_cp 는 50 기준이라 값이 다르다 — 50 대까지 필요하면 별도 처리).
const cpm = Object.fromEntries(
  (await j(`${POGO}/cp_multiplier.json`)).map((r) => [r.level, r.multiplier])
)
console.log('CP 배율:', Object.keys(cpm).length, '레벨')

// ── 5. 레이드 보스 (주기적으로 바뀐다 — 이 앱의 '주기갱신' 재료) ──
const raid = await j(`${POGO}/raid_bosses.json`)
const tiers = Object.fromEntries(
  Object.entries(raid.current ?? {}).map(([tier, list]) => [
    tier,
    list.map((b) => ({
      id: b.id, name: b.name, form: b.form, tier: b.tier,
      types: b.type, shiny: b.possible_shiny,
      cp: [b.min_unboosted_cp, b.max_unboosted_cp],
      boostedWeather: b.boosted_weather,
    })),
  ])
)

await fs.mkdir(OUT, { recursive: true })
await fs.writeFile(path.join(OUT, 'pokemon.json'), JSON.stringify(out))
await fs.writeFile(path.join(OUT, 'categories.json'), JSON.stringify(categories))
await fs.writeFile(path.join(OUT, 'raid-bosses.json'), JSON.stringify(tiers))
await fs.writeFile(path.join(OUT, 'evolutions.json'), JSON.stringify(evolutions))
await fs.writeFile(path.join(OUT, 'stats.json'), JSON.stringify(stats))
await fs.writeFile(path.join(OUT, 'cpm.json'), JSON.stringify(cpm))
await fs.writeFile(path.join(OUT, 'moves.json'), JSON.stringify(moves))
await fs.writeFile(
  path.join(OUT, 'meta.json'),
  JSON.stringify(
    {
      fetchedAt: new Date().toISOString(),
      released: ids.length,
      evolutions: Object.keys(evolutions).length,
      stats: Object.keys(stats).length,
      cpmLevels: Object.keys(cpm).length,
      moves: { fast: moves.fast.length, charged: moves.charged.length },
      koMissing: out.filter((p) => !p.ko).length,
      raidTiers: Object.fromEntries(Object.entries(tiers).map(([t, l]) => [t, l.length])),
      sources: ['pogoapi.net (커뮤니티)', 'pokeapi.co (한국어 이름)'],
      note: 'pogoapi 는 기본 UA 를 403 으로 막는다. PokeAPI 1025종 중 GO 미출시 88종은 제외했다.',
    },
    null, 2
  )
)
console.log('완료 →', OUT)
console.log('  종', out.length, '· 한국어 누락', out.filter((p) => !p.ko).length)
console.log('  레이드 티어', Object.entries(tiers).map(([t, l]) => `${t}:${l.length}`).join(' '))
