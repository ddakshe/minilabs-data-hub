/*
 * school-zones/{schools,zones,chain,admissions}.json → school-zones/app/*
 *
 * 사용법:
 *   node scripts/build-school-zones-app.mjs
 *   (fetch:school-zones → build:admissions 를 먼저 돌린 뒤에 실행한다)
 *
 * 소비자: 「내 학군 찾기」 미니앱.
 *
 * 🔑 **원본을 앱에 그대로 줄 수 없다.** schools.json 은 4.4MB 로 허브 전체에서 가장 큰
 *    파일이다. recall-mini 가 1.8MB 를 번들에 넣었다가 minify 1.70MB 가 나와서 런타임
 *    fetch 로 뺀 전례가 있는데(실측 2026-08-17), 이건 그것의 2.5배다.
 *
 * **자르지 말고 쪼갠다.** 이 허브의 기존 답이 그렇다 — local-currency 는 시군구별 254개
 * 파일, aptcost 는 stats/{코드}.json 253개, oil 은 아예 app/ 서브디렉터리를 따로 둔다.
 * 앱은 화면을 옮길 때마다 샤드 하나씩만 받는다.
 *
 * ── 설계 결정 ──────────────────────────────────────────────
 * 1) **학교별 파일을 만들지 않는다.** 12,011개면 git 이 감당하기 어렵고, 어차피 검색
 *    결과에 주소를 띄워야 해서(동명이교 1,066건) 인덱스가 그 정보를 이미 갖는다.
 *    학교 상세는 인덱스 한 줄 + 해당 학구 샤드로 조립한다.
 * 2) **인덱스는 배열로 인코딩한다.** 키 이름이 12,011번 반복되면 그것만 수백 KB다.
 *    `FIELDS` 가 순서를 문서화한다.
 * 3) **중학교 학구 샤드를 따로 둔다.** 비평준화 지역에는 고교 학교군이 없어서
 *    학교군 샤드에 얹으면 그 지역 중학교가 통째로 고아가 된다.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.resolve(__dirname, '../school-zones')
const APP = path.join(DIR, 'app')

/**
 * 인덱스 한 줄의 필드 순서. 앱의 타입 정의와 짝이다.
 *
 * estab(공립/사립)과 elemZone(통학구역명)은 **일부러 뺐다** — zone/mid 샤드가 이미
 * 들고 있고, 상세 화면은 어차피 그 샤드를 받는다. 12,011번 반복되는 필드라
 * 하나 뺄 때마다 수십 KB 다.
 */
const FIELDS = ['id', 'name', 'level', 'addr', 'highZone', 'midZone']

const read = async (f) => JSON.parse(await fs.readFile(path.join(DIR, f), 'utf8'))
const readOpt = async (f) => { try { return await read(f) } catch { return null } }

/** 주소에서 시도·시군구를 뺀 나머지. 인덱스가 sido/gu 를 따로 들고 있어 중복이다. */
function shortAddr(addr) {
  return addr.split(' ').slice(2).join(' ')
}

