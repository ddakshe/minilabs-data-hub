/*
 * 교육통계서비스(KESS) 학교별 데이터셋 → school-zones/careers.json
 *
 * 사용법:
 *   node scripts/fetch-school-careers.mjs
 *   (fetch:school-zones 를 먼저 돌려 schools.json 이 있어야 한다)
 *   KESS_CACHE=<dir> 로 받은 엑셀을 재사용할 수 있다 (기본: OS 임시 폴더)
 *
 * 소비자: 「내 학군 찾기」 미니앱 — 고교 졸업생 진로(4년제·전문대·국외·취업·기타).
 *
 * 🔑 **학교알리미 API 에는 진로가 없다.** 「졸업생의 진로 현황」은 공시항목이지만 OpenAPI
 *    34개에도 대량다운로드에도 빠져 있다. 전국 학교 단위로 받을 수 있는 곳은 KESS 의
 *    「학교/학과별 데이터셋」 엑셀뿐이다. 대학 **이름**은 없고 유형(국내 4년제/전문대/국외)까지다.
 *
 * 라이선스: KESS 「공공데이터 이용정책」 — "영리 목적의 이용을 포함한 자유로운 활용이
 * 보장됩니다 (공공데이터법 제1조, 제3조)". 출처(교육통계서비스, 한국교육개발원)를 표기한다.
 *
 * ── 함정 (전부 실측 2026-09-10) ─────────────────────────────
 * 1) **고교 값은 이듬해 재추출 때 채워진다.** 2026 파일(2026-09 추출)은 고교 2,367곳의
 *    진학·취업·기타·대학구분이 전부 0 이고, 2025 파일(2026-02 재추출)은 다 차 있다.
 *    → 최신 파일부터 내려가며 **고교 값이 찬 첫 파일**을 쓴다. 0 을 0% 로 싣지 않는다.
 * 2) **다운로드 전에 사용목적 폼을 거친다.** `POST /contents/dataset/poll` 후 같은 쿠키로
 *    `downLoad.do`. 목적은 사실대로 「민간기업 및 단체 / 기타」로 낸다.
 * 3) **옛 파일에는 대학 구분 열이 없다** (2019 파일은 진학자 합계뿐, 125열).
 *    필수 열이 하나라도 없으면 그 파일은 건너뛴다.
 * 4) **진학률이 높다고 좋은 학교가 아니다.** 진학자는 졸업한 해 대학에 등록한 학생이고
 *    재수생은 '기타'로 빠진다. 2025 파일에서 서울 일반고 진학률 중앙값은 강남·서초가 53%로
 *    **최하위**다(휘문고 49%, 기타 51%). 앱은 순위를 매기지 않고 구성만 보여준다.
 * 5) **학교 코드가 KEDI 체계라 학구도 ID 와 다르다.** (시도 약칭, 학교명) 으로 찾고 동명이면
 *    행정구로 거른다. 그래도 둘 이상이면 버린다 — 조용히 아무거나 붙이지 않는다.
 * 6) **xlsx 라이브러리를 쓰지 않는다.** 시트 XML 이 110MB 라 무겁긴 해도 zip 해제(zlib)와
 *    정규식으로 충분하다. 공유 문자열(sharedStrings) 참조와 발음 표기(<rPh>)를 처리해야 한다.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.resolve(__dirname, '../school-zones')

const ORIGIN = 'https://kess.kedi.re.kr'
const LIST_URL = `${ORIGIN}/contents/dataset`
const CACHE = process.env.KESS_CACHE ?? path.join(os.tmpdir(), 'kess-dataset')
const MAX_TRIES = 3
/** 함정 2: 사용목적 폼 값 — 민간기업 및 단체(13) / 기타(07) */
const PURPOSE = { TYPE_A: '13', TYPE_B: '07' }
/** 고교 중 이 비율 이상에 진로 값이 있어야 "채워진 파일"로 본다 (함정 1) */
const FILLED_MIN = 0.9

const SIDO_SHORT = {
  서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천',
  광주광역시: '광주', 대전광역시: '대전', 울산광역시: '울산', 세종특별자치시: '세종',
  경기도: '경기', 강원특별자치도: '강원', 충청북도: '충북', 충청남도: '충남',
  전북특별자치도: '전북', 전라남도: '전남', 경상북도: '경북', 경상남도: '경남', 제주특별자치도: '제주',
}

