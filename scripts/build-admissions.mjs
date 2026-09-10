/*
 * 고교별 대학 진학 실적 수동 시딩 → school-zones/admissions.json
 *
 * 사용법:
 *   node scripts/build-admissions.mjs                        seed/*.json → admissions.json
 *   node scripts/build-admissions.mjs --resolve list.txt      붙여넣은 목록 → 시드 초안(stdout)
 *
 * 소비자: 학교 계보 미니앱의 랭킹 화면(대학 × 연도로 필터).
 *
 * 🔑 **자동 수집 경로가 없다.** 학교알리미의 「졸업생의 진로 현황」은 법정 공시항목이지만
 *    ① OpenAPI 제공목록 34개에 없고 ② 대량다운로드에도 없으며 ③ 있다 해도 대학 '유형'별
 *    (전문대/4년제/국외)이라 "어느 대학에 몇 명"이 아니다 (2026-09-10 실측).
 *    대학이 국정감사에 제출한 자료를 언론·입시업체가 보도하는 게 사실상 유일한 공개 경로고,
 *    연 1회라 손으로 넣되 넣는 순간 검증한다.
 *
 * **대학은 서울대에 한정하지 않는다.** 시드 파일 하나가 (대학 × 연도) 한 묶음이다.
 * 공개 수준은 대학마다 크게 다르다 — 서울대는 매년 국정감사로 상위권 고교가 공개되지만
 * 연·고대는 거의 공개하지 않는다. 그래서 `coverage` 를 대학별로 따로 적는다.
 *
 * ── 이 데이터의 함정 ────────────────────────────────────────
 * 1) **동명이교가 1,066건이다.** 세화고는 서울·제주·포항 셋이고 호계초는 5곳이다.
 *    기사에는 "세화고"라고만 나온다. 이름으로 조인하면 **예외 없이 조용히 틀린 학교에
 *    숫자가 붙는다** → 시드는 반드시 `schoolId` 를 갖고, `--resolve` 가 그걸 만들어준다.
 *    이름이 여러 학교에 걸리면 후보를 보여주고 멈춘다.
 * 2) **미공개는 0이 아니다.** 공개분은 상위 일부 학교뿐이다. 목록에 없는 학교를 0으로
 *    그리면 통계가 거짓말이 된다 → `coverage: 'partial'` 을 달고 앱은 "미공개"와 "0명"을
 *    다르게 표기한다.
 * 3) **집계 기준이 대학·연도마다 다르다.** 합격자/등록자, 수시+정시 합산 여부, 재수생 포함
 *    여부가 출처마다 갈린다. `basis` 없이는 **대학끼리도 연도끼리도 비교할 수 없다.**
 *    앱에서 두 대학을 나란히 놓을 때 basis 가 다르면 합산하지 말고 따로 보여준다.
 * 4) **폐교·통합된 학교가 섞인다.** 과거 연도 자료에는 지금 없는 학교가 있다.
 *    schools.json 은 운영 중인 학교만 담으므로 매칭이 실패한다 — 경고로 남기고 건너뛴다.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../school-zones')
const SEED_DIR = path.join(OUT_DIR, 'seed')

async function loadSchools() {
  const { schools } = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'schools.json'), 'utf8'))
  return schools
}

/** 함정 1: 이름은 후보 목록으로만 다룬다. 하나로 좁혀지지 않으면 실패시킨다. */
function indexByName(schools) {
  const map = new Map()
  for (const s of schools) {
    if (s.level !== '고') continue
    for (const key of new Set([s.name, s.name.replace(/고등학교$/, '고')])) {
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(s)
    }
  }
  return map
}

async function resolve(listPath) {
  if (!listPath) throw new Error('--resolve <파일> 형식으로 목록 파일을 준다')
  const byName = indexByName(await loadSchools())
  const text = await fs.readFile(listPath, 'utf8')

  const out = [], problems = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    // "경기고등학교 62" · "경기고<TAB>62" · "1 경기고등학교 62" 를 모두 받는다
    const m = line.match(/^(?:\d+[.)]?\s+)?(.+?)[\s\t]+(\d+)\s*$/)
    if (!m) { problems.push(`형식을 못 읽음: "${line}"`); continue }
    const [, name, count] = m
    const hits = byName.get(name) ?? byName.get(name.replace(/고$/, '고등학교')) ?? []

    if (hits.length === 0) { problems.push(`못 찾음: "${name}" — 폐교했거나 표기가 다르다(함정 4)`); continue }
    if (hits.length > 1) {
      problems.push(`이름이 겹침: "${name}" → ` +
        hits.map((h) => `${h.sido} ${h.addr.split(' ').slice(1, 3).join(' ')} [${h.id}]`).join(' / '))
      continue
    }
    out.push({ schoolId: hits[0].id, name: hits[0].name, count: Number(count) })
  }

  if (problems.length) {
    console.error(`\n✗ 해결 못한 ${problems.length}건 — 시드에 넣기 전에 손으로 정리한다:`)
    for (const p of problems) console.error(`   · ${p}`)
    console.error('\n  이름이 겹치는 건 위 [schoolId] 중 하나를 직접 골라 넣는다.\n')
  }
  console.log(JSON.stringify({
    university: 'TODO 서울대학교',
    universityKey: 'TODO snu',
    year: new Date().getFullYear(),
    basis: 'TODO 등록자 · 수시+정시',
    source: 'TODO 출처(언론사·보도일 또는 국정감사 제출자료)',
    sourceUrl: 'TODO',
    coverage: 'partial',
    schools: out,
  }, null, 1))
  if (problems.length) process.exitCode = 1
}

