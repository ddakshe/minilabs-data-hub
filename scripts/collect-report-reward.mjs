#!/usr/bin/env node
/*
 * 신고하고 포상금받자 — 동네별 무단투기 신고포상금 「조례 원문 재료」 수집
 *
 *   node scripts/collect-report-reward.mjs --sido 서울특별시
 *   node scripts/collect-report-reward.mjs --code 11680,41110
 *   node scripts/collect-report-reward.mjs --all            (이미 regions/{code}.json 이 있는 곳은 건너뜀)
 *   … --force   있어도 다시 받는다 (stale 재검수 등)
 *
 * → report-reward/_work/{code}.json (커밋하지 않는다)
 *   후보 조례·규칙 목록 + 포상금 조문 원문 + 포상금 별표 링크.
 *   **값을 판단하지 않는다.** 지급률·상한·기한을 읽어 regions/{code}.json 을 채우는 건
 *   사람(또는 수집 세션)의 몫이다 → report-reward/COLLECT.md
 *
 * 국가법령정보센터 Open API(DRF). LAW_OC 필요(.env). **국내 IP 에서 돌린다.**
 * 포상금 조항은 폐기물 조례에만 있지 않다 — 시행규칙(홍천), 별도 과태료 조례(수원),
 * 신고포상금 조례(경기 광주·구리)에도 있다. 그래서 본문검색으로 넓게 줍고 조문 단위로 거른다.
 */
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadUnits, shortName } from './report-reward/units.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, 'report-reward')
const WORK = path.join(DIR, '_work')

// ── .env 로더 (의존성 없이) ──
;(function loadEnv() {
  const p = path.join(ROOT, '.env')
  if (!existsSync(p)) return
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
})()

const OC = process.env.LAW_OC
if (!OC) {
  console.error('LAW_OC 가 필요합니다 (.env 또는 환경변수) — 국가법령정보 공동활용 인증키')
  process.exit(1)
}

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const FORCE = args.includes('--force')
// 「포상금」이 아니라 「보상금」이라고 쓰는 조례가 있다(오산·고양 환경오염행위 신고 보상 조례) — 둘 다 줍는다
const BODY_QUERIES = ['무단투기 포상금', '투기 포상금', '폐기물 포상금', '투기 보상금', '폐기물 보상금', '환경오염 신고 보상']
const DUMPING = /투기|폐기물|쓰레기|꽁초/
const GAP_MS = 300

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ymd = (s) => (/^\d{8}$/.test(s ?? '') ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null)
const list = (v) => (Array.isArray(v) ? v : v ? [v] : [])
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)

async function fetchRetry(url, { tries = 3, gapMs = 1500, timeoutMs = 25000 } = {}) {
  let last
  for (let i = 1; i <= tries; i += 1) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      last = e
      if (i < tries) {
        console.warn(`  ⚠ 네트워크 오류 (${i}/${tries}) — ${gapMs * i}ms 뒤 재시도: ${e.message}`)
        await sleep(gapMs * i)
      }
    }
  }
  throw last
}

let calls = 0
async function drf(endpoint, params) {
  const qs = new URLSearchParams({ OC, target: 'ordin', type: 'JSON', ...params })
  const url = `http://www.law.go.kr/DRF/${endpoint}?${qs}`
  await sleep(GAP_MS)
  calls += 1
  const res = await fetchRetry(url)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    // 인증키 오류·IP 차단은 HTML/문자열로 온다 — 그대로 보여줘야 원인을 안다
    throw new Error(`${endpoint} JSON 아님 (HTTP ${res.status}): ${text.slice(0, 200).replace(/\s+/g, ' ')}`)
  }
}

async function searchAll(query, search) {
  const out = []
  for (let page = 1; ; page += 1) {
    const s = (await drf('lawSearch.do', { query, search: String(search), nw: '1', display: '100', page: String(page) })).OrdinSearch
    const items = list(s?.law)
    out.push(...items)
    if (!items.length || out.length >= Number(s.totalCnt)) break
  }
  return out
}