async function writeJson(rel, obj) {
  const file = path.join(APP, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const text = JSON.stringify(obj)
  await fs.writeFile(file, text + '\n')
  return Buffer.byteLength(text)
}

async function main() {
  const { schools, baseDate } = await read('schools.json')
  const { zones } = await read('zones.json')
  const chain = await read('chain.json')
  const admissions = await readOpt('admissions.json')
  const statsFile = await readOpt('stats.json')
  const stats = statsFile?.stats ?? {}

  const zoneById = new Map(zones.map((z) => [z.id, z]))
  const schoolById = new Map(schools.map((s) => [s.id, s]))
  const zoneName = (id) => zoneById.get(id)?.name ?? null

  await fs.rm(APP, { recursive: true, force: true })

  // ── 검색·라우팅 인덱스 (설계 2) ──────────────────────────
  const index = schools.map((s) => [
    s.id, s.name, s.level, shortAddr(s.addr),
    s.highZone ?? null, s.midZone ?? null,
  ])
  const indexBytes = await writeJson('search.json', {
    fields: FIELDS, baseDate, count: index.length, rows: index,
  })

  // ── 고교 학교군 샤드 ────────────────────────────────────
  // 학교 한 줄. 지표(stats)는 **샤드에만** 얹는다 — 12,011줄짜리 검색 인덱스에
  // 넣으면 첫 검색에 받는 용량이 그만큼 늘어난다. 상세 화면은 어차피 샤드를 받는다.
  const brief = (id) => {
    const s = schoolById.get(id)
    if (!s) return null
    const st = stats[id]
    return st ? { i: s.id, n: s.name, e: s.estab, st } : { i: s.id, n: s.name, e: s.estab }
  }
  let zoneBytes = 0
  for (const z of chain.highZones) {
    const assigned = new Set(z.assignedHighSchools)
    // 이 학교군에 물리는 중학교들이 속한 학구 — 요약만 싣는다(전체는 mid 샤드).
    const midMap = new Map()
    for (const id of z.middleSchools) {
      const m = schoolById.get(id)
      if (!m?.midZone) continue
      if (!midMap.has(m.midZone)) midMap.set(m.midZone, 0)
      midMap.set(m.midZone, midMap.get(m.midZone) + 1)
    }
    zoneBytes += await writeJson(`zone/${z.id}.json`, {
      id: z.id, name: z.name, sido: z.sido, office: z.office,
      // 함정: 배정 명단(추첨)에는 자사고·특목고가 빠져 있다. 소속은 위치 기준이고
      // 추첨 대상 여부는 a 플래그로 구분한다.
      high: z.highSchools.map((id) => ({ ...brief(id), a: assigned.has(id) })).filter((x) => x.i),
      middle: z.middleSchools.map((id) => {
        const m = schoolById.get(id)
        return m ? { ...brief(id), mz: m.midZone ?? null } : null
      }).filter((x) => x?.i),
      midZones: [...midMap].map(([id, n]) => ({ i: id, n: zoneName(id), c: n })),
      elemCount: z.elemSchools.length,
    })
  }

  // ── 홈 「지역에서 찾기」 인덱스 ─────────────────────────
  // 고교 학교군 73개를 시도별로 묶는다. 검색 말고 **이름을 몰라도 들어갈 수 있는** 두 번째
  // 진입로다. 학교군이 없는 시도(전 지역 비평준화)는 싣지 않는다 — 그 지역은 검색으로 찾는다.
  // h(고교 수)는 zone 샤드와 같은 위치 기준(자사고·특목고 포함)이라 학교군 화면 숫자와 맞는다.
  const SIDO_SHORT = {
    서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천',
    광주광역시: '광주', 대전광역시: '대전', 울산광역시: '울산', 세종특별자치시: '세종',
    경기도: '경기', 강원특별자치도: '강원', 충청북도: '충북', 충청남도: '충남',
    전북특별자치도: '전북', 전라남도: '전남', 경상북도: '경북', 경상남도: '경남', 제주특별자치도: '제주',
  }
  const order = Object.keys(SIDO_SHORT)
  const bySido = new Map()
  for (const z of chain.highZones) {
    if (!bySido.has(z.sido)) bySido.set(z.sido, [])
    bySido.get(z.sido).push({ i: z.id, n: z.name, h: z.highSchools.length, m: z.middleSchools.length })
  }
  const rank = (sido) => (order.indexOf(sido) === -1 ? 999 : order.indexOf(sido))
  const sidos = [...bySido]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0], 'ko'))
    .map(([sido, zones]) => ({
      sido,
      label: SIDO_SHORT[sido] ?? sido,
      zones: zones.sort((a, b) => a.n.localeCompare(b.n, 'ko')),
    }))
  const indexed = sidos.reduce((n, x) => n + x.zones.length, 0)
  if (indexed !== chain.highZones.length) {
    throw new Error(`학교군 인덱스 ${indexed}개 ≠ 원본 ${chain.highZones.length}개`)
  }
  const zonesIndexBytes = await writeJson('zones-index.json', { baseDate, sidos })

  // ── 중학교 학구 샤드 (설계 3) ───────────────────────────
  let midBytes = 0, midCount = 0
  for (const z of chain.midZones) {
    const elems = z.elemSchools.map((id) => {
      const e = schoolById.get(id)
      return e ? { ...brief(id), ez: e.elemZone ? zoneName(e.elemZone) : null } : null
    }).filter((x) => x?.i)
    const mids = z.middleSchools.map(brief).filter(Boolean)
    if (!mids.length && !elems.length) continue
    // 이 학구의 중학교가 속한 고교 학교군 (되짚어 올라가기용)
    const up = z.middleSchools.map((id) => schoolById.get(id)?.highZone).find(Boolean) ?? null
    midBytes += await writeJson(`mid/${z.id}.json`, {
      id: z.id, name: z.name, sido: z.sido, office: z.office, shared: !!z.shared,
      highZone: up, highZoneName: up ? zoneName(up) : null,
      middle: mids, elem: elems,
    })
    midCount++
  }

  // ── 랭킹 (시드가 비어 있으면 빈 배열로 나간다 — 앱이 빈 상태를 그린다) ──
  // 랭킹 행이 들고 있는 highZone 은 ID 다. 앱에는 ID→이름 표가 없으므로(학교군 샤드를
  // 73개나 받을 수는 없다) 여기서 이름을 얹어 보낸다.
  if (admissions) {
    for (const d of admissions.datasets ?? []) {
      for (const r of d.schools ?? []) r.highZoneName = r.highZone ? zoneName(r.highZone) : null
    }
  }

  const admBytes = await writeJson('admissions.json', admissions ?? {
    coverageNote: '공개된 상위 학교만 실려 있다. 목록에 없는 학교는 0명이 아니라 미공개다.',
    comparisonNote: 'basis 가 다르면 대학끼리·연도끼리 합산하지 말고 따로 보여준다.',
    universities: [], datasets: [],
  })

  const counts = {
    schools: { 초: 0, 중: 0, 고: 0 },
    highZones: chain.highZones.length,
    midZones: midCount,
    nonLevelledHigh: schools.filter((s) => s.nonLevelled).length,
  }
  for (const s of schools) counts.schools[s.level]++

  await writeJson('meta.json', {
    baseDate,
    source: '학구도안내서비스(한국교육시설안전원) 공공데이터',
    statsSource: statsFile
      ? { source: statsFile.source, license: statsFile.license, pbanYr: statsFile.pbanYr, fields: statsFile.fields }
      : null,
    license: '공공누리 제1유형 — 출처 표시',
    counts,
    // 앱이 화면에 그대로 지켜야 하는 것들. 어기면 앱이 거짓말을 한다.
    caveats: {
      zone: '학군은 교육청이 정한 배정 구역이다. 개인의 실제 진학 경로가 아니다.',
      admissions: '목록에 없는 학교는 0명이 아니라 미공개다.',
      nonLevelled: '비평준화 지역 고교는 학교군이 없어 드릴다운이 불가능하다.',
    },
  })

  const kb = (b) => (b / 1024).toFixed(0) + 'KB'
  const gzKb = async (rel) => (zlib.gzipSync(await fs.readFile(path.join(APP, rel))).length / 1024).toFixed(0) + 'KB'

  console.log(`✓ app/search.json      ${kb(indexBytes)} (gzip ${await gzKb('search.json')}) — ${index.length}개교`)
  console.log(`✓ app/zones-index.json ${kb(zonesIndexBytes)} — 시도 ${sidos.length}곳 · 학교군 ${indexed}개`)
  console.log(`✓ app/zone/*.json      ${kb(zoneBytes)} / ${chain.highZones.length}개 (평균 ${kb(zoneBytes / chain.highZones.length)})`)
  console.log(`✓ app/mid/*.json       ${kb(midBytes)} / ${midCount}개 (평균 ${kb(midBytes / midCount)})`)
  console.log(`✓ app/admissions.json  ${kb(admBytes)}${admissions ? '' : ' (시드 없음 — 빈 상태)'}`)
  console.log(`  지표 있는 학교 ${Object.keys(stats).length}곳${statsFile ? ` (${statsFile.pbanYr}년 공시)` : ' — stats.json 없음'}`)
  console.log(`  초 ${counts.schools.초} · 중 ${counts.schools.중} · 고 ${counts.schools.고} (비평준화 ${counts.nonLevelledHigh})`)
}

main().catch((e) => { console.error('✗', e.message); process.exit(1) })