async function build() {
  const schools = await loadSchools()
  const byId = new Map(schools.map((s) => [s.id, s]))

  let files = []
  try { files = (await fs.readdir(SEED_DIR)).filter((f) => f.endsWith('.json')).sort() } catch {}
  if (!files.length) throw new Error(`${SEED_DIR} 에 시드 파일이 없다 — --resolve 로 초안부터 만든다`)

  const datasets = [], universities = new Map()
  for (const file of files) {
    const seed = JSON.parse(await fs.readFile(path.join(SEED_DIR, file), 'utf8'))
    const at = file
    // 아직 안 채운 스켈레톤은 무해하게 건너뛴다. TODO 검사는 내용이 있을 때만 한다.
    if (!Array.isArray(seed.schools) || !seed.schools.length) { console.warn(`· ${at} — 비어 있어 건너뛴다 (아직 안 채운 시드)`); continue }
    const todo = (v) => !v || String(v).startsWith('TODO')
    if (todo(seed.university) || todo(seed.universityKey)) throw new Error(`${at}: university 와 universityKey 를 채워야 한다`)
    if (!Number.isInteger(seed.year)) throw new Error(`${at}: year 가 정수가 아니다`)
    if (todo(seed.source)) throw new Error(`${at}: source 를 채워야 한다 (출처 표시 의무)`)
    if (todo(seed.basis)) throw new Error(`${at}: basis 를 적어야 한다 — 없으면 대학·연도 간 비교가 불가능하다(함정 3)`)

    const seen = new Set(), rows = []
    for (const r of seed.schools) {
      const s = byId.get(r.schoolId)
      if (!s) throw new Error(`${at}: 모르는 schoolId ${r.schoolId} (${r.name ?? '이름없음'})`)
      if (s.level !== '고') throw new Error(`${at}: ${s.name} 은 고등학교가 아니다`)
      if (seen.has(r.schoolId)) throw new Error(`${at}: ${s.name} 이 두 번 들어 있다`)
      if (!Number.isInteger(r.count) || r.count < 0) throw new Error(`${at}: ${s.name} 의 count 가 이상하다 (${r.count})`)
      seen.add(r.schoolId)
      rows.push({ schoolId: s.id, name: s.name, count: r.count, highZone: s.highZone, nonLevelled: !!s.nonLevelled })
    }

    rows.sort((a, b) => b.count - a.count)
    let rank = 0, prev = null
    rows.forEach((r, i) => { if (r.count !== prev) { rank = i + 1; prev = r.count } r.rank = rank })

    const key = `${seed.universityKey}:${seed.year}`
    if (datasets.some((d) => `${d.universityKey}:${d.year}` === key)) throw new Error(`${at}: ${key} 가 중복이다`)

    const noZone = rows.filter((r) => !r.highZone).length
    if (noZone) console.warn(`· ${at} — ${noZone}곳은 학교군이 없다(비평준화). 앱에서 드릴다운을 막아야 한다.`)

    universities.set(seed.universityKey, seed.university)
    datasets.push({
      universityKey: seed.universityKey, university: seed.university, year: seed.year,
      basis: seed.basis, source: seed.source, sourceUrl: seed.sourceUrl ?? null,
      coverage: seed.coverage ?? 'partial', // 함정 2
      schools: rows,
    })
  }

  if (!datasets.length) throw new Error('내용이 있는 시드가 하나도 없다')
  datasets.sort((a, b) => b.year - a.year || a.universityKey.localeCompare(b.universityKey))

  await fs.writeFile(path.join(OUT_DIR, 'admissions.json'), JSON.stringify({
    // 함정 2: 목록에 없는 학교는 "0명"이 아니라 "미공개"다. 앱은 이 구분을 지켜야 한다.
    coverageNote: '공개된 상위 학교만 실려 있다. 목록에 없는 학교는 0명이 아니라 미공개다.',
    // 함정 3: basis 가 다른 데이터끼리 합산하지 않는다.
    comparisonNote: 'basis 가 다르면 대학끼리·연도끼리 합산하지 말고 따로 보여준다.',
    universities: [...universities].map(([key, name]) => ({ key, name })),
    datasets,
  }, null, 1) + '\n')

  for (const d of datasets) {
    console.log(`✓ ${d.year} ${d.university} — ${d.schools.length}곳 (1위 ${d.schools[0].name} ${d.schools[0].count})`)
  }
}

const run = process.argv[2] === '--resolve' ? resolve(process.argv[3]) : build()
run.catch((e) => { console.error('✗', e.message); process.exit(1) })