/** 전국 본문검색 결과 — 하루 한 번만 받는다 */
async function bodySearchIndex() {
  const cache = path.join(WORK, '_search.json')
  if (existsSync(cache) && !FORCE) {
    const c = JSON.parse(readFileSync(cache, 'utf8'))
    if (c.date === kstToday()) return c.items
  }
  const byId = new Map()
  for (const q of BODY_QUERIES) {
    const items = await searchAll(q, 2)
    console.log(`  본문검색 '${q}' ${items.length}건`)
    for (const it of items) byId.set(it['자치법규ID'], it)
  }
  const items = [...byId.values()]
  await fs.writeFile(cache, JSON.stringify({ date: kstToday(), queries: BODY_QUERIES, items }))
  return items
}

/**
 * 조문·별표 거르기 — 실측으로 세 번 고쳤다.
 *  1) 「포상」만으로 거르면 대행업체 평가 조례의 우수업체 포상, 도시정비 조례의 신고포상금이 섞인다.
 *  2) 그런데 조문에 「투기·폐기물」 낱말까지 요구하면 **법 조항 번호로만 대상을 가리키는 조문**을 놓친다
 *     — 「법 제8조제1항 또는 제2항의 위반행위를 신고한 자」(남양주·고양·하남, 2026-09-11 수집 세션 보고).
 *     법령 인용이 정확한 조례일수록 빠지는 필터였다. → 법규 제목이 폐기물·청소·투기·환경오염·과태료
 *     계열이면 조문에는 「포상/보상 + 신고」만 요구하고, 그 밖의 법규에서만 낱말을 요구한다.
 *  3) 「포상금」 대신 「보상금」이라고 쓰는 조례가 있다(오산).
 * 별표는 제목에 포상·보상·지급기준이 있거나, 뽑힌 조문이 「별표 N」으로 가리키는 것.
 * 별표 제목이 그냥 「별표」「별표 3」인 곳이 많다(종로·광진·양천·오산·가평) — 번호로 잇는다. 서식은 뺀다.
 * 조문여부 'N' 은 장·절 제목 행이다.
 */
const REWARD = /포상|보상/
const WASTE_TITLE = /폐기물|청소|투기|환경오염|과태료|쓰레기/

function pickArticles(body, ordinTitle) {
  const titleIsWaste = WASTE_TITLE.test(ordinTitle ?? '')
  const arts = []
  for (const a of list(body?.['조문']?.['조'])) {
    const text = a['조내용'] ?? ''
    if (a['조문여부'] !== 'Y' || !REWARD.test(text) || !/신고/.test(text)) continue
    if (!titleIsWaste && !DUMPING.test(text)) continue
    arts.push({ no: text.match(/^제\d+조(의\d+)?/)?.[0] ?? null, title: a['조제목'] || null, text })
  }
  return arts
}

function pickTables(body, articles) {
  const referenced = new Set(articles.flatMap((a) => [...a.text.matchAll(/별표\s*(\d+)/g)].map((m) => Number(m[1]))))
  return list(body?.['별표']?.['별표단위'])
    .filter((t) => {
      const title = t['별표제목'] ?? ''
      if (/서식/.test(title) && !/기준|금액/.test(title)) return false
      return /포상|보상|지급기준/.test(title) || referenced.has(Number(t['별표번호']))
    })
    .map((t) => ({ title: t['별표제목'], fileType: t['별표첨부파일구분'] || null, fileUrl: t['별표첨부파일명'] || null, text: t['별표내용'] || null }))
}

