// KOSIS Open API → korea-stats/stats.json
//
// Usage:
//   node --env-file=.env.local scripts/fetch-kosis.js
//   KOSIS_API_KEY=xxx node scripts/fetch-kosis.js
//
// Produces a time-series stats.json:
//   - 월별 지표: 최근 36개월 history
//   - 연별 지표: 최근 10년 history

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../korea-stats/stats.json')

const API_KEY = process.env.KOSIS_API_KEY
if (!API_KEY) {
  console.error('✗ KOSIS_API_KEY env var required')
  process.exit(1)
}

const BASE = 'https://kosis.kr/openapi/Param/statisticsParameterData.do'

const MONTHLY_HISTORY = 36
const YEARLY_HISTORY = 10

// ───────────────────────────── helpers ─────────────────────────────

async function kosis(params) {
  const qs = new URLSearchParams({
    method: 'getList',
    apiKey: API_KEY,
    format: 'json',
    jsonVD: 'Y',
    ...params,
  })
  const res = await fetch(`${BASE}?${qs}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (data && !Array.isArray(data) && data.err) {
    throw new Error(`KOSIS ${data.err}: ${data.errMsg}`)
  }
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('empty response')
  }
  return data
}

const sortDesc = (rows) =>
  [...rows].sort((a, b) => (b.PRD_DE || '').localeCompare(a.PRD_DE || ''))
const sortAsc = (rows) =>
  [...rows].sort((a, b) => (a.PRD_DE || '').localeCompare(b.PRD_DE || ''))

function shiftYear(prd, years) {
  if (!prd) return prd
  if (prd.length === 4) return String(Number(prd) + years)
  if (prd.length === 6) {
    const y = Number(prd.slice(0, 4)) + years
    return `${y}${prd.slice(4)}`
  }
  return prd
}

const num = (x) => {
  const n = Number(x)
  return Number.isFinite(n) ? n : null
}

function pct(current, prior) {
  if (prior == null || prior === 0) return 0
  return Math.round(((current - prior) / prior) * 1000) / 10
}

function fmtPrd(prd) {
  if (!prd) return ''
  if (prd.length === 4) return `${prd}년`
  if (prd.length === 6) return `${prd.slice(0, 4)}.${prd.slice(4)}`
  return prd
}

// history: [{prd, value}] — 오래된 것 → 최신 순
function buildHistory(rows, length, transform = (r) => num(r.DT)) {
  return sortAsc(rows)
    .slice(-length)
    .map((r) => ({ prd: r.PRD_DE, value: transform(r) }))
    .filter((h) => h.value != null)
}

// 일반 케이스: 최신값, YoY, history 한 번에
function scalarWithHistory(rows, historyLength) {
  const sorted = sortDesc(rows)
  const latest = sorted[0]
  const priorPrd = shiftYear(latest.PRD_DE, -1)
  const prior = sorted.find((r) => r.PRD_DE === priorPrd)
  const cur = num(latest.DT)
  const priorVal = prior ? num(prior.DT) : null
  return {
    value: cur,
    prd: latest.PRD_DE,
    changePct: priorVal == null ? 0 : pct(cur, priorVal),
    history: buildHistory(rows, historyLength),
  }
}

// ───────────────────────────── indicators ─────────────────────────────

const indicators = [
  {
    id: 'pop_total',
    category: 'population',
    title: '총인구',
    unit: '명',
    frequency: 'M',
    source: '통계청 주민등록인구',
    async fetchValue() {
      const rows = await kosis({
        orgId: '101',
        tblId: 'DT_1B04005N',
        objL1: '00',
        objL2: '0',
        itmId: 'T2',
        prdSe: 'M',
        newEstPrdCnt: String(MONTHLY_HISTORY + 1),
      })
      return scalarWithHistory(rows, MONTHLY_HISTORY)
    },
  },

  {
    id: 'pop_fertility',
    category: 'population',
    title: '합계출산율',
    unit: '명',
    decimals: 2,
    frequency: 'Y',
    source: '통계청 인구동향조사',
    async fetchValue() {
      const rows = await kosis({
        orgId: '101',
        tblId: 'DT_1B8000G',
        objL1: '00',
        objL2: '12',
        itmId: 'T1',
        prdSe: 'Y',
        newEstPrdCnt: String(YEARLY_HISTORY + 1),
      })
      return scalarWithHistory(rows, YEARLY_HISTORY)
    },
  },

  {
    id: 'pop_elderly',
    category: 'population',
    title: '고령인구 비율',
    unit: '%',
    decimals: 1,
    frequency: 'Y',
    source: '통계청 장래인구추계',
    async fetchValue() {
      // 장래인구추계 — 특정 기간 지정 필요
      const thisYear = new Date().getFullYear()
      const rows = await kosis({
        orgId: '101',
        tblId: 'DT_1BPA002',
        objL1: '1',
        objL2: '33',
        itmId: 'T10',
        prdSe: 'Y',
        startPrdDe: String(thisYear - YEARLY_HISTORY),
        endPrdDe: String(thisYear),
      })
      return scalarWithHistory(rows, YEARLY_HISTORY)
    },
  },

  {
    id: 'pop_household',
    category: 'population',
    title: '1인 가구 비율',
    unit: '%',
    decimals: 1,
    frequency: 'Y',
    source: '통계청 인구총조사',
    async fetchValue() {
      const rows = await kosis({
        orgId: '101',
        tblId: 'DT_1YL21161',
        objL1: '00',
        itmId: 'T10',
        prdSe: 'Y',
        newEstPrdCnt: String(YEARLY_HISTORY + 1),
      })
      return scalarWithHistory(rows, YEARLY_HISTORY)
    },
  },

  {
    id: 'eco_gni',
    category: 'economy',
    title: '1인당 국민총소득',
    unit: '달러',
    frequency: 'Y',
    source: '한국은행 국민계정',
    async fetchValue() {
      const rows = await kosis({
        orgId: '301',
        tblId: 'DT_200Y101',
        objL1: '13102136288ACC_ITEM.1010601',
        itmId: '13103136288999',
        prdSe: 'Y',
        newEstPrdCnt: String(YEARLY_HISTORY + 1),
      })
      const r = scalarWithHistory(rows, YEARLY_HISTORY)
      r.value = Math.round(r.value)
      r.history = r.history.map((h) => ({ ...h, value: Math.round(h.value) }))
      return r
    },
  },

  {
    id: 'eco_cpi',
    category: 'economy',
    title: '소비자물가 상승률',
    unit: '%',
    decimals: 1,
    frequency: 'M',
    source: '통계청 소비자물가조사',
    async fetchValue() {
      // Fetch 48 months so we can compute 36 monthly YoY rates.
      const rows = await kosis({
        orgId: '101',
        tblId: 'DT_1J22003',
        objL1: 'T10',
        itmId: 'T',
        prdSe: 'M',
        newEstPrdCnt: String(MONTHLY_HISTORY + 12),
      })
      const byPrd = new Map(rows.map((r) => [r.PRD_DE, num(r.DT)]))
      const sortedAsc = sortAsc(rows)

      // For each month where we have a year-ago value, compute YoY rate.
      const yoyPoints = []
      for (const r of sortedAsc) {
        const prior = byPrd.get(shiftYear(r.PRD_DE, -1))
        if (prior == null) continue
        const cur = num(r.DT)
        if (cur == null) continue
        yoyPoints.push({
          prd: r.PRD_DE,
          value: Math.round(((cur - prior) / prior) * 1000) / 10,
        })
      }

      const history = yoyPoints.slice(-MONTHLY_HISTORY)
      const latest = history[history.length - 1]
      const prevMonth = history[history.length - 2] || latest
      return {
        value: latest.value,
        prd: latest.prd,
        changePct: Math.round((latest.value - prevMonth.value) * 10) / 10,
        history,
      }
    },
  },

  {
    id: 'soc_unemp',
    category: 'society',
    title: '실업률',
    unit: '%',
    decimals: 1,
    frequency: 'M',
    source: '통계청 경제활동인구조사',
    async fetchValue() {
      const rows = await kosis({
        orgId: '101',
        tblId: 'DT_1DA7102S',
        objL1: '0',
        objL2: '00',
        itmId: 'T80',
        prdSe: 'M',
        newEstPrdCnt: String(MONTHLY_HISTORY + 1),
      })
      return scalarWithHistory(rows, MONTHLY_HISTORY)
    },
  },

  {
    id: 'soc_house',
    category: 'society',
    title: '전세가격지수',
    unit: 'pt',
    decimals: 1,
    frequency: 'M',
    source: '한국부동산원 전국주택가격동향',
    async fetchValue() {
      const rows = await kosis({
        orgId: '408',
        tblId: 'DT_30404_B013',
        objL1: '00',
        objL2: 'a0',
        itmId: 'sales',
        prdSe: 'M',
        newEstPrdCnt: String(MONTHLY_HISTORY + 1),
      })
      const r = scalarWithHistory(rows, MONTHLY_HISTORY)
      r.value = Math.round(r.value * 10) / 10
      r.history = r.history.map((h) => ({
        ...h,
        value: Math.round(h.value * 10) / 10,
      }))
      return r
    },
  },

  {
    id: 'soc_crime',
    category: 'society',
    title: '5대 강력범죄',
    unit: '건',
    frequency: 'M',
    source: '경찰청 범죄통계',
    async fetchValue() {
      // 월별 발생건수를 그대로 history로, 최신 12개월 합계를 대표값으로
      const rows = await kosis({
        orgId: '132',
        tblId: 'DT_13204_A0400',
        objL1: '022',
        itmId: 'T001',
        prdSe: 'M',
        newEstPrdCnt: String(MONTHLY_HISTORY),
      })
      const history = buildHistory(rows, MONTHLY_HISTORY)
      // 대표값: 최근 12개월 합
      const last12 = history.slice(-12).reduce((s, h) => s + (h.value || 0), 0)
      const prev12 = history
        .slice(-24, -12)
        .reduce((s, h) => s + (h.value || 0), 0)
      return {
        value: last12,
        prd: history[history.length - 1]?.prd,
        changePct: prev12 > 0 ? pct(last12, prev12) : 0,
        history,
      }
    },
  },

  {
    id: 'soc_edu',
    category: 'society',
    title: '학생 1인당 월평균 사교육비',
    unit: '만원',
    decimals: 1,
    frequency: 'Y',
    source: '통계청 초중고 사교육비조사',
    async fetchValue() {
      const rows = await kosis({
        orgId: '101',
        tblId: 'DT_1PE201',
        objL1: '10',
        itmId: 'T01',
        prdSe: 'Y',
        newEstPrdCnt: String(YEARLY_HISTORY + 1),
      })
      const r = scalarWithHistory(rows, YEARLY_HISTORY)
      r.value = Math.round(r.value * 10) / 10
      r.history = r.history.map((h) => ({
        ...h,
        value: Math.round(h.value * 10) / 10,
      }))
      return r
    },
  },

  {
    id: 'hea_life',
    category: 'health',
    title: '기대수명',
    unit: '세',
    decimals: 1,
    frequency: 'Y',
    source: '통계청 생명표',
    async fetchValue() {
      const rows = await kosis({
        orgId: '101',
        tblId: 'DT_1B41',
        objL1: '01',
        itmId: 'T6',
        prdSe: 'Y',
        newEstPrdCnt: String(YEARLY_HISTORY + 1),
      })
      const r = scalarWithHistory(rows, YEARLY_HISTORY)
      r.value = Math.round(r.value * 10) / 10
      r.history = r.history.map((h) => ({
        ...h,
        value: Math.round(h.value * 10) / 10,
      }))
      return r
    },
  },

  {
    id: 'hea_obesity',
    category: 'health',
    title: '비만 유병률',
    unit: '%',
    decimals: 1,
    frequency: 'Y',
    source: '질병관리청 국민건강영양조사',
    async fetchValue() {
      const rows = await kosis({
        orgId: '177',
        tblId: 'DT_11702_N101',
        objL1: '1',
        objL2: '103',
        itmId: 'RATIO',
        prdSe: 'Y',
        newEstPrdCnt: String(YEARLY_HISTORY + 1),
      })
      return scalarWithHistory(rows, YEARLY_HISTORY)
    },
  },

  {
    id: 'hea_smoke',
    category: 'health',
    title: '현재 흡연율',
    unit: '%',
    decimals: 1,
    frequency: 'Y',
    source: '질병관리청 국민건강영양조사',
    async fetchValue() {
      const rows = await kosis({
        orgId: '177',
        tblId: 'DT_11702_N001',
        objL1: '1',
        objL2: '103',
        itmId: 'T20',
        prdSe: 'Y',
        newEstPrdCnt: String(YEARLY_HISTORY + 1),
      })
      return scalarWithHistory(rows, YEARLY_HISTORY)
    },
  },
]

// 우울감 경험률 — KOSIS 전국 표 없음. 정적 값.
const staticExtras = [
  {
    id: 'hea_mental',
    category: 'health',
    title: '우울감 경험률',
    value: 7.3,
    unit: '%',
    changePct: 0.5,
    decimals: 1,
    frequency: 'Y',
    source: '지역사회건강조사 (추정)',
    note: 'KOSIS 전국 통계표 없음 → 정적 값',
    history: [],
  },
]

// ───────────────────────────── issue detection ─────────────────────────────
//
// "5년 최저/최고", "기록적", "반등" 등의 문구를 history 기반으로 자동 생성.
function detectHighlights(stat) {
  if (!stat.history || stat.history.length < 3) return null
  const values = stat.history.map((h) => h.value).filter((v) => v != null)
  if (values.length < 3) return null

  const latest = values[values.length - 1]
  const min = Math.min(...values)
  const max = Math.max(...values)
  const len = values.length
  const span = stat.frequency === 'Y' ? `${len}년` : `${len}개월`

  if (latest === min) {
    return { tag: `${span} 최저`, emoji: '📉', priority: 3 }
  }
  if (latest === max) {
    return { tag: `${span} 최고`, emoji: '📈', priority: 3 }
  }

  // 2번째로 극단인 값 근처 (튜닝 필요 없는 단순 버전)
  const sorted = [...values].sort((a, b) => a - b)
  if (latest === sorted[1])
    return { tag: `${span} 2번째 최저`, emoji: '📉', priority: 2 }
  if (latest === sorted[sorted.length - 2])
    return { tag: `${span} 2번째 최고`, emoji: '📈', priority: 2 }

  return null
}

function buildIssues(stats) {
  const candidates = []
  for (const s of stats) {
    const h = detectHighlights(s)
    if (h) candidates.push({ ...s, ...h })
  }
  // 우선순위: 최고/최저(3) > 2번째(2). 동률 시 changePct 절댓값.
  candidates.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    return Math.abs(b.changePct) - Math.abs(a.changePct)
  })

  const top = candidates.slice(0, 2)
  if (top.length < 2) {
    // fallback — 변화율 큰 것
    const more = [...stats]
      .filter((s) => !top.find((t) => t.id === s.id) && s.changePct)
      .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
      .slice(0, 2 - top.length)
      .map((s) => ({
        ...s,
        tag: `전년 대비 ${s.changePct > 0 ? '+' : ''}${s.changePct}%`,
        emoji: s.changePct > 0 ? '📈' : '📉',
      }))
    top.push(...more)
  }

  return top.map((s) => ({
    id: `i_${s.id}`,
    emoji: s.emoji,
    title: `${s.title} · ${s.tag}`,
    description: s.period
      ? `${s.period} 기준`
      : `최신 기준 ${s.changePct > 0 ? '+' : ''}${s.changePct}%`,
    category: s.category,
  }))
}

// ───────────────────────────── main ─────────────────────────────

async function main() {
  console.log(`▶ KOSIS fetch start (${indicators.length} indicators)\n`)

  const stats = []
  const errors = []

  for (const ind of indicators) {
    try {
      const { value, changePct, prd, history } = await ind.fetchValue()
      stats.push({
        id: ind.id,
        category: ind.category,
        title: ind.title,
        value,
        unit: ind.unit,
        changePct,
        decimals: ind.decimals,
        frequency: ind.frequency,
        source: ind.source,
        period: fmtPrd(prd),
        history,
      })
      const vStr =
        typeof value === 'number'
          ? value.toLocaleString('ko-KR', {
              minimumFractionDigits: ind.decimals || 0,
              maximumFractionDigits: ind.decimals || 0,
            })
          : String(value)
      const sign = changePct > 0 ? '+' : ''
      console.log(
        `  ✓ ${ind.title.padEnd(22)} ${vStr} ${ind.unit}  (${sign}${changePct}%, ${fmtPrd(prd)}, hist=${history.length})`,
      )
    } catch (e) {
      errors.push({ title: ind.title, error: e.message })
      console.error(`  ✗ ${ind.title.padEnd(22)} ${e.message}`)
    }
    await new Promise((r) => setTimeout(r, 120))
  }

  for (const s of staticExtras) stats.push(s)

  const output = {
    updatedAt: new Date().toISOString().slice(0, 10),
    source: 'KOSIS Open API',
    categories: [
      { id: 'population', label: '인구', emoji: '👥' },
      { id: 'economy', label: '경제', emoji: '💰' },
      { id: 'society', label: '사회', emoji: '🏙️' },
      { id: 'health', label: '보건', emoji: '🩺' },
    ],
    issues: buildIssues(stats),
    stats,
    errors: errors.length ? errors : undefined,
  }

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n')

  const totalPoints = stats.reduce(
    (s, x) => s + (x.history ? x.history.length : 0),
    0,
  )
  const bytes = (await fs.stat(OUTPUT_PATH)).size
  console.log(
    `\n✓ wrote ${path.relative(process.cwd(), OUTPUT_PATH)}  (${stats.length} stats, ${totalPoints} points, ${(bytes / 1024).toFixed(1)} KB)`,
  )

  if (errors.length) process.exitCode = 1
}

main().catch((e) => {
  console.error('\n✗ fatal:', e.message)
  process.exit(1)
})