/** 엑셀 머리글(줄바꿈·공백 제거) → 내부 이름 */
const COLUMNS = {
  day: '조사기준일', sido: '시도', gu: '행정구', level: '학교급', type: '고등학교유형',
  name: '학교명', branch: '본분교', state: '상태',
  g: '졸업자_계', adv: '진학자_계', j: '취업자_계', m: '입대자_계', o: '기타_계',
  dc: '국내_전문대학_계', du: '국내_대학_계', fc: '국외_전문대학_계', fu: '국외_대학_계',
}

// ── HTTP (쿠키 유지) ────────────────────────────────────────
const jar = new Map()
async function http(url, init = {}) {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': 'Mozilla/5.0 (minilabs-data-hub)', ...(cookie ? { Cookie: cookie } : {}), ...init.headers },
  })
  for (const c of res.headers.getSetCookie()) {
    const kv = c.split(';')[0]
    const i = kv.indexOf('=')
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1))
  }
  if (!res.ok) throw new Error(`${url} — HTTP ${res.status}`)
  return res
}

/** 목록 페이지의 onclick="downLoad('ID','파일','표시명','01')" 중 상반기 학교별 파일 */
async function listFiles() {
  const html = await (await http(LIST_URL)).text()
  const re = /downLoad\('(\d+)','([^']+)','((\d{4})년 유초중등 학교별 학년별 학생수 학급수 입학 졸업[^']*)','01'\)/g
  const byYear = new Map()
  for (const m of html.matchAll(re)) {
    const year = Number(m[4])
    if (!byYear.has(year)) byYear.set(year, { id: m[1], fileNm: m[2], name: m[3], year })
  }
  if (!byYear.size) throw new Error('데이터셋 목록에서 학교별 파일을 못 찾았다 — 페이지 구조가 바뀌었는지 확인')
  return [...byYear.values()].sort((a, b) => b.year - a.year)
}