async function collectUnit(unit, bodyHits) {
  const name = shortName(unit)
  // 본문검색에서 이 자치단체 것 + 법규명으로 「○○ 폐기물」 (포상금 조항이 없어도 「없다」 판단의 근거로 남긴다)
  const byName = [...(await searchAll(`${name} 폐기물`, 1)), ...(await searchAll(`${name} 환경오염`, 1))].filter(
    (it) => it['지자체기관명'] === unit.orgName,
  )
  const cands = new Map()
  for (const it of [...bodyHits.filter((it) => it['지자체기관명'] === unit.orgName), ...byName]) cands.set(it['자치법규ID'], it)

  const ordinances = []
  for (const it of cands.values()) {
    const mst = it['자치법규일련번호']
    const body = (await drf('lawService.do', { MST: mst })).LawService
    const info = body?.['자치법규기본정보'] ?? {}
    const articles = pickArticles(body, info['자치법규명'] ?? it['자치법규명'])
    const tables = pickTables(body, articles)
    ordinances.push({
      title: info['자치법규명'] ?? it['자치법규명'],
      kind: it['자치법규종류'] ?? null, // 조례 | 규칙
      ordinId: String(info['자치법규ID'] ?? it['자치법규ID']),
      mst: String(mst),
      promulgatedAt: ymd(info['공포일자'] ?? it['공포일자']),
      effectiveAt: ymd(info['시행일자'] ?? it['시행일자']),
      url: `https://www.law.go.kr/LSW/ordinInfoP.do?ordinSeq=${mst}`,
      dept: [info['담당부서명'], info['전화번호']].filter(Boolean).join(' ') || null,
      hasReward: articles.length > 0 || tables.length > 0,
      articles,
      tables,
    })
  }
  ordinances.sort((a, b) => Number(b.hasReward) - Number(a.hasReward) || a.title.localeCompare(b.title))
  const hint = !ordinances.length ? 'no-ordinance' : ordinances.some((o) => o.hasReward) ? 'reward-found' : 'no-reward-article'
  return { code: unit.code, sido: unit.sido, sigungu: unit.sigungu, orgName: unit.orgName, collectedAt: new Date().toISOString(), hint, ordinances }
}

const units = await loadUnits(ROOT)
let targets
if (opt('--code')) {
  const codes = new Set(opt('--code').split(','))
  targets = units.filter((u) => codes.has(u.code))
  const missing = [...codes].filter((c) => !targets.some((u) => u.code === c))
  if (missing.length) console.warn(`⚠ 목록에 없는 code: ${missing.join(', ')} — 일반구면 모시 코드(앞 4자리+0)`)
} else if (opt('--sido')) {
  targets = units.filter((u) => u.sido === opt('--sido'))
  if (!targets.length) console.warn(`⚠ '${opt('--sido')}' 에 해당하는 곳이 없다. 시도 이름: ${[...new Set(units.map((u) => u.sido))].join(', ')}`)
} else if (args.includes('--all')) {
  targets = units
} else {
  console.error('사용법: --sido 서울특별시 | --code 11680,41110 | --all  [--force]')
  process.exit(1)
}
if (!FORCE) targets = targets.filter((u) => !existsSync(path.join(DIR, 'regions', `${u.code}.json`)))

await fs.mkdir(WORK, { recursive: true })
console.log(`대상 ${targets.length}곳`)
const bodyHits = await bodySearchIndex()
const summary = []
for (const unit of targets) {
  try {
    const out = await collectUnit(unit, bodyHits)
    await fs.writeFile(path.join(WORK, `${unit.code}.json`), JSON.stringify(out, null, 2))
    const n = out.ordinances.filter((o) => o.hasReward).length
    summary.push(`${unit.code} ${unit.orgName} — ${out.hint} (포상금 조문 있는 법규 ${n} / 후보 ${out.ordinances.length})`)
    console.log(`  ✓ ${summary.at(-1)}`)
  } catch (e) {
    summary.push(`${unit.code} ${unit.orgName} — ERROR ${e.message}`)
    console.error(`  ✗ ${summary.at(-1)}`)
  }
}
await fs.writeFile(path.join(WORK, '_summary.txt'), summary.join('\n') + '\n')
console.log(`끝 — API 호출 ${calls}회 · report-reward/_work/_summary.txt`)
if (summary.some((s) => s.includes('ERROR'))) process.exit(1)