async function download(f) {
  const file = path.join(CACHE, f.fileNm)
  const cached = await fs.stat(file).catch(() => null)
  if (cached?.size > 1_000_000) return file

  await http(`${ORIGIN}/contents/dataset/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ FILE_ID: f.id, GROUP_A: '01', ...PURPOSE }),
  })
  const q = new URLSearchParams({ fileNm: f.fileNm, userfileNm: f.name })
  const buf = Buffer.from(await (await http(`${ORIGIN}/contents/dataSet/downLoad.do?${q}`)).arrayBuffer())
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error(`${f.name} — xlsx(zip) 가 아니다 (${buf.length}B). 사용목적 폼 절차가 바뀌었을 수 있다`)
  }
  await fs.mkdir(CACHE, { recursive: true })
  await fs.writeFile(file, buf)
  return file
}

// ── xlsx 읽기 (함정 6) ──────────────────────────────────────
function unzip(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('zip 끝 레코드가 없다')
  const count = buf.readUInt16LE(eocd + 10)
  const entries = new Map()
  let p = buf.readUInt32LE(eocd + 16)
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 중앙 디렉터리가 깨졌다')
    const nlen = buf.readUInt16LE(p + 28)
    entries.set(buf.toString('utf8', p + 46, p + 46 + nlen), {
      method: buf.readUInt16LE(p + 10), csize: buf.readUInt32LE(p + 20), off: buf.readUInt32LE(p + 42),
    })
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
  }
  return (name) => {
    const e = entries.get(name)
    if (!e) return null
    const start = e.off + 30 + buf.readUInt16LE(e.off + 26) + buf.readUInt16LE(e.off + 28)
    const raw = buf.subarray(start, start + e.csize)
    return e.method === 0 ? raw : zlib.inflateRawSync(raw)
  }
}

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] !== '#' ? (ENT[e] ?? m)
    : String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))))
const attrs = (s) => Object.fromEntries([...s.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
const textOf = (xml) => decode(xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').replace(/<t\b[^>]*>([\s\S]*?)<\/t>|<[^>]+>/g, (_, t) => t ?? ''))

function colIndex(ref) {
  let n = 0
  for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64
  return n - 1
}

/** 「학교별 …」 시트를 행 배열의 제너레이터로 */
function* sheetRows(buf) {
  const get = unzip(buf)
  const wb = get('xl/workbook.xml').toString('utf8')
  const rels = get('xl/_rels/workbook.xml.rels').toString('utf8')
  const sheet = [...wb.matchAll(/<sheet\b([^>]*?)\/?>/g)].map((m) => attrs(m[1])).find((a) => decode(a.name ?? '').includes('학교별'))
  if (!sheet) throw new Error('「학교별」 시트가 없다')
  const rel = [...rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)].map((m) => attrs(m[1])).find((a) => a.Id === sheet['r:id'])
  const target = rel.Target.startsWith('/') ? rel.Target.slice(1) : `xl/${rel.Target}`

  const sstBuf = get('xl/sharedStrings.xml')
  const sst = sstBuf ? [...sstBuf.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : []

  const xml = get(target).toString('utf8')
  for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const out = []
    for (const c of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(c[1])
      if (!a.r || !c[2]) continue
      let v
      if (a.t === 'inlineStr') v = textOf(c[2])
      else {
        const raw = c[2].match(/<v>([\s\S]*?)<\/v>/)?.[1]
        if (raw === undefined) continue
        v = a.t === 's' ? sst[Number(raw)] : decode(raw)
      }
      out[colIndex(a.r)] = v
    }
    yield out
  }
}

/** 파일 하나 → 고교 행들. 필수 열이 없으면 { missing } */
function readHighSchools(buf) {
  let col = null
  const rows = []
  for (const r of sheetRows(buf)) {
    if (!col) {
      if (!r.some((v) => typeof v === 'string' && v.trim() === '학교명')) continue
      const header = r.map((v) => String(v ?? '').replace(/\s+/g, ''))
      col = {}
      const missing = []
      for (const [k, label] of Object.entries(COLUMNS)) {
        const i = header.indexOf(label)
        if (i < 0) missing.push(label)
        col[k] = i
      }
      if (missing.length) return { missing }
      continue
    }
    const at = (k) => String(r[col[k]] ?? '').trim()
    if (at('level') !== '고등학교' || at('branch') !== '본교' || at('state').includes('폐')) continue
    const num = (k) => { const n = Number(at(k)); return Number.isFinite(n) ? n : 0 }
    rows.push({
      day: at('day'), sido: at('sido'), gu: at('gu'), name: at('name'),
      type: at('type').replace('고등학교', ''),
      g: num('g'), adv: num('adv'), j: num('j'), m: num('m'), o: num('o'),
      dc: num('dc'), du: num('du'), fc: num('fc'), fu: num('fu'),
    })
  }
  if (!col) throw new Error('머리글 행(학교명)을 못 찾았다')
  return { rows }
}

async function main() {
  const { schools } = JSON.parse(await fs.readFile(path.join(DIR, 'schools.json'), 'utf8'))
  const files = await listFiles()
  console.log(`· 학교별(상반기) 파일 ${files.length}개 — 최신 ${files[0].year}년부터 확인`)

  let picked = null
  for (const f of files.slice(0, MAX_TRIES)) {
    const file = await download(f)
    const res = readHighSchools(await fs.readFile(file))
    if (res.missing) { console.log(`  ${f.year}: 필수 열 없음 (${res.missing.join(', ')}) — 건너뜀`); continue }
    const graduated = res.rows.filter((r) => r.g > 0)
    const filled = graduated.filter((r) => r.adv + r.j + r.m + r.o > 0).length
    const ratio = filled / Math.max(1, graduated.length)
    console.log(`  ${f.year}: 고교 ${res.rows.length}곳 · 진로 값 ${filled}/${graduated.length} (${(ratio * 100).toFixed(0)}%)`)
    if (ratio >= FILLED_MIN) { picked = { f, rows: res.rows }; break }
  }
  if (!picked) throw new Error(`최근 ${MAX_TRIES}개 파일 모두 고교 진로가 비어 있다`)

  // 정합성: 대학 구분 합 = 진학자, 진학+취업+입대+기타 = 졸업자. 안 맞는 행은 싣지 않는다.
  let inconsistent = 0
  const usable = picked.rows.filter((r) => {
    if (r.g <= 0) return false
    const ok = r.dc + r.du + r.fc + r.fu === r.adv && r.adv + r.j + r.m + r.o === r.g
    if (!ok) inconsistent++
    return ok
  })

  // 함정 5: 조인
  const byKey = new Map()
  for (const r of usable) {
    const k = `${r.sido}|${r.name}`
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(r)
  }
  const careers = new Map()
  const usedBy = new Map()
  let missing = 0, ambiguous = 0
  const high = schools.filter((s) => s.level === '고')
  for (const s of high) {
    const sido = SIDO_SHORT[s.sido] ?? s.sido
    const cands = (byKey.get(`${sido}|${s.name}`) ?? [])
      .filter((r) => sido === '세종' || !r.gu || s.addr.includes(r.gu.split(' ')[0]))
    if (cands.length === 0) { missing++; continue }
    if (cands.length > 1) { ambiguous++; continue }
    const r = cands[0]
    if (!usedBy.has(r)) usedBy.set(r, [])
    usedBy.get(r).push(s.id)
    careers.set(s.id, { t: r.type, g: r.g, u: r.du, c: r.dc, f: r.fc + r.fu, j: r.j, m: r.m, o: r.o })
  }
  let shared = 0
  for (const ids of usedBy.values()) {
    if (ids.length < 2) continue
    for (const id of ids) careers.delete(id)
    shared += ids.length
  }

  // 검증
  if (careers.size < high.length * 0.9) {
    throw new Error(`진로가 붙은 고교가 ${careers.size}/${high.length}곳뿐이다 — 조인 키나 열 매핑을 의심하라`)
  }
  const general = [...careers.values()].filter((c) => c.t === '일반' && c.g >= 30).map((c) => c.u / c.g).sort((a, b) => a - b)
  const median = general[Math.floor(general.length / 2)]
  if (!(median > 0.4 && median < 0.9)) {
    throw new Error(`일반고 4년제 진학 비율 중앙값이 ${(median * 100).toFixed(0)}% — 열이 밀렸을 가능성`)
  }

  const day = picked.rows.find((r) => r.day)?.day ?? ''
  const year = Number(day.slice(0, 4)) || picked.f.year
  await fs.writeFile(path.join(DIR, 'careers.json'), JSON.stringify({
    year,
    surveyDate: day ? `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}` : null,
    graduatedIn: `${year}-02`,
    source: '교육통계서비스 학교별 데이터셋 (한국교육개발원)',
    sourceUrl: LIST_URL,
    sourceFile: picked.f.name,
    license: '공공데이터법에 따른 공공데이터 — 영리 목적 포함 자유 이용, 출처 표시',
    fields: {
      t: '고등학교 유형(일반/자율/특수목적/특성화)', g: '졸업자', u: '국내 4년제 대학 진학', c: '국내 전문대학 진학',
      f: '국외 대학·전문대학 진학', j: '취업', m: '입대', o: '기타 — 재수·미파악 등',
    },
    caveat: '진학은 졸업한 해에 대학에 등록한 학생만 센다. 재수생은 기타에 들어가 재수가 많은 학교일수록 진학 비율이 낮다. 학교 순위로 쓰지 않는다.',
    count: careers.size,
    careers: Object.fromEntries(careers),
  }, null, 1) + '\n')

  console.log(`✓ school-zones/careers.json — ${year}년 조사(${year}년 2월 졸업생) · 고교 ${careers.size}/${high.length}곳`)
  console.log(`  미매칭 ${missing} · 동명 모호 ${ambiguous} · 한 행에 여러 학교 ${shared} · 정합성 불일치 행 ${inconsistent}`)
  console.log(`  일반고(졸업 30+) 4년제 진학 비율 중앙값 ${(median * 100).toFixed(0)}%`)
  const hw = high.find((s) => s.name === '휘문고등학교')
  const c = hw && careers.get(hw.id)
  if (c) console.log(`  예) 휘문고 — 졸업 ${c.g} · 4년제 ${c.u} · 전문대 ${c.c} · 국외 ${c.f} · 취업 ${c.j} · 기타 ${c.o}`)
}

main().catch((e) => { console.error('✗', e.message); process.exit(1) })
